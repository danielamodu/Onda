import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { transitionPayment } from "@/lib/payments/domain";
import { SettlementConfigurationError } from "@/lib/payments/settlement/providers";
import { settlementAttemptKey } from "@/lib/payments/tempo/memo";
import { TEMPO_MODERATO_CHAIN_ID, getTempoFundingConfig, getTempoSettlementConfig } from "@/lib/payments/tempo/config";
import {
  baseUnitsFromDecimalString,
  checkReserveFits,
  debitKey,
  debitSettlement,
  findActiveReservationForPayment,
  findDebitByKey,
  releaseReservation,
  reserveForSettlement,
  withGuardedTreasurySection,
  LedgerConflictError as LedgerConflict,
  LedgerError,
  LedgerInsufficientFundsError,
  ReservationExistsError,
} from "@/lib/payments/treasury/ledger";
import { verifyDestinationEvidence } from "@/lib/payments/settlement/verification";
import type {
  DestinationVerification,
  DestinationSettlementVerifier,
  SettlementAttemptSnapshot,
  SettlementCommand,
  SettlementExpectation,
  SettlementInitiation,
  SettlementProvider,
} from "@/lib/payments/settlement/types";

export class SettlementConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementConflictError";
  }
}

// An attempt that is still pending without any recorded submission well
// beyond RPC and finality timescales is treated as stuck: its submission, if
// any, can only be discovered by memo reconciliation, never by re-verifying
// a hash that does not exist. Must comfortably exceed block finality and
// indexer lag so a live concurrent submission is never mistaken for stuck.
export const STALE_UNSUBMITTED_MS = 10 * 60 * 1000;

export type PaymentLedgerTrailEntry = {
  id: string;
  type: string;
  amountUnits: string;
  reference: string | null;
  createdAt: Date;
  tokenDecimals: number;
  tokenSymbol: string;
};

export async function getPaymentLedgerTrail(businessId: string, paymentId: string): Promise<PaymentLedgerTrailEntry[]> {
  const payment = await db.payment.findFirst({ where: { id: paymentId, businessId }, select: { id: true } });
  if (!payment) throw new SettlementConflictError("Payment not found.");
  const entries = await db.treasuryLedgerEntry.findMany({
    where: { paymentId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      type: true,
      amountUnits: true,
      reference: true,
      createdAt: true,
      treasuryAccount: { select: { tokenDecimals: true, tokenSymbol: true } },
    },
  });
  return entries.map((entry) => ({
    id: entry.id,
    type: entry.type,
    amountUnits: entry.amountUnits.toString(),
    reference: entry.reference,
    createdAt: entry.createdAt,
    tokenDecimals: entry.treasuryAccount.tokenDecimals,
    tokenSymbol: entry.treasuryAccount.tokenSymbol,
  }));
}

export type SettlementResult =
  | { state: "settling"; attemptId: string; isSimulation: boolean }
  | { state: "settled"; attemptId: string; isSimulation: boolean }
  | { state: "failed"; attemptId: string; reason: string; retryable: boolean };

type SettlementDependencies = {
  provider: SettlementProvider;
  verifier: DestinationSettlementVerifier;
};

export type PaymentForSettlement = {
  id: string;
  businessId: string;
  status: string;
  asset: string;
  amount: { toFixed(digits?: number): string };
  chainId: number | null;
  tokenAddress: string | null;
  transactionHash: string | null;
  destinationAddress: string | null;
  recipient: { tempoAddress: string | null } | null;
};

export function snapshot(attempt: {
  id: string;
  paymentId: string;
  sourceChainId: number | null;
  destinationChainId: number | null;
  sourceAsset: string | null;
  sourceTokenAddress: string | null;
  destinationAsset: string | null;
  destinationTokenAddress: string | null;
  sourceAmount: { toString(): string } | null;
  destinationAmount: { toString(): string } | null;
  recipientAddress: string | null;
  sourceTransactionHash: string | null;
  destinationTransactionHash: string | null;
  bridgeMessageId: string | null;
}): SettlementAttemptSnapshot {
  return {
    ...attempt,
    sourceAmount: attempt.sourceAmount?.toString() ?? null,
    destinationAmount: attempt.destinationAmount?.toString() ?? null,
  };
}

