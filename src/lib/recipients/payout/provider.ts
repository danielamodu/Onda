import type { NgnPayoutQuote, RecipientPayoutProvider, RecipientPayoutResult } from "@/lib/recipients/payout/types";

export class PayoutProviderUnavailableError extends Error {
  constructor() {
    super("NGN payout is not available yet. No conversion or bank transfer has been started.");
    this.name = "PayoutProviderUnavailableError";
  }
}

export class UnavailableRecipientPayoutProvider implements RecipientPayoutProvider {
  quoteNgnConversion(_paymentId: string): Promise<NgnPayoutQuote> {
    void _paymentId;
    return Promise.reject(new PayoutProviderUnavailableError());
  }

  initiatePayout(_paymentId: string, _quoteId: string, _bankAccountId: string): Promise<RecipientPayoutResult> {
    void _paymentId;
    void _quoteId;
    void _bankAccountId;
    return Promise.reject(new PayoutProviderUnavailableError());
  }

  checkPayoutStatus(_providerReference: string): Promise<RecipientPayoutResult> {
    void _providerReference;
    return Promise.reject(new PayoutProviderUnavailableError());
  }

  verifyCompletedPayout(_providerReference: string): Promise<boolean> {
    void _providerReference;
    return Promise.reject(new PayoutProviderUnavailableError());
  }
}

export const recipientPayoutProvider: RecipientPayoutProvider = new UnavailableRecipientPayoutProvider();
