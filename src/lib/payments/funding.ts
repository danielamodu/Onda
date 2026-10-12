import { Prisma } from "@prisma/client";
import type { Hash, Hex } from "viem";
import { db } from "@/lib/db";
import { transitionPayment } from "@/lib/payments/domain";
import type { TempoFundingConfig } from "@/lib/payments/tempo/config";
import { TempoFundingVerificationError, verifyTempoFundingTransaction, type VerifiedTempoFunding } from "@/lib/payments/tempo/funding";
import {
  baseUnitsFromDecimalString,
  creditVerifiedTempoDeposit,
  fundingCreditKey,
  getOrCreateTreasuryAccount,
  withGuardedTreasurySection,
  LedgerError,
} from "@/lib/payments/treasury/ledger";

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
  config: TempoFundingConfig;
  verify?: typeof verifyTempoFundingTransaction;
};

function toFailureMessage(error: TempoFundingVerificationError) {
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
    verification = await (dependencies.verify ?? verifyTempoFundingTransaction)(
      normalizedHash as Hash,
      payment.amount.toFixed(2),
      payment.id,
      payment.fundingAuthorizationSignature as Hex,
      dependencies.config,
    );
  } catch (error) {
    if (!(error instanceof TempoFundingVerificationError)) throw error;
    await db.payment.updateMany({
      where: { id: paymentId, businessId, status: "funding", transactionHash: normalizedHash },
      data: { status: transitionPayment("funding", "failed"), fundingError: toFailureMessage(error) },
    });
    return { state: "failed", transactionHash: normalizedHash, reason: toFailureMessage(error) };
  }

  if (verification.state === "pending") return { state: "pending", transactionHash: normalizedHash };

  let amountUnits: bigint;
  try {
    amountUnits = baseUnitsFromDecimalString(payment.amount.toFixed(2), verification.funding.tokenDecimals);
  } catch (error) {
    const reason = error instanceof LedgerError ? error.message : "The funding amount cannot be represented in token base units.";
    await db.payment.updateMany({
      where: { id: paymentId, businessId, status: "funding", transactionHash: normalizedHash },
      data: { status: transitionPayment("funding", "failed"), fundingError: reason.slice(0, 240) },
    });
    return { state: "failed", transactionHash: normalizedHash, reason: reason.slice(0, 240) };
  }

  await persistFundingSuccess(businessId, paymentId, normalizedHash, verification.funding, amountUnits);
  return { state: "funded", transactionHash: normalizedHash };
}

async function persistFundingSuccess(
  businessId: string,
  paymentId: string,
  transactionHash: string,
  funding: VerifiedTempoFunding,
  amountUnits: bigint,
) {
  const account = await getOrCreateTreasuryAccount(db, {
    chainId: funding.chainId,
    tokenAddress: funding.tokenAddress,
    tokenSymbol: funding.tokenSymbol,
    tokenDecimals: funding.tokenDecimals,
    treasuryAddress: funding.treasuryAddress,
  });
  try {
    await withGuardedTreasurySection(db, account.id, async (tx) => {
      const result = await tx.payment.updateMany({
        where: { id: paymentId, businessId, status: "funding", transactionHash },
        data: {
          status: transitionPayment("funding", "funded"),
          chainId: funding.chainId,
          tokenAddress: funding.tokenAddress,
          senderAddress: funding.senderAddress,
          destinationAddress: funding.treasuryAddress,
          blockNumber: funding.blockNumber,
          blockHash: funding.blockHash,
          confirmedAt: new Date(),
          fundingError: null,
        },
      });
      if (result.count === 0) {
        const current = await tx.payment.findFirst({ where: { id: paymentId, businessId } });
        if (current?.status === "funded" && current.transactionHash === transactionHash) return { replay: true as const };
        throw new FundingConflictError("Payment funding status changed before confirmation could be saved.");
      }
      await creditVerifiedTempoDeposit(tx, {
        treasuryAccountId: account.id,
        paymentId,
        chainId: funding.chainId,
        tokenAddress: funding.tokenAddress,
        amountUnits,
        transactionHash,
      });
      return { replay: false as const };
    });
  } catch (error) {
    // A concurrent duplicate credit won the race after our pre-check. The
    // credit key is unique per funding transaction, so confirm the row with
    // a fresh read (the guarded transaction already rolled back) and proceed.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await db.treasuryLedgerEntry.findFirst({
        where: { idempotencyKey: fundingCreditKey(funding.chainId, transactionHash) },
        select: { id: true },
      });
      if (existing) return;
    }
    throw error;
  }
}
