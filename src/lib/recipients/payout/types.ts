export type NgnPayoutQuote = {
  quoteId: string;
  sourceAmount: string;
  sourceAsset: "USDC";
  payoutAmount: string;
  payoutCurrency: "NGN";
  exchangeRate: string;
  feeAmount: string;
  expiresAt: Date;
};

export type RecipientPayoutStatus = "pending" | "completed" | "failed";

export type RecipientPayoutResult = {
  providerReference: string;
  status: RecipientPayoutStatus;
};

export interface RecipientPayoutProvider {
  quoteNgnConversion(paymentId: string): Promise<NgnPayoutQuote>;
  initiatePayout(paymentId: string, quoteId: string, bankAccountId: string): Promise<RecipientPayoutResult>;
  checkPayoutStatus(providerReference: string): Promise<RecipientPayoutResult>;
  verifyCompletedPayout(providerReference: string): Promise<boolean>;
}