function command(payment: PaymentForSettlement, attemptNumber: number): SettlementCommand {
  return {
    paymentId: payment.id,
    idempotencyKey: settlementAttemptKey(payment.id, attemptNumber),
    sourceChainId: payment.chainId,
    sourceAsset: payment.asset,
    sourceTokenAddress: payment.tokenAddress,
    sourceTransactionHash: payment.transactionHash,
    sourceAmount: payment.amount.toFixed(2),
    destinationAddress: payment.recipient?.tempoAddress ?? null,
  };
}

function requireRecipientTempoAddress(payment: PaymentForSettlement) {
  if (!payment.recipient?.tempoAddress) {
    throw new SettlementConflictError("This payment has no recipient Tempo address. Record the recipient's Tempo wallet address before settling.");
  }
}

function requireTempoBacking(payment: PaymentForSettlement) {
  let tokenAddress: string;
  try {
    tokenAddress = getTempoSettlementConfig().tokenAddress;
  } catch (error) {
    throw error instanceof SettlementConfigurationError
      ? error
      : new SettlementConfigurationError("Tempo settlement is not configured.");
  }
  if (payment.chainId !== TEMPO_MODERATO_CHAIN_ID || payment.tokenAddress?.toLowerCase() !== tokenAddress.toLowerCase()) {
    throw new SettlementConflictError("This payment was not funded with the configured Tempo settlement asset, so it cannot settle.");
  }
}

class ClaimLostRaceError extends Error {
  constructor() {
    super("Settlement claim lost to a concurrent request.");
    this.name = "ClaimLostRaceError";
  }
}

type TreasuryBacking = {
  accountId: string;
  tokenDecimals: number;
  amountUnits: bigint;
};

async function treasuryBackingFor(payment: PaymentForSettlement): Promise<TreasuryBacking> {
  let treasuryAddress: string;
  try {
    treasuryAddress = getTempoFundingConfig().treasuryAddress;
  } catch (error) {
    throw error instanceof SettlementConfigurationError
      ? error
      : new SettlementConfigurationError("Tempo treasury is not configured.");
  }
  if (payment.chainId == null || !payment.tokenAddress) {
    throw new SettlementConflictError("This payment has no verified Tempo funding to settle against.");
  }
  const account = await db.treasuryAccount.findUnique({
    where: {
      chainId_tokenAddress_treasuryAddress: {
        chainId: payment.chainId,
        tokenAddress: payment.tokenAddress,
        treasuryAddress,
      },
    },
  });
  if (!account) {
    throw new SettlementConfigurationError("Treasury ledger is not initialized for this asset. Fund the payment first.");
  }
  let amountUnits: bigint;
  try {
    amountUnits = baseUnitsFromDecimalString(payment.amount.toFixed(2), account.tokenDecimals);
  } catch (error) {
    throw new SettlementConflictError(
      error instanceof LedgerError ? error.message : "The settlement amount cannot be represented in token base units.",
    );
  }
  return { accountId: account.id, tokenDecimals: account.tokenDecimals, amountUnits };
}

function toConflictError(error: unknown): SettlementConflictError {
  if (error instanceof LedgerInsufficientFundsError) {
    return new SettlementConflictError("Treasury available balance cannot cover this settlement. Fund the treasury first.");
  }
  if (error instanceof LedgerConflict) {
    return new SettlementConflictError(error.message);
  }
  if (error instanceof SettlementConflictError) return error;
  throw error;
}

async function releaseActiveReservation(payment: PaymentForSettlement, reason: string): Promise<void> {
  let backing: TreasuryBacking;
  try {
    backing = await treasuryBackingFor(payment);
  } catch {
    return;
  }
  await withGuardedTreasurySection(db, backing.accountId, async (tx) => {
    const reservation = await findActiveReservationForPayment(tx, backing.accountId, payment.id);
    if (!reservation) return;
    await releaseReservation(tx, { treasuryAccountId: backing.accountId, reservationId: reservation.id, reason });
  });
}

