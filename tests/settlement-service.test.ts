import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

function duplicateKeyError() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint", { code: "P2002", clientVersion: "6.19.3" });
}

const mockDb = vi.hoisted(() => ({
  state: {
    payment: null as null | Record<string, unknown>,
    attempts: [] as Array<Record<string, unknown>>,

    treasuryAccount: null as null | { id: string; version: number; tokenDecimals: number; chainId: number; tokenAddress: string },
    treasuryEntries: [] as Array<Record<string, unknown>>,
  },
  payment: { findFirst: vi.fn(), updateMany: vi.fn() },
  paymentSettlement: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  treasuryAccount: {
    findUnique: vi.fn(async () => (mockDb.state.treasuryAccount ? { ...mockDb.state.treasuryAccount } : null)),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (mockDb.state.treasuryAccount) throw duplicateKeyError();
      mockDb.state.treasuryAccount = { id: "treasury-1", version: 0, tokenDecimals: 6, chainId: 42431, tokenAddress: data.tokenAddress as string };
      return { ...mockDb.state.treasuryAccount };
    }),
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
      return mockDb.state.treasuryEntries.find((entry) => Object.entries(where ?? {}).every(([key, value]) => entry[key] === value)) ?? null;
    }),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return mockDb.state.treasuryEntries.filter((entry) => Object.entries(where ?? {}).every(([key, value]) => entry[key] === value)).map((entry) => ({ ...entry }));
    }),
  },
  $transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));

import { SettlementConflictError, settlePayment } from "@/lib/payments/settlement/service";
import { TestDestinationSettlementVerifier, TestSettlementProvider } from "@/lib/payments/settlement/providers";
import { TempoNativeSettlementProvider } from "@/lib/payments/tempo/provider";
import { TempoDestinationSettlementVerifier } from "@/lib/payments/tempo/verifier";
import { settlementMemo } from "@/lib/payments/tempo/memo";
import { getAddress, parseUnits } from "viem";
import type { DestinationSettlementVerifier, SettlementInitiation, SettlementProvider } from "@/lib/payments/settlement/types";

function setUpDatabase() {
  const updatePayment = vi.fn(async ({ where, data }: { where: { status: string }; data: { status: string } }) => {
    if (mockDb.state.payment?.status !== where.status) return { count: 0 };
    mockDb.state.payment.status = data.status;
    return { count: 1 };
  });
  const createAttempt = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    const attempt = { id: `settlement-${mockDb.state.attempts.length + 1}`, ...data };
    mockDb.state.attempts.push(attempt);
    return attempt;
  });
  const updateAttempt = vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const attempt = mockDb.state.attempts.find((entry) => entry.id === where.id);
    if (!attempt) throw new Error("Missing test attempt");
    Object.assign(attempt, data);
    return attempt;
  });
  const transactionClient = {
    payment: { updateMany: updatePayment },
    paymentSettlement: { create: createAttempt, update: updateAttempt },
    treasuryAccount: mockDb.treasuryAccount,
    treasuryLedgerEntry: mockDb.treasuryLedgerEntry,
  };

  mockDb.payment.findFirst.mockImplementation(async () => mockDb.state.payment ? { ...mockDb.state.payment } : null);
  mockDb.payment.updateMany.mockImplementation(updatePayment);
  mockDb.paymentSettlement.findFirst.mockImplementation(async () => {
    const latest = [...mockDb.state.attempts].sort((a, b) => Number(b.attemptNumber) - Number(a.attemptNumber))[0];
    return latest ? { ...latest } : null;
  });
  mockDb.paymentSettlement.create.mockImplementation(createAttempt);
  mockDb.paymentSettlement.update.mockImplementation(updateAttempt);
  mockDb.$transaction.mockImplementation(async (callback: (client: typeof transactionClient) => unknown) => callback(transactionClient));
}

