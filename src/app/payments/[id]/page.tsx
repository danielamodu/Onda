import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Check, ChevronLeft, CircleDashed } from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import { FundPayment } from "@/components/fund-payment";
import { getSessionUser } from "@/lib/auth/session";
import { getBusinessPayment } from "@/lib/payments/service";
import { getTempoFundingUiConfig, getTempoPublicConfig } from "@/lib/payments/tempo/config";
import { PaymentSettlement } from "@/components/payment-settlement";
import { getSettlementUiMode } from "@/lib/payments/settlement/providers";
import { getPaymentLedgerTrail } from "@/lib/payments/settlement/service";
import { paymentStatusLabel } from "@/lib/payments/domain";
import { formatUnits } from "viem";

const money = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const ledgerTypeLabels: Record<string, string> = {
  CREDIT: "Deposit credited",
  RESERVE: "Reserved for settlement",
  RELEASE: "Reservation released",
  DEBIT: "Settled debit",
  ADJUSTMENT: "Correction",
};

export default async function PaymentDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const payment = await getBusinessPayment(user.businessId, id);
  if (!payment) notFound();
  const fundingConfig = await getTempoFundingUiConfig().catch(() => null);
  const date = new Intl.DateTimeFormat("en", { dateStyle: "long", timeStyle: "short" }).format(payment.createdAt);
  const paymentStatus = payment.status;
  const settlementAttempt = payment.settlements[0] ?? null;
  const settlementAttemptProps = settlementAttempt ? {
    id: settlementAttempt.id,
    status: settlementAttempt.status,
    verificationStatus: settlementAttempt.verificationStatus,
    isSimulation: settlementAttempt.isSimulation,
    retryable: settlementAttempt.retryable,
    batchId: settlementAttempt.batchId,
    destinationChainId: settlementAttempt.destinationChainId,
    destinationAsset: settlementAttempt.destinationAsset,
    destinationTokenAddress: settlementAttempt.destinationTokenAddress,
    destinationAmount: settlementAttempt.destinationAmount?.toString() ?? null,
    recipientAddress: settlementAttempt.recipientAddress,
    sourceTransactionHash: settlementAttempt.sourceTransactionHash,
    destinationTransactionHash: settlementAttempt.destinationTransactionHash,
    settledAt: settlementAttempt.settledAt?.toISOString() ?? null,
    failureReason: settlementAttempt.failureReason,
  } : null;
  const ledgerTrail = await getPaymentLedgerTrail(user.businessId, id).catch(() => []);
  let tempoExplorerBaseUrl: string | null = null;
  try {
    tempoExplorerBaseUrl = getTempoPublicConfig().explorerUrl;
  } catch {
    tempoExplorerBaseUrl = null;
  }
  const step = paymentStatus === "funded" || paymentStatus === "settled" || paymentStatus === "payout_pending" || paymentStatus === "completed" ? 2 : paymentStatus === "funding" ? 1 : 0;
  const destinationNetwork = payment.chainId === 42431 ? "Tempo Moderato" : null;
  return <div className="app-shell"><SiteHeader signedIn businessName={user.business.name}/><main className="page-wrap details-page"><Link className="back-link" href="/"><ChevronLeft size={17}/> All payments</Link><p className="eyebrow">PAYMENT DETAILS</p><section className="details-card"><div className="details-hero"><div className="details-icon"><CircleDashed size={22}/></div><div><span className={`status status-${payment.status}`}>{paymentStatusLabel(payment.status)}</span><h1>${money.format(Number(payment.amount))} <small>{payment.asset}</small></h1><p>Payment to {payment.recipient.name}</p></div></div><div className="funding-steps" aria-label="Payment progress"><span className={step >= 0 ? "step-done" : ""}>Created</span><i/><span className={step >= 1 ? "step-done" : ""}>Funding</span><i/><span className={step >= 2 ? "step-done" : ""}>Funded</span></div><div className="detail-rule"/><dl className="details-list"><div><dt>Recipient</dt><dd>{payment.recipient.name}<small>{payment.recipient.identifier}</small></dd></div><div><dt>Amount</dt><dd>${money.format(Number(payment.amount))} <span className="muted">{payment.asset}</span></dd></div><div><dt>Destination</dt><dd>Nigeria <span className="muted">· {payment.payoutCurrency}</span></dd></div>{destinationNetwork && <div><dt>Funded on</dt><dd>{destinationNetwork} <span className="muted">· Tempo AlphaUSD</span></dd></div>}<div><dt>Payment ID</dt><dd className="id-value">{payment.id}</dd></div>{payment.reference && <div><dt>Reference</dt><dd>{payment.reference}</dd></div>}<div><dt>Created</dt><dd>{date}</dd></div></dl><div className="payment-honesty"><Check size={16}/><span>{paymentStatus === "funded" ? "AlphaUSD transfer independently verified on Tempo." : paymentStatus === "funding" ? "Transfer submitted. Waiting for Tempo confirmation." : paymentStatus === "failed" ? "This transfer could not be verified." : "Payment created. Funds have not been sent."}</span></div></section><FundPayment paymentId={payment.id} amount={payment.amount.toFixed(2)} status={payment.status} transactionHash={payment.transactionHash} authorizationSignature={payment.fundingAuthorizationSignature} fundingError={payment.fundingError} config={fundingConfig}/><PaymentSettlement paymentId={payment.id} paymentStatus={payment.status} providerMode={getSettlementUiMode()} attempt={settlementAttemptProps} explorerBaseUrl={tempoExplorerBaseUrl}/>{ledgerTrail.length > 0 && <section className="details-card"><p className="eyebrow">TREASURY TRAIL</p><dl className="details-list">{ledgerTrail.map((entry) => <div key={entry.id}><dt>{ledgerTypeLabels[entry.type] ?? entry.type}</dt><dd>{formatUnits(BigInt(entry.amountUnits), entry.tokenDecimals)} <span className="muted">{entry.tokenSymbol}</span>{entry.reference && <small>{entry.reference}</small>}</dd></div>)}</dl></section>}<p className="details-caption">Funding transfers are sent directly from your connected wallet to Onda’s Tempo treasury. Onda never holds your wallet keys.</p></main></div>;
}
