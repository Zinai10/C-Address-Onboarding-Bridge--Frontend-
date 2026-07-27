import {
  isConnected,
  getAddress,
  signTransaction,
  getNetwork,
} from "@stellar/freighter-api";
import {
  TransactionBuilder,
  Operation,
  BASE_FEE,
  Networks,
  Asset,
  Horizon,
  rpc,
  Account,
} from "@stellar/stellar-sdk";
import { BRIDGE_CONTRACT_ID, type StellarNetwork } from "./types";
import { withSequenceRetry } from "./sequenceManager";

const HORIZON_URLS: Record<StellarNetwork, string> = {
  PUBLIC: "https://horizon.stellar.org",
  TESTNET: "https://horizon-testnet.stellar.org",
};

const SOROBAN_RPC_URLS: Record<StellarNetwork, string> = {
  PUBLIC: "https://soroban-rpc.stellar.org",
  TESTNET: "https://soroban-rpc-testnet.stellar.org",
};

export async function getHorizonServer(network: StellarNetwork): Promise<Horizon.Server> {
  const { Horizon } = await import("@stellar/stellar-sdk");
  return new Horizon.Server(HORIZON_URLS[network]);
}

export async function getSorobanRpcServer(network: StellarNetwork): Promise<rpc.Server> {
  const { rpc } = await import("@stellar/stellar-sdk");
  return new rpc.Server(SOROBAN_RPC_URLS[network]);
}

export async function getNetworkPassphrase(network: StellarNetwork): Promise<string> {
  const { Networks } = await import("@stellar/stellar-sdk");
  return network === "PUBLIC" ? Networks.PUBLIC : Networks.TESTNET;
}

export async function connectWallet(): Promise<string | null> {
  try {
    const conn = await isConnected();
    if (!conn.isConnected) {
      throw new Error("Freighter not detected");
    }
    const addr = await getAddress();
    return addr.address;
  } catch (e) {
    console.error("Failed to connect wallet:", e);
    return null;
  }
}

export async function checkConnection(): Promise<boolean> {
  try {
    const result = await isConnected();
    return result.isConnected;
  } catch {
    return false;
  }
}

export async function getWalletAddress(): Promise<string | null> {
  try {
    const result = await getAddress();
    return result.address;
  } catch {
    return null;
  }
}

export async function getCurrentNetwork(): Promise<StellarNetwork> {
  try {
    const result = await getNetwork();
    const networkName = String(result.network ?? "").toUpperCase();
    return networkName === "PUBLIC" ? "PUBLIC" : "TESTNET";
  } catch {
    return "TESTNET";
  }
}

export function isValidStellarAddress(address: string): boolean {
  return /^[G|C][A-Z0-9]{55}$/.test(address);
}

export function isCAddress(address: string): boolean {
  return address.startsWith("C") && address.length === 56;
}

export function isGAddress(address: string): boolean {
  return address.startsWith("G") && address.length === 56;
}

export interface PaymentResult {
  hash: string;
  successful: boolean;
}

export interface AccountBalances {
  total: string;
  balances: { asset: string; amount: string }[];
}

export interface BridgeTransactionData {
  id: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
  asset: string;
  status: "pending" | "confirmed" | "failed";
  timestamp: number;
  type: "g-to-c" | "fiat" | "cex";
  hash?: string;
  memo?: string;
}

interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
}

interface HorizonPayment {
  id: string;
  from?: string;
  to?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  transaction_successful?: boolean;
  created_at?: string;
  transaction_hash?: string;
}

export async function getAccountBalances(
  address: string,
  network: StellarNetwork
): Promise<AccountBalances> {
  const server = await getHorizonServer(network);
  try {
    const account = await server.loadAccount(address);
    const balances = (account.balances as HorizonBalance[]).map((b) => ({
      asset: b.asset_type === "native" ? "XLM" : (b.asset_code || "unknown"),
      amount: b.balance,
    }));
    const total = balances.find((b) => b.asset === "XLM")?.amount || "0";
    return { total, balances };
  } catch {
    return { total: "0", balances: [] };
  }
}

export async function fetchRecentTransactions(
  address: string,
  network: StellarNetwork,
  limit: number = 10
): Promise<BridgeTransactionData[]> {
  const server = await getHorizonServer(network);
  try {
    const payments = await server
      .payments()
      .forAccount(address)
      .limit(limit)
      .order("desc")
      .call();

    return (payments.records as HorizonPayment[]).map((p) => ({
      id: p.id,
      fromAddress: p.from || "",
      toAddress: p.to || "",
      amount: p.amount || "0",
      asset: p.asset_type === "native" ? "XLM" : (p.asset_code || "XLM"),
      status: p.transaction_successful ? "confirmed" as const : "failed" as const,
      timestamp: new Date(p.created_at || Date.now()).getTime(),
      type: "g-to-c" as const,
      hash: p.transaction_hash,
    }));
  } catch {
    return [];
  }
}