async function debitVerifiedSettlement(
  payment: PaymentForSettlement,
  providerIdempotencyKey: string,
  attemptNumber: number,
  transactionHash: string,
): Promise<void> {
  const backing = await treasuryBackingFor(payment);
  try {
    await withGuardedTreasurySection(db, backing.accountId, async (tx) => {
      let reservation = await findActiveReservationForPayment(tx, backing.accountId, payment.id);
      if (!reservation) {
        const priorDebit = await findDebitByKey(tx, backing.accountId, providerIdempotencyKey);
        if (priorDebit) return;
        const repair = await reserveForSettlement(tx, {
          treasuryAccountId: backing.accountId,
          paymentId: payment.id,
          attemptNumber,
          amountUnits: backing.amountUnits,
          idempotencyKey: `reserve:${payment.id}:${attemptNumber}:repair:${randomUUID().slice(0, 8)}`,
        });
        reservation = { id: repair.reservationId, paymentId: payment.id, amountUnits: backing.amountUnits };
      }
      const debit = await debitSettlement(tx, {
        treasuryAccountId: backing.accountId,
        paymentId: payment.id,
        providerIdempotencyKey,
        reservationId: reservation.id,
        amountUnits: backing.amountUnits,
        transactionHash,
      });
      if (debit.duplicate) {
        await releaseReservation(tx, {
          treasuryAccountId: backing.accountId,
          reservationId: reservation.id,
          reason: "duplicate debit replay; releasing surplus hold",
        });
      }
    });
  } catch (error) {
    // A concurrent duplicate debit won the race after our pre-check. The
    // debit key is unique per attempt, so a P2002 here proves the debit row
    // exists — confirm it with a fresh read (the guarded transaction already
    // rolled back) and proceed to mark the payment settled.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await db.treasuryLedgerEntry.findFirst({
        where: { idempotencyKey: debitKey(providerIdempotencyKey) },
        select: { id: true },
      });
      if (existing) return;
    }
    throw error;
  }
}

export function expectation(attempt: SettlementAttemptSnapshot): SettlementExpectation | null {
  if (!attempt.destinationChainId || !attempt.destinationTokenAddress || !attempt.destinationAmount || !attempt.recipientAddress) return null;
  return {
    destinationChainId: attempt.destinationChainId,
    destinationTokenAddress: attempt.destinationTokenAddress,
    destinationAmount: attempt.destinationAmount,
    recipientAddress: attempt.recipientAddress,
    bridgeMessageId: attempt.bridgeMessageId,
  };
}

