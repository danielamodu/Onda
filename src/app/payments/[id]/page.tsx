import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Check, ChevronLeft, CircleDashed } from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import { FundPayment } from "@/components/fund-payment";
import { getSessionUser } from "@/lib/auth/session";
import { getBusinessPayment } from "@/lib/payments/service";
import { getBasePublicConfig } from "@/lib/payments/base/config";
import { PaymentSettlement } from "@/components/payment-settlement";
import { getSettlementUiMode } from "@/lib/payments/settlement/providers";
import { paymentStatusLabel } from "@/lib/payments/domain";

const money = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default async function PaymentDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const payment = await getBusinessPayment(user.businessId, id);
  if (!payment) notFound();
  const baseConfig = getBasePublicConfig();
  const date = new Intl.DateTimeFormat("en", { dateStyle: "long", timeStyle: "short" }).format(payment.createdAt);
  const paymentStatus = payment.status;
  const settlementAttempt = payment.settlements[0] ?? null;
  const settlementAttemptProps = settlementAttempt ? {
    id: settlementAttempt.id,
    status: settlementAttempt.status,
    verificationStatus: settlementAttempt.verificationStatus,
    isSimulation: settlementAttempt.isSimulation,
    retryable: settlementAttempt.retryable,
    destinationChainId: settlementAttempt.destinationChainId,
    destinationAsset: settlementAttempt.destinationAsset,
    destinationTokenAddress: settlementAttempt.destinationTokenAddress,
    destinationAmount: settlementAttempt.destinationAmount?.toString() ?? null,
    recipientAddress: settlementAttempt.recipientAddress,
    destinationTransactionHash: settlementAttempt.destinationTransactionHash,
    settledAt: settlementAttempt.settledAt?.toISOString() ?? null,
    failureReason: settlementAttempt.failureReason,
  } : null;
  const step = paymentStatus === "funded" || paymentStatus === "settled" || paymentStatus === "payout_pending" || paymentStatus === "completed" ? 2 : paymentStatus === "funding" ? 1 : 0;
  const destinationNetwork = payment.chainId === 8453 ? "Base" : payment.chainId === 84532 ? "Base Sepolia" : null;
  return <div className="app-shell"><SiteHeader signedIn businessName={user.business.name}/><main className="page-wrap details-page"><Link className="back-link" href="/"><ChevronLeft size={17}/> All payments</Link><p className="eyebrow">PAYMENT DETAILS</p><section className="details-card"><div className="details-hero"><div className="details-icon"><CircleDashed size={22}/></div><div><span className={`status status-${payment.status}`}>{paymentStatusLabel(payment.status)}</span><h1>${money.format(Number(payment.amount))} <small>{payment.asset}</small></h1><p>Payment to {payment.recipient.name}</p></div></div><div className="funding-steps" aria-label="Payment progress"><span className={step >= 0 ? "step-done" : ""}>Created</span><i/><span className={step >= 1 ? "step-done" : ""}>Funding</span><i/><span className={step >= 2 ? "step-done" : ""}>Funded</span></div><div className="detail-rule"/><dl className="details-list"><div><dt>Recipient</dt><dd>{payment.recipient.name}<small>{payment.recipient.identifier}</small></dd></div><div><dt>Amount</dt><dd>${money.format(Number(payment.amount))} <span className="muted">{payment.asset}</span></dd></div><div><dt>Destination</dt><dd>Nigeria <span className="muted">· {payment.payoutCurrency}</span></dd></div>{destinationNetwork && <div><dt>Funded on</dt><dd>{destinationNetwork} <span className="muted">· Base USDC</span></dd></div>}<div><dt>Payment ID</dt><dd className="id-value">{payment.id}</dd></div>{payment.reference && <div><dt>Reference</dt><dd>{payment.reference}</dd></div>}<div><dt>Created</dt><dd>{date}</dd></div></dl><div className="payment-honesty"><Check size={16}/><span>{paymentStatus === "funded" ? "USDC transfer independently verified on Base." : paymentStatus === "funding" ? "Transfer submitted. Waiting for Base confirmations." : paymentStatus === "failed" ? "This transfer could not be verified." : "Payment created. Funds have not been sent."}</span></div></section><FundPayment paymentId={payment.id} amount={payment.amount.toFixed(2)} status={payment.status} transactionHash={payment.transactionHash} authorizationSignature={payment.fundingAuthorizationSignature} fundingError={payment.fundingError} config={baseConfig}/><PaymentSettlement paymentId={payment.id} paymentStatus={payment.status} providerMode={getSettlementUiMode()} attempt={settlementAttemptProps}/><p className="details-caption">Transfers are sent directly from your connected wallet to Onda’s configured funding address. Onda never holds your wallet keys.</p></main></div>;
}
