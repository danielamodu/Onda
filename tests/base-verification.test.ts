import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, type Address, type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { usdcTransferAbi } from "@/lib/payments/base/abi";
import { fundingAuthorizationMessage } from "@/lib/payments/base/authorization";
import { BaseVerificationError, verifyBaseTransfer } from "@/lib/payments/base/verify";

const token = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
const destination = "0x1111111111111111111111111111111111111111" as Address;
const signingAccount = privateKeyToAccount(`0x${"11".repeat(32)}` as Hex);
const sender = signingAccount.address;
const hash = `0x${"ab".repeat(32)}` as Hash;
const blockHash = `0x${"cd".repeat(32)}` as Hash;
const amount = BigInt(500_000_000);

function evidence(overrides: { chainId?: number; tokenAddress?: Address; amount?: bigint; status?: "success" | "reverted" } = {}) {
  const transactionAmount = overrides.amount ?? amount;
  const transactionToken = overrides.tokenAddress ?? token;
  const encoded = encodeFunctionData({ abi: usdcTransferAbi, functionName: "transfer", args: [destination, transactionAmount] });
  const topics = encodeEventTopics({ abi: usdcTransferAbi, eventName: "Transfer", args: { from: sender, to: destination } });
  const data = encodeAbiParameters([{ type: "uint256" }], [transactionAmount]);
  return {
    transaction: { chainId: overrides.chainId ?? 84532, to: transactionToken, from: sender, input: encoded, hash },
    receipt: {
      transactionHash: hash,
      status: overrides.status ?? "success",
      logs: [{ address: token, data, topics, blockNumber: BigInt(1), blockHash, transactionHash: hash, transactionIndex: 0, logIndex: 0, removed: false }],
      blockNumber: BigInt(1),
      blockHash,
    },
  } as unknown as Pick<Parameters<typeof verifyBaseTransfer>[0], "transaction" | "receipt">;
}

async function input(overrides: Parameters<typeof evidence>[0] = {}) {
  const fixture = evidence(overrides);
  const paymentId = "payment-1";
  const expectedAmount = "500.00";
  const authorizationSignature = await signingAccount.signMessage({
    message: fundingAuthorizationMessage({ paymentId, amount: expectedAmount, chainId: 84532, tokenAddress: token, destinationAddress: destination, senderAddress: sender }),
  });
  return {
    ...fixture,
    paymentId,
    authorizationSignature,
    chainId: 84532,
    tokenAddress: token,
    destinationAddress: destination,
    expectedAmount,
  } as unknown as Parameters<typeof verifyBaseTransfer>[0];
}

async function verify(overrides: Parameters<typeof evidence>[0] = {}) {
  return verifyBaseTransfer(await input(overrides));
}

describe("Base USDC transfer verification", () => {
  it("rejects malformed transaction calldata", async () => {
    const fixture = await input();
    await expect(verifyBaseTransfer({ ...fixture, transaction: { ...fixture.transaction, input: "0xdeadbeef" as Hex } })).rejects.toBeInstanceOf(BaseVerificationError);
  });

  it("rejects a transaction from the wrong chain", async () => {
    await expect(verify({ chainId: 1 })).rejects.toThrow("wrong network");
  });

  it("rejects a transaction that calls a different token", async () => {
    const wrongToken = "0x3333333333333333333333333333333333333333" as Address;
    await expect(verify({ tokenAddress: wrongToken })).rejects.toThrow("USDC contract");
  });

  it("rejects an incorrect amount", async () => {
    await expect(verify({ amount: BigInt(499_000_000) })).rejects.toThrow("amount does not match");
  });

  it("rejects a reverted transaction", async () => {
    await expect(verify({ status: "reverted" })).rejects.toThrow("did not succeed");
  });

  it("rejects an authorization signed by a different wallet", async () => {
    const fixture = await input();
    const otherAccount = privateKeyToAccount(`0x${"22".repeat(32)}` as Hex);
    const signature = await otherAccount.signMessage({ message: fixture.authorizationSignature });
    await expect(verifyBaseTransfer({ ...fixture, authorizationSignature: signature })).rejects.toThrow("did not authorize");
  });

  it("accepts the exact successful and wallet-authorized USDC transfer", async () => {
    await expect(verify()).resolves.toMatchObject({
      chainId: 84532,
      transactionHash: hash,
      tokenAddress: token,
      senderAddress: sender,
      destinationAddress: destination,
      blockNumber: BigInt(1),
      blockHash,
    });
  });
});