function fundedPayment(status = "funded") {
  return {
    id: "payment-test-1",
    businessId: "business-test-1",
    status,
    asset: "USDC",
    amount: { toFixed: () => "500.00" },
    chainId: 84532,
    tokenAddress: "base-test-token",
    transactionHash: `0x${"11".repeat(32)}`,
    destinationAddress: null,
    recipient: { tempoAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" },
  };
}

function provider(implementation: (call: number) => Promise<SettlementInitiation>) {
  let calls = 0;
  const value: SettlementProvider = {
    id: "test-fixture-provider",
    mode: "test",
    assertAvailable() {},
    initiateSettlement: () => implementation(++calls),
  };
  return { value, calls: () => calls };
}

const pendingInitiation: SettlementInitiation = {
  state: "pending",
  sourceTransactionHash: null,
  destinationChainId: null,
  destinationAsset: null,
  destinationTokenAddress: null,
  destinationAmount: null,
  recipientAddress: null,
  bridgeMessageId: null,
  failureReason: null,
  retryable: false,
};

describe("settlement orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TEMPO_CHAIN_ID = "42431";
    process.env.TEMPO_RPC_URL = "https://rpc.moderato.tempo.xyz";
    process.env.TEMPO_SETTLEMENT_TOKEN_ADDRESS = "0x20c0000000000000000000000000000000000001";
    process.env.TEMPO_SETTLEMENT_PRIVATE_KEY = `0x${"55".repeat(32)}`;
    process.env.TEMPO_TREASURY_ADDRESS = "0x1111111111111111111111111111111111111111";
    mockDb.state.payment = fundedPayment();
    mockDb.state.attempts = [];
    mockDb.state.treasuryAccount = null;
    mockDb.state.treasuryEntries = [];
    setUpDatabase();
  });

function seedTreasury(entry: { type: string; amountUnits: bigint; paymentId?: string; reservationId?: string | null; idempotencyKey: string }) {
  mockDb.state.treasuryAccount = {
    id: "treasury-1",
    version: mockDb.state.treasuryAccount?.version ?? 0,
    tokenDecimals: 6,
    chainId: 42431,
    tokenAddress: "0x20c0000000000000000000000000000000000001",
  };
  const available = mockDb.state.treasuryEntries.reduce(
    (sum, row) => sum + (row.type === "CREDIT" || row.type === "RELEASE" ? BigInt(String(row.amountUnits)) : row.type === "RESERVE" ? -BigInt(String(row.amountUnits)) : BigInt(0)),
    BigInt(0),
  );
  const effect = entry.type === "RESERVE" ? -entry.amountUnits : entry.amountUnits;
  mockDb.state.treasuryEntries.push({
    id: `treasury-entry-${mockDb.state.treasuryEntries.length + 1}`,
    treasuryAccountId: "treasury-1",
    paymentId: entry.paymentId ?? null,
    type: entry.type,
    amountUnits: entry.amountUnits,
    balanceAfterUnits: available + effect,
    reservationId: entry.reservationId ?? null,
    reference: null,
    ...{ idempotencyKey: entry.idempotencyKey },
  });
}

function seedCredit(amountUnits = BigInt("1000000000")) {
  seedTreasury({ type: "CREDIT", amountUnits, paymentId: "pay-funder", idempotencyKey: `funding:42431:0x${"aa".repeat(32)}` });
}

function tempoTestRuntime(overrides: {
  submitTransfer?: () => Promise<{ transactionHash: `0x${string}`; status: "success" | "reverted" | "pending" }>;
  getReceipt?: (config: unknown, hash: string) => Promise<null | { status: "success" | "failed"; tokenLogs: Array<{ from: `0x${string}`; to: `0x${string}`; value: bigint; memo: `0x${string}` }> }>;
  verifyDestination?: (expected: unknown, attempt: unknown) => Promise<unknown>;
} = {}) {
  const sender = getAddress("0x1111111111111111111111111111111111111111");
  const token = getAddress("0x20c0000000000000000000000000000000000001");
  const submittedHash = `0x${"44".repeat(32)}` as `0x${string}`;
  let submits = 0;
  const provider = new TempoNativeSettlementProvider({
    loadConfig: () => ({ chainId: 42431 as const, rpcUrl: "https://example.invalid", tokenAddress: token, settlementPrivateKey: `0x${"55".repeat(32)}` as `0x${string}`, explorerUrl: "https://explore.testnet.tempo.xyz" }),
    deriveSender: () => sender,
    getTokenMeta: async () => ({ decimals: 6, symbol: "AlphaUSD" }),
    getSettlementBalance: async () => parseUnits("1000000", 6),
    findPriorTransfer: async () => null,
    submitTransfer: overrides.submitTransfer ?? (async () => {
      submits += 1;
      return { transactionHash: submittedHash, status: "success" as const };
    }),
  });
  const verifier = overrides.verifyDestination
    ? ({ verifyDestination: overrides.verifyDestination } as unknown as DestinationSettlementVerifier)
    : new TempoDestinationSettlementVerifier({
      loadConfig: () => ({ chainId: 42431 as const, rpcUrl: "https://example.invalid", tokenAddress: token, settlementPrivateKey: `0x${"55".repeat(32)}` as `0x${string}`, explorerUrl: "https://explore.testnet.tempo.xyz" }),
      deriveSender: () => sender,
      getRpcChainId: async () => 42431,
      getReceipt: overrides.getReceipt ?? (async () => null),
      getTransactionChainId: async () => 42431,
      getTokenDecimals: async () => 6,
    });
  return { provider, verifier, sender, token, submittedHash, submits: () => submits };
}

