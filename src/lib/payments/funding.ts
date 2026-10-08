import { Prisma } from "@prisma/client";
import type { Hash, Hex } from "viem";
import { db } from "@/lib/db";
import { transitionPayment } from "@/lib/payments/domain";
import type { getBaseFundingConfig } from "@/lib/payments/base/config";
import { BaseVerificationError, verifyBaseTransaction, type VerifiedBaseTransfer } from "@/lib/payments/base/verify";

export class FundingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FundingConflictError";
  }
}

export type FundingResult =
  | { state: "pending"; transactionHash: string }
  | { state: "funded"; transactionHash: string }
  | { state: "failed"; transactionHash: string; reason: string };

type FundingDependencies = {
  config: ReturnType<typeof getBaseFundingConfig>;
  verify?: typeof verifyBaseTransaction;
};

function toFailureMessage(error: BaseVerificationError) {
  return error.message.slice(0, 240);
}

export async function fundPayment(
  businessId: string,
  paymentId: string,
  transactionHash: Hash,
  authorizationSignature: Hex,
  dependencies: FundingDependencies,
): Promise<FundingResult> {
  const normalizedHash = transactionHash.toLowerCase();
  let payment = await db.payment.findFirst({ where: { id: paymentId, businessId } });
  if (!payment) throw new FundingConflictError("Payment not found.");
  if (payment.status === "funded" && payment.transactionHash === normalizedHash) {
    return { state: "funded", transactionHash: normalizedHash };
  }
  if (payment.status === "failed" && payment.transactionHash === normalizedHash) {
    return { state: "failed", transactionHash: normalizedHash, reason: payment.fundingError ?? "This funding attempt failed verification." };
  }

  if (payment.status === "created" && payment.transactionHash === null) {
    try {
      const claimed = await db.payment.updateMany({
        where: { id: paymentId, businessId, status: "created", transactionHash: null },
        data: { status: transitionPayment("created", "funding"), transactionHash: normalizedHash, fundingAuthorizationSignature: authorizationSignature, fundingError: null },
      });
      if (claimed.count > 0) {
        payment = { ...payment, status: "funding", transactionHash: normalizedHash, fundingAuthorizationSignature: authorizationSignature };
      } else {
        payment = await db.payment.findFirst({ where: { id: paymentId, businessId } });
        if (!payment) throw new FundingConflictError("Payment not found.");
      }
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new FundingConflictError("This transaction has already been used for a payment.");
      }
      throw error;
    }
  }

  if (!payment) throw new FundingConflictError("Payment not found.");
  if (payment.status !== "funding" || payment.transactionHash !== normalizedHash) {
    throw new FundingConflictError("This payment already has a different or completed funding attempt.");
  }
  if (!payment.fundingAuthorizationSignature) {
    throw new FundingConflictError("This funding attempt is missing its wallet authorization.");
  }

  let verification;
  try {
    verification = await (dependencies.verify ?? verifyBaseTransaction)(
      normalizedHash as Hash,
      payment.amount.toFixed(2),
      payment.id,
      payment.fundingAuthorizationSignature as Hex,
      dependencies.config,
    );
  } catch (error) {
    if (!(error instanceof BaseVerificationError)) throw error;
    await db.payment.updateMany({
      where: { id: paymentId, businessId, status: "funding", transactionHash: normalizedHash },
      data: { status: transitionPayment("funding", "failed"), fundingError: toFailureMessage(error) },
    });
    return { state: "failed", transactionHash: normalizedHash, reason: toFailureMessage(error) };
  }

  if (verification.state === "pending") return { state: "pending", transactionHash: normalizedHash };

  await persistFundingSuccess(businessId, paymentId, normalizedHash, verification.transfer);
  return { state: "funded", transactionHash: normalizedHash };
}

async function persistFundingSuccess(
  businessId: string,
  paymentId: string,
  transactionHash: string,
  transfer: VerifiedBaseTransfer,
) {
  const result = await db.payment.updateMany({
    where: { id: paymentId, businessId, status: "funding", transactionHash },
    data: {
      status: transitionPayment("funding", "funded"),
      chainId: transfer.chainId,
      tokenAddress: transfer.tokenAddress,
      senderAddress: transfer.senderAddress,
      destinationAddress: transfer.destinationAddress,
      blockNumber: transfer.blockNumber,
      blockHash: transfer.blockHash,
      confirmedAt: new Date(),
      fundingError: null,
    },
  });
  if (result.count === 0) {
    const current = await db.payment.findFirst({ where: { id: paymentId, businessId } });
    if (current?.status === "funded" && current.transactionHash === transactionHash) return;
    throw new FundingConflictError("Payment funding status changed before confirmation could be saved.");
  }
}
