import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({ payment: { findFirst: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { getBusinessPayment } from "@/lib/payments/service";

describe("business payment access boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("scopes a payment lookup to the authenticated business", async () => {
    dbMock.payment.findFirst.mockResolvedValue(null);
    await expect(getBusinessPayment("business-b", "payment-a")).resolves.toBeNull();
    expect(dbMock.payment.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "payment-a", businessId: "business-b" } }));
  });
});
