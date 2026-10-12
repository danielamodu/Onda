import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Real-Postgres settlement lifecycle, concurrency, and crash-recovery proof
// for Phase 8. Runs only when TREASURY_TEST_DATABASE_URL points at a
// throwaway Postgres database with all migrations applied. Skipped otherwise.
// Chain gateways and verifiers are injected fakes; a separate live Moderato
// run covers the real chain path.
const DATABASE_URL = process.env.TREASURY_TEST_DATABASE_URL;
const enabled = Boolean(DATABASE_URL);

const TOKEN = "0x20c0000000000000000000000000000000000001";
const SENDER = "0x1111111111111111111111111111111111111111";

let seq = 0;
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq += 1)}`;
// Globally unique, valid 32-byte hex hashes. Required: destinationTransactionHash
// and funding idempotency keys are UNIQUE in Postgres and tests share one DB.
let hashSeq = 0;
const uniqueHash = () => {
  hashSeq += 1;
  return `0x${(Date.now().toString(16) + hashSeq.toString(16).padStart(8, "0")).padStart(64, "0").slice(-64)}`;
};
const fundingHashFor = () => uniqueHash();
const txHashFor = () => uniqueHash();
const tempoAddressFor = (tag: string) => `0x${tag.padEnd(40, "1").slice(0, 40)}`;

describe.skipIf(!enabled)("settlement lifecycle on postgres", () => {
  let db: import("@prisma/client").PrismaClient;
  let fundPayment: typeof import("@/lib/payments/funding").fundPayment;
  let settlePayment: typeof import("@/lib/payments/settlement/service").settlePayment;
  let settleBatch: typeof import("@/lib/payments/settlement/batches").settleBatch;
  let reconcileStaleSettlements: typeof import("@/lib/payments/settlement/reconcile").reconcileStaleSettlements;
  let TempoNativeSettlementProvider: typeof import("@/lib/payments/tempo/provider").TempoNativeSettlementProvider;
  let ledger: typeof import("@/lib/payments/treasury/ledger");

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL as string;
    process.env.TEMPO_CHAIN_ID = "42431";
    process.env.TEMPO_RPC_URL = "https://rpc.moderato.tempo.xyz";
    process.env.TEMPO_SETTLEMENT_TOKEN_ADDRESS = TOKEN;
    process.env.TEMPO_SETTLEMENT_PRIVATE_KEY = `0x${"55".repeat(32)}`;
    process.env.TEMPO_TREASURY_ADDRESS = SENDER;
    process.env.TEMPO_MAX_BATCH_SIZE = "10";
    const prisma = await import("@prisma/client");
    db = new prisma.PrismaClient();
    ({ fundPayment } = await import("@/lib/payments/funding"));
    ({ settlePayment } = await import("@/lib/payments/settlement/service"));
    ({ settleBatch } = await import("@/lib/payments/settlement/batches"));
    ({ reconcileStaleSettlements } = await import("@/lib/payments/settlement/reconcile"));
    ({ TempoNativeSettlementProvider } = await import("@/lib/payments/tempo/provider"));
    ledger = await import("@/lib/payments/treasury/ledger");
  });

  afterAll(async () => {
    const client = db as unknown as import("@prisma/client").PrismaClient | undefined;
    await client?.$disconnect();
  });

  const fundingConfig = () => ({
    chainId: 42431,
    chainName: "Tempo Moderato",
    rpcUrl: "https://example.invalid",
    tokenAddress: TOKEN,
    tokenSymbol: "AlphaUSB",
    treasuryAddress: SENDER,
    explorerUrl: "https://explore.testnet.tempo.xyz",
  });

  function fakeVerifyFunding() {
    return async () => ({
      state: "verified" as const,
      funding: {
        chainId: 42431,
        transactionHash: "0xunused",
        tokenAddress: TOKEN,
        tokenSymbol: "AlphaUSD",
        tokenDecimals: 6,
        senderAddress: SENDER,
        treasuryAddress: SENDER,
        blockNumber: BigInt(99),
        blockHash: `0x${"cd".repeat(32)}`,
      },
    });
  }

  function fakeGateway(submits: { count: number }, txHash: string = txHashFor()) {
    return {
      loadConfig: () => ({ chainId: 42431 as const, rpcUrl: "https://example.invalid", tokenAddress: TOKEN, settlementPrivateKey: `0x${"55".repeat(32)}` as `0x${string}`, explorerUrl: "https://explore.testnet.tempo.xyz" }),
      deriveSender: () => SENDER,
      getTokenMeta: async () => ({ decimals: 6, symbol: "AlphaUSD" }),
      getSettlementBalance: async () => BigInt("1000000000000"),
      findPriorTransfer: async () => null,
      submitTransfer: async () => {
        submits.count += 1;
        return { transactionHash: txHash, status: "success" as const };
      },
      submitBatchTransfer: async () => {
        submits.count += 1;
        return { transactionHash: txHash, status: "success" as const };
      },
    };
  }

  // Stub verifier: echoes verified evidence derived from the attempt itself,
  // so the service-level evidence cross-check passes deterministically.
  // Mirrors the real verifier: no recorded hash means pending, never verified.
  function verifyingStub() {
    return {
      verifyDestination: async (
        expected: {
          destinationChainId: number; destinationTokenAddress: string; destinationAmount: string; recipientAddress: string; bridgeMessageId: string | null;
        } | null,
        attempt: { sourceTransactionHash: string | null },
      ) => {
        if (!expected || !attempt.sourceTransactionHash) return { state: "pending" as const };
        return {
          state: "verified" as const,
          evidence: {
            destinationChainId: expected.destinationChainId,
            transactionHash: attempt.sourceTransactionHash,
            transactionStatus: "success" as const,
            destinationTokenAddress: expected.destinationTokenAddress,
            destinationAmount: expected.destinationAmount,
            recipientAddress: expected.recipientAddress,
            bridgeMessageId: null,
          },
        };
      },
    };
  }

  async function makeBusiness() {
    const tag = uid("biz");
    return db.business.create({ data: { name: tag, email: `${tag}@example.com` } });
  }

  async function makeRecipient(businessId: string) {
    const tag = uid("rcpt");
    return db.recipient.create({
      data: { businessId, name: tag, identifier: `${tag}@example.com`, tempoAddress: tempoAddressFor(tag.replace(/[^0-9a-f]/gi, "a")) },
    });
  }

  async function makeFundedPayment(businessId: string, recipientId: string, amount: string) {
    const payment = await db.payment.create({
      data: { businessId, recipientId, amount, asset: "AlphaUSD", payoutCurrency: "NGN", status: "created" },
    });
    const hash = fundingHashFor();
    const result = await fundPayment(businessId, payment.id, hash as `0x${string}`, `0x${"ef".repeat(65)}` as `0x${string}`, {
      config: fundingConfig() as never,
      verify: fakeVerifyFunding() as never,
    });
    expect(result.state).toBe("funded");
    return { payment, hash };
  }

  // Legacy-style funded row: verified funding fields but no ledger credit,
  // as produced before the ledger existed.
  async function makeUnbackedFundedPayment(businessId: string, recipientId: string, amount: string) {
    const hash = fundingHashFor();
    return db.payment.create({
      data: {
        businessId, recipientId, amount, asset: "AlphaUSD", payoutCurrency: "NGN", status: "funded",
        transactionHash: hash.toLowerCase(), chainId: 42431, tokenAddress: TOKEN,
        senderAddress: SENDER, destinationAddress: SENDER, confirmedAt: new Date(),
      },
    });
  }

  async function treasuryAccountId() {
    const found = await db.treasuryAccount.findUnique({
      where: { chainId_tokenAddress_treasuryAddress: { chainId: 42431, tokenAddress: TOKEN, treasuryAddress: SENDER } },
    });
    if (found) return found.id;
    const created = await db.treasuryAccount.create({
      data: { chainId: 42431, tokenAddress: TOKEN, tokenSymbol: "AlphaUSD", tokenDecimals: 6, treasuryAddress: SENDER },
    });
    return created.id;
  }

  async function entryTypesFor(paymentId: string) {
    const entries = await db.treasuryLedgerEntry.findMany({ where: { paymentId } });
    return entries.map((entry) => entry.type).sort();
  }

  it("runs the full fund, settle, retry lifecycle with no duplicate ledger rows", async () => {
    const business = await makeBusiness();
    const recipient = await makeRecipient(business.id);
    const { payment } = await makeFundedPayment(business.id, recipient.id, "500.00");
    const submits = { count: 0 };
    const provider = new TempoNativeSettlementProvider(fakeGateway(submits) as never);

    const first = await settlePayment(business.id, payment.id, { provider, verifier: verifyingStub() as never });
    expect(first.state).toBe("settled");
    expect(submits.count).toBe(1);

    const second = await settlePayment(business.id, payment.id, { provider, verifier: verifyingStub() as never });
    expect(second.state).toBe("settled");
    expect(submits.count).toBe(1);

    expect(await db.paymentSettlement.count({ where: { paymentId: payment.id } })).toBe(1);
    expect(await entryTypesFor(payment.id)).toEqual(["CREDIT", "DEBIT", "RESERVE"]);
    expect((await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe("settled");
  });

  it("settles exactly one of two concurrent payments when the pool covers one", async () => {
    const business = await makeBusiness();
    const accountId = await treasuryAccountId();
    // Seed an unattributed top-up so the pool is non-trivial, then size two
    // legacy (uncredited) payments relative to the live balance: each fits
    // alone, both together exceed it. Deterministic on a shared database.
    await ledger.withGuardedTreasurySection(db as never, accountId, async (tx) => {
      await ledger.creditFundingDeposit(tx as never, {
        treasuryAccountId: accountId, paymentId: "ops-topup", chainId: 42431,
        amountUnits: BigInt("10000000"), transactionHash: fundingHashFor(),
      });
    });
    const baseline = await ledger.getTreasuryBalances(db, accountId);
    // Each payment fits alone; both together exceed the pool. Derived from
    // the live balance so the test is deterministic on a shared database.
    // (Legacy unbacked rows are used so the payments don't credit the pool.)
    const eachUnits = baseline.availableUnits / BigInt(2) + BigInt(1000000);
    const human = `${eachUnits / BigInt(1000000)}.${((eachUnits % BigInt(1000000)) / BigInt(10000)).toString().padStart(2, "0")}`;
    const recipientA = await makeRecipient(business.id);
    const recipientB = await makeRecipient(business.id);
    const a = await makeUnbackedFundedPayment(business.id, recipientA.id, human);
    const b = await makeUnbackedFundedPayment(business.id, recipientB.id, human);
    const submitsA = { count: 0 };
    const submitsB = { count: 0 };
    const providerA = new TempoNativeSettlementProvider(fakeGateway(submitsA) as never);
    const providerB = new TempoNativeSettlementProvider(fakeGateway(submitsB) as never);
    const results = await Promise.allSettled([
      settlePayment(business.id, a.id, { provider: providerA, verifier: verifyingStub() as never }),
      settlePayment(business.id, b.id, { provider: providerB, verifier: verifyingStub() as never }),
    ]);
    const settled = results.filter((r) => r.status === "fulfilled" && (r.value as { state: string }).state === "settled");
    expect(settled).toHaveLength(1);
    expect(submitsA.count + submitsB.count).toBe(1);
    const loserId = results[0].status === "fulfilled" && (results[0].value as { state: string }).state === "settled" ? b.id : a.id;
    expect((await db.payment.findUniqueOrThrow({ where: { id: loserId } })).status).toBe("funded");
    expect(await db.paymentSettlement.count({ where: { paymentId: loserId } })).toBe(0);
    expect(await db.treasuryLedgerEntry.count({ where: { paymentId: loserId, type: "RESERVE" } })).toBe(0);
  });

  it("lets exactly one concurrent settle of the same payment win", async () => {
    const business = await makeBusiness();
    const recipient = await makeRecipient(business.id);
    const { payment } = await makeFundedPayment(business.id, recipient.id, "10.00");
    const submits = { count: 0 };
    const provider = new TempoNativeSettlementProvider(fakeGateway(submits) as never);
    const results = await Promise.allSettled([
      settlePayment(business.id, payment.id, { provider, verifier: verifyingStub() as never }),
      settlePayment(business.id, payment.id, { provider, verifier: verifyingStub() as never }),
    ]);
    // At least one request must resolve. Under real Postgres the loser of the
    // claim race may instead reject (its claim and reservation both lost to the
    // winner before the winner's row was visible to re-read) — an accepted,
    // non-destructive loss. What must hold is that no duplicate work happened:
    // the end-state assertions below prove exactly one attempt, reserve, and
    // debit regardless of which path the loser took.
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(results.filter((result) => result.status === "rejected").length).toBeLessThanOrEqual(1);
    // The loser rejoins verification while the winner may not have recorded
    // its transaction yet; one more pass converges without resubmitting.
    const final = await settlePayment(business.id, payment.id, { provider, verifier: verifyingStub() as never });
    expect(final.state).toBe("settled");
    expect(submits.count).toBe(1);
    expect(await db.paymentSettlement.count({ where: { paymentId: payment.id } })).toBe(1);
    expect(await db.treasuryLedgerEntry.count({ where: { paymentId: payment.id, type: "RESERVE" } })).toBe(1);
    expect(await db.treasuryLedgerEntry.count({ where: { paymentId: payment.id, type: "DEBIT" } })).toBe(1);
  });

  it("recovers a debit-without-settle crash with no second debit", async () => {
    const business = await makeBusiness();
    const recipient = await makeRecipient(business.id);
    const { payment } = await makeFundedPayment(business.id, recipient.id, "10.00");
    const submits = { count: 0 };
    const txHash = txHashFor();
    const provider = new TempoNativeSettlementProvider(fakeGateway(submits, txHash) as never);
    const pendingVerifier = { verifyDestination: async () => ({ state: "pending" as const }) };
    const first = await settlePayment(business.id, payment.id, { provider, verifier: pendingVerifier as never });
    expect(first.state).toBe("settling");
    // Simulate the crash window: debit landed, settle-status update did not.
    const accountId = await treasuryAccountId();
    const attempt = await db.paymentSettlement.findFirstOrThrow({ where: { paymentId: payment.id }, orderBy: { attemptNumber: "desc" } });
    await ledger.withGuardedTreasurySection(db as never, accountId, async (tx) => {
      const reservation = await ledger.findActiveReservationForPayment(tx as never, accountId, payment.id);
      if (!reservation) throw new Error("expected active reservation");
      await ledger.debitSettlement(tx as never, {
        treasuryAccountId: accountId,
        paymentId: payment.id,
        providerIdempotencyKey: attempt.providerIdempotencyKey,
        reservationId: reservation.id,
        amountUnits: BigInt("10000000"),
        transactionHash: txHash,
      });
    });
    const recovered = await settlePayment(business.id, payment.id, { provider, verifier: verifyingStub() as never });
    expect(recovered.state).toBe("settled");
    expect(await db.treasuryLedgerEntry.count({ where: { paymentId: payment.id, type: "DEBIT" } })).toBe(1);
  });

  it("claims one of two duplicate concurrent batches and leaves no partial rows for the loser", async () => {
    const business = await makeBusiness();
    const recipientA = await makeRecipient(business.id);
    const recipientB = await makeRecipient(business.id);
    const a = await makeFundedPayment(business.id, recipientA.id, "5.00");
    const b = await makeFundedPayment(business.id, recipientB.id, "5.00");
    const submits = { count: 0 };
    const provider = new TempoNativeSettlementProvider(fakeGateway(submits) as never);
    const ids = [a.payment.id, b.payment.id];
    const results = await Promise.allSettled([
      settleBatch(business.id, ids, { provider, verifier: verifyingStub() as never }),
      settleBatch(business.id, ids, { provider, verifier: verifyingStub() as never }),
    ]);
    const settled = results.filter((r) => r.status === "fulfilled" && (r.value as { state: string }).state === "settled");
    expect(settled.length).toBeGreaterThanOrEqual(1);
    const batches = await db.settlementBatch.findMany({ where: { providerIdempotencyKey: `batch:${[...ids].sort().join(",")}` } });
    expect(batches).toHaveLength(1);
    expect(submits.count).toBe(1);
  });

  it("lets one overlapping batch win without partial rows for the loser", async () => {
    const business = await makeBusiness();
    const recipientA = await makeRecipient(business.id);
    const recipientB = await makeRecipient(business.id);
    const recipientC = await makeRecipient(business.id);
    const a = await makeFundedPayment(business.id, recipientA.id, "5.00");
    const b = await makeFundedPayment(business.id, recipientB.id, "5.00");
    const c = await makeFundedPayment(business.id, recipientC.id, "5.00");
    const submits = { count: 0 };
    const provider = new TempoNativeSettlementProvider(fakeGateway(submits) as never);
    const results = await Promise.allSettled([
      settleBatch(business.id, [a.payment.id, b.payment.id], { provider, verifier: verifyingStub() as never }),
      settleBatch(business.id, [a.payment.id, c.payment.id], { provider, verifier: verifyingStub() as never }),
    ]);
    const settledCount = results.filter((r) => r.status === "fulfilled" && (r.value as { state: string }).state === "settled").length;
    expect(settledCount).toBe(1);
    const batchKeys = [
      `batch:${[a.payment.id, b.payment.id].sort().join(",")}`,
      `batch:${[a.payment.id, c.payment.id].sort().join(",")}`,
    ];
    const shells = await db.settlementBatch.findMany({ where: { providerIdempotencyKey: { in: batchKeys }, status: "pending" } });
    for (const shell of shells) {
      // A losing shell must own no attempts and therefore no reservations.
      expect(await db.paymentSettlement.count({ where: { batchId: shell.id } })).toBe(0);
    }
    expect(await db.payment.count({ where: { id: { in: [a.payment.id, b.payment.id, c.payment.id] }, status: "settled" } })).toBe(2);
  });

  it("enforces ledger uniqueness and foreign-key constraints", async () => {
    const accountId = await treasuryAccountId();
    const key = `funding:42431:${uniqueHash()}`;
    await db.treasuryLedgerEntry.create({
      data: { treasuryAccountId: accountId, type: "CREDIT", amountUnits: BigInt(1), balanceAfterUnits: BigInt(1), idempotencyKey: key },
    });
    await expect(db.treasuryLedgerEntry.create({
      data: { treasuryAccountId: accountId, type: "CREDIT", amountUnits: BigInt(1), balanceAfterUnits: BigInt(2), idempotencyKey: key },
    })).rejects.toMatchObject({ code: "P2002" });
    await expect(db.treasuryLedgerEntry.create({
      data: { treasuryAccountId: "missing-account", type: "CREDIT", amountUnits: BigInt(1), balanceAfterUnits: BigInt(1), idempotencyKey: uid("k") },
    })).rejects.toMatchObject({ code: "P2003" });
    await expect(db.treasuryLedgerEntry.create({
      data: { treasuryAccountId: accountId, type: "RELEASE", amountUnits: BigInt(1), balanceAfterUnits: BigInt(1), reservationId: "missing-entry", idempotencyKey: uid("k") },
    })).rejects.toMatchObject({ code: "P2003" });
    await expect(db.paymentSettlement.create({
      data: {
        paymentId: "missing-payment", attemptNumber: 1, provider: "x",
        providerIdempotencyKey: uid("k"), status: "pending", verificationStatus: "unverified",
      },
    })).rejects.toMatchObject({ code: "P2003" });
  });

  it("exhausts guarded retries under perpetual contention with no partial writes", async () => {
    const accountId = await treasuryAccountId();
    const before = await db.treasuryLedgerEntry.count({ where: { treasuryAccountId: accountId } });
    await expect(ledger.withGuardedTreasurySection(db as never, accountId, async (tx) => {
      // Simulate a concurrent committer so our own version bump always loses.
      await (tx as typeof db).treasuryAccount.updateMany({ where: { id: accountId }, data: { version: { increment: 1 } } });
      await (tx as typeof db).treasuryLedgerEntry.create({
        data: { treasuryAccountId: accountId, type: "ADJUSTMENT", amountUnits: BigInt(1), balanceAfterUnits: BigInt(0), idempotencyKey: uid("adj") },
      });
      return "unreachable";
    }, 2)).rejects.toThrow(/contention/i);
    expect(await db.treasuryLedgerEntry.count({ where: { treasuryAccountId: accountId } })).toBe(before);
  });

  it("sweeper recovers a stale crash-before-submit single payment end to end", async () => {
    const business = await makeBusiness();
    const recipient = await makeRecipient(business.id);
    const { payment } = await makeFundedPayment(business.id, recipient.id, "7.00");
    const submits = { count: 0 };
    const provider = new TempoNativeSettlementProvider(fakeGateway(submits) as never);
    // First pass claims and reserves but the initiation record never lands:
    // simulate by backdating a manually created pending attempt with no tx.
    await db.$transaction(async (tx) => {
      await tx.payment.updateMany({ where: { id: payment.id }, data: { status: "settling" } });
      await tx.paymentSettlement.create({
        data: {
          paymentId: payment.id, attemptNumber: 1, provider: "tempo-native",
          providerIdempotencyKey: `${payment.id}:settlement:1`,
          status: "pending", verificationStatus: "unverified",
          sourceChainId: 42431, sourceAsset: "AlphaUSD", sourceTokenAddress: TOKEN,
          sourceAmount: "7.00", sourceTransactionHash: null,
          initiatedAt: new Date(Date.now() - 3600_000),
        },
      });
    });
    const accountId = await treasuryAccountId();
    await ledger.withGuardedTreasurySection(db as never, accountId, async (tx) => {
      await ledger.reserveForSettlement(tx as never, {
        treasuryAccountId: accountId, paymentId: payment.id, attemptNumber: 1, amountUnits: BigInt("7000000"),
      });
    });
    const stale = new Date(Date.now() - 3600_000);
    await db.payment.update({ where: { id: payment.id }, data: { updatedAt: stale } });
    await db.paymentSettlement.updateMany({ where: { paymentId: payment.id }, data: { updatedAt: stale } });

    const { items } = await reconcileStaleSettlements({ businessId: business.id, olderThanMs: 60_000 }, {
      provider, verifier: verifyingStub() as never, fundingConfig: fundingConfig() as never,
    });
    const item = items.find((entry) => entry.kind === "settlement" && entry.id === payment.id);
    expect(item?.outcome).toBe("settled");
    expect(submits.count).toBe(1);
    expect((await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe("settled");
    // Manual hold + superseding hold + exactly one debit; no duplicates.
    expect(await db.treasuryLedgerEntry.count({ where: { paymentId: payment.id, type: "RESERVE" } })).toBe(2);
    expect(await db.treasuryLedgerEntry.count({ where: { paymentId: payment.id, type: "RELEASE" } })).toBe(1);
    expect(await db.treasuryLedgerEntry.count({ where: { paymentId: payment.id, type: "DEBIT" } })).toBe(1);
  });

  it("sweeper rejoins a stale pending batch without resubmitting blindly", async () => {
    const business = await makeBusiness();
    const recipientA = await makeRecipient(business.id);
    const recipientB = await makeRecipient(business.id);
    const a = await makeFundedPayment(business.id, recipientA.id, "5.00");
    const b = await makeFundedPayment(business.id, recipientB.id, "5.00");
    const submits = { count: 0 };
    const provider = new TempoNativeSettlementProvider(fakeGateway(submits) as never);
    // Drive a batch to the pending-hold state: verifier stays pending.
    const holding = { verifyDestination: async () => ({ state: "pending" as const }) };
    const first = await settleBatch(business.id, [a.payment.id, b.payment.id], { provider, verifier: holding as never });
    expect(first.state).toBe("settling");
    expect(submits.count).toBe(1);
    const stale = new Date(Date.now() - 3600_000);
    const batchIds = (await db.settlementBatch.findMany({
      where: { paymentIds: { hasSome: [a.payment.id] } },
      select: { id: true },
    })).map((row) => row.id);
    await db.settlementBatch.updateMany({ where: { id: { in: batchIds } }, data: { updatedAt: stale } });
    await db.paymentSettlement.updateMany({ where: { paymentId: { in: [a.payment.id, b.payment.id] } }, data: { updatedAt: stale } });
    await db.payment.updateMany({ where: { id: { in: [a.payment.id, b.payment.id] } }, data: { updatedAt: stale } });

    const { items } = await reconcileStaleSettlements({ businessId: business.id, olderThanMs: 60_000 }, {
      provider, verifier: verifyingStub() as never, fundingConfig: fundingConfig() as never,
    });
    const ours = await db.settlementBatch.findFirstOrThrow({
      where: { paymentIds: { hasSome: [a.payment.id] }, status: "settled" },
    });
    const item = items.find((entry) => entry.kind === "batch" && entry.id === ours.id);
    expect(item?.outcome).toBe("settled");
    // The original submission was adopted, not duplicated.
    expect(submits.count).toBe(1);
    expect(await db.payment.count({ where: { id: { in: [a.payment.id, b.payment.id] }, status: "settled" } })).toBe(2);
  });
});
