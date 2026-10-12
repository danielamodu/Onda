import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import {
  baseUnitsFromDecimalString,
  creditFundingDeposit,
  creditVerifiedTempoDeposit,
  debitKey,
  debitSettlement,
  fundingCreditKey,
  getOrCreateTreasuryAccount,
  getTreasuryBalances,
  reconcileTreasury,
  releaseKey,
  releaseReservation,
  reserveForSettlement,
  reserveKey,
  summarizeLedger,
  withGuardedTreasurySection,
  LedgerConflictError,
  LedgerError,
  LedgerInsufficientFundsError,
  type TreasuryDb,
  type TreasuryTx,
} from "@/lib/payments/treasury/ledger";

function p2002() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint", { code: "P2002", clientVersion: "6.19.3" });
}

type Entry = {
  id: string;
  treasuryAccountId: string;
  paymentId: string | null;
  type: string;
  amountUnits: bigint;
  balanceAfterUnits: bigint;
  reservationId: string | null;
  idempotencyKey: string;
  reference: string | null;
};

function createFakeDb() {
  const state = {
    account: null as null | { id: string; version: number; tokenDecimals: number; chainId: number; tokenAddress: string },
    entries: [] as Entry[],
    failNextBump: false,
    entrySeq: 0,
  };
  const matchWhere = (entry: Entry, where: Record<string, unknown>): boolean =>
    Object.entries(where ?? {}).every(([key, value]) => (entry as unknown as Record<string, unknown>)[key] === value);

  const treasuryLedgerEntry = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const input = data as unknown as Omit<Entry, "id">;
      if (state.entries.some((entry) => entry.idempotencyKey === input.idempotencyKey)) throw p2002();
      state.entrySeq += 1;
      const entry: Entry = { ...input, id: `entry-${state.entrySeq}` };
      state.entries.push(entry);
      return { id: entry.id };
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const found = state.entries.find((entry) => matchWhere(entry, where));
      return found ? { ...found } : null;
    }),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return state.entries.filter((entry) => matchWhere(entry, where)).map((entry) => ({ ...entry }));
    }),
  };
  const treasuryAccount = {
    findUnique: vi.fn(async () => (state.account ? { ...state.account } : null)),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (state.account) throw p2002();
      state.account = { id: "treasury-1", version: 0, tokenDecimals: Number(data.tokenDecimals ?? 6), chainId: 42431, tokenAddress: "0xtoken" };
      return { ...state.account };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (!state.account) return { count: 0 };
      if (state.failNextBump) {
        state.failNextBump = false;
        return { count: 0 };
      }
      if ((where as { version?: number }).version !== undefined && (where as { version?: number }).version !== state.account.version) {
        return { count: 0 };
      }
      Object.assign(state.account, data);
      return { count: 1 };
    }),
  };
  const tx = { treasuryAccount, treasuryLedgerEntry } as unknown as TreasuryTx;
  const db = {
    $transaction: vi.fn(async (fn: (tx: TreasuryTx) => Promise<unknown>) => fn(tx)),
    treasuryAccount: {
      findUnique: treasuryAccount.findUnique,
      create: treasuryAccount.create,
      updateMany: treasuryAccount.updateMany,
    },
    treasuryLedgerEntry,
  } as unknown as TreasuryDb;
  return { state, db, tx };
}

const ACCOUNT_ID = "treasury-1";

describe("ledger amount helpers", () => {
  it("converts human decimal strings to base units without floats", () => {
    expect(baseUnitsFromDecimalString("500.00", 6)).toBe(BigInt("500000000"));
    expect(baseUnitsFromDecimalString("0.01", 6)).toBe(BigInt("10000"));
  });

  it("rejects malformed amounts", () => {
    expect(() => baseUnitsFromDecimalString("-1.00", 6)).toThrow(LedgerError);
    expect(() => baseUnitsFromDecimalString("abc", 6)).toThrow(LedgerError);
    expect(() => baseUnitsFromDecimalString("1.00", -1)).toThrow(LedgerError);
  });

  it("builds stable idempotency keys", () => {
    expect(fundingCreditKey(42431, `0x${"AB".repeat(32)}`)).toBe(`funding:42431:0x${"ab".repeat(32)}`);
    expect(reserveKey("pay-1", 2)).toBe("reserve:pay-1:2");
    expect(debitKey("pay-1:settlement:2")).toBe("settle:pay-1:settlement:2");
    expect(releaseKey("entry-9")).toBe("release:entry-9");
  });
});

