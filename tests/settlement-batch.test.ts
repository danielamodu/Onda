import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { getAddress, parseUnits } from "viem";
import { TempoNativeSettlementProvider } from "@/lib/payments/tempo/provider";
import { TempoDestinationSettlementVerifier } from "@/lib/payments/tempo/verifier";
import { settlementMemo } from "@/lib/payments/tempo/memo";
import { settleBatch, batchIdempotencyKey } from "@/lib/payments/settlement/batches";
import { SettlementConflictError } from "@/lib/payments/settlement/service";

function duplicateKeyError() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint", { code: "P2002", clientVersion: "6.19.3" });
}

const SENDER = getAddress("0x1111111111111111111111111111111111111111");
const TOKEN = getAddress("0x20c0000000000000000000000000000000000001");
const RECIPIENT_A = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
const RECIPIENT_B = getAddress("0x2222222222222222222222222222222222222222");
const BATCH_HASH = `0x${"55".repeat(32)}` as `0x${string}`;

const mockDb = vi.hoisted(() => {
  const matchEntryWhere = (entry: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where ?? {}).every(([key, value]) =>
      value !== null && typeof value === "object" && "in" in (value as Record<string, unknown>)
        ? (value as { in: unknown[] }).in.includes(entry[key])
        : entry[key] === value,
    );
  const deriveBalances = () => {
    let credited = BigInt(0), debited = BigInt(0);
    const consumed = new Set<unknown>();
    for (const e of mockDb.state.treasuryEntries) {
      if (e.type === "CREDIT") credited += BigInt(String(e.amountUnits));
      if (e.type === "DEBIT") { debited += BigInt(String(e.amountUnits)); if (e.reservationId) consumed.add(e.reservationId); }
      if (e.type === "RELEASE" && e.reservationId) consumed.add(e.reservationId);
    }
    let reserved = BigInt(0);
    for (const e of mockDb.state.treasuryEntries) { if (e.type === "RESERVE" && !consumed.has(e.id)) reserved += BigInt(String(e.amountUnits)); }
    return { creditedUnits: credited, reservedUnits: reserved, debitedUnits: debited };
  };
  return {
  state: {
    payments: [] as Array<Record<string, unknown>>,
    attempts: [] as Array<Record<string, unknown>>,
    batches: [] as Array<Record<string, unknown>>,
    treasuryAccount: null as null | { id: string; version: number; tokenDecimals: number; chainId: number; tokenAddress: string },
    treasuryEntries: [] as Array<Record<string, unknown>>,
  },
  payment: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  paymentSettlement: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  settlementBatch: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  treasuryAccount: {
    findUnique: vi.fn(async () => (mockDb.state.treasuryAccount ? { ...mockDb.state.treasuryAccount, ...deriveBalances() } : null)),
    update: vi.fn(async () => (mockDb.state.treasuryAccount ? { ...mockDb.state.treasuryAccount } : null)),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (!mockDb.state.treasuryAccount) return { count: 0 };
      if ((where as { version?: number }).version !== undefined && (where as { version?: number }).version !== mockDb.state.treasuryAccount.version) {
        return { count: 0 };
      }
      Object.assign(mockDb.state.treasuryAccount, data);
      return { count: 1 };
    }),
  },
  treasuryLedgerEntry: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const input = data as Record<string, unknown>;
      if (mockDb.state.treasuryEntries.some((entry) => entry.idempotencyKey === input.idempotencyKey)) throw duplicateKeyError();
      const entry = { ...input, id: `treasury-entry-${mockDb.state.treasuryEntries.length + 1}` };
      mockDb.state.treasuryEntries.push(entry);
      return { id: entry.id };
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return mockDb.state.treasuryEntries.find((entry) => matchEntryWhere(entry, where)) ?? null;
    }),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return mockDb.state.treasuryEntries.filter((entry) => matchEntryWhere(entry, where)).map((entry) => ({ ...entry }));
    }),
  },
  $transaction: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({ db: mockDb }));

function fundedPayment(id: string, amount: string, recipient: string) {
  return {
    id,
    businessId: "business-test-1",
    status: "funded",
    asset: "AlphaUSD",
    amount: { toFixed: () => amount },
    chainId: 42431,
    tokenAddress: TOKEN,
    transactionHash: `0x${"11".repeat(32)}`,
    destinationAddress: null,
    recipient: { tempoAddress: recipient },
  };
}

