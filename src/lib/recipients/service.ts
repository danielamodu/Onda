import { db } from "@/lib/db";
import type { RecipientPreference } from "@/lib/recipients/validation";

export class RecipientAccessError extends Error {
  constructor(message = "Payment not found.") {
    super(message);
    this.name = "RecipientAccessError";
  }
}

export class RecipientPaymentUnavailableError extends Error {
  constructor(message = "Funds are not available until settlement is independently verified.") {
    super(message);
    this.name = "RecipientPaymentUnavailableError";
  }
}

const paymentSelect = {
    id: true,
    amount: true,
    asset: true,
    country: true,
    payoutCurrency: true,
    reference: true,
    status: true,
    transactionHash: true,
    chainId: true,
    confirmedAt: true,
    recipientPreference: true,
    recipientPreferenceSelectedAt: true,
    createdAt: true,
    business: { select: { name: true } },
    recipient: { select: { id: true, name: true, identifier: true } },
    settlements: {
      orderBy: { attemptNumber: "desc" as const },
      take: 1,
      select: {
        status: true,
        verificationStatus: true,
        isSimulation: true,
        destinationChainId: true,
        destinationAsset: true,
        destinationTransactionHash: true,
        settledAt: true,
      },
    },
};

export type IncomingPayment = Awaited<ReturnType<typeof getIncomingPayment>>;

export function isRecipientPaymentSettled(payment: NonNullable<IncomingPayment>) {
  const settlement = payment.settlements[0];
  return payment.status === "settled"
    && settlement?.status === "settled"
    && settlement.verificationStatus === "verified"
    && !settlement.isSimulation
    && settlement.destinationTransactionHash !== null
    && settlement.settledAt !== null;
}

export async function getRecipientProfile(recipientAccountId: string) {
  return db.recipientAccount.findUnique({
    where: { id: recipientAccountId },
    select: { id: true, name: true, email: true, createdAt: true },
  });
}

export async function listIncomingPayments(recipientAccountId: string) {
  return db.payment.findMany({
    where: { recipient: { accountId: recipientAccountId } },
    select: paymentSelect,
    orderBy: { createdAt: "desc" },
  });
}

export async function getIncomingPayment(recipientAccountId: string, paymentId: string) {
  return db.payment.findFirst({
    where: { id: paymentId, recipient: { accountId: recipientAccountId } },
    select: paymentSelect,
  });
}

export async function selectRecipientPreference(recipientAccountId: string, paymentId: string, preference: RecipientPreference) {
  const payment = await getIncomingPayment(recipientAccountId, paymentId);
  if (!payment) throw new RecipientAccessError();
  if (!isRecipientPaymentSettled(payment)) throw new RecipientPaymentUnavailableError();

  const selectedAt = new Date();
  const update = await db.payment.updateMany({
    where: { id: payment.id, status: "settled", recipient: { is: { accountId: recipientAccountId } } },
    data: { recipientPreference: preference, recipientPreferenceSelectedAt: selectedAt },
  });
  if (update.count !== 1) throw new RecipientAccessError();
  return { preference, selectedAt, payoutStarted: false };
}

export async function getRecipientDashboard(recipientAccountId: string) {
  const payments = await listIncomingPayments(recipientAccountId);
  const settledCount = payments.filter(isRecipientPaymentSettled).length;
  const failedCount = payments.filter((payment) => payment.status === "failed").length;
  return {
    total: payments.length,
    settled: settledCount,
    pending: payments.length - settledCount - failedCount,
    recent: payments.slice(0, 8),
  };
}