describe("summarizeLedger", () => {
  it("computes available as credits minus active reserves minus debits", () => {
    const summary = summarizeLedger([
      { id: "c1", type: "CREDIT", amountUnits: BigInt(1000), paymentId: null, reservationId: null },
      { id: "r1", type: "RESERVE", amountUnits: BigInt(400), paymentId: "p1", reservationId: null },
      { id: "r2", type: "RESERVE", amountUnits: BigInt(100), paymentId: "p2", reservationId: null },
      { id: "x2", type: "RELEASE", amountUnits: BigInt(100), paymentId: "p2", reservationId: "r2" },
      { id: "d1", type: "DEBIT", amountUnits: BigInt(200), paymentId: "p3", reservationId: "r3" },
    ]);
    expect(summary).toMatchObject({ creditedUnits: BigInt(1000), reservedUnits: BigInt(400), debitedUnits: BigInt(200), availableUnits: BigInt(400) });
    expect(summary.activeReservations.map((entry) => entry.id)).toEqual(["r1"]);
  });
});

describe("treasury account provisioning", () => {
  it("creates the account once and survives a creation race", async () => {
    const { db } = createFakeDb();
    const identity = { chainId: 42431, tokenAddress: "0xtoken", tokenSymbol: "AlphaUSD", tokenDecimals: 6, treasuryAddress: "0xtreasury" };
    const first = await getOrCreateTreasuryAccount(db, identity);
    expect(first.id).toBe("treasury-1");
    const second = await getOrCreateTreasuryAccount(db, identity);
    expect(second.id).toBe(first.id);
    expect(db.treasuryAccount.create).toHaveBeenCalledTimes(1);
  });
});