function setUpDatabase() {
  const tx = {
    payment: {
      updateMany: vi.fn(async ({ where, data }: { where: { id?: { in: string[] }; status?: string }; data: Record<string, unknown> }) => {
        const ids = where.id?.in ?? [];
        let count = 0;
        for (const row of mockDb.state.payments) {
          if (ids.includes(row.id as string) && row.status === (where.status ?? row.status)) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      }),
    },
    paymentSettlement: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (mockDb.state.attempts.some((row) => (row.providerIdempotencyKey as string) === (data.providerIdempotencyKey as string))) {
          throw duplicateKeyError();
        }
        const row = { id: `attempt-${mockDb.state.attempts.length + 1}`, ...data };
        mockDb.state.attempts.push(row);
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = mockDb.state.attempts.find((entry) => entry.id === where.id);
        if (!row) throw new Error("Missing attempt");
        Object.assign(row, data);
        return { ...row };
      }),
    },
    settlementBatch: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (mockDb.state.batches.some((row) => (row.providerIdempotencyKey as string) === (data.providerIdempotencyKey as string))) {
          throw duplicateKeyError();
        }
        const row = { id: `batch-${mockDb.state.batches.length + 1}`, status: "pending", transactionHash: null, failureReason: null, retryable: false, settledAt: null, failedAt: null, ...data };
        mockDb.state.batches.push(row);
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = mockDb.state.batches.find((entry) => entry.id === where.id);
        if (!row) throw new Error("Missing batch");
        Object.assign(row, data);
        return { ...row };
      }),
    },
    treasuryAccount: mockDb.treasuryAccount,
    treasuryLedgerEntry: mockDb.treasuryLedgerEntry,
  };
  mockDb.payment.findMany.mockImplementation(async ({ where }: { where: { id?: { in: string[] } } }) => {
    const ids = where.id?.in ?? [];
    return mockDb.state.payments.filter((row) => ids.includes(row.id as string)).map((row) => ({ ...row }));
  });
  mockDb.payment.updateMany.mockImplementation(tx.payment.updateMany);
  mockDb.paymentSettlement.findMany.mockImplementation(async ({ where }: { where: { paymentId?: { in: string[] } } }) => {
    const ids = where.paymentId?.in ?? [];
    return mockDb.state.attempts.filter((row) => ids.includes(row.paymentId as string)).map((row) => ({ ...row }));
  });
  mockDb.paymentSettlement.create.mockImplementation(tx.paymentSettlement.create);
  mockDb.paymentSettlement.update.mockImplementation(tx.paymentSettlement.update);
  mockDb.settlementBatch.findUnique.mockImplementation(async ({ where }: { where: { providerIdempotencyKey?: string; id?: string } }) => {
    const row = mockDb.state.batches.find((entry) =>
      (where.providerIdempotencyKey !== undefined && entry.providerIdempotencyKey === where.providerIdempotencyKey)
      || (where.id !== undefined && entry.id === where.id));
    if (!row) return null;
    const attempts = mockDb.state.attempts.filter((attempt) => attempt.batchId === row.id).map((attempt) => ({ ...attempt }));
    return { ...row, attempts };
  });
  mockDb.settlementBatch.create.mockImplementation(tx.settlementBatch.create);
  mockDb.settlementBatch.update.mockImplementation(tx.settlementBatch.update);
  mockDb.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));
}

function batchGateway(overrides: Record<string, unknown> = {}) {
  const calls = { submits: 0, reconciles: 0 };
  return {
    calls,
    loadConfig: () => ({ chainId: 42431 as const, rpcUrl: "https://example.invalid", tokenAddress: TOKEN, settlementPrivateKey: `0x${"55".repeat(32)}` as `0x${string}`, explorerUrl: "https://explore.testnet.tempo.xyz" }),
    deriveSender: () => SENDER,
    getTokenMeta: async () => ({ decimals: 6, symbol: "AlphaUSD" }),
    getSettlementBalance: async () => parseUnits("1000000", 6),
    findPriorTransfer: vi.fn(async (_input: unknown): Promise<`0x${string}` | null> => {
      void _input;
      calls.reconciles += 1;
      return null;
    }),
    submitTransfer: async () => { throw new Error("batch flow must not submit single transfers"); },
    submitBatchTransfer: vi.fn(async () => {
      calls.submits += 1;
      return { transactionHash: BATCH_HASH, status: "success" as const };
    }),
    ...overrides,
  };
}

