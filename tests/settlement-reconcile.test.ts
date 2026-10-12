import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  payments: [] as Array<Record<string, unknown>>,
  attempts: [] as Array<Record<string, unknown>>,
  batches: [] as Array<Record<string, unknown>>,
  treasuryAccount: null as null | Record<string, unknown>,
  treasuryEntries: [] as Array<Record<string, unknown>>,
}));

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where ?? {}).every(([key, value]) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const cond = value as Record<string, unknown>;
      if ("lt" in cond) return (row[key] as Date) < (cond.lt as Date);
      if ("not" in cond) return row[key] !== cond.not;
      if ("in" in cond) return (cond.in as Array<unknown>).includes(row[key]);
      return true;
    }
    return row[key] === value;
  });
}

vi.mock("@/lib/db", () => ({
  db: {
    payment: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        mockDb.payments.filter((row) => matches(row, where)).map((row) => ({ ...row }))),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        mockDb.payments.find((row) => matches(row, where)) ?? null),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of mockDb.payments) {
          if (matches(row, where)) {
            Object.assign(row, typeof data === "object" ? data : {});
            count += 1;
          }
        }
        return { count };
      }),
    },
    paymentSettlement: {
      findFirst: vi.fn(async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: Record<string, unknown> }) => {
        const rows = mockDb.attempts.filter((row) => matches(row, where));
        if (orderBy && "attemptNumber" in orderBy) {
          rows.sort((a, b) => (orderBy.attemptNumber === "desc" ? Number(b.attemptNumber) - Number(a.attemptNumber) : Number(a.attemptNumber) - Number(b.attemptNumber)));
        }
        const found = rows[0];
        return found ? { ...found } : null;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        mockDb.attempts.filter((row) => matches(row, where)).map((row) => ({ ...row }))),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (mockDb.attempts.some((row) => row.providerIdempotencyKey === data.providerIdempotencyKey)) {
          const { Prisma } = await import("@prisma/client");
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint", { code: "P2002", clientVersion: "6.19.3" });
        }
        const row = { id: `attempt-${mockDb.attempts.length + 1}`, ...data };
        mockDb.attempts.push(row);
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = mockDb.attempts.find((entry) => entry.id === where.id);
        if (!row) throw new Error("Missing attempt");
        Object.assign(row, data);
        return { ...row };
      }),
    },
    settlementBatch: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = mockDb.batches.find((entry) =>
          (where.providerIdempotencyKey !== undefined && entry.providerIdempotencyKey === where.providerIdempotencyKey)
          || (where.id !== undefined && entry.id === where.id));
        if (!row) return null;
        return { ...row, attempts: mockDb.attempts.filter((attempt) => attempt.batchId === row.id).map((attempt) => ({ ...attempt })) };
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return mockDb.batches.filter((row) => matches(row, where)).map((row) => ({ ...row }));
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (mockDb.batches.some((row) => row.providerIdempotencyKey === data.providerIdempotencyKey)) {
          const { Prisma } = await import("@prisma/client");
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint", { code: "P2002", clientVersion: "6.19.3" });
        }
        const row = { id: `batch-${mockDb.batches.length + 1}`, status: "pending", transactionHash: null, failureReason: null, retryable: false, settledAt: null, failedAt: null, ...data };
        mockDb.batches.push(row);
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = mockDb.batches.find((entry) => entry.id === where.id);
        if (!row) throw new Error("Missing batch");
        Object.assign(row, data);
        return { ...row };
      }),
    },
    treasuryAccount: {
      findUnique: vi.fn(async () => (mockDb.treasuryAccount ? { ...mockDb.treasuryAccount } : null)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (mockDb.treasuryAccount) {
          const { Prisma } = await import("@prisma/client");
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint", { code: "P2002", clientVersion: "6.19.3" });
        }
        mockDb.treasuryAccount = { id: "treasury-1", version: 0, tokenDecimals: 6, chainId: 42431, tokenAddress: data.tokenAddress as string, tokenSymbol: "AlphaUSD", treasuryAddress: data.treasuryAddress as string };
        return { ...mockDb.treasuryAccount };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!mockDb.treasuryAccount) return { count: 0 };
        if ((where as { version?: number }).version !== undefined && (where as { version?: number }).version !== mockDb.treasuryAccount.version) {
          return { count: 0 };
        }
        Object.assign(mockDb.treasuryAccount, data);
        return { count: 1 };
      }),
    },
    treasuryLedgerEntry: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const input = data as Record<string, unknown>;
        if (mockDb.treasuryEntries.some((entry) => entry.idempotencyKey === input.idempotencyKey)) {
          const { Prisma } = await import("@prisma/client");
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint", { code: "P2002", clientVersion: "6.19.3" });
        }
        const entry = { ...input, id: `entry-${mockDb.treasuryEntries.length + 1}` };
        mockDb.treasuryEntries.push(entry);
        return { id: entry.id };
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return mockDb.treasuryEntries.find((entry) => Object.entries(where ?? {}).every(([key, value]) => entry[key] === value)) ?? null;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return mockDb.treasuryEntries.filter((entry) => Object.entries(where ?? {}).every(([key, value]) => entry[key] === value)).map((entry) => ({ ...entry }));
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      payment: (await import("@/lib/db")).db.payment,
      paymentSettlement: (await import("@/lib/db")).db.paymentSettlement,
      settlementBatch: (await import("@/lib/db")).db.settlementBatch,
      treasuryAccount: (await import("@/lib/db")).db.treasuryAccount,
      treasuryLedgerEntry: (await import("@/lib/db")).db.treasuryLedgerEntry,
    })),
  },
}));

