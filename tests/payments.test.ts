import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  const tx = {
    recipient: { upsert: vi.fn() },
    payment: { create: vi.fn() },
    recipientAccount: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  return { tx, $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) };
});
const tx = dbMock.tx;

vi.mock("@/lib/db", () => ({ db: dbMock }));

import { createPaymentSchema, canTransition, transitionPayment } from "@/lib/payments/domain";
import { createPayment } from "@/lib/payments/service";

const validInput = {
  recipientName: "Ada Okafor",
  identifier: "ada@example.com",
  tempoAddress: "0x2222222222222222222222222222222222222222",
  country: "NG",
  payoutCurrency: "NGN",
  amount: 500,
  asset: "AlphaUSD",
  reference: "INV-1042",
};

describe("payment input validation", () => {
  it("accepts a valid Nigerian AlphaUSD payment", () => {
    expect(createPaymentSchema.parse(validInput)).toMatchObject({ amount: 500, country: "NG", asset: "AlphaUSD" });
  });

  it.each([
    [{ ...validInput, amount: 0 }, "zero amount"],
    [{ ...validInput, amount: 1.001 }, "more than two decimals"],
    [{ ...validInput, asset: "BTC" }, "unsupported asset"],
    [{ ...validInput, asset: "USDC" }, "legacy USDC asset"],
    [{ ...validInput, country: "GH" }, "unsupported country"],
    [{ ...validInput, recipientName: " " }, "missing recipient"],
    [{ ...validInput, tempoAddress: "not-an-address" }, "malformed recipient Tempo address"],
  ])("rejects %s (%s)", (input) => {
    expect(createPaymentSchema.safeParse(input).success).toBe(false);
  });

  it("requires the recipient Tempo address", () => {
    const { tempoAddress: _omitted, ...withoutAddress } = validInput;
    void _omitted;
    expect(createPaymentSchema.safeParse(withoutAddress).success).toBe(false);
  });
});

describe("payment creation", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("creates or updates a recipient and persists a payment in created state", async () => {
    tx.recipient.upsert.mockResolvedValue({ id: "recipient-1" });
    tx.payment.create.mockResolvedValue({ id: "payment-1", status: "created" });
    const input = createPaymentSchema.parse(validInput);
    const payment = await createPayment("business-1", input);
    expect(dbMock.$transaction).toHaveBeenCalledOnce();
    expect(tx.recipient.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { businessId_identifier: { businessId: "business-1", identifier: "ada@example.com" } } }));
    expect(tx.recipient.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ tempoAddress: "0x2222222222222222222222222222222222222222" }),
      create: expect.objectContaining({ tempoAddress: "0x2222222222222222222222222222222222222222" }),
    }));
    expect(tx.payment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ businessId: "business-1", recipientId: "recipient-1", status: "created", amount: 500, asset: "AlphaUSD" }) }));
    expect(payment).toMatchObject({ id: "payment-1", status: "created" });
  });

  it("links a business contact to an existing recipient account by normalized email", async () => {
    tx.recipientAccount.findUnique.mockResolvedValue({ id: "recipient-account-1" });
    tx.recipient.upsert.mockResolvedValue({ id: "recipient-1" });
    tx.payment.create.mockResolvedValue({ id: "payment-1", status: "created" });
    const input = createPaymentSchema.parse({ ...validInput, identifier: "Ada@Example.com" });
    await createPayment("business-1", input);
    expect(tx.recipientAccount.findUnique).toHaveBeenCalledWith({ where: { email: "ada@example.com" }, select: { id: true } });
    expect(tx.recipient.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { businessId_identifier: { businessId: "business-1", identifier: "ada@example.com" } },
      update: expect.objectContaining({ accountId: "recipient-account-1" }),
      create: expect.objectContaining({ accountId: "recipient-account-1" }),
    }));
  });
});

describe("payment state machine", () => {
  it("allows the initial created payment to enter funding", () => {
    expect(canTransition("created", "funding")).toBe(true);
    expect(transitionPayment("created", "funding")).toBe("funding");
  });

  it("rejects skipped and terminal-state transitions", () => {
    expect(canTransition("created", "settled")).toBe(false);
    expect(() => transitionPayment("created", "settled")).toThrow("Invalid payment transition");
    expect(canTransition("completed", "failed")).toBe(false);
  });
});
