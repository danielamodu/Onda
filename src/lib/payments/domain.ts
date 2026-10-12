import { z } from "zod";

export const paymentStatuses = [
  "draft", "created", "funding", "funded", "settling", "settled",
  "payout_pending", "completed", "failed",
] as const;
export type PaymentStatus = (typeof paymentStatuses)[number];

const paymentStatusLabels: Record<PaymentStatus, string> = {
  draft: "Draft",
  created: "Created",
  funding: "Funding",
  funded: "Funded",
  settling: "Settling",
  settled: "Settled",
  payout_pending: "Payout pending",
  completed: "Completed",
  failed: "Failed",
};

export function paymentStatusLabel(status: PaymentStatus): string {
  return paymentStatusLabels[status];
}

const transitions: Record<PaymentStatus, readonly PaymentStatus[]> = {
  draft: ["created", "failed"],
  created: ["funding", "failed"],
  funding: ["funded", "failed"],
  funded: ["settling", "failed"],
  settling: ["settled", "failed"],
  settled: ["payout_pending", "completed", "failed"],
  payout_pending: ["completed", "failed"],
  completed: [],
  failed: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return transitions[from].includes(to);
}

export function transitionPayment(from: PaymentStatus, to: PaymentStatus): PaymentStatus {
  if (!canTransition(from, to)) throw new Error(`Invalid payment transition: ${from} → ${to}`);
  return to;
}

export const createPaymentSchema = z.object({
  recipientName: z.string().trim().min(2, "Enter the recipient’s name.").max(100),
  identifier: z.string().trim().min(3, "Enter an email address or recipient identifier.").max(254),
  tempoAddress: z.string().trim().regex(
    /^0x[a-fA-F0-9]{40}$/,
    "Enter the recipient’s Tempo wallet address (0x followed by 40 hex characters).",
  ),
  country: z.literal("NG", { error: "Nigeria is currently the supported destination." }),
  payoutCurrency: z.enum(["USDC", "NGN"]),
  amount: z.coerce.number().positive("Enter an amount greater than zero.").max(1_000_000, "Amount is above the current limit.").refine((value) => Number.isFinite(value) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-8, "Use no more than two decimal places."),
  asset: z.literal("AlphaUSD", { error: "AlphaUSD is the supported payment asset." }),
  reference: z.string().trim().max(140, "Reference must be 140 characters or fewer.").optional().default(""),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
