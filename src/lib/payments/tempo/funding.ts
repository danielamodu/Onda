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
import { tip20Abi } from "@/lib/payments/tempo/abi";
import type { TempoFundingConfig } from "@/lib/payments/tempo/config";
import { TEMPO_CANONICAL_ASSET } from "@/lib/payments/tempo/config";

export function fundingAuthorizationMessage(input: {
  paymentId: string;
  amount: string;
  chainId: number;
  tokenAddress: Address;
  treasuryAddress: Address;
  senderAddress: Address;
}) {
  return [
    `Authorize Onda ${TEMPO_CANONICAL_ASSET} payment`,
    `Payment: ${input.paymentId}`,
    `Amount: ${input.amount} ${TEMPO_CANONICAL_ASSET}`,
    `Network: Tempo (${input.chainId})`,
    `Token: ${input.tokenAddress.toLowerCase()}`,
    `Treasury: ${input.treasuryAddress.toLowerCase()}`,
    `Sender: ${input.senderAddress.toLowerCase()}`,
  ].join("\n");
}

type VerifiableTransaction = { chainId: number | null; to: Address | null; from: Address; input: Hex; hash: Hash };
type VerifiableReceipt = Pick<TransactionReceipt, "transactionHash" | "status" | "blockNumber" | "blockHash"> & { logs: readonly Log[] };

export type VerifiedTempoFunding = {
  chainId: number;
  transactionHash: Hash;
  tokenAddress: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  senderAddress: Address;
  treasuryAddress: Address;
  blockNumber: bigint;
  blockHash: Hash;
};

export class TempoFundingVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TempoFundingVerificationError";
  }
}

export async function verifyTempoFundingTransfer(input: {
  transaction: VerifiableTransaction;
  receipt: VerifiableReceipt;
  paymentId: string;
  authorizationSignature: Hex;
  chainId: number;
  tokenAddress: Address;
  tokenSymbol: string;
  treasuryAddress: Address;
  expectedAmount: string;
  tokenDecimals: number;
}): Promise<VerifiedTempoFunding> {
  const { transaction, receipt, paymentId, authorizationSignature, chainId, tokenAddress, tokenSymbol, treasuryAddress, expectedAmount, tokenDecimals } = input;
  if (receipt.transactionHash.toLowerCase() !== transaction.hash.toLowerCase()) {
    throw new TempoFundingVerificationError("The receipt does not belong to the submitted transaction.");
  }
  if (transaction.chainId !== chainId) throw new TempoFundingVerificationError("The transaction is on the wrong network.");
  if (receipt.status !== "success") throw new TempoFundingVerificationError(`The ${tokenSymbol} funding transfer did not succeed.`);
  if (!transaction.to || transaction.to.toLowerCase() !== tokenAddress.toLowerCase()) {
    throw new TempoFundingVerificationError(`The transaction did not call the configured ${tokenSymbol} contract.`);
  }

  let transferTo: Address;
  let transferAmount: bigint;
  try {
    const decoded = decodeFunctionData({ abi: tip20Abi, data: transaction.input as Hex });
    if (decoded.functionName !== "transfer" && decoded.functionName !== "transferWithMemo") {
      throw new Error(`Unexpected ${tokenSymbol} method.`);
    }
    [transferTo, transferAmount] = decoded.args;
  } catch {
    throw new TempoFundingVerificationError(`The transaction is not a valid ${tokenSymbol} transfer.`);
  }

  let expectedUnits: bigint;
  try {
    expectedUnits = parseUnits(expectedAmount, tokenDecimals);
  } catch {
    throw new TempoFundingVerificationError("The expected funding amount is invalid.");
  }
  if (transferTo.toLowerCase() !== treasuryAddress.toLowerCase()) {
    throw new TempoFundingVerificationError(`The ${tokenSymbol} funding transfer went to the wrong destination.`);
  }
  if (transferAmount !== expectedUnits) throw new TempoFundingVerificationError("The funding transfer amount does not match this payment.");

  const authorizationMessage = fundingAuthorizationMessage({
    paymentId,
    amount: expectedAmount,
    chainId,
    tokenAddress,
    treasuryAddress,
    senderAddress: transaction.from,
  });
  let authorized: boolean;
  try {
    authorized = await verifyMessage({ address: transaction.from, message: authorizationMessage, signature: authorizationSignature });
  } catch {
    authorized = false;
  }
  if (!authorized) throw new TempoFundingVerificationError("The transaction sender did not authorize this payment.");

  const matchingLogs: Array<{ from: Address; to: Address; value: bigint }> = [];
  for (const log of receipt.logs as readonly Log[]) {
    if (log.address.toLowerCase() !== tokenAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: tip20Abi, eventName: "Transfer", data: log.data, topics: log.topics });
      matchingLogs.push(decoded.args);
    } catch {
      // Ignore other events emitted by the token contract.
    }
  }
  const expectedTransfer = matchingLogs.filter((log) =>
    log.from.toLowerCase() === transaction.from.toLowerCase()
      && log.to.toLowerCase() === treasuryAddress.toLowerCase()
      && log.value === expectedUnits,
  );
  if (expectedTransfer.length !== 1) throw new TempoFundingVerificationError(`The confirmed ${tokenSymbol} funding event does not match this payment.`);

  return {
    chainId,
    transactionHash: transaction.hash,
    tokenAddress,
    tokenSymbol,
    tokenDecimals,
    senderAddress: transaction.from,
    treasuryAddress,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
  };
}

export type TempoFundingVerificationResult = { state: "pending" } | { state: "verified"; funding: VerifiedTempoFunding };

export async function verifyTempoFundingTransaction(
  transactionHash: Hash,
  expectedAmount: string,
  paymentId: string,
  authorizationSignature: Hex,
  config: TempoFundingConfig,
): Promise<TempoFundingVerificationResult> {
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const rpcChainId = await client.getChainId();
  if (rpcChainId !== config.chainId) throw new Error("TEMPO_RPC_URL returned a different chain ID than TEMPO_CHAIN_ID.");
  const [decimals, symbol] = await Promise.all([
    client.readContract({ address: config.tokenAddress, abi: tip20Abi, functionName: "decimals" }),
    client.readContract({ address: config.tokenAddress, abi: tip20Abi, functionName: "symbol" }),
  ]);
  if (!Number.isInteger(decimals) || decimals < 2 || decimals > 36) {
    throw new TempoFundingVerificationError("The configured settlement token returned invalid metadata.");
  }
  if (symbol !== config.tokenSymbol) {
    throw new TempoFundingVerificationError("The configured settlement token does not match the expected payment asset.");
  }
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

  const funding = await verifyTempoFundingTransfer({
    transaction,
    receipt,
    paymentId,
    authorizationSignature,
    chainId: config.chainId,
    tokenAddress: config.tokenAddress,
    tokenSymbol: config.tokenSymbol,
    treasuryAddress: config.treasuryAddress,
    expectedAmount,
    tokenDecimals: decimals,
  });
  return { state: "verified", funding };
}