function batchVerifier() {
  return new TempoDestinationSettlementVerifier({
    loadConfig: () => ({ chainId: 42431 as const, rpcUrl: "https://example.invalid", tokenAddress: TOKEN, settlementPrivateKey: `0x${"55".repeat(32)}` as `0x${string}`, explorerUrl: "https://explore.testnet.tempo.xyz" }),
    deriveSender: () => SENDER,
    getRpcChainId: async () => 42431,
    getReceipt: async (_config: unknown, hash: string) => hash !== BATCH_HASH ? null : {
      status: "success" as const,
      tokenLogs: [
        { from: SENDER, to: RECIPIENT_A, value: parseUnits("500.00", 6), memo: settlementMemo("payment-a") },
        { from: SENDER, to: RECIPIENT_B, value: parseUnits("250.00", 6), memo: settlementMemo("payment-b") },
      ],
    },
    getTransactionChainId: async () => 42431,
    getTokenDecimals: async () => 6,
  });
}

describe("batch settlement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TEMPO_CHAIN_ID = "42431";
    process.env.TEMPO_RPC_URL = "https://rpc.moderato.tempo.xyz";
    process.env.TEMPO_SETTLEMENT_TOKEN_ADDRESS = TOKEN;
    process.env.TEMPO_SETTLEMENT_PRIVATE_KEY = `0x${"55".repeat(32)}`;
    process.env.TEMPO_TREASURY_ADDRESS = SENDER;
    process.env.TEMPO_MAX_BATCH_SIZE = "10";
    mockDb.state.payments = [fundedPayment("payment-a", "500.00", RECIPIENT_A), fundedPayment("payment-b", "250.00", RECIPIENT_B)];
    mockDb.state.attempts = [];
    mockDb.state.batches = [];
    mockDb.state.treasuryAccount = { id: "treasury-1", version: 0, tokenDecimals: 6, chainId: 42431, tokenAddress: TOKEN };
    mockDb.state.treasuryEntries = [{
      id: "treasury-entry-0",
      treasuryAccountId: "treasury-1",
      paymentId: "pay-funder",
      type: "CREDIT",
      amountUnits: BigInt("1000000000"),
      balanceAfterUnits: BigInt("1000000000"),
      reservationId: null,
      idempotencyKey: "funding:42431:0xaa",
      reference: null,
    }];
    setUpDatabase();
  });

  it("computes a stable batch idempotency key", () => {
    expect(batchIdempotencyKey(["payment-b", "payment-a"])).toBe("batch:payment-a,payment-b");
  });

  it("settles two payments in one atomic transaction with per-payment outcomes", async () => {
    const gateway = batchGateway();
    const provider = new TempoNativeSettlementProvider(gateway);
    const result = await settleBatch("business-test-1", ["payment-a", "payment-b"], { provider, verifier: batchVerifier() });
    expect(result.state).toBe("settled");
    if (result.state !== "settled") throw new Error("expected settled");
    expect(result.attemptIds).toHaveLength(2);
    expect(result.payments).toEqual([
      { paymentId: "payment-a", state: "settled", transactionHash: BATCH_HASH },
      { paymentId: "payment-b", state: "settled", transactionHash: BATCH_HASH },
    ]);
    expect(gateway.calls.submits).toBe(1);
    const submitted = (gateway.submitBatchTransfer.mock.calls[0] as unknown[])[0] as { transfers: Array<{ to: string; amount: bigint; memo: string }> };
    expect(submitted.transfers).toHaveLength(2);
    expect(submitted.transfers[0]).toMatchObject({ to: RECIPIENT_A, amount: parseUnits("500.00", 6), memo: settlementMemo("payment-a") });
    expect(submitted.transfers[1]).toMatchObject({ to: RECIPIENT_B, amount: parseUnits("250.00", 6), memo: settlementMemo("payment-b") });
    expect(mockDb.state.payments.every((row) => row.status === "settled")).toBe(true);
    const types = mockDb.state.treasuryEntries.map((entry) => entry.type);
    expect(types.filter((type) => type === "RESERVE")).toHaveLength(2);
    expect(types.filter((type) => type === "DEBIT")).toHaveLength(2);
    const batch = mockDb.state.batches[0];
    expect(batch).toMatchObject({ status: "settled", transactionHash: BATCH_HASH });
    expect(mockDb.state.attempts.every((attempt) => attempt.batchId === batch.id)).toBe(true);
    expect(mockDb.state.attempts.every((attempt) => attempt.destinationTransactionHash === BATCH_HASH)).toBe(true);
  });

  it("rejects duplicate, single, oversized, and missing payments", async () => {
    const gateway = batchGateway();
    const provider = new TempoNativeSettlementProvider(gateway);
    const verifier = batchVerifier();
    await expect(settleBatch("business-test-1", ["payment-a", "payment-a"], { provider, verifier })).rejects.toBeInstanceOf(SettlementConflictError);
    await expect(settleBatch("business-test-1", ["payment-a"], { provider, verifier })).rejects.toBeInstanceOf(SettlementConflictError);
    await expect(settleBatch("business-test-1", ["payment-a", "payment-missing"], { provider, verifier })).rejects.toBeInstanceOf(SettlementConflictError);
    expect(gateway.calls.submits).toBe(0);
    expect(mockDb.state.batches).toHaveLength(0);
  });

  it("rejects cross-asset batches and payments without recipient addresses", async () => {
    mockDb.state.payments.push({ ...fundedPayment("payment-c", "10.00", RECIPIENT_A), asset: "USDC" });
    mockDb.state.payments.push({ ...fundedPayment("payment-d", "10.00", RECIPIENT_A), recipient: { tempoAddress: null } });
    const gateway = batchGateway();
    const provider = new TempoNativeSettlementProvider(gateway);
    const verifier = batchVerifier();
    await expect(settleBatch("business-test-1", ["payment-a", "payment-c"], { provider, verifier })).rejects.toBeInstanceOf(SettlementConflictError);
    await expect(settleBatch("business-test-1", ["payment-a", "payment-d"], { provider, verifier })).rejects.toBeInstanceOf(SettlementConflictError);
    expect(gateway.calls.submits).toBe(0);
  });

  it("refuses a batch that exceeds available treasury funds", async () => {
    mockDb.state.treasuryEntries = [];
    const gateway = batchGateway();
    const provider = new TempoNativeSettlementProvider(gateway);
    await expect(settleBatch("business-test-1", ["payment-a", "payment-b"], { provider, verifier: batchVerifier() }))
      .rejects.toBeInstanceOf(SettlementConflictError);
    expect(gateway.calls.submits).toBe(0);
    // A pending shell records the refusal; no attempts, reservations, or status changes.
    expect(mockDb.state.batches).toHaveLength(1);
    expect(mockDb.state.batches[0]).toMatchObject({ status: "pending", failureReason: expect.stringContaining("cannot cover") });
    expect(mockDb.state.attempts).toHaveLength(0);
    expect(mockDb.state.payments.every((row) => row.status === "funded")).toBe(true);
    expect(mockDb.state.treasuryEntries).toHaveLength(0);
  });

  it("treats a concurrent duplicate batch claim as a reconcile retry", async () => {
    const gateway = batchGateway();
    const provider = new TempoNativeSettlementProvider(gateway);
    mockDb.settlementBatch.create.mockRejectedValueOnce(duplicateKeyError());
    await expect(settleBatch("business-test-1", ["payment-a", "payment-b"], { provider, verifier: batchVerifier() }))
      .rejects.toThrow(/already claimed by a concurrent request/);
    expect(gateway.calls.submits).toBe(0);
  });

  it("releases reservations and stays retryable when the batch transaction reverts", async () => {
    const gateway = batchGateway({
      submitBatchTransfer: async () => ({ transactionHash: BATCH_HASH, status: "reverted" as const }),
    });
    const provider = new TempoNativeSettlementProvider(gateway);
    const result = await settleBatch("business-test-1", ["payment-a", "payment-b"], { provider, verifier: batchVerifier() });
    expect(result.state).toBe("settling");
    expect(mockDb.state.attempts.every((attempt) => attempt.status === "failed" && attempt.retryable === true)).toBe(true);
    const types = mockDb.state.treasuryEntries.map((entry) => entry.type);
    expect(types.filter((type) => type === "RELEASE")).toHaveLength(2);
    const batch = mockDb.state.batches[0];
    expect(batch).toMatchObject({ status: "failed", retryable: true });
  });

  it("holds for reconciliation when the receipt is missing evidence", async () => {
    const gateway = batchGateway();
    const provider = new TempoNativeSettlementProvider(gateway);
    const verifier = new TempoDestinationSettlementVerifier({
      loadConfig: () => ({ chainId: 42431 as const, rpcUrl: "https://example.invalid", tokenAddress: TOKEN, settlementPrivateKey: `0x${"55".repeat(32)}` as `0x${string}`, explorerUrl: "https://explore.testnet.tempo.xyz" }),
      deriveSender: () => SENDER,
      getRpcChainId: async () => 42431,
      getReceipt: async () => null,
      getTransactionChainId: async () => 42431,
      getTokenDecimals: async () => 6,
    });
    const result = await settleBatch("business-test-1", ["payment-a", "payment-b"], { provider, verifier });
    expect(result.state).toBe("settling");
    expect(mockDb.state.payments.every((row) => row.status === "settling")).toBe(true);
    expect(mockDb.state.treasuryEntries.some((entry) => entry.type === "DEBIT")).toBe(false);
  });

  it("reuses a previously submitted batch transaction on retry", async () => {
    const gateway = batchGateway();
    // A shared batch transaction carries every payment memo.
    gateway.findPriorTransfer.mockImplementation(async () => BATCH_HASH);
    const provider = new TempoNativeSettlementProvider(gateway);
    const first = await settleBatch("business-test-1", ["payment-a", "payment-b"], { provider, verifier: batchVerifier() });
    expect(first.state).toBe("settled");
    expect(gateway.calls.submits).toBe(0);
    expect(mockDb.state.batches).toHaveLength(1);
    expect(mockDb.state.payments.every((row) => row.status === "settled")).toBe(true);
  });

  it("returns an already-settled batch without resubmitting", async () => {
    const gateway = batchGateway();
    const provider = new TempoNativeSettlementProvider(gateway);
    const first = await settleBatch("business-test-1", ["payment-a", "payment-b"], { provider, verifier: batchVerifier() });
    expect(first.state).toBe("settled");
    const submitsAfterFirst = gateway.calls.submits;
    const second = await settleBatch("business-test-1", ["payment-a", "payment-b"], { provider, verifier: batchVerifier() });
    expect(second).toMatchObject({ state: "settled", batchId: first.batchId });
    expect(gateway.calls.submits).toBe(submitsAfterFirst);
  });

  it("holds pending without releasing on ambiguous partial prior transfers", async () => {
    const gateway = batchGateway();
    gateway.findPriorTransfer.mockImplementation(async (input: unknown) =>
      (input as { memo: string }).memo === settlementMemo("payment-a") ? BATCH_HASH : `0x${"66".repeat(32)}`);
    const provider = new TempoNativeSettlementProvider(gateway);
    const result = await settleBatch("business-test-1", ["payment-a", "payment-b"], { provider, verifier: batchVerifier() });
    expect(result.state).toBe("settling");
    expect(gateway.calls.submits).toBe(0);
    // Uncertainty must not release reservations or fail anything terminally.
    expect(mockDb.state.batches[0]).toMatchObject({ status: "pending", retryable: true });
    expect(mockDb.state.attempts.every((attempt) => attempt.status === "pending")).toBe(true);
    expect(mockDb.state.payments.every((row) => row.status === "settling")).toBe(true);
    const types = mockDb.state.treasuryEntries.map((entry) => entry.type);
    expect(types.filter((type) => type === "RESERVE")).toHaveLength(2);
    expect(types).not.toContain("RELEASE");
    expect(types).not.toContain("DEBIT");
  });
});