import { reconcileStaleSettlements } from "@/lib/payments/settlement/reconcile";
import { TestSettlementProvider, TestDestinationSettlementVerifier } from "@/lib/payments/settlement/providers";

const TOKEN = "0x20c0000000000000000000000000000000000001";
const SENDER = "0x1111111111111111111111111111111111111111";
const FUNDING_HASH = `0x${"ab".repeat(32)}`;

const fundingConfig = {
  chainId: 42431,
  chainName: "Tempo Moderato",
  rpcUrl: "https://example.invalid",
  tokenAddress: TOKEN,
  tokenSymbol: "AlphaUSD",
  treasuryAddress: SENDER,
  explorerUrl: "https://explore.testnet.tempo.xyz",
};

function seedPayment(overrides: Record<string, unknown> = {}) {
  const row = {
    id: "payment-1",
    businessId: "business-1",
    status: "created",
    asset: "AlphaUSD",
    amount: { toFixed: () => "500.00" },
    chainId: null,
    tokenAddress: null,
    senderAddress: null,
    destinationAddress: null,
    transactionHash: null,
    fundingAuthorizationSignature: null,
    fundingError: null,
    blockNumber: null,
    blockHash: null,
    confirmedAt: null,
    recipient: { tempoAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" },
    updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    ...overrides,
  };
  mockDb.payments.push(row);
  return row;
}

describe("reconcileStaleSettlements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.payments = [];
    mockDb.attempts = [];
    mockDb.batches = [];
    mockDb.treasuryAccount = null;
    mockDb.treasuryEntries = [];
    process.env.TEMPO_CHAIN_ID = "42431";
    process.env.TEMPO_RPC_URL = "https://rpc.moderato.tempo.xyz";
    process.env.TEMPO_SETTLEMENT_TOKEN_ADDRESS = TOKEN;
    process.env.TEMPO_SETTLEMENT_PRIVATE_KEY = `0x${"55".repeat(32)}`;
    process.env.TEMPO_TREASURY_ADDRESS = SENDER;
    process.env.TEMPO_MAX_BATCH_SIZE = "10";
  });

  it("resumes stuck funding through the normal idempotent path", async () => {
    seedPayment({ status: "funding", transactionHash: FUNDING_HASH.toLowerCase(), fundingAuthorizationSignature: `0x${"ef".repeat(65)}` });
    const verify = vi.fn().mockResolvedValue({
      state: "verified",
      funding: {
        chainId: 42431, transactionHash: FUNDING_HASH, tokenAddress: TOKEN, tokenSymbol: "AlphaUSD", tokenDecimals: 6,
        senderAddress: SENDER, treasuryAddress: SENDER, blockNumber: BigInt(1), blockHash: `0x${"cd".repeat(32)}`,
      },
    });
    const { items } = await reconcileStaleSettlements({ businessId: "business-1" }, {
      provider: new TestSettlementProvider(),
      verifier: new TestDestinationSettlementVerifier(),
      fundingConfig: fundingConfig as never,
      verifyFunding: verify as never,
    });
    expect(items).toContainEqual(expect.objectContaining({ kind: "funding", id: "payment-1", outcome: "settled" }));
    expect(mockDb.payments[0].status).toBe("funded");
    expect(mockDb.treasuryEntries.some((entry) => entry.type === "CREDIT")).toBe(true);
  });

  it("reports funding without a recorded transaction as needs-review", async () => {
    seedPayment({ status: "funding", transactionHash: null, fundingAuthorizationSignature: null });
    const { items } = await reconcileStaleSettlements({ businessId: "business-1" }, {
      provider: new TestSettlementProvider(),
      verifier: new TestDestinationSettlementVerifier(),
      fundingConfig: fundingConfig as never,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "funding", outcome: "needs-review" });
  });

  it("backfills a missing credit for an already-funded payment", async () => {
    seedPayment({
      status: "funded", transactionHash: FUNDING_HASH.toLowerCase(), fundingAuthorizationSignature: `0x${"ef".repeat(65)}`,
      chainId: 42431, tokenAddress: TOKEN, senderAddress: SENDER, destinationAddress: SENDER, confirmedAt: new Date(),
    });
    const verify = vi.fn().mockResolvedValue({
      state: "verified",
      funding: {
        chainId: 42431, transactionHash: FUNDING_HASH, tokenAddress: TOKEN, tokenSymbol: "AlphaUSD", tokenDecimals: 6,
        senderAddress: SENDER, treasuryAddress: SENDER, blockNumber: BigInt(1), blockHash: `0x${"cd".repeat(32)}`,
      },
    });
    const { items } = await reconcileStaleSettlements({ businessId: "business-1" }, {
      provider: new TestSettlementProvider(),
      verifier: new TestDestinationSettlementVerifier(),
      fundingConfig: fundingConfig as never,
      verifyFunding: verify as never,
    });
    expect(items).toContainEqual(expect.objectContaining({ kind: "credit", outcome: "advanced" }));
    expect(mockDb.treasuryEntries.some((entry) => entry.type === "CREDIT")).toBe(true);
    // Second sweep finds the credit already present.
    const rerun = await reconcileStaleSettlements({ businessId: "business-1" }, {
      provider: new TestSettlementProvider(),
      verifier: new TestDestinationSettlementVerifier(),
      fundingConfig: fundingConfig as never,
      verifyFunding: verify as never,
    });
    expect(rerun.items).toContainEqual(expect.objectContaining({ kind: "credit", outcome: "advanced" }));
  });

  it("re-verifies a stuck settling payment without duplicating work", async () => {
    seedPayment({ status: "settling" });
    mockDb.attempts.push({
      id: "attempt-1", paymentId: "payment-1", attemptNumber: 1, status: "pending",
      verificationStatus: "pending", isSimulation: true, retryable: false,
      sourceTransactionHash: null, destinationTransactionHash: null, bridgeMessageId: null,
      destinationChainId: null, destinationTokenAddress: null, destinationAmount: null, recipientAddress: null,
      failureReason: null, updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const { items } = await reconcileStaleSettlements({ businessId: "business-1" }, {
      provider: new TestSettlementProvider(),
      verifier: new TestDestinationSettlementVerifier(),
      fundingConfig: fundingConfig as never,
    });
    expect(items).toContainEqual(expect.objectContaining({ kind: "settlement", id: "payment-1", outcome: "settled" }));
    expect(mockDb.payments[0].status).toBe("settled");
  });

  it("reports unexpected failures as needs-review without throwing", async () => {
    seedPayment({ status: "funding", transactionHash: FUNDING_HASH.toLowerCase(), fundingAuthorizationSignature: `0x${"ef".repeat(65)}` });
    const verify = vi.fn().mockRejectedValue(new Error("RPC down"));
    const { items } = await reconcileStaleSettlements({ businessId: "business-1" }, {
      provider: new TestSettlementProvider(),
      verifier: new TestDestinationSettlementVerifier(),
      fundingConfig: fundingConfig as never,
      verifyFunding: verify as never,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "funding", outcome: "needs-review", detail: "RPC down" });
  });

  it("respects the item limit", async () => {
    seedPayment({ id: "payment-1", status: "funding", transactionHash: FUNDING_HASH.toLowerCase(), fundingAuthorizationSignature: `0x${"ef".repeat(65)}` });
    seedPayment({ id: "payment-2", status: "funding", transactionHash: FUNDING_HASH.toLowerCase(), fundingAuthorizationSignature: `0x${"ef".repeat(65)}` });
    const verify = vi.fn().mockRejectedValue(new Error("RPC down"));
    const { items } = await reconcileStaleSettlements({ businessId: "business-1", limit: 1 }, {
      provider: new TestSettlementProvider(),
      verifier: new TestDestinationSettlementVerifier(),
      fundingConfig: fundingConfig as never,
      verifyFunding: verify as never,
    });
    expect(items).toHaveLength(1);
  });
});
