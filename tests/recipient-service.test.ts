import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  payment: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  recipientAccount: { findUnique: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));

import { getIncomingPayment, getRecipientDashboard, isRecipientPaymentSettled, listIncomingPayments, RecipientPaymentUnavailableError, selectRecipientPreference } from "@/lib/recipients/service";
import { PayoutProviderUnavailableError, UnavailableRecipientPayoutProvider } from "@/lib/recipients/payout/provider";

function incomingPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: "payment-a",
    amount: "500.00",
    asset: "USDC",
    country: "NG",
    payoutCurrency: "NGN",
    reference: null,
    status: "settled",
    transactionHash: "0xbase-public-hash",
    chainId: 84532,
    tokenAddress: "base-usdc-token",
    senderAddress: "0xbusiness-wallet",
    destinationAddress: null,
    blockNumber: 1,
    blockHash: "0xbase-block",
    confirmedAt: new Date("2026-10-01T10:00:00Z"),
    recipientPreference: null,
    recipientPreferenceSelectedAt: null,
    createdAt: new Date("2026-10-01T09:00:00Z"),
    business: { name: "Northstar Studio" },
    recipient: { id: "recipient-a", name: "Ada", identifier: "ada@example.com" },
    settlements: [{
      status: "settled",
      verificationStatus: "verified",
      isSimulation: false,
      destinationChainId: 42431,
      destinationAsset: "USDC",
      destinationAmount: "500.00",
      recipientAddress: "0xrecipient-wallet",
      destinationTransactionHash: "0xdestination-public-hash",
      settledAt: new Date("2026-10-01T10:05:00Z"),
      failureReason: null,
    }],
    ...overrides,
  };
}

describe("recipient payment access and preferences", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists payments only through the authenticated recipient account relationship", async () => {
    const payment = incomingPayment();
    mockDb.payment.findMany.mockResolvedValue([payment]);
    await expect(listIncomingPayments("account-a")).resolves.toEqual([payment]);
    expect(mockDb.payment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { recipient: { accountId: "account-a" } } }));
  });

  it("cannot return another recipient's payment", async () => {
    mockDb.payment.findFirst.mockResolvedValue(null);
    await expect(getIncomingPayment("account-b", "payment-a")).resolves.toBeNull();
    expect(mockDb.payment.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "payment-a", recipient: { accountId: "account-b" } } }));
  });

  it("recognizes only independently verified, non-simulated settlement as available", () => {
    expect(isRecipientPaymentSettled(incomingPayment() as never)).toBe(true);
    expect(isRecipientPaymentSettled(incomingPayment({ status: "created" }) as never)).toBe(false);
    expect(isRecipientPaymentSettled(incomingPayment({ settlements: [{ ...incomingPayment().settlements[0], isSimulation: true }] }) as never)).toBe(false);
    expect(isRecipientPaymentSettled(incomingPayment({ settlements: [{ ...incomingPayment().settlements[0], verificationStatus: "simulated" }] }) as never)).toBe(false);
  });

  it.each(["KEEP_STABLECOIN", "CONVERT_TO_NGN"] as const)("saves %s as recipient intent without changing payment state", async (preference) => {
    const payment = incomingPayment();
    mockDb.payment.findFirst.mockResolvedValue(payment);
    mockDb.payment.updateMany.mockResolvedValue({ count: 1 });
    const result = await selectRecipientPreference("account-a", "payment-a", preference);
    expect(result).toMatchObject({ preference, payoutStarted: false });
    expect(mockDb.payment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "payment-a", status: "settled", recipient: { is: { accountId: "account-a" } } },
      data: expect.objectContaining({ recipientPreference: preference, recipientPreferenceSelectedAt: expect.any(Date) }),
    }));
    const updateData = mockDb.payment.updateMany.mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty("status");
    expect(updateData).not.toHaveProperty("payoutCompletedAt");
  });

  it("does not treat an unsettled payment as available", async () => {
    mockDb.payment.findFirst.mockResolvedValue(incomingPayment({ status: "funded" }));
    await expect(selectRecipientPreference("account-a", "payment-a", "KEEP_STABLECOIN")).rejects.toBeInstanceOf(RecipientPaymentUnavailableError);
    expect(mockDb.payment.updateMany).not.toHaveBeenCalled();
  });

  it("keeps simulation-only settlement unavailable to a recipient", async () => {
    mockDb.payment.findFirst.mockResolvedValue(incomingPayment({ settlements: [{ ...incomingPayment().settlements[0], isSimulation: true, verificationStatus: "simulated" }] }));
    await expect(selectRecipientPreference("account-a", "payment-a", "CONVERT_TO_NGN")).rejects.toBeInstanceOf(RecipientPaymentUnavailableError);
    expect(mockDb.payment.updateMany).not.toHaveBeenCalled();
  });

  it("counts verified settlement separately from pending, failed, and simulated records", async () => {
    mockDb.payment.findMany.mockResolvedValue([
      incomingPayment(),
      incomingPayment({ id: "payment-b", status: "created", settlements: [] }),
      incomingPayment({ id: "payment-c", status: "failed", settlements: [] }),
      incomingPayment({ id: "payment-d", settlements: [{ ...incomingPayment().settlements[0], isSimulation: true }] }),
    ]);
    await expect(getRecipientDashboard("account-a")).resolves.toMatchObject({ total: 4, settled: 1, pending: 2 });
  });

  it("keeps every NGN payout operation unavailable until a provider is implemented", async () => {
    const provider = new UnavailableRecipientPayoutProvider();
    await expect(provider.quoteNgnConversion("payment-a")).rejects.toBeInstanceOf(PayoutProviderUnavailableError);
    await expect(provider.initiatePayout("payment-a", "quote-a", "bank-a")).rejects.toBeInstanceOf(PayoutProviderUnavailableError);
    await expect(provider.checkPayoutStatus("reference-a")).rejects.toBeInstanceOf(PayoutProviderUnavailableError);
    await expect(provider.verifyCompletedPayout("reference-a")).rejects.toBeInstanceOf(PayoutProviderUnavailableError);
  });
});