/**
 * Internal helper that handles the shared transaction-building flow used by
 * both buildAndSubmitPayment and bridgeViaContract:
 *   1. Retries on sequence-number conflicts via withSequenceRetry
 *   2. Constructs the Account and TransactionBuilder
 *   3. Signs the XDR via Freighter
 *   4. Rebuilds the signed transaction and submits it
 *
 * Callers supply the resolved `destination` and `asset` up-front so that the
 * two public functions keep their own destination/asset-resolution logic.
 *
 * @param sourceAddress - The G-address that will sign and pay fees
 * @param destination   - The resolved destination address for the payment
 * @param asset         - The resolved Stellar Asset to send
 * @param amount        - Amount as a decimal string (e.g. "10.5")
 * @param network       - "PUBLIC" or "TESTNET"
 * @param server        - An already-initialised Horizon.Server instance
 * @param passphrase    - The network passphrase for signing/rebuilding
 */
async function buildSignAndSubmit(
  sourceAddress: string,
  destination: string,
  asset: Asset,
  amount: string,
  network: StellarNetwork,
  server: Horizon.Server,
  passphrase: string
): Promise<PaymentResult> {
  const { TransactionBuilder, Operation, BASE_FEE } = await import("@stellar/stellar-sdk");

  return withSequenceRetry(
    sourceAddress,
    async (getSequence) => {
      const sequence = await getSequence();
      const account = new Account(sourceAddress, (sequence - 1n).toString());

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: passphrase,
      })
        .addOperation(
          Operation.payment({
            destination,
            asset,
            amount,
          })
        )
        .setTimeout(30)
        .build();

      const signedResult = await signTransaction(tx.toXDR(), {
        networkPassphrase: passphrase,
      });

      if ("error" in signedResult && signedResult.error) {
        throw new Error(`Signing failed: ${signedResult.error}`);
      }

      const signedXDR = (signedResult as { signedTxXdr: string }).signedTxXdr;
      const signedTx = TransactionBuilder.fromXDR(signedXDR, passphrase);

      const submitResult = await server.submitTransaction(signedTx);
      return {
        hash: submitResult.hash,
        successful: submitResult.successful,
      };
    },
    server
  );
}

export async function buildAndSubmitPayment(
  sourceAddress: string,
  destinationAddress: string,
  amount: string,
  assetCode: string,
  network: StellarNetwork
): Promise<PaymentResult> {
  const server = await getHorizonServer(network);
  const passphrase = await getNetworkPassphrase(network);
  const { Asset } = await import("@stellar/stellar-sdk");

  // Resolve the asset, validating any non-native trustline against the account
  const horizonAccount = await server.loadAccount(sourceAddress);
  let asset: Asset;

  if (assetCode === "XLM") {
    asset = Asset.native();
  } else {
    const balances = horizonAccount.balances as HorizonBalance[];
    const matchingBalance = balances.find((b) => b.asset_code === assetCode);
    if (!matchingBalance) {
      throw new Error(`No ${assetCode} trustline found for this account`);
    }
    asset = new Asset(assetCode, matchingBalance.asset_issuer);
  }

  return buildSignAndSubmit(
    sourceAddress,
    destinationAddress,
    asset,
    amount,
    network,
    server,
    passphrase
  );
}

export async function bridgeViaContract(
  sourceAddress: string,
  cAddress: string,
  amount: string,
  assetCode: string,
  network: StellarNetwork
): Promise<PaymentResult> {
  if (!BRIDGE_CONTRACT_ID) {
    return buildAndSubmitPayment(sourceAddress, cAddress, amount, assetCode, network);
  }

  const server = await getHorizonServer(network);
  const passphrase = await getNetworkPassphrase(network);
  const { Asset } = await import("@stellar/stellar-sdk");

  // The contract always receives native XLM; cAddress is handled by the contract
  const asset = Asset.native();

  try {
    return await buildSignAndSubmit(
      sourceAddress,
      BRIDGE_CONTRACT_ID,
      asset,
      amount,
      network,
      server,
      passphrase
    );
  } catch (e: unknown) {
    const err = e as { response?: { data?: { extras?: { result_codes?: unknown } } } };
    if (err.response?.data?.extras?.result_codes) {
      throw new Error(
        `Transaction failed: ${JSON.stringify(err.response.data.extras.result_codes)}`
      );
    }
    throw e;
  }
}

export function getExplorerUrl(
  network: StellarNetwork,
  type: "tx" | "account" | "contract",
  id: string
): string {
  const base = network === "PUBLIC"
    ? "https://stellar.expert/explorer/public"
    : "https://stellar.expert/explorer/testnet";
  return `${base}/${type}/${id}`;
}

export function getAccountMinimumBalance(): string {
  return "1.0";
}
