import { Prisma } from "@prisma/client";
import { getAddress, isAddress } from "viem";
import { db } from "@/lib/db";
import { transitionPayment } from "@/lib/payments/domain";
import { SettlementConfigurationError } from "@/lib/payments/settlement/errors";
import { settlementAttemptKey } from "@/lib/payments/tempo/memo";
import { RECEIVE_POLICY_GUARD_ADDRESS, getTempoFundingConfig } from "@/lib/payments/tempo/config";
import {
  baseUnitsFromDecimalString,
  debitSettlement,
  findActiveReservationForPayment,
  findDebitByKey,
  getTreasuryBalances,
  releaseReservation,
  reserveForSettlement,
  withGuardedTreasurySection,
  LedgerConflictError,
  LedgerError,
  LedgerInsufficientFundsError,
} from "@/lib/payments/treasury/ledger";
import { verifyDestinationEvidence } from "@/lib/payments/settlement/verification";
import { SettlementConflictError, STALE_UNSUBMITTED_MS, type PaymentForSettlement } from "@/lib/payments/settlement/service";
import { settlementMemo } from "@/lib/payments/tempo/memo";
import type { TempoChainGateway } from "@/lib/payments/tempo/provider";
import type {
  DestinationSettlementVerifier,
  SettlementExpectation,
  SettlementProvider,
} from "@/lib/payments/settlement/types";

export type BatchSettleResult =
  | { state: "settling"; batchId: string; attemptIds: string[]; payments: Array<{ paymentId: string; state: string; transactionHash: string | null }> }
  | { state: "settled"; batchId: string; attemptIds: string[]; payments: Array<{ paymentId: string; state: string; transactionHash: string | null }> }
  | { state: "failed"; batchId: string; reason: string; retryable: boolean };

export type BatchDependencies = {
  provider: Pick<SettlementProvider, "id" | "mode" | "assertAvailable"> & { batchGateway: TempoChainGateway };
  verifier: DestinationSettlementVerifier;
};

export function isBatchCapableProvider(
  provider: SettlementProvider,
): provider is SettlementProvider & { batchGateway: TempoChainGateway } {
  return "batchGateway" in provider && typeof (provider as { batchGateway?: unknown }).batchGateway === "object";
}

export function batchIdempotencyKey(paymentIds: string[]) {
  return `batch:${[...paymentIds].sort().join(",")}`;
}

export function getMaxBatchSize(): number {
  const raw = process.env.TEMPO_MAX_BATCH_SIZE ?? "10";
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 2 || parsed > 25) {
    throw new SettlementConfigurationError("TEMPO_MAX_BATCH_SIZE must be an integer between 2 and 25.");
  }
  return parsed;
}

type ValidatedBatchItem = PaymentForSettlement & { paymentId: string; amountUnits: bigint; memo: `0x${string}` };

type BatchAttemptView = {
  id: string;
  paymentId: string;
  attemptNumber: number;
  providerIdempotencyKey: string;
  sourceTransactionHash: string | null;
  status: string;
  retryable: boolean;
  updatedAt: Date | null;
  createdAt: Date | null;
};

function checkPaymentSet(paymentIds: string[]) {
  const unique = [...new Set(paymentIds)];
  if (unique.length !== paymentIds.length) throw new SettlementConflictError("Batch payment ids must be distinct.");
  if (unique.length < 2) throw new SettlementConflictError("Batch settlement requires at least two payments. Settle a single payment directly.");
  if (unique.length > getMaxBatchSize()) {
    throw new SettlementConflictError(`Batch settlement supports at most ${getMaxBatchSize()} payments per batch.`);
  }
  return unique;
}

