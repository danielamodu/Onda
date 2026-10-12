import { describe, expect, it } from "vitest";

// Database-backed treasury concurrency proof. Runs only when
// TREASURY_TEST_DATABASE_URL points at a throwaway Postgres database with the
// Phase 7 migration applied (e.g. `prisma migrate deploy`). It is skipped in
// environments without a database; mocked coverage lives in
// treasury-ledger.test.ts and does NOT prove real concurrency control.
const DATABASE_URL = process.env.TREASURY_TEST_DATABASE_URL;
const enabled = Boolean(DATABASE_URL);

describe.skipIf(!enabled)("treasury ledger concurrency (postgres)", () => {
  it("serializes concurrent reservations so overspend is impossible", async () => {
    process.env.DATABASE_URL = DATABASE_URL as string;
    const { PrismaClient } = await import("@prisma/client");
    const { getOrCreateTreasuryAccount, withGuardedTreasurySection, creditFundingDeposit, reserveForSettlement, getTreasuryBalances, LedgerError } =
      await import("@/lib/payments/treasury/ledger");
    const db = new PrismaClient();
    try {
      // Unique treasury identity + payment ids per run: these suites share one
      // Neon branch and never truncate, so a fixed account/key would carry a
      // prior run's accumulated credits and reservations (and collide on the
      // reservation idempotency key). A fresh identity restores the clean
      // 1000-unit pool this test's fixed amounts assume.
      const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const account = await getOrCreateTreasuryAccount(db, {
        chainId: 42431,
        tokenAddress: `0xconcurrency-${run}`,
        tokenSymbol: "AlphaUSD",
        tokenDecimals: 6,
        treasuryAddress: `0xtreasury-${run}`,
      });
      const fundingHash = `0x${"c".repeat(60)}${Date.now().toString(16).slice(-4).padStart(4, "0")}`;
      await withGuardedTreasurySection(db, account.id, async (tx) =>
        creditFundingDeposit(tx, {
          treasuryAccountId: account.id,
          paymentId: `pay-fund-${run}`,
          chainId: 42431,
          amountUnits: BigInt(1000),
          transactionHash: fundingHash,
        }),
      );
      const results = await Promise.allSettled(
        [`pay-a-${run}`, `pay-b-${run}`].map((paymentId, index) =>
          withGuardedTreasurySection(db, account.id, async (tx) =>
            reserveForSettlement(tx, {
              treasuryAccountId: account.id,
              paymentId,
              attemptNumber: 1,
              amountUnits: BigInt(600),
            }),
          ).then(
            (value) => ({ paymentId, index, ok: true as const, value }),
            (error) => ({ paymentId, index, ok: false as const, error }),
          ),
        ),
      );
      const ok = results.filter((result) => result.status === "fulfilled" && result.value.ok);
      const failed = results.filter((result) => result.status === "fulfilled" && !result.value.ok);
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(1);
      const reason = (failed[0] as { status: "fulfilled"; value: { error: unknown } }).value.error;
      // The loser is rejected as a ledger-level conflict. Which flavor depends
      // on timing under real Postgres: if its optimistic retry re-reads the
      // winner's committed hold it is LedgerInsufficientFundsError; if its own
      // superseded attempt is still observable it is ReservationExistsError.
      // Both are safe refusals — the balance assertions below prove no overspend.
      expect(reason).toBeInstanceOf(LedgerError);
      const balances = await getTreasuryBalances(db, account.id);
      expect(balances.reservedUnits).toBe(BigInt(600));
      expect(balances.availableUnits).toBe(BigInt(400));
    } finally {
      await db.$disconnect();
    }
  });

  it("credits the same funding transaction exactly once under race", async () => {
    process.env.DATABASE_URL = DATABASE_URL as string;
    const { PrismaClient } = await import("@prisma/client");
    const { getOrCreateTreasuryAccount, withGuardedTreasurySection, creditFundingDeposit } =
      await import("@/lib/payments/treasury/ledger");
    const db = new PrismaClient();
    try {
      const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const account = await getOrCreateTreasuryAccount(db, {
        chainId: 42431,
        tokenAddress: `0xconcurrency-${run}`,
        tokenSymbol: "AlphaUSD",
        tokenDecimals: 6,
        treasuryAddress: `0xtreasury-${run}`,
      });
      const fundingHash = `0x${Date.now().toString(16).padStart(16, "0")}${"d".repeat(48)}`.slice(0, 66);
      const outcomes = await Promise.all(
        [`pay-x-${run}`, `pay-y-${run}`].map((paymentId) =>
          withGuardedTreasurySection(db, account.id, async (tx) =>
            creditFundingDeposit(tx, {
              treasuryAccountId: account.id,
              paymentId,
              chainId: 42431,
              amountUnits: BigInt(500),
              transactionHash: fundingHash,
            }),
          ),
        ),
      );
      const fresh = outcomes.filter((outcome) => !outcome.duplicate);
      // Same deposit presented against different payments: exactly one credit.
      expect(fresh).toHaveLength(1);
    } finally {
      await db.$disconnect();
    }
  });
});
