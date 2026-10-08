import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  const tx = {
    recipient: { upsert: vi.fn() },
    payment: { create: vi.fn() },
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
  country: "NG",
  payoutCurrency: "NGN",
  amount: 500,
  asset: "USDC",
  reference: "INV-1042",
};

describe("payment input validation", () => {
  it("accepts a valid Nigerian USDC payment", () => {
    expect(createPaymentSchema.parse(validInput)).toMatchObject({ amount: 500, country: "NG", asset: "USDC" });
  });

  it.each([
    [{ ...validInput, amount: 0 }, "zero amount"],
    [{ ...validInput, amount: 1.001 }, "more than two decimals"],
    [{ ...validInput, asset: "BTC" }, "unsupported asset"],
    [{ ...validInput, country: "GH" }, "unsupported country"],
    [{ ...validInput, recipientName: " " }, "missing recipient"],
  ])("rejects %s (%s)", (input) => {
    expect(createPaymentSchema.safeParse(input).success).toBe(false);
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
    expect(tx.payment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ businessId: "business-1", recipientId: "recipient-1", status: "created", amount: 500, asset: "USDC" }) }));
    expect(payment).toMatchObject({ id: "payment-1", status: "created" });
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
