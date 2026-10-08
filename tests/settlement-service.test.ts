import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  state: { payment: null as null | Record<string, unknown>, attempts: [] as Array<Record<string, unknown>> },
  payment: { findFirst: vi.fn(), updateMany: vi.fn() },
  paymentSettlement: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));

import { SettlementConflictError, settlePayment } from "@/lib/payments/settlement/service";
import { TestDestinationSettlementVerifier, TestSettlementProvider } from "@/lib/payments/settlement/providers";
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
    mockDb.state.payment = fundedPayment();
    mockDb.state.attempts = [];
    setUpDatabase();
  });

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
});
