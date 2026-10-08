import { db } from "@/lib/db";
import type { CreatePaymentInput } from "@/lib/payments/domain";

export async function createPayment(businessId: string, input: CreatePaymentInput) {
  return db.$transaction(async (tx) => {
    const recipient = await tx.recipient.upsert({
      where: { businessId_identifier: { businessId, identifier: input.identifier } },
      update: { name: input.recipientName, country: input.country, payoutCurrency: input.payoutCurrency },
      create: {
        businessId,
        name: input.recipientName,
        identifier: input.identifier,
        country: input.country,
        payoutCurrency: input.payoutCurrency,
      },
    });

    return tx.payment.create({
      data: {
        businessId,
        recipientId: recipient.id,
        amount: input.amount,
        asset: input.asset,
        country: input.country,
        payoutCurrency: input.payoutCurrency,
        reference: input.reference || null,
        status: "created",
      },
      include: { recipient: true },
    });
  });
}

export async function getBusinessPayment(businessId: string, paymentId: string) {
  return db.payment.findFirst({
    where: { id: paymentId, businessId },
    include: { recipient: true, settlements: { orderBy: { attemptNumber: "desc" } } },
  });
}
