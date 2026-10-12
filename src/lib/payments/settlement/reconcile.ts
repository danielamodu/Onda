import type { Hash, Hex } from "viem";
import { db } from "@/lib/db";
import { fundPayment } from "@/lib/payments/funding";
import { settlePayment } from "@/lib/payments/settlement/service";
import { settleBatch, isBatchCapableProvider } from "@/lib/payments/settlement/batches";
import type { TempoFundingConfig } from "@/lib/payments/tempo/config";
import { verifyTempoFundingTransaction } from "@/lib/payments/tempo/funding";
import {
  baseUnitsFromDecimalString,
  creditVerifiedTempoDeposit,
  fundingCreditKey,
  getOrCreateTreasuryAccount,
  withGuardedTreasurySection,
} from "@/lib/payments/treasury/ledger";
import type { DestinationSettlementVerifier, SettlementProvider } from "@/lib/payments/settlement/types";

export type ReconcileOutcome =
  | "advanced"
  | "settled"
  | "failed"
  | "still-pending"
  | "needs-review"
  | "skipped";

export type ReconcileItem = {
  kind: "funding" | "credit" | "settlement" | "batch";
  id: string;
  outcome: ReconcileOutcome;
  detail: string;
};

export type ReconcileDependencies = {
  provider: SettlementProvider;
  verifier: DestinationSettlementVerifier;
  fundingConfig: TempoFundingConfig;
  verifyFunding?: typeof verifyTempoFundingTransaction;
};

export type ReconcileOptions = {
  businessId?: string;
  olderThanMs?: number;
  limit?: number;
};

const DEFAULT_STALE_MS = 5 * 60 * 1000;
const DEFAULT_LIMIT = 25;

function summarize(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown reconciliation error").slice(0, 200);
}

/**
 * Backfill a missing ledger credit for an already-funded payment by
 * re-verifying its recorded funding transaction on-chain. Never invents a
 * credit: a missing or mismatched receipt leaves the payment untouched.
 */
async function backfillFundingCredit(
  businessId: string,
  payment: { id: string; amount: { toFixed(digits?: number): string }; transactionHash: string | null; fundingAuthorizationSignature: string | null },
  dependencies: Pick<ReconcileDependencies, "fundingConfig" | "verifyFunding">,
): Promise<"credited" | "already-credited" | "still-pending"> {
  const { fundingConfig } = dependencies;
  const verify = dependencies.verifyFunding ?? verifyTempoFundingTransaction;
  if (!payment.transactionHash || !payment.fundingAuthorizationSignature) return "still-pending";
  const normalizedHash = payment.transactionHash.toLowerCase();
  const existing = await db.treasuryLedgerEntry.findFirst({
    where: { idempotencyKey: fundingCreditKey(fundingConfig.chainId, normalizedHash) },
    select: { id: true },
  });
  if (existing) return "already-credited";
  const verification = await verify(
    normalizedHash as Hash,
    payment.amount.toFixed(2),
    payment.id,
    payment.fundingAuthorizationSignature as Hex,
    fundingConfig,
  );
  if (verification.state === "pending") return "still-pending";
  const funding = verification.funding;
  const amountUnits = baseUnitsFromDecimalString(payment.amount.toFixed(2), funding.tokenDecimals);
  const account = await getOrCreateTreasuryAccount(db, {
    chainId: funding.chainId,
    tokenAddress: funding.tokenAddress,
    tokenSymbol: funding.tokenSymbol,
    tokenDecimals: funding.tokenDecimals,
    treasuryAddress: funding.treasuryAddress,
  });
  await withGuardedTreasurySection(db, account.id, async (tx) => {
    await creditVerifiedTempoDeposit(tx, {
      treasuryAccountId: account.id,
      paymentId: payment.id,
      chainId: funding.chainId,
      tokenAddress: funding.tokenAddress,
      amountUnits,
      transactionHash: normalizedHash,
    });
  });
  return "credited";
}

/**
 * Idempotent crash-recovery sweep. Re-runs the normal idempotent entry
 * points (fundPayment, settlePayment, settleBatch) for stale operations and
 * backfills missing funding credits. Safe to rerun: it never releases a
 * reservation, never submits a replacement transaction blindly (submission
 * paths reconcile first), and reports anything it cannot resolve as
 * needs-review without changing financial state.
 *
 * Each item is driven for up to three passes while it keeps returning
 * still-pending: multi-step recoveries (e.g. stale unsubmitted attempt →
 * failed+retryable → new attempt → submit → verify → settled) need more than
 * one pass, and every pass is idempotent by construction.
 */