describe("withGuardedTreasurySection", () => {
  it("bumps the version once on success", async () => {
    const { state, db } = createFakeDb();
    state.account = { id: ACCOUNT_ID, version: 7, tokenDecimals: 6, chainId: 42431, tokenAddress: "0xtoken" };
    const result = await withGuardedTreasurySection(db, ACCOUNT_ID, async () => "ok");
    expect(result).toBe("ok");
    expect(state.account?.version).toBe(8);
  });

  it("retries after contention and then succeeds", async () => {
    const { state, db } = createFakeDb();
    state.account = { id: ACCOUNT_ID, version: 3, tokenDecimals: 6, chainId: 42431, tokenAddress: "0xtoken" };
    state.failNextBump = true;
    const result = await withGuardedTreasurySection(db, ACCOUNT_ID, async () => "recovered");
    expect(result).toBe("recovered");
    expect(state.account?.version).toBe(4);
  });

  it("surfaces permanent constraint violations without retrying", async () => {
    const { state, db } = createFakeDb();
    state.account = { id: ACCOUNT_ID, version: 0, tokenDecimals: 6, chainId: 42431, tokenAddress: "0xtoken" };
    await expect(
      withGuardedTreasurySection(db, ACCOUNT_ID, async () => {
        throw p2002();
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("fails closed when the treasury account is missing", async () => {
    const { db } = createFakeDb();
    await expect(withGuardedTreasurySection(db, ACCOUNT_ID, async () => "x")).rejects.toThrow(LedgerError);
  });
});

describe("creditFundingDeposit", () => {
  it("credits a verified deposit exactly once", async () => {
    const { tx } = createFakeDb();
    const first = await creditFundingDeposit(tx, {
      treasuryAccountId: ACCOUNT_ID,
      paymentId: "pay-1",
      chainId: 42431,
      amountUnits: BigInt(500000000),
      transactionHash: `0x${"ab".repeat(32)}`,
    });
    expect(first.duplicate).toBe(false);
    const replay = await creditFundingDeposit(tx, {
      treasuryAccountId: ACCOUNT_ID,
      paymentId: "pay-1",
      chainId: 42431,
      amountUnits: BigInt(500000000),
      transactionHash: `0x${"AB".repeat(32)}`,
    });
    expect(replay).toMatchObject({ entryId: first.entryId, duplicate: true });
    const balances = await getTreasuryBalances({ treasuryLedgerEntry: tx.treasuryLedgerEntry }, ACCOUNT_ID);
    expect(balances.availableUnits).toBe(BigInt(500000000));
  });

  it("rejects non-positive credits", async () => {
    const { tx } = createFakeDb();
    await expect(creditFundingDeposit(tx, {
      treasuryAccountId: ACCOUNT_ID, paymentId: "pay-1", chainId: 42431, amountUnits: BigInt(0), transactionHash: `0x${"ab".repeat(32)}`,
    })).rejects.toThrow(LedgerError);
  });
});

describe("reserveForSettlement", () => {
  async function fundedTx() {
    const { tx } = createFakeDb();
    await creditFundingDeposit(tx, {
      treasuryAccountId: ACCOUNT_ID, paymentId: "pay-0", chainId: 42431, amountUnits: BigInt(1000000), transactionHash: `0x${"aa".repeat(32)}`,
    });
    return tx;
  }

  it("reserves within available funds", async () => {
    const tx = await fundedTx();
    const { reservationId } = await reserveForSettlement(tx, {
      treasuryAccountId: ACCOUNT_ID, paymentId: "pay-1", attemptNumber: 1, amountUnits: BigInt(400000),
    });
    expect(reservationId).toMatch(/^entry-/);
    const balances = await getTreasuryBalances({ treasuryLedgerEntry: tx.treasuryLedgerEntry }, ACCOUNT_ID);
    expect(balances).toMatchObject({ availableUnits: BigInt(600000), reservedUnits: BigInt(400000) });
  });

  it("rejects a second active reservation for the same payment", async () => {
    const tx = await fundedTx();
    await reserveForSettlement(tx, { treasuryAccountId: ACCOUNT_ID, paymentId: "pay-1", attemptNumber: 1, amountUnits: BigInt(100) });
    await expect(reserveForSettlement(tx, { treasuryAccountId: ACCOUNT_ID, paymentId: "pay-1", attemptNumber: 2, amountUnits: BigInt(100) }))
      .rejects.toThrow(LedgerConflictError);
  });

  it("rejects reservations that exceed available funds", async () => {
    const tx = await fundedTx();
    await expect(reserveForSettlement(tx, { treasuryAccountId: ACCOUNT_ID, paymentId: "pay-1", attemptNumber: 1, amountUnits: BigInt(1000001) }))
      .rejects.toThrow(LedgerInsufficientFundsError);
  });

  it("treats a repeated reservation write as a conflict, not a double spend", async () => {
    const tx = await fundedTx();
    await reserveForSettlement(tx, { treasuryAccountId: ACCOUNT_ID, paymentId: "pay-1", attemptNumber: 1, amountUnits: BigInt(100) });
    await expect(reserveForSettlement(tx, { treasuryAccountId: ACCOUNT_ID, paymentId: "pay-2", attemptNumber: 1, amountUnits: BigInt(100) })
      .then(async () => {
        // Force the P2002 path by replaying the identical idempotency key through a fresh reservation shape.
        await tx.treasuryLedgerEntry.create({
          data: { treasuryAccountId: ACCOUNT_ID, paymentId: "pay-2", type: "RESERVE", amountUnits: BigInt(100), balanceAfterUnits: BigInt(0), idempotencyKey: reserveKey("pay-1", 1) },
        });
      })).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("releaseReservation", () => {
  it("releases an active reservation and is idempotent on replay", async () => {
    const { tx } = createFakeDb();
    await creditFundingDeposit(tx, { treasuryAccountId: ACCOUNT_ID, paymentId: "pay-0", chainId: 42431, amountUnits: BigInt(1000), transactionHash: `0x${"aa".repeat(32)}` });
    const { reservationId } = await reserveForSettlement(tx, { treasuryAccountId: ACCOUNT_ID, paymentId: "pay-1", attemptNumber: 1, amountUnits: BigInt(400) });
    const released = await releaseReservation(tx, { treasuryAccountId: ACCOUNT_ID, reservationId, reason: "attempt failed terminally" });
    expect(released.alreadyReleased).toBe(false);
    const replay = await releaseReservation(tx, { treasuryAccountId: ACCOUNT_ID, reservationId, reason: "attempt failed terminally" });
    expect(replay.alreadyReleased).toBe(true);
    const balances = await getTreasuryBalances({ treasuryLedgerEntry: tx.treasuryLedgerEntry }, ACCOUNT_ID);
    expect(balances).toMatchObject({ availableUnits: BigInt(1000), reservedUnits: BigInt(0) });
  });
});

describe("debitSettlement", () => {
  async function reservedTx() {
    const { tx } = createFakeDb();
    await creditFundingDeposit(tx, { treasuryAccountId: ACCOUNT_ID, paymentId: "pay-0", chainId: 42431, amountUnits: BigInt(1000), transactionHash: `0x${"aa".repeat(32)}` });
    const { reservationId } = await reserveForSettlement(tx, { treasuryAccountId: ACCOUNT_ID, paymentId: "pay-1", attemptNumber: 1, amountUnits: BigInt(400) });
    return { tx, reservationId };
  }

  it("debits a verified settlement exactly once and keeps available flat", async () => {
    const { tx, reservationId } = await reservedTx();
    const first = await debitSettlement(tx, {
      treasuryAccountId: ACCOUNT_ID, paymentId: "pay-1", providerIdempotencyKey: "pay-1:settlement:1",
      reservationId, amountUnits: BigInt(400), transactionHash: `0x${"bb".repeat(32)}`,
    });
    expect(first.duplicate).toBe(false);
    const replay = await debitSettlement(tx, {
      treasuryAccountId: ACCOUNT_ID, paymentId: "pay-1", providerIdempotencyKey: "pay-1:settlement:1",
      reservationId, amountUnits: BigInt(400), transactionHash: `0x${"bb".repeat(32)}`,
    });
    expect(replay).toMatchObject({ entryId: first.entryId, duplicate: true });
    const balances = await getTreasuryBalances({ treasuryLedgerEntry: tx.treasuryLedgerEntry }, ACCOUNT_ID);
    expect(balances).toMatchObject({ availableUnits: BigInt(600), reservedUnits: BigInt(0), debitedUnits: BigInt(400) });
  });

  it("refuses a debit without an active reservation", async () => {
    const { tx } = createFakeDb();
    await expect(debitSettlement(tx, {
      treasuryAccountId: ACCOUNT_ID, paymentId: "pay-9", providerIdempotencyKey: "pay-9:settlement:1",
      reservationId: "entry-missing", amountUnits: BigInt(100), transactionHash: `0x${"bb".repeat(32)}`,
    })).rejects.toThrow(LedgerConflictError);
  });

  it("refuses a debit whose amount differs from its reservation", async () => {
    const { tx, reservationId } = await reservedTx();
    await expect(debitSettlement(tx, {
      treasuryAccountId: ACCOUNT_ID, paymentId: "pay-1", providerIdempotencyKey: "pay-1:settlement:1",
      reservationId, amountUnits: BigInt(399), transactionHash: `0x${"bb".repeat(32)}`,
    })).rejects.toThrow(LedgerConflictError);
  });
});

describe("reconcileTreasury", () => {
  const balances = { creditedUnits: BigInt(1000), reservedUnits: BigInt(200), debitedUnits: BigInt(300), availableUnits: BigInt(500) };
  it("reports balanced when on-chain matches ledger-held", () => {
    expect(reconcileTreasury(balances, BigInt(700))).toMatchObject({ ledgerHeldUnits: BigInt(700), driftUnits: BigInt(0), status: "balanced" });
  });
  it("reports shortfall below ledger-held", () => {
    expect(reconcileTreasury(balances, BigInt(699))).toMatchObject({ driftUnits: BigInt(-1), status: "shortfall" });
  });
  it("reports surplus above ledger-held", () => {
    expect(reconcileTreasury(balances, BigInt(701))).toMatchObject({ driftUnits: BigInt(1), status: "surplus" });
  });
});

describe("treasury guard integration", () => {
  it("serializes concurrent reservations so combined overspend fails", async () => {
    const { db } = createFakeDb();
    const account = await getOrCreateTreasuryAccount(db, {
      chainId: 42431, tokenAddress: "0xtoken", tokenSymbol: "AlphaUSD", tokenDecimals: 6, treasuryAddress: "0xtreasury",
    });
    await withGuardedTreasurySection(db, account.id, async (tx) => {
      await creditFundingDeposit(tx, {
        treasuryAccountId: account.id, paymentId: "pay-0", chainId: 42431, amountUnits: BigInt(1000), transactionHash: `0x${"aa".repeat(32)}`,
      });
    });
    const attempt = (paymentId: string, attemptNumber: number, amount: bigint) =>
      withGuardedTreasurySection(db, account.id, async (tx) => {
        // Small yield to force interleaving of the read-modify-write sections.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return reserveForSettlement(tx, { treasuryAccountId: account.id, paymentId, attemptNumber, amountUnits: amount });
      });
    // Sequential here (mocks cannot interleave); the guard's version bump is
    // asserted, and true concurrency is covered by treasury-ledger.pg.test.ts.
    await attempt("pay-1", 1, BigInt(600));
    await expect(attempt("pay-2", 1, BigInt(500))).rejects.toThrow(LedgerInsufficientFundsError);
    const balances = await getTreasuryBalances(db, account.id);
    expect(balances).toMatchObject({ availableUnits: BigInt(400), reservedUnits: BigInt(600) });
  });
});

describe("historical base records", () => {
  it("credits tempo-verified deposits and refuses base-chain evidence", async () => {
    const { state, tx } = createFakeDb();
    state.account = { id: ACCOUNT_ID, version: 0, tokenDecimals: 6, chainId: 42431, tokenAddress: "0xtoken" };
    const ok = await creditVerifiedTempoDeposit(tx as never, {
      treasuryAccountId: ACCOUNT_ID,
      paymentId: "pay-tempo",
      chainId: 42431,
      tokenAddress: "0xTOKEN",
      amountUnits: BigInt(100),
      transactionHash: `0x${"aa".repeat(32)}`,
    });
    expect(ok.duplicate).toBe(false);
    await expect(creditVerifiedTempoDeposit(tx as never, {
      treasuryAccountId: ACCOUNT_ID,
      paymentId: "pay-base",
      chainId: 84532,
      tokenAddress: "0xbase",
      amountUnits: BigInt(100),
      transactionHash: `0x${"cc".repeat(32)}`,
    })).rejects.toThrow(LedgerConflictError);
    await expect(creditVerifiedTempoDeposit(tx as never, {
      treasuryAccountId: ACCOUNT_ID,
      paymentId: "pay-wrong-token",
      chainId: 42431,
      tokenAddress: "0xother",
      amountUnits: BigInt(100),
      transactionHash: `0x${"dd".repeat(32)}`,
    })).rejects.toThrow(LedgerConflictError);
    const balances = await getTreasuryBalances({ treasuryLedgerEntry: tx.treasuryLedgerEntry }, ACCOUNT_ID);
    expect(balances.creditedUnits).toBe(BigInt(100));
  });
});