async function loadBatchPayments(
  businessId: string,
  paymentIds: string[],
  treasury: { chainId: number; tokenAddress: string; tokenSymbol: string; tokenDecimals: number },
  requireFunded: boolean,
): Promise<ValidatedBatchItem[]> {
  const payments = await db.payment.findMany({
    where: { id: { in: paymentIds }, businessId },
    include: { recipient: { select: { tempoAddress: true } } },
  }) as PaymentForSettlement[];
  if (payments.length !== paymentIds.length) throw new SettlementConflictError("One or more payments were not found.");
  const byId = new Map(payments.map((payment) => [payment.id, payment]));
  const ordered = paymentIds.map((id) => byId.get(id) as PaymentForSettlement);
  for (const payment of ordered) {
    if (requireFunded && payment.status !== "funded") {
      throw new SettlementConflictError("Only funded payments can enter batch settlement.");
    }
    if (!payment.recipient?.tempoAddress || !isAddress(payment.recipient.tempoAddress)) {
      throw new SettlementConflictError("Every batch payment needs a valid recipient Tempo address.");
    }
    if (payment.asset !== treasury.tokenSymbol) {
      throw new SettlementConflictError("Batch payments must all use the configured settlement asset.");
    }
    if (payment.chainId !== treasury.chainId || payment.tokenAddress?.toLowerCase() !== treasury.tokenAddress.toLowerCase()) {
      throw new SettlementConflictError("Batch payments must all be funded with the configured Tempo settlement asset.");
    }
  }
  return ordered.map((payment) => {
    let amountUnits: bigint;
    try {
      amountUnits = baseUnitsFromDecimalString(payment.amount.toFixed(2), treasury.tokenDecimals);
    } catch (error) {
      throw new SettlementConflictError(
        error instanceof LedgerError ? error.message : "A batch amount cannot be represented in token base units.",
      );
    }
    if (amountUnits <= BigInt(0)) throw new SettlementConflictError("Batch amounts must be greater than zero.");
    return { ...payment, paymentId: payment.id, amountUnits, memo: settlementMemo(payment.id) };
  });
}

function validateBatchRecipients(items: ValidatedBatchItem[], sender: string, tokenSymbol: string) {
  for (const item of items) {
    const recipient = getAddress(item.recipient?.tempoAddress as string);
    if (recipient.toLowerCase() === sender.toLowerCase()) {
      throw new SettlementConflictError("A batch recipient must not be the settlement wallet itself.");
    }
    if (recipient.toLowerCase() === RECEIVE_POLICY_GUARD_ADDRESS.toLowerCase()) {
      throw new SettlementConflictError(`A batch recipient is not payable in ${tokenSymbol}.`);
    }
  }
}