function tempoFundedPayment() {
  return {
    ...fundedPayment(),
    asset: "AlphaUSD",
    chainId: 42431,
    tokenAddress: getAddress("0x20c0000000000000000000000000000000000001"),
  };
}

  it("moves a funded payment through settling to a clearly marked simulated result", async () => {
    const result = await settlePayment("business-test-1", "payment-test-1", {
      provider: new TestSettlementProvider(),
      verifier: new TestDestinationSettlementVerifier(),
    });

    expect(result).toMatchObject({ state: "settled", isSimulation: true });
    expect(mockDb.state.payment?.status).toBe("settled");
    expect(mockDb.state.attempts[0]).toMatchObject({
      provider: "test-simulation",
      status: "settled",
      verificationStatus: "simulated",
      isSimulation: true,
      sourceChainId: 84532,
      sourceAsset: "USDC",
      sourceAmount: "500.00",
      destinationChainId: null,
      destinationTokenAddress: null,
      destinationTransactionHash: undefined,
      bridgeMessageId: null,
    });
  });

  it("rejects a payment that has not reached funded", async () => {
    mockDb.state.payment = fundedPayment("created");
    await expect(settlePayment("business-test-1", "payment-test-1", {
      provider: new TestSettlementProvider(),
      verifier: new TestDestinationSettlementVerifier(),
    })).rejects.toBeInstanceOf(SettlementConflictError);
    expect(mockDb.state.attempts).toHaveLength(0);
  });

  it("does not initiate a second bridge call when a duplicate request re-verifies", async () => {
    const bridge = provider(async () => pendingInitiation);
    let verifications = 0;
    const verifier: DestinationSettlementVerifier = {
      async verifyDestination() {
        verifications += 1;
        return verifications === 1 ? { state: "pending" } : { state: "simulated", reason: "test-only" };
      },
    };

    const first = await settlePayment("business-test-1", "payment-test-1", { provider: bridge.value, verifier });
    const second = await settlePayment("business-test-1", "payment-test-1", { provider: bridge.value, verifier });

    expect(first.state).toBe("settling");
    expect(second).toMatchObject({ state: "settled", isSimulation: true });
    expect(bridge.calls()).toBe(1);
    expect(mockDb.state.attempts).toHaveLength(1);
  });

  it("returns an already-settled payment idempotently", async () => {
    mockDb.state.payment = fundedPayment("settled");
    mockDb.state.attempts = [{ id: "settlement-existing", attemptNumber: 1, status: "settled", isSimulation: true }];
    const bridge = provider(async () => pendingInitiation);

    await expect(settlePayment("business-test-1", "payment-test-1", {
      provider: bridge.value,
      verifier: new TestDestinationSettlementVerifier(),
    })).resolves.toEqual({ state: "settled", attemptId: "settlement-existing", isSimulation: true });
    expect(bridge.calls()).toBe(0);
  });

  it("fails a payment after a terminal source transaction failure", async () => {
    const bridge = provider(async () => ({ ...pendingInitiation, state: "failed", failureReason: "Source transaction reverted.", retryable: false }));
    const result = await settlePayment("business-test-1", "payment-test-1", {
      provider: bridge.value,
      verifier: new TestDestinationSettlementVerifier(),
    });
    expect(result).toMatchObject({ state: "failed", retryable: false, reason: "Source transaction reverted." });
    expect(mockDb.state.payment?.status).toBe("failed");
  });

  it("allows a new idempotent attempt after a recoverable source failure", async () => {
    const bridge = provider(async (call) => call === 1
      ? { ...pendingInitiation, state: "failed", failureReason: "Source RPC timed out.", retryable: true }
      : pendingInitiation);
    const dependencies = { provider: bridge.value, verifier: new TestDestinationSettlementVerifier() };

    const first = await settlePayment("business-test-1", "payment-test-1", dependencies);
    const retry = await settlePayment("business-test-1", "payment-test-1", dependencies);

    expect(first.state).toBe("settling");
    expect(retry).toMatchObject({ state: "settled", isSimulation: true });
    expect(bridge.calls()).toBe(2);
    expect(mockDb.state.attempts).toHaveLength(2);
    expect(mockDb.state.payment?.status).toBe("settled");
  });

  it("fails safely when destination verification reports a failed transaction", async () => {
    const verifier: DestinationSettlementVerifier = {
      async verifyDestination() {
        return { state: "failed", reason: "Destination transaction failed.", retryable: false };
      },
    };
    const result = await settlePayment("business-test-1", "payment-test-1", {
      provider: provider(async () => pendingInitiation).value,
      verifier,
    });
    expect(result).toMatchObject({ state: "failed", reason: "Destination transaction failed." });
    expect(mockDb.state.payment?.status).toBe("failed");
  });

  it("requires a recipient Tempo address before creating a settlement attempt", async () => {
    mockDb.state.payment = { ...fundedPayment(), recipient: { tempoAddress: null } };
    await expect(settlePayment("business-test-1", "payment-test-1", {
      provider: new TestSettlementProvider(),
      verifier: new TestDestinationSettlementVerifier(),
    })).rejects.toBeInstanceOf(SettlementConflictError);
    expect(mockDb.state.attempts).toHaveLength(0);
    expect(mockDb.state.payment?.status).toBe("funded");
  });

  it("settles a funded payment through a Tempo transfer with independent verification", async () => {
    const recipient = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    const sender = getAddress("0x1111111111111111111111111111111111111111");
    const token = getAddress("0x20c0000000000000000000000000000000000001");
    mockDb.state.payment = { ...fundedPayment(), asset: "AlphaUSD", chainId: 42431, tokenAddress: token };
    seedCredit();
    const submittedHash = `0x${"44".repeat(32)}` as `0x${string}`;
    let submits = 0;
    const tempoProvider = new TempoNativeSettlementProvider({
      loadConfig: () => ({ chainId: 42431 as const, rpcUrl: "https://example.invalid", tokenAddress: token, settlementPrivateKey: `0x${"55".repeat(32)}` as `0x${string}`, explorerUrl: "https://explore.testnet.tempo.xyz" }),
      deriveSender: () => sender,
      getTokenMeta: async () => ({ decimals: 6, symbol: "AlphaUSD" }),
      getSettlementBalance: async () => parseUnits("1000000", 6),
      findPriorTransfer: async () => null,
      submitTransfer: async () => {
        submits += 1;
        return { transactionHash: submittedHash, status: "success" as const };
      },
    });
    const tempoVerifier = new TempoDestinationSettlementVerifier({
      loadConfig: () => ({ chainId: 42431 as const, rpcUrl: "https://example.invalid", tokenAddress: token, settlementPrivateKey: `0x${"55".repeat(32)}` as `0x${string}`, explorerUrl: "https://explore.testnet.tempo.xyz" }),
      deriveSender: () => sender,
      getRpcChainId: async () => 42431,
      getReceipt: async (_config, hash) => hash !== submittedHash ? null : {
        status: "success" as const,
        tokenLogs: [{ from: sender, to: recipient, value: parseUnits("500.00", 6), memo: settlementMemo("payment-test-1") }],
      },
      getTransactionChainId: async () => 42431,
      getTokenDecimals: async () => 6,
    });

    const first = await settlePayment("business-test-1", "payment-test-1", { provider: tempoProvider, verifier: tempoVerifier });
    expect(first).toMatchObject({ state: "settled", isSimulation: false });
    expect(submits).toBe(1);
    expect(mockDb.state.payment?.status).toBe("settled");
    expect(mockDb.state.attempts[0]).toMatchObject({
      provider: "tempo-native",
      status: "settled",
      verificationStatus: "verified",
      isSimulation: false,
      destinationChainId: 42431,
      destinationTokenAddress: token,
      destinationAmount: "500.00",
      recipientAddress: recipient,
      sourceTransactionHash: submittedHash,
      destinationTransactionHash: submittedHash,
      bridgeMessageId: null,
    });

    const second = await settlePayment("business-test-1", "payment-test-1", { provider: tempoProvider, verifier: tempoVerifier });
    expect(second).toMatchObject({ state: "settled", isSimulation: false });
    expect(submits).toBe(1);
    expect(mockDb.state.attempts).toHaveLength(1);
    const entryTypes = mockDb.state.treasuryEntries.map((entry) => entry.type);
    expect(entryTypes).toContain("RESERVE");
    expect(entryTypes).toContain("DEBIT");
    const debit = mockDb.state.treasuryEntries.find((entry) => entry.type === "DEBIT");
    expect(debit).toMatchObject({ paymentId: "payment-test-1", amountUnits: BigInt("500000000"), reference: submittedHash });
  });

  it("refuses to settle a Base-funded payment with the real provider", async () => {
    const sender = getAddress("0x1111111111111111111111111111111111111111");
    const token = getAddress("0x20c0000000000000000000000000000000000001");
    const tempoProvider = new TempoNativeSettlementProvider({
      loadConfig: () => ({ chainId: 42431 as const, rpcUrl: "https://example.invalid", tokenAddress: token, settlementPrivateKey: `0x${"55".repeat(32)}` as `0x${string}`, explorerUrl: "https://explore.testnet.tempo.xyz" }),
      deriveSender: () => sender,
      getTokenMeta: async () => ({ decimals: 6, symbol: "AlphaUSD" }),
      getSettlementBalance: async () => parseUnits("1000000", 6),
      findPriorTransfer: async () => null,
      submitTransfer: async () => { throw new Error("must not submit"); },
    });
    const tempoVerifier = new TempoDestinationSettlementVerifier({
      loadConfig: () => ({ chainId: 42431 as const, rpcUrl: "https://example.invalid", tokenAddress: token, settlementPrivateKey: `0x${"55".repeat(32)}` as `0x${string}`, explorerUrl: "https://explore.testnet.tempo.xyz" }),
      deriveSender: () => sender,
      getRpcChainId: async () => 42431,
      getReceipt: async () => null,
      getTransactionChainId: async () => 42431,
      getTokenDecimals: async () => 6,
    });
    await expect(settlePayment("business-test-1", "payment-test-1", { provider: tempoProvider, verifier: tempoVerifier }))
      .rejects.toBeInstanceOf(SettlementConflictError);
    expect(mockDb.state.attempts).toHaveLength(0);
    expect(mockDb.state.payment?.status).toBe("funded");
  });

  it("refuses to settle a Tempo payment funded in the wrong token", async () => {
    mockDb.state.payment = { ...fundedPayment(), asset: "AlphaUSD", chainId: 42431, tokenAddress: "0x9999999999999999999999999999999999999999" };
    const sender = getAddress("0x1111111111111111111111111111111111111111");
    const token = getAddress("0x20c0000000000000000000000000000000000001");
    const tempoProvider = new TempoNativeSettlementProvider({
      loadConfig: () => ({ chainId: 42431 as const, rpcUrl: "https://example.invalid", tokenAddress: token, settlementPrivateKey: `0x${"55".repeat(32)}` as `0x${string}`, explorerUrl: "https://explore.testnet.tempo.xyz" }),
      deriveSender: () => sender,
      getTokenMeta: async () => ({ decimals: 6, symbol: "AlphaUSD" }),
      getSettlementBalance: async () => parseUnits("1000000", 6),
      findPriorTransfer: async () => null,
      submitTransfer: async () => { throw new Error("must not submit"); },
    });
    const tempoVerifier = new TempoDestinationSettlementVerifier({
      loadConfig: () => ({ chainId: 42431 as const, rpcUrl: "https://example.invalid", tokenAddress: token, settlementPrivateKey: `0x${"55".repeat(32)}` as `0x${string}`, explorerUrl: "https://explore.testnet.tempo.xyz" }),
      deriveSender: () => sender,
      getRpcChainId: async () => 42431,
      getReceipt: async () => null,
      getTransactionChainId: async () => 42431,
      getTokenDecimals: async () => 6,
    });
    await expect(settlePayment("business-test-1", "payment-test-1", { provider: tempoProvider, verifier: tempoVerifier }))
      .rejects.toBeInstanceOf(SettlementConflictError);
    expect(mockDb.state.attempts).toHaveLength(0);
  });

  it("refuses to settle when treasury available balance is insufficient", async () => {
    mockDb.state.payment = tempoFundedPayment();
    seedCredit(BigInt("100000000"));
    const { provider, verifier } = tempoTestRuntime({
      submitTransfer: async () => { throw new Error("must not submit"); },
    });
    await expect(settlePayment("business-test-1", "payment-test-1", { provider, verifier }))
      .rejects.toBeInstanceOf(SettlementConflictError);
    expect(mockDb.state.attempts).toHaveLength(0);
    expect(mockDb.state.payment?.status).toBe("funded");
    expect(mockDb.state.treasuryEntries).toHaveLength(1);
  });

  it("refuses a second active reservation for the same payment", async () => {
    mockDb.state.payment = tempoFundedPayment();
    seedCredit();
    mockDb.state.treasuryEntries.push({
      id: "treasury-entry-prior",
      treasuryAccountId: "treasury-1",
      paymentId: "payment-test-1",
      type: "RESERVE",
      amountUnits: BigInt("500000000"),
      balanceAfterUnits: BigInt("500000000"),
      reservationId: null,
      idempotencyKey: "reserve:payment-test-1:0",
      reference: "stale hold",
    });
    const { provider, verifier } = tempoTestRuntime({
      submitTransfer: async () => { throw new Error("must not submit"); },
    });
    await expect(settlePayment("business-test-1", "payment-test-1", { provider, verifier }))
      .rejects.toBeInstanceOf(SettlementConflictError);
    expect(mockDb.state.attempts).toHaveLength(0);
    expect(mockDb.state.payment?.status).toBe("funded");
  });

  it("releases the reservation when verification fails terminally", async () => {
    mockDb.state.payment = tempoFundedPayment();
    seedCredit();
    const { provider } = tempoTestRuntime();
    const verifier = {
      async verifyDestination() {
        return { state: "failed", reason: "Destination transaction failed.", retryable: false };
      },
    } as unknown as DestinationSettlementVerifier;
    const result = await settlePayment("business-test-1", "payment-test-1", { provider, verifier });
    expect(result).toMatchObject({ state: "failed", retryable: false });
    expect(mockDb.state.payment?.status).toBe("failed");
    const types = mockDb.state.treasuryEntries.map((entry) => entry.type);
    expect(types).toEqual(["CREDIT", "RESERVE", "RELEASE"]);
    const release = mockDb.state.treasuryEntries.find((entry) => entry.type === "RELEASE");
    expect(release).toMatchObject({ paymentId: "payment-test-1", amountUnits: BigInt("500000000") });
  });

  it("supersedes the reservation on retry after a recoverable initiation failure", async () => {
    mockDb.state.payment = tempoFundedPayment();
    seedCredit();
    const recipient = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    const sender = getAddress("0x1111111111111111111111111111111111111111");
    const token = getAddress("0x20c0000000000000000000000000000000000001");
    const submittedHash = `0x${"44".repeat(32)}` as `0x${string}`;
    let calls = 0;
    const provider = new TempoNativeSettlementProvider({
      loadConfig: () => ({ chainId: 42431 as const, rpcUrl: "https://example.invalid", tokenAddress: token, settlementPrivateKey: `0x${"55".repeat(32)}` as `0x${string}`, explorerUrl: "https://explore.testnet.tempo.xyz" }),
      deriveSender: () => sender,
      getTokenMeta: async () => ({ decimals: 6, symbol: "AlphaUSD" }),
      getSettlementBalance: async () => parseUnits("1000000", 6),
      findPriorTransfer: async () => null,
      submitTransfer: async () => {
        calls += 1;
        if (calls === 1) throw new Error("RPC timeout");
        return { transactionHash: submittedHash, status: "success" as const };
      },
    });
    const verifier = new TempoDestinationSettlementVerifier({
      loadConfig: () => ({ chainId: 42431 as const, rpcUrl: "https://example.invalid", tokenAddress: token, settlementPrivateKey: `0x${"55".repeat(32)}` as `0x${string}`, explorerUrl: "https://explore.testnet.tempo.xyz" }),
      deriveSender: () => sender,
      getRpcChainId: async () => 42431,
      getReceipt: async (_config, hash) => hash !== submittedHash ? null : {
        status: "success" as const,
        tokenLogs: [{ from: sender, to: recipient, value: parseUnits("500.00", 6), memo: settlementMemo("payment-test-1") }],
      },
      getTransactionChainId: async () => 42431,
      getTokenDecimals: async () => 6,
    });
    const first = await settlePayment("business-test-1", "payment-test-1", { provider, verifier });
    expect(first.state).toBe("settling");
    expect(mockDb.state.attempts).toHaveLength(1);
    const retry = await settlePayment("business-test-1", "payment-test-1", { provider, verifier });
    expect(retry).toMatchObject({ state: "settled", isSimulation: false });
    expect(mockDb.state.attempts).toHaveLength(2);
    const types = mockDb.state.treasuryEntries.map((entry) => entry.type);
    expect(types).toEqual(["CREDIT", "RESERVE", "RELEASE", "RESERVE", "DEBIT"]);
  });
});