export async function settlePayment(
  businessId: string,
  paymentId: string,
  dependencies: SettlementDependencies,
): Promise<SettlementResult> {
  const { provider, verifier } = dependencies;
  if (provider.mode === "test" && process.env.NODE_ENV === "production") {
    throw new SettlementConfigurationError("The test settlement provider is disabled in production.");
  }
  provider.assertAvailable();

  let payment = await db.payment.findFirst({ where: { id: paymentId, businessId }, include: { recipient: { select: { tempoAddress: true } } } }) as PaymentForSettlement | null;
  if (!payment) throw new SettlementConflictError("Payment not found.");
  let latest = await db.paymentSettlement.findFirst({ where: { paymentId }, orderBy: { attemptNumber: "desc" } });

  if (payment.status === "settled") {
    if (!latest) throw new SettlementConflictError("Settled payment is missing its settlement audit record.");
    return { state: "settled", attemptId: latest.id, isSimulation: latest.isSimulation };
  }
  if (payment.status === "failed") {
    if (latest?.status === "failed") return { state: "failed", attemptId: latest.id, reason: latest.failureReason ?? "Settlement failed.", retryable: latest.retryable };
    throw new SettlementConflictError("A failed payment cannot be settled.");
  }

  let attempt = latest;
  let shouldInitiate = false;
  if (payment.status === "funded") {
    requireRecipientTempoAddress(payment);
    const realMode = provider.mode === "real";
    if (realMode) requireTempoBacking(payment);
    const nextAttemptNumber = (latest?.attemptNumber ?? 0) + 1;
    const backing = realMode ? await treasuryBackingFor(payment) : null;
    const claimAndReserve = async (tx: Prisma.TransactionClient) => {
      // Validate before mutating so failed checks leave no rows behind.
      if (backing) {
        await checkReserveFits(tx, {
          treasuryAccountId: backing.accountId,
          paymentId,
          amountUnits: backing.amountUnits,
        });
      }
      const claimed = await tx.payment.updateMany({
        where: { id: paymentId, businessId, status: "funded" },
        data: { status: transitionPayment("funded", "settling") },
      });
      if (claimed.count === 0) throw new ClaimLostRaceError();
      const created = await tx.paymentSettlement.create({
        data: {
          paymentId,
          attemptNumber: nextAttemptNumber,
          provider: provider.id,
          providerIdempotencyKey: settlementAttemptKey(paymentId, nextAttemptNumber),
          status: "pending",
          verificationStatus: "unverified",
          sourceChainId: payment?.chainId,
          sourceAsset: payment?.asset,
          sourceTokenAddress: payment?.tokenAddress,
          sourceAmount: payment?.amount.toFixed(2),
          sourceTransactionHash: null,
          initiatedAt: new Date(),
        },
      });
      if (backing) {
        await reserveForSettlement(tx, {
          treasuryAccountId: backing.accountId,
          paymentId,
          attemptNumber: nextAttemptNumber,
          amountUnits: backing.amountUnits,
        });
      }
      return created;
    };
    try {
      attempt = backing
        ? await withGuardedTreasurySection(db, backing.accountId, claimAndReserve)
        : await db.$transaction(claimAndReserve);
    } catch (error) {
      if (error instanceof ClaimLostRaceError) {
        attempt = null;
      } else if (error instanceof ReservationExistsError) {
        // A concurrent request already claimed and reserved. Re-read and
        // rejoin verification instead of failing: the shared attempt and
        // debit keys make the loser converge without double payout.
        attempt = null;
      } else {
        throw toConflictError(error);
      }
    }
    if (!attempt) {
      payment = await db.payment.findFirst({ where: { id: paymentId, businessId }, include: { recipient: { select: { tempoAddress: true } } } }) as PaymentForSettlement | null;
      latest = await db.paymentSettlement.findFirst({ where: { paymentId }, orderBy: { attemptNumber: "desc" } });
      if (payment?.status === "settled" && latest) return { state: "settled", attemptId: latest.id, isSimulation: latest.isSimulation };
      if (payment?.status === "settling" && latest) return verifyExisting(payment, latest, provider, verifier);
      throw new SettlementConflictError("Payment is no longer available for settlement.");
    }
    shouldInitiate = true;
  } else if (payment.status === "settling" && latest?.status === "failed" && latest.retryable) {
    requireRecipientTempoAddress(payment);
    const realMode = provider.mode === "real";
    if (realMode) requireTempoBacking(payment);
    const nextAttemptNumber = latest.attemptNumber + 1;
    const backing = realMode ? await treasuryBackingFor(payment) : null;
    const attemptData = {
      paymentId,
      attemptNumber: nextAttemptNumber,
      provider: provider.id,
      providerIdempotencyKey: settlementAttemptKey(paymentId, nextAttemptNumber),
      status: "pending" as const,
      verificationStatus: "unverified" as const,
      sourceChainId: payment.chainId,
      sourceAsset: payment.asset,
      sourceTokenAddress: payment.tokenAddress,
      sourceAmount: payment.amount.toFixed(2),
      initiatedAt: new Date(),
    };
    try {
      if (backing) {
        attempt = await withGuardedTreasurySection(db, backing.accountId, async (tx) => {
          // Release the superseded hold first so the replacement fit-check
          // counts those funds as available. Validate before creating rows.
          const superseded = await findActiveReservationForPayment(tx, backing.accountId, paymentId);
          if (superseded) {
            await releaseReservation(tx, {
              treasuryAccountId: backing.accountId,
              reservationId: superseded.id,
              reason: `superseded by attempt ${nextAttemptNumber}`,
            });
          }
          await checkReserveFits(tx, {
            treasuryAccountId: backing.accountId,
            paymentId,
            amountUnits: backing.amountUnits,
          });
          const created = await tx.paymentSettlement.create({ data: attemptData });
          await reserveForSettlement(tx, {
            treasuryAccountId: backing.accountId,
            paymentId,
            attemptNumber: nextAttemptNumber,
            amountUnits: backing.amountUnits,
          });
          return created;
        });
      } else {
        attempt = await db.paymentSettlement.create({ data: attemptData });
      }
      shouldInitiate = true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        attempt = await db.paymentSettlement.findFirst({ where: { paymentId }, orderBy: { attemptNumber: "desc" } });
        if (!attempt) throw new SettlementConflictError("Settlement retry could not be claimed.");
      } else {
        throw toConflictError(error);
      }
    }
  } else if (payment.status !== "settling" || !latest) {
    throw new SettlementConflictError("Only funded payments can enter settlement.");
  }

  if (!attempt) throw new SettlementConflictError("Settlement attempt could not be loaded.");
  if (shouldInitiate) {
    let initiation: SettlementInitiation;
    try {
      initiation = await provider.initiateSettlement(command(payment, attempt.attemptNumber));
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 240) : "Settlement provider returned an unknown result.";
      await db.paymentSettlement.update({
        where: { id: attempt.id },
        data: { status: "pending", verificationStatus: "pending", failureReason: reason, retryable: false },
      });
      return { state: "settling", attemptId: attempt.id, isSimulation: provider.mode === "test" };
    }
    attempt = await db.paymentSettlement.update({
      where: { id: attempt.id },
      data: {
        sourceTransactionHash: initiation.sourceTransactionHash,
        destinationChainId: initiation.destinationChainId,
        destinationAsset: initiation.destinationAsset,
        destinationTokenAddress: initiation.destinationTokenAddress,
        destinationAmount: initiation.destinationAmount,
        recipientAddress: initiation.recipientAddress,
        bridgeMessageId: initiation.bridgeMessageId,
        status: initiation.state === "failed" ? "failed" : "pending",
        verificationStatus: initiation.state === "failed" ? "failed" : "pending",
        failureReason: initiation.failureReason,
        retryable: initiation.retryable,
        failedAt: initiation.state === "failed" ? new Date() : null,
      },
    });
    if (initiation.state === "failed") {
      if (!initiation.retryable) {
        await db.payment.updateMany({ where: { id: paymentId, businessId, status: "settling" }, data: { status: transitionPayment("settling", "failed") } });
        if (provider.mode === "real") {
          await releaseActiveReservation(payment, `settlement initiation failed: ${(initiation.failureReason ?? "unknown").slice(0, 120)}`);
        }
      }
      return { state: initiation.retryable ? "settling" : "failed", attemptId: attempt.id, ...(initiation.retryable ? { isSimulation: provider.mode === "test" } : { reason: initiation.failureReason ?? "Settlement source transaction failed.", retryable: false }) } as SettlementResult;
    }
  }

  return verifyExisting(payment, attempt, provider, verifier);
}