export async function settleBatch(
  businessId: string,
  paymentIds: string[],
  dependencies: BatchDependencies,
): Promise<BatchSettleResult> {
  const { provider, verifier } = dependencies;
  if (provider.mode !== "real") throw new SettlementConfigurationError("Batch settlement requires the real Tempo provider.");
  provider.assertAvailable();
  const gateway = provider.batchGateway;
  if (!gateway.submitBatchTransfer) {
    throw new SettlementConfigurationError("The configured settlement provider does not support batch submission.");
  }
  const config = gateway.loadConfig();
  const funding = getTempoFundingConfig();
  if (funding.tokenAddress.toLowerCase() !== config.tokenAddress.toLowerCase() || funding.chainId !== config.chainId) {
    throw new SettlementConfigurationError("Tempo funding and settlement configuration do not match.");
  }

  const account = await db.treasuryAccount.findUnique({
    where: {
      chainId_tokenAddress_treasuryAddress: {
        chainId: config.chainId,
        tokenAddress: config.tokenAddress,
        treasuryAddress: funding.treasuryAddress,
      },
    },
  });
  if (!account) throw new SettlementConfigurationError("Treasury ledger is not initialized for this asset. Fund a payment first.");
  const treasury = {
    chainId: config.chainId,
    tokenAddress: config.tokenAddress,
    tokenSymbol: funding.tokenSymbol,
    tokenDecimals: account.tokenDecimals,
  };

  const unique = checkPaymentSet(paymentIds);
  const key = batchIdempotencyKey(unique);

  const existingBatch = await db.settlementBatch.findUnique({
    where: { providerIdempotencyKey: key },
    include: { attempts: { orderBy: { attemptNumber: "asc" } } },
  });
  if (existingBatch?.status === "settled") {
    return {
      state: "settled",
      batchId: existingBatch.id,
      attemptIds: existingBatch.attempts.map((attempt) => attempt.id),
      payments: existingBatch.attempts.map((attempt) => ({
        paymentId: attempt.paymentId,
        state: "settled" as const,
        transactionHash: attempt.destinationTransactionHash,
      })),
    };
  }
  if (existingBatch?.status === "failed" && !existingBatch.retryable) {
    throw new SettlementConflictError("This batch already failed terminally. Settle the payments individually.");
  }

  let batchId: string;
  let attempts: BatchAttemptView[];
  let freshClaim = false;
  if (existingBatch) {
    batchId = existingBatch.id;
    attempts = existingBatch.attempts.map((attempt) => ({
      id: attempt.id,
      paymentId: attempt.paymentId,
      attemptNumber: attempt.attemptNumber,
      providerIdempotencyKey: attempt.providerIdempotencyKey,
      sourceTransactionHash: attempt.sourceTransactionHash,
      status: attempt.status,
      retryable: attempt.retryable,
      updatedAt: attempt.updatedAt instanceof Date ? attempt.updatedAt : null,
      createdAt: attempt.createdAt instanceof Date ? attempt.createdAt : null,
    }));
  } else {
    // Shell is created only after payment validation below, so rejected
    // requests leave no rows behind. freshClaim is set only once this call
    // has itself claimed and reserved inside the guarded section.
    batchId = "";
    attempts = [];
  }

  // Rejoin path: an existing pending batch already owns attempts.
  const items = await loadBatchPayments(businessId, unique, treasury, attempts.length === 0);
  if (attempts.length > 0) {
    const attemptPaymentIds = [...new Set(attempts.map((attempt) => attempt.paymentId))].sort();
    if (attemptPaymentIds.join(",") !== [...unique].sort().join(",")) {
      throw new SettlementConflictError("Batch membership changed; refusing to reconcile.");
    }
    for (const item of items) {
      if (item.status !== "settling" && item.status !== "settled") {
        throw new SettlementConflictError("Batch payments left the settling flow; refusing to reconcile.");
      }
    }
  }
  const sender = gateway.deriveSender(config);
  validateBatchRecipients(items, sender, treasury.tokenSymbol);

  if (!existingBatch) {
    try {
      const created = await db.settlementBatch.create({
        data: {
          treasuryAccountId: account.id,
          providerIdempotencyKey: key,
          paymentIds: unique,
          status: "pending",
        },
      });
      batchId = created.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new SettlementConflictError("This batch was already claimed by a concurrent request. Retry to reconcile it.");
      }
      throw error;
    }
  }

  const summarize = (state: "settling" | "settled", transactionHash: string | null) => ({
    state,
    batchId,
    attemptIds: attempts.map((attempt) => attempt.id),
    payments: attempts.map((attempt) => ({
      paymentId: attempt.paymentId,
      state: state === "settled" ? ("settled" as const) : ("settling" as const),
      transactionHash,
    })),
  });

  const recordSubmission = async (transactionHash: string | null, failureReason: string | null, retryable: boolean) => {
    await db.$transaction(async (tx) => {
      if (transactionHash) {
        await tx.settlementBatch.update({
          where: { id: batchId },
          data: { transactionHash, failureReason: null },
        });
        for (const attempt of attempts) {
          const item = items.find((entry) => entry.paymentId === attempt.paymentId) as ValidatedBatchItem;
          await tx.paymentSettlement.update({
            where: { id: attempt.id },
            data: {
              sourceTransactionHash: transactionHash,
              destinationChainId: config.chainId,
              destinationAsset: treasury.tokenSymbol,
              destinationTokenAddress: config.tokenAddress,
              destinationAmount: item.amount.toFixed(2),
              recipientAddress: getAddress(item.recipient?.tempoAddress as string),
              status: "pending",
              verificationStatus: "pending",
              failureReason,
              retryable,
              failedAt: null,
            },
          });
          attempt.sourceTransactionHash = transactionHash;
        }
      } else {
        await tx.settlementBatch.update({
          where: { id: batchId },
          data: { failureReason, retryable },
        });
        for (const attempt of attempts) {
          await tx.paymentSettlement.update({
            where: { id: attempt.id },
            data: { verificationStatus: "pending", failureReason, retryable },
          });
        }
      }
    });
  };

  // Reconcile: adopt a previously submitted transaction only when a single
  // transaction carries every payment memo. A scan ERROR is "unknown" (never
  // treated as empty — an outage must not trigger a replacement submission).
  // Payments stay funded and no new rows are at risk.
  const reconcilePriorTransaction = async (): Promise<string | "ambiguous" | "unknown" | null> => {
    const found: Array<string | null> = [];
    for (const item of items) {
      try {
        found.push(await gateway.findPriorTransfer({
          config,
          memo: item.memo,
          to: getAddress(item.recipient?.tempoAddress as string),
          amount: item.amountUnits,
        }));
      } catch {
        return "unknown";
      }
    }
    const resolved = found.filter((hash): hash is string => hash !== null);
    if (resolved.length === 0) return null;
    const uniqueHashes = [...new Set(resolved.map((hash) => hash.toLowerCase()))];
    if (resolved.length === items.length && uniqueHashes.length === 1) return resolved[0];
    return "ambiguous";
  };

  // Fresh path: claim payments, create attempts, and reserve the total atomically.
  if (attempts.length === 0) {
    const totalUnits = items.reduce((sum, item) => sum + item.amountUnits, BigInt(0));
    const priorAttempts = await db.paymentSettlement.findMany({
      where: { paymentId: { in: unique } },
      select: { paymentId: true, attemptNumber: true },
    });
    try {
      const claimed = await withGuardedTreasurySection(db, account.id, async (tx) => {
        const balances = await getTreasuryBalances(tx, account.id);
        if (balances.availableUnits < totalUnits) {
          throw new LedgerInsufficientFundsError("Treasury available balance cannot cover this batch.");
        }
        for (const item of items) {
          const active = await findActiveReservationForPayment(tx, account.id, item.paymentId);
          if (active) throw new LedgerConflictError(`Payment ${item.paymentId} already has an active treasury reservation.`);
        }
        const claimedPayments = await tx.payment.updateMany({
          where: { id: { in: unique }, businessId, status: "funded" },
          data: { status: transitionPayment("funded", "settling") },
        });
        if (claimedPayments.count !== unique.length) {
          throw new SettlementConflictError("Some payments are no longer available for batch settlement.");
        }
        const createdAttempts: BatchAttemptView[] = [];
        for (const item of items) {
          const attemptNumber = priorAttempts
            .filter((attempt) => attempt.paymentId === item.paymentId)
            .reduce((peak, attempt) => Math.max(peak, attempt.attemptNumber), 0) + 1;
          const created = await tx.paymentSettlement.create({
            data: {
              paymentId: item.paymentId,
              attemptNumber,
              batchId,
              provider: provider.id,
              providerIdempotencyKey: settlementAttemptKey(item.paymentId, attemptNumber),
              status: "pending",
              verificationStatus: "unverified",
              sourceChainId: item.chainId,
              sourceAsset: item.asset,
              sourceTokenAddress: item.tokenAddress,
              sourceAmount: item.amount.toFixed(2),
              sourceTransactionHash: null,
              initiatedAt: new Date(),
            },
          });
          await reserveForSettlement(tx, {
            treasuryAccountId: account.id,
            paymentId: item.paymentId,
            attemptNumber,
            amountUnits: item.amountUnits,
          });
          createdAttempts.push({
            id: created.id,
            paymentId: item.paymentId,
            attemptNumber,
            providerIdempotencyKey: settlementAttemptKey(item.paymentId, attemptNumber),
            sourceTransactionHash: null,
            status: "pending",
            retryable: false,
            updatedAt: new Date(),
            createdAt: new Date(),
          });
        }
        return createdAttempts;
      });
      attempts = claimed;
      freshClaim = true;
    } catch (error) {
      if (error instanceof SettlementConflictError) throw error;
      let reason: string;
      if (error instanceof LedgerInsufficientFundsError) {
        reason = "Treasury available balance cannot cover this batch. Fund the treasury first.";
      } else if (error instanceof LedgerConflictError || error instanceof LedgerError) {
        reason = error.message;
      } else {
        throw error;
      }
      await db.settlementBatch.update({
        where: { id: batchId },
        data: { failureReason: reason.slice(0, 240), retryable: true },
      });
      throw new SettlementConflictError(reason);
    }
  }

  // Rejoin: a previous call already owns attempts. Failed non-retryable
  // attempts can never rejoin — those payments must settle individually.
  // Failed retryable attempts (e.g. after a conclusively reverted batch)
  // are reset to pending so the shared flow below reconciles and, only if
  // nothing landed on-chain, resubmits. Reservations stay held throughout:
  // reverted transfers moved no funds, and timed-out submissions are covered
  // by the memo reconcile below.
  for (const attempt of attempts) {
    if (attempt.status === "failed" && !attempt.retryable) {
      throw new SettlementConflictError("A batch attempt already failed terminally. Settle the payments individually.");
    }
  }
  if (attempts.some((attempt) => attempt.status === "failed")) {
    await db.$transaction(async (tx) => {
      for (const attempt of attempts) {
        if (attempt.status === "failed") {
          await tx.paymentSettlement.update({
            where: { id: attempt.id },
            data: { status: "pending", verificationStatus: "pending", retryable: false, failedAt: null },
          });
          attempt.status = "pending";
          attempt.retryable = false;
        }
      }
    });
  }

  let transactionHash: string | null = attempts.every((attempt) => attempt.sourceTransactionHash)
    ? attempts[0].sourceTransactionHash
    : null;
  // Uncertainty hold: attempts referencing different transactions, or
  // ambiguous prior transfers, are NOT conclusive failure. The batch stays
  // pending with reservations held so a retry or operator review can
  // reconcile without risking a duplicate payout or a corrupt release.
  const holdBatchUncertain = async (reason: string) => {
    await db.$transaction(async (tx) => {
      await tx.settlementBatch.update({
        where: { id: batchId },
        data: { status: "pending", failureReason: reason, retryable: true },
      });
      for (const attempt of attempts) {
        await tx.paymentSettlement.update({
          where: { id: attempt.id },
          data: { status: "pending", verificationStatus: "pending", failureReason: reason, retryable: true },
        });
      }
    });
    return { ...summarize("settling", null), batchId };
  };
  if (transactionHash && !attempts.every((attempt) => attempt.sourceTransactionHash === transactionHash)) {
    return holdBatchUncertain("Batch attempts reference different transactions; holding for reconciliation. No funds were released.");
  }
  if (!transactionHash) {
    const reconciled = await reconcilePriorTransaction();
    if (reconciled === "ambiguous") {
      return holdBatchUncertain("Ambiguous prior transfers reference these payments; holding for reconciliation. No funds were released.");
    }
    if (reconciled === "unknown") {
      return holdBatchUncertain("Prior transfers could not be checked; holding for reconciliation instead of risking a duplicate submission.");
    }
    transactionHash = reconciled;
  }

  // Submit only when this call just claimed (freshClaim, so no other
  // submitter can exist), or when rejoining stale attempts with a clean
  // reconcile (any live submitter would have produced a transaction the scan
  // would find, or is too recent for its absence to be meaningful). A scan
  // failure never authorizes submission. Staleness uses createdAt, which
  // status updates never rewrite, so repeated holds cannot reset the clock.
  const attemptsStale = attempts.length > 0 && attempts.every((attempt) => {
    if (!attempt.createdAt || !(attempt.createdAt instanceof Date)) return false;
    return Date.now() - attempt.createdAt.getTime() > STALE_UNSUBMITTED_MS;
  });
  if (!transactionHash) {
    if (!freshClaim && !attemptsStale) {
      return holdBatchUncertain("No prior batch transaction found yet and another submission may be live; holding for reconciliation.");
    }
    if (!gateway.submitBatchTransfer) {
      throw new SettlementConfigurationError("The configured settlement provider does not support batch submission.");
    }
    let submission: { transactionHash: string; status: "success" | "reverted" | "pending" };
    try {
      submission = await gateway.submitBatchTransfer({
        config,
        transfers: items.map((item) => ({
          to: getAddress(item.recipient?.tempoAddress as string),
          amount: item.amountUnits,
          memo: item.memo,
        })),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 240) : "Batch submission failed.";
      await recordSubmission(null, reason, true);
      return { ...summarize("settling", null), batchId };
    }
    if (submission.status === "pending") {
      await recordSubmission(submission.transactionHash, "Batch submitted but unconfirmed; retry to reconcile.", true);
      return { ...summarize("settling", submission.transactionHash), batchId };
    }
    if (submission.status !== "success") {
      await releaseBatchReservations(account.id, unique, "batch transaction reverted");
      await db.$transaction(async (tx) => {
        await tx.settlementBatch.update({
          where: { id: batchId },
          data: { status: "failed", failureReason: "Batch transaction reverted.", retryable: true, failedAt: new Date() },
        });
        for (const attempt of attempts) {
          await tx.paymentSettlement.update({
            where: { id: attempt.id },
            data: { status: "failed", verificationStatus: "failed", failureReason: "Batch transaction reverted.", retryable: true, failedAt: new Date() },
          });
        }
      });
      return { ...summarize("settling", null), batchId };
    }
    transactionHash = submission.transactionHash;
    await recordSubmission(transactionHash, null, false);
  } else {
    await recordSubmission(transactionHash, null, false);
  }

  const hash = transactionHash;
  const outcomes: Array<{ attempt: BatchAttemptView; item: ValidatedBatchItem; verified: boolean }> = [];
  for (const attempt of attempts) {
    const item = items.find((entry) => entry.paymentId === attempt.paymentId) as ValidatedBatchItem;
    const expected: SettlementExpectation = {
      destinationChainId: config.chainId,
      destinationTokenAddress: config.tokenAddress,
      destinationAmount: item.amount.toFixed(2),
      recipientAddress: getAddress(item.recipient?.tempoAddress as string),
      bridgeMessageId: null,
    };
    let verified = false;
    try {
      const result = await verifier.verifyDestination(expected, {
        id: attempt.id,
        paymentId: item.paymentId,
        sourceChainId: item.chainId,
        destinationChainId: config.chainId,
        sourceAsset: item.asset,
        sourceTokenAddress: item.tokenAddress,
        destinationAsset: treasury.tokenSymbol,
        destinationTokenAddress: config.tokenAddress,
        sourceAmount: item.amount.toFixed(2),
        destinationAmount: item.amount.toFixed(2),
        recipientAddress: getAddress(item.recipient?.tempoAddress as string),
        sourceTransactionHash: hash,
        destinationTransactionHash: null,
        bridgeMessageId: null,
      });
      if (result.state === "verified") {
        const checked = verifyDestinationEvidence(expected, result.evidence);
        verified = checked.state === "verified";
        if (!verified) {
          await db.paymentSettlement.update({
            where: { id: attempt.id },
            data: { verificationStatus: "failed", failureReason: "Batch evidence rejected for this payment." },
          });
        }
      } else if (result.state === "failed" && !result.retryable) {
        await db.paymentSettlement.update({
          where: { id: attempt.id },
          data: { verificationStatus: "failed", failureReason: `Batch evidence rejected: ${result.reason.slice(0, 160)}` },
        });
      } else if (result.state === "failed") {
        await db.paymentSettlement.update({
          where: { id: attempt.id },
          data: { verificationStatus: "pending", failureReason: result.reason.slice(0, 240), retryable: true },
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 240) : "Batch verification is temporarily unavailable.";
      await db.paymentSettlement.update({ where: { id: attempt.id }, data: { verificationStatus: "pending", failureReason: reason } });
    }
    outcomes.push({ attempt, item, verified });
  }

  if (!outcomes.every((outcome) => outcome.verified)) {
    await db.settlementBatch.update({
      where: { id: batchId },
      data: { failureReason: "Batch receipt is missing evidence for every payment; holding for reconciliation.", retryable: true },
    });
    return { ...summarize("settling", hash), batchId };
  }

  const settledAt = new Date();
  await withGuardedTreasurySection(db, account.id, async (tx) => {
    for (const { attempt, item } of outcomes) {
      const reservation = await findActiveReservationForPayment(tx, account.id, item.paymentId);
      if (!reservation) {
        const prior = await findDebitByKey(tx, account.id, attempt.providerIdempotencyKey);
        if (!prior) {
          throw new SettlementConfigurationError(`Batch payment ${item.paymentId} has no active treasury reservation.`);
        }
        continue;
      }
      await debitSettlement(tx, {
        treasuryAccountId: account.id,
        paymentId: item.paymentId,
        providerIdempotencyKey: attempt.providerIdempotencyKey,
        reservationId: reservation.id,
        amountUnits: item.amountUnits,
        transactionHash: hash,
      });
    }
  });
  await db.$transaction(async (tx) => {
    for (const { attempt, item } of outcomes) {
      await tx.paymentSettlement.update({
        where: { id: attempt.id },
        data: {
          status: "settled",
          verificationStatus: "verified",
          isSimulation: false,
          destinationChainId: config.chainId,
          destinationTokenAddress: config.tokenAddress,
          destinationAmount: item.amount.toFixed(2),
          recipientAddress: getAddress(item.recipient?.tempoAddress as string),
          destinationTransactionHash: hash,
          verifiedAt: settledAt,
          settledAt,
          failureReason: null,
        },
      });
    }
    await tx.payment.updateMany({
      where: { id: { in: unique }, businessId, status: "settling" },
      data: { status: transitionPayment("settling", "settled") },
    });
    await tx.settlementBatch.update({
      where: { id: batchId },
      data: { status: "settled", failureReason: null, retryable: false, settledAt },
    });
  });
  return { ...summarize("settled", hash), batchId };
}

async function releaseBatchReservations(treasuryAccountId: string, paymentIds: string[], reason: string) {
  await withGuardedTreasurySection(db, treasuryAccountId, async (tx) => {
    for (const paymentId of paymentIds) {
      const reservation = await findActiveReservationForPayment(tx, treasuryAccountId, paymentId);
      if (reservation) {
        await releaseReservation(tx, { treasuryAccountId, reservationId: reservation.id, reason });
      }
    }
  });
}

export async function getBatchStatus(businessId: string, batchId: string) {
  const batch = await db.settlementBatch.findUnique({
    where: { id: batchId },
    include: {
      attempts: {
        orderBy: { attemptNumber: "asc" },
        include: { payment: { select: { id: true, businessId: true, amount: true, asset: true, status: true } } },
      },
    },
  });
  if (!batch || batch.attempts.some((attempt) => attempt.payment.businessId !== businessId)) return null;
  return {
    id: batch.id,
    status: batch.status,
    transactionHash: batch.transactionHash,
    failureReason: batch.failureReason,
    retryable: batch.retryable,
    settledAt: batch.settledAt?.toISOString() ?? null,
    payments: batch.attempts.map((attempt) => ({
      paymentId: attempt.paymentId,
      status: attempt.payment.status,
      attemptStatus: attempt.status,
      transactionHash: attempt.destinationTransactionHash ?? attempt.sourceTransactionHash,
    })),
  };
}
