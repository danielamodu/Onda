import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({ getRecipientSessionAccount: vi.fn() }));
vi.mock("@/lib/auth/recipient-session", () => authMock);

import { GET as getIncomingPayments } from "@/app/api/recipient/payments/route";
import { GET as getIncomingPayment } from "@/app/api/recipient/payments/[id]/route";
import { PUT as updatePreference } from "@/app/api/recipient/payments/[id]/preference/route";

describe("recipient API authentication boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.getRecipientSessionAccount.mockResolvedValue(null);
  });

  it("rejects unauthenticated access to incoming payments", async () => {
    const response = await getIncomingPayments();
    expect(response.status).toBe(401);
  });

  it("rejects unauthenticated access to payment details", async () => {
    const response = await getIncomingPayment(new Request("http://localhost"), { params: Promise.resolve({ id: "payment-a" }) });
    expect(response.status).toBe(401);
  });

  it("rejects unauthenticated preference changes", async () => {
    const response = await updatePreference(new Request("http://localhost", { method: "PUT", body: JSON.stringify({ preference: "CONVERT_TO_NGN" }) }), { params: Promise.resolve({ id: "payment-a" }) });
    expect(response.status).toBe(401);
  });
});