export async function reconcileStaleSettlements(
  options: ReconcileOptions,
  dependencies: ReconcileDependencies,
): Promise<{ items: ReconcileItem[] }> {
  const olderThanMs = options.olderThanMs ?? DEFAULT_STALE_MS;
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), 100);
  const cutoff = new Date(Date.now() - olderThanMs);
  const businessFilter = options.businessId ? { businessId: options.businessId } : {};
  const items: ReconcileItem[] = [];
  const push = (item: ReconcileItem) => {
    if (items.length < limit) items.push(item);
  };

  const stuckFunding = await db.payment.findMany({
    where: { ...businessFilter, status: "funding", updatedAt: { lt: cutoff } },
    select: { id: true, businessId: true, transactionHash: true, fundingAuthorizationSignature: true },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
  for (const payment of stuckFunding) {
    if (items.length >= limit) break;
    if (!payment.transactionHash || !payment.fundingAuthorizationSignature) {
      push({ kind: "funding", id: payment.id, outcome: "needs-review", detail: "Funding attempt has no recorded transaction to resume." });
      continue;
    }
    try {
      const result = await fundPayment(payment.businessId, payment.id, payment.transactionHash as Hash, payment.fundingAuthorizationSignature as Hex, {
        config: dependencies.fundingConfig,
        verify: dependencies.verifyFunding,
      });
      push({
        kind: "funding",
        id: payment.id,
        outcome: result.state === "funded" ? "settled" : result.state === "failed" ? "failed" : "still-pending",
        detail: result.state === "failed" ? result.reason : `Funding is ${result.state}.`,
      });
    } catch (error) {
      push({ kind: "funding", id: payment.id, outcome: "needs-review", detail: summarize(error) });
    }
  }

  const fundedPayments = await db.payment.findMany({
    where: { ...businessFilter, status: "funded", transactionHash: { not: null }, updatedAt: { lt: cutoff } },
    select: { id: true, businessId: true, amount: true, transactionHash: true, fundingAuthorizationSignature: true },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
  for (const payment of fundedPayments) {
    if (items.length >= limit) break;
    try {
      const outcome = await backfillFundingCredit(payment.businessId, payment, dependencies);
      push({
        kind: "credit",
        id: payment.id,
        outcome: outcome === "credited" || outcome === "already-credited" ? "advanced" : "still-pending",
        detail: outcome === "credited"
          ? "Missing ledger credit was backfilled from the verified funding transaction."
          : outcome === "already-credited"
            ? "Ledger credit already present."
            : "Funding receipt not yet verifiable; left untouched.",
      });
    } catch (error) {
      push({ kind: "credit", id: payment.id, outcome: "needs-review", detail: summarize(error) });
    }
  }

  const settlingPayments = await db.payment.findMany({
    where: { ...businessFilter, status: "settling", updatedAt: { lt: cutoff } },
    select: { id: true, businessId: true },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
  for (const payment of settlingPayments) {
    if (items.length >= limit) break;
    try {
      let outcome: ReconcileOutcome = "still-pending";
      let detail = "Settlement is settling.";
      for (let pass = 0; pass < 3; pass++) {
        const result = await settlePayment(payment.businessId, payment.id, {
          provider: dependencies.provider,
          verifier: dependencies.verifier,
        });
        if (result.state === "settled") {
          outcome = "settled";
          detail = "Settlement is settled.";
          break;
        }
        if (result.state === "failed") {
          outcome = "failed";
          detail = result.reason;
          break;
        }
        detail = `Settlement is settling (pass ${pass + 1}).`;
      }
      push({ kind: "settlement", id: payment.id, outcome, detail });
    } catch (error) {
      push({ kind: "settlement", id: payment.id, outcome: "needs-review", detail: summarize(error) });
    }
  }

  const pendingBatches = await db.settlementBatch.findMany({
    where: { status: "pending", updatedAt: { lt: cutoff } },
    select: { id: true, paymentIds: true },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
  for (const batch of pendingBatches) {
    if (items.length >= limit) break;
    const member = await db.payment.findFirst({
      where: { id: { in: batch.paymentIds }, ...(options.businessId ? { businessId: options.businessId } : {}) },
      select: { businessId: true },
    });
    if (!member) {
      push({ kind: "batch", id: batch.id, outcome: "skipped", detail: "Batch does not belong to this business scope." });
      continue;
    }
    try {
      if (!isBatchCapableProvider(dependencies.provider)) {
        push({ kind: "batch", id: batch.id, outcome: "skipped", detail: "Batch recovery requires the real Tempo provider." });
        continue;
      }
      let outcome: ReconcileOutcome = "still-pending";
      let detail = "Batch is settling.";
      for (let pass = 0; pass < 3; pass++) {
        const result = await settleBatch(member.businessId, batch.paymentIds, {
          provider: dependencies.provider,
          verifier: dependencies.verifier,
        });
        if (result.state === "settled") {
          outcome = "settled";
          detail = "Batch is settled.";
          break;
        }
        if (result.state === "failed") {
          outcome = "failed";
          detail = result.reason;
          break;
        }
        detail = `Batch is settling (pass ${pass + 1}).`;
      }
      push({ kind: "batch", id: batch.id, outcome, detail });
    } catch (error) {
      push({ kind: "batch", id: batch.id, outcome: "needs-review", detail: summarize(error) });
    }
  }

  return { items };
}