async function verifyExisting(
  payment: PaymentForSettlement,
  attempt: NonNullable<Awaited<ReturnType<typeof db.paymentSettlement.findFirst>>>,
  provider: SettlementProvider,
  verifier: DestinationSettlementVerifier,
): Promise<SettlementResult> {
  if (attempt.status === "settled") return { state: "settled", attemptId: attempt.id, isSimulation: attempt.isSimulation };
  if (attempt.status === "failed") return { state: "failed", attemptId: attempt.id, reason: attempt.failureReason ?? "Settlement failed.", retryable: attempt.retryable };

  // Crash recovery: a pending attempt that never recorded a submission hash
  // cannot be verified (there is nothing to check) and must not be resubmitted
  // blindly. Once stale, fail it retryably WITHOUT releasing the reservation:
  // the retry branch supersedes the hold and the provider reconciles by memo
  // before any new submission, so a late-landing original is adopted, never
  // duplicated. Fresh attempts are left alone — a submission may be in flight.
  const updatedAtMs = attempt.updatedAt instanceof Date ? attempt.updatedAt.getTime() : NaN;
  if (
    attempt.status === "pending" &&
    !attempt.sourceTransactionHash &&
    !Number.isNaN(updatedAtMs) &&
    Date.now() - updatedAtMs > STALE_UNSUBMITTED_MS
  ) {
    await db.paymentSettlement.update({
      where: { id: attempt.id },
      data: {
        status: "failed",
        verificationStatus: "failed",
        failureReason: "Settlement submission was never recorded. Retry to reconcile before any new submission.",
        retryable: true,
        failedAt: new Date(),
      },
    });
    return { state: "settling", attemptId: attempt.id, isSimulation: attempt.isSimulation };
  }

  let result: DestinationVerification;
  try {
    result = await verifier.verifyDestination(expectation(snapshot(attempt)), snapshot(attempt));
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 240) : "Destination verification is temporarily unavailable.";
    await db.paymentSettlement.update({ where: { id: attempt.id }, data: { verificationStatus: "pending", failureReason: reason } });
    return { state: "settling", attemptId: attempt.id, isSimulation: attempt.isSimulation };
  }
  if (result.state === "pending") {
    await db.paymentSettlement.update({ where: { id: attempt.id }, data: { verificationStatus: "pending" } });
    return { state: "settling", attemptId: attempt.id, isSimulation: attempt.isSimulation };
  }
  if (result.state === "failed") {
    const { reason, retryable } = result;
    if (!retryable && provider.mode === "real") {
      await releaseActiveReservation(payment, `settlement failed: ${reason.slice(0, 120)}`);
    }
    await db.$transaction(async (tx) => {
      await tx.paymentSettlement.update({
        where: { id: attempt.id },
        data: { status: "failed", verificationStatus: "failed", failureReason: reason, retryable, failedAt: new Date() },
      });
      if (!retryable) await tx.payment.updateMany({ where: { id: payment.id, businessId: payment.businessId, status: "settling" }, data: { status: transitionPayment("settling", "failed") } });
    });
    return { state: retryable ? "settling" : "failed", attemptId: attempt.id, ...(retryable ? { isSimulation: provider.mode === "test" } : { reason, retryable: false }) } as SettlementResult;
  }

  if (result.state !== "verified" && result.state !== "simulated") {
    throw new SettlementConfigurationError("Destination verifier returned an unsupported settlement state.");
  }
  let simulation = false;
  let simulationReason: string | null = null;
  if (result.state === "simulated") {
    simulation = true;
    simulationReason = result.reason;
  }
  if (simulation && provider.mode !== "test") {
    throw new SettlementConfigurationError("A real settlement provider cannot return simulated verification.");
  }
  const evidence = result.state === "verified" ? result.evidence : null;
  if (evidence) {
    const expected = expectation(snapshot(attempt));
    if (!expected) throw new SettlementConfigurationError("Verified destination data is missing its expected route parameters.");
    const checked = verifyDestinationEvidence(expected, evidence);
    if (checked.state === "failed") {
      const reason = checked.reason;
      if (provider.mode === "real") {
        await releaseActiveReservation(payment, `settlement evidence rejected: ${reason.slice(0, 120)}`);
      }
      await db.paymentSettlement.update({ where: { id: attempt.id }, data: { status: "failed", verificationStatus: "failed", failureReason: reason, failedAt: new Date() } });
      await db.payment.updateMany({ where: { id: payment.id, businessId: payment.businessId, status: "settling" }, data: { status: transitionPayment("settling", "failed") } });
      return { state: "failed", attemptId: attempt.id, reason, retryable: false };
    }
    if (checked.state !== "verified") throw new SettlementConfigurationError("Destination evidence validator returned an unsupported state.");
  }

  const settledAt = new Date();
  if (!simulation && provider.mode === "real" && evidence) {
    await debitVerifiedSettlement(payment, attempt.providerIdempotencyKey, attempt.attemptNumber, evidence.transactionHash);
  }
  await db.$transaction(async (tx) => {
    await tx.paymentSettlement.update({
      where: { id: attempt.id },
      data: {
        status: "settled",
        verificationStatus: simulation ? "simulated" : "verified",
        isSimulation: simulation,
        destinationChainId: evidence?.destinationChainId ?? attempt.destinationChainId,
        destinationTokenAddress: evidence?.destinationTokenAddress ?? attempt.destinationTokenAddress,
        destinationAmount: evidence?.destinationAmount ?? attempt.destinationAmount,
        recipientAddress: evidence?.recipientAddress ?? attempt.recipientAddress,
        destinationTransactionHash: evidence?.transactionHash ?? attempt.destinationTransactionHash,
        bridgeMessageId: evidence?.bridgeMessageId ?? attempt.bridgeMessageId,
        verifiedAt: simulation ? null : settledAt,
        settledAt,
        failureReason: simulation ? simulationReason : null,
      },
    });
    await tx.payment.updateMany({
      where: { id: payment.id, businessId: payment.businessId, status: "settling" },
      data: { status: transitionPayment("settling", "settled") },
    });
  });
  return { state: "settled", attemptId: attempt.id, isSimulation: simulation };
}
