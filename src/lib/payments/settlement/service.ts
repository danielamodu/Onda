import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { transitionPayment } from "@/lib/payments/domain";
import { SettlementConfigurationError } from "@/lib/payments/settlement/providers";
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

export type SettlementResult =
  | { state: "settling"; attemptId: string; isSimulation: boolean }
  | { state: "settled"; attemptId: string; isSimulation: boolean }
  | { state: "failed"; attemptId: string; reason: string; retryable: boolean };

type SettlementDependencies = {
  provider: SettlementProvider;
  verifier: DestinationSettlementVerifier;
};

type PaymentForSettlement = {
  id: string;
  businessId: string;
  status: string;
  asset: string;
  amount: { toFixed(digits?: number): string };
  chainId: number | null;
  tokenAddress: string | null;
  transactionHash: string | null;
  destinationAddress: string | null;
};

function snapshot(attempt: {
  id: string;
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
    idempotencyKey: `${payment.id}:settlement:${attemptNumber}`,
    sourceChainId: payment.chainId,
    sourceAsset: payment.asset,
    sourceTokenAddress: payment.tokenAddress,
    sourceTransactionHash: payment.transactionHash,
    sourceAmount: payment.amount.toFixed(2),
    destinationAddress: payment.destinationAddress,
  };
}

function expectation(attempt: SettlementAttemptSnapshot): SettlementExpectation | null {
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

  let payment = await db.payment.findFirst({ where: { id: paymentId, businessId } }) as PaymentForSettlement | null;
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
    const nextAttemptNumber = (latest?.attemptNumber ?? 0) + 1;
    attempt = await db.$transaction(async (tx) => {
      const claimed = await tx.payment.updateMany({
        where: { id: paymentId, businessId, status: "funded" },
        data: { status: transitionPayment("funded", "settling") },
      });
      if (claimed.count === 0) return null;
      return tx.paymentSettlement.create({
        data: {
          paymentId,
          attemptNumber: nextAttemptNumber,
          provider: provider.id,
          providerIdempotencyKey: `${paymentId}:settlement:${nextAttemptNumber}`,
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
    });
    if (!attempt) {
      payment = await db.payment.findFirst({ where: { id: paymentId, businessId } }) as PaymentForSettlement | null;
      latest = await db.paymentSettlement.findFirst({ where: { paymentId }, orderBy: { attemptNumber: "desc" } });
      if (payment?.status === "settled" && latest) return { state: "settled", attemptId: latest.id, isSimulation: latest.isSimulation };
      if (payment?.status === "settling" && latest) return verifyExisting(payment, latest, provider, verifier);
      throw new SettlementConflictError("Payment is no longer available for settlement.");
    }
    shouldInitiate = true;
  } else if (payment.status === "settling" && latest?.status === "failed" && latest.retryable) {
    const nextAttemptNumber = latest.attemptNumber + 1;
    try {
      attempt = await db.paymentSettlement.create({
        data: {
          paymentId,
          attemptNumber: nextAttemptNumber,
          provider: provider.id,
          providerIdempotencyKey: `${paymentId}:settlement:${nextAttemptNumber}`,
          status: "pending",
          verificationStatus: "unverified",
          sourceChainId: payment.chainId,
          sourceAsset: payment.asset,
          sourceTokenAddress: payment.tokenAddress,
          sourceAmount: payment.amount.toFixed(2),
          initiatedAt: new Date(),
        },
      });
      shouldInitiate = true;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      attempt = await db.paymentSettlement.findFirst({ where: { paymentId }, orderBy: { attemptNumber: "desc" } });
      if (!attempt) throw new SettlementConflictError("Settlement retry could not be claimed.");
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
      if (!initiation.retryable) await db.payment.updateMany({ where: { id: paymentId, businessId, status: "settling" }, data: { status: transitionPayment("settling", "failed") } });
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
      await db.paymentSettlement.update({ where: { id: attempt.id }, data: { status: "failed", verificationStatus: "failed", failureReason: reason, failedAt: new Date() } });
      await db.payment.updateMany({ where: { id: payment.id, businessId: payment.businessId, status: "settling" }, data: { status: transitionPayment("settling", "failed") } });
      return { state: "failed", attemptId: attempt.id, reason, retryable: false };
    }
    if (checked.state !== "verified") throw new SettlementConfigurationError("Destination evidence validator returned an unsupported state.");
  }

  const settledAt = new Date();
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
