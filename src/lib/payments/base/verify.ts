import {
  decodeEventLog,
  decodeFunctionData,
  parseUnits,
  verifyMessage,
  type Address,
  type Hash,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";
import { createPublicClient, http } from "viem";
import type { getBaseFundingConfig } from "@/lib/payments/base/config";
import { usdcTransferAbi } from "@/lib/payments/base/abi";
import { fundingAuthorizationMessage } from "@/lib/payments/base/authorization";

type FundingConfig = ReturnType<typeof getBaseFundingConfig>;
type VerifiableTransaction = { chainId: number | null; to: Address | null; from: Address; input: Hex; hash: Hash };
type VerifiableReceipt = Pick<TransactionReceipt, "transactionHash" | "status" | "blockNumber" | "blockHash"> & { logs: readonly Log[] };

export type VerifiedBaseTransfer = {
  chainId: number;
  transactionHash: Hash;
  tokenAddress: Address;
  senderAddress: Address;
  destinationAddress: Address;
  blockNumber: bigint;
  blockHash: Hash;
};

export class BaseVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaseVerificationError";
  }
}

export async function verifyBaseTransfer(input: {
  transaction: VerifiableTransaction;
  receipt: VerifiableReceipt;
  paymentId: string;
  authorizationSignature: Hex;
  chainId: number;
  tokenAddress: Address;
  destinationAddress: Address;
  expectedAmount: string;
}): Promise<VerifiedBaseTransfer> {
  const { transaction, receipt, paymentId, authorizationSignature, chainId, tokenAddress, destinationAddress, expectedAmount } = input;
  if (receipt.transactionHash.toLowerCase() !== transaction.hash.toLowerCase()) {
    throw new BaseVerificationError("The receipt does not belong to the submitted transaction.");
  }
  if (transaction.chainId !== chainId) throw new BaseVerificationError("The transaction is on the wrong network.");
  if (receipt.status !== "success") throw new BaseVerificationError("The USDC transfer did not succeed.");
  if (!transaction.to || transaction.to.toLowerCase() !== tokenAddress.toLowerCase()) {
    throw new BaseVerificationError("The transaction did not call the configured USDC contract.");
  }

  let transferTo: Address;
  let transferAmount: bigint;
  try {
    const decoded = decodeFunctionData({ abi: usdcTransferAbi, data: transaction.input as Hex });
    if (decoded.functionName !== "transfer") throw new Error("Unexpected USDC method.");
    [transferTo, transferAmount] = decoded.args;
  } catch {
    throw new BaseVerificationError("The transaction is not a valid USDC transfer.");
  }

  const expectedUnits = parseUnits(expectedAmount, 6);
  if (transferTo.toLowerCase() !== destinationAddress.toLowerCase()) {
    throw new BaseVerificationError("The USDC transfer went to the wrong destination.");
  }
  if (transferAmount !== expectedUnits) throw new BaseVerificationError("The USDC transfer amount does not match this payment.");

  const authorizationMessage = fundingAuthorizationMessage({
    paymentId,
    amount: expectedAmount,
    chainId,
    tokenAddress,
    destinationAddress,
    senderAddress: transaction.from,
  });
  let authorized: boolean;
  try {
    authorized = await verifyMessage({ address: transaction.from, message: authorizationMessage, signature: authorizationSignature });
  } catch {
    authorized = false;
  }
  if (!authorized) throw new BaseVerificationError("The transaction sender did not authorize this payment.");

  const matchingLogs: Array<{ from: Address; to: Address; value: bigint }> = [];
  for (const log of receipt.logs as readonly Log[]) {
    if (log.address.toLowerCase() !== tokenAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: usdcTransferAbi, eventName: "Transfer", data: log.data, topics: log.topics });
      matchingLogs.push(decoded.args);
    } catch {
      // Ignore other events emitted by the token contract.
    }
  }
  const expectedTransfer = matchingLogs.filter((log) =>
    log.from.toLowerCase() === transaction.from.toLowerCase()
      && log.to.toLowerCase() === destinationAddress.toLowerCase()
      && log.value === expectedUnits,
  );
  if (expectedTransfer.length !== 1) throw new BaseVerificationError("The confirmed USDC transfer event does not match this payment.");

  return {
    chainId,
    transactionHash: transaction.hash,
    tokenAddress,
    senderAddress: transaction.from,
    destinationAddress,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
  };
}

export type BaseVerificationResult = { state: "pending" } | { state: "verified"; transfer: VerifiedBaseTransfer };

export async function verifyBaseTransaction(
  transactionHash: Hash,
  expectedAmount: string,
  paymentId: string,
  authorizationSignature: Hex,
  config: FundingConfig,
): Promise<BaseVerificationResult> {
  const client = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) });
  const rpcChainId = await client.getChainId();
  if (rpcChainId !== config.chainId) throw new Error("BASE_RPC_URL returned a different chain ID than BASE_CHAIN_ID.");
  let receipt: TransactionReceipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: transactionHash });
  } catch (error) {
    if (error instanceof Error && /not found|could not be found/i.test(error.message)) return { state: "pending" };
    throw error;
  }
  let transaction: VerifiableTransaction;
  try {
    const fetched = await client.getTransaction({ hash: transactionHash });
    transaction = {
      chainId: "chainId" in fetched ? fetched.chainId ?? null : null,
      to: fetched.to,
      from: fetched.from,
      input: fetched.input,
      hash: fetched.hash,
    };
  } catch (error) {
    if (error instanceof Error && /not found|could not be found/i.test(error.message)) return { state: "pending" };
    throw error;
  }

  const transfer = await verifyBaseTransfer({
    transaction,
    receipt,
    paymentId,
    authorizationSignature,
    chainId: config.chainId,
    tokenAddress: config.tokenAddress,
    destinationAddress: config.destinationAddress,
    expectedAmount,
  });
  const head = await client.getBlockNumber();
  const confirmations = head - receipt.blockNumber + BigInt(1);
  return confirmations >= BigInt(config.confirmations) ? { state: "verified", transfer } : { state: "pending" };
}
