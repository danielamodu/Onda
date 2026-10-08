import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { getBaseFundingConfig } from "@/lib/payments/base/config";
import { BaseVerificationError, type VerifiedBaseTransfer } from "@/lib/payments/base/verify";

const mockedDb = vi.hoisted(() => ({ payment: { findFirst: vi.fn(), updateMany: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: mockedDb }));

import { fundPayment, FundingConflictError } from "@/lib/payments/funding";

const hash = `0x${"ab".repeat(32)}` as const;
const signature = `0x${"ef".repeat(65)}` as `0x${string}`;
const chainConfig = {
  chainId: 84532,
  chainName: "Base Sepolia",
  chain: { id: 84532 },
  tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  destinationAddress: "0x1111111111111111111111111111111111111111",
  rpcUrl: "https://sepolia.base.org",
  confirmations: 2,
} as unknown as ReturnType<typeof getBaseFundingConfig>;
const successfulTransfer: VerifiedBaseTransfer = {
  chainId: 84532,
  transactionHash: hash,
  tokenAddress: chainConfig.tokenAddress,
  senderAddress: "0x2222222222222222222222222222222222222222",
  destinationAddress: chainConfig.destinationAddress,
  blockNumber: BigInt(12),
  blockHash: `0x${"cd".repeat(32)}`,
};

function payment(overrides: Record<string, unknown> = {}) {
  return { id: "payment-1", businessId: "business-1", amount: { toFixed: () => "500.00" }, status: "created", transactionHash: null, fundingAuthorizationSignature: null, fundingError: null, ...overrides };
}

describe("Base payment funding persistence", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not fund an already-funded payment again", async () => {
    mockedDb.payment.findFirst.mockResolvedValue(payment({ status: "funded", transactionHash: hash }));
    const verify = vi.fn();
    await expect(fundPayment("business-1", "payment-1", hash, signature, { config: chainConfig, verify })).resolves.toEqual({ state: "funded", transactionHash: hash });
    expect(verify).not.toHaveBeenCalled();
    expect(mockedDb.payment.updateMany).not.toHaveBeenCalled();
  });

  it("rejects reuse of the hash unique to another payment", async () => {
    mockedDb.payment.findFirst.mockResolvedValue(payment());
    mockedDb.payment.updateMany.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("Unique constraint", { code: "P2002", clientVersion: "6.19.3" }));
    await expect(fundPayment("business-1", "payment-1", hash, signature, { config: chainConfig, verify: vi.fn() })).rejects.toBeInstanceOf(FundingConflictError);
  });

  it("persists the transaction hash before verification and stores verified Base data", async () => {
    mockedDb.payment.findFirst.mockResolvedValue(payment());
    mockedDb.payment.updateMany.mockResolvedValue({ count: 1 });
    const verify = vi.fn().mockResolvedValue({ state: "verified", transfer: successfulTransfer });
    await expect(fundPayment("business-1", "payment-1", hash, signature, { config: chainConfig, verify })).resolves.toEqual({ state: "funded", transactionHash: hash });
    expect(mockedDb.payment.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { id: "payment-1", businessId: "business-1", status: "created", transactionHash: null },
      data: expect.objectContaining({ status: "funding", transactionHash: hash, fundingAuthorizationSignature: signature }),
    }));
    expect(mockedDb.payment.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { id: "payment-1", businessId: "business-1", status: "funding", transactionHash: hash },
      data: expect.objectContaining({ status: "funded", chainId: 84532, tokenAddress: chainConfig.tokenAddress, blockNumber: BigInt(12), blockHash: successfulTransfer.blockHash }),
    }));
  });

  it("moves a pending funding attempt to failed when independent verification rejects it", async () => {
    mockedDb.payment.findFirst.mockResolvedValue(payment());
    mockedDb.payment.updateMany.mockResolvedValue({ count: 1 });
    const verify = vi.fn().mockRejectedValue(new BaseVerificationError("The USDC transfer amount does not match this payment."));
    await expect(fundPayment("business-1", "payment-1", hash, signature, { config: chainConfig, verify })).resolves.toMatchObject({ state: "failed", transactionHash: hash });
    expect(mockedDb.payment.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ data: expect.objectContaining({ status: "failed", fundingError: expect.stringContaining("amount") }) }));
  });
});
