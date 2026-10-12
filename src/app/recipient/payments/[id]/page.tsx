import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Check, ChevronLeft, CircleDashed } from "lucide-react";
import { RecipientPortalHeader } from "@/components/recipient-portal-header";
import { RecipientPreferenceForm } from "@/components/recipient-preference";
import { getRecipientSessionAccount } from "@/lib/auth/recipient-session";
import { getIncomingPayment, isRecipientPaymentSettled } from "@/lib/recipients/service";
import { paymentStatusLabel } from "@/lib/payments/domain";

const money = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default async function RecipientPaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const account = await getRecipientSessionAccount();
  if (!account) redirect("/recipient/login");
  const { id } = await params;
  const payment = await getIncomingPayment(account.id, id);
  if (!payment) notFound();

  const settlement = payment.settlements[0] ?? null;
  const available = isRecipientPaymentSettled(payment);
  const simulated = payment.status === "settled" && settlement?.isSimulation === true;
  const displayedStatus = available ? "Settled" : simulated ? "Test simulation" : payment.status === "settled" ? "Settlement unverified" : paymentStatusLabel(payment.status);
  const funded = Boolean(payment.transactionHash && payment.confirmedAt);
  const fundingStatus = funded ? "Confirmed on Tempo" : payment.status === "funding" ? "Confirmation pending" : "Not funded yet";
  const settlementStatus = available ? "Verified" : simulated ? "Test only · no funds moved" : settlement?.status === "pending" ? "In progress" : "Not verified";
  const network = payment.chainId === 42431 ? "Tempo Moderato" : null;

  return <div className="app-shell"><RecipientPortalHeader name={account.name}/><main className="page-wrap details-page recipient-details">
    <Link className="back-link" href="/recipient"><ChevronLeft size={17}/> All incoming payments</Link>
    <p className="eyebrow">INCOMING PAYMENT</p>
    <section className="details-card">
      <div className="details-hero"><div className="details-icon"><CircleDashed size={22}/></div><div><span className={`status ${available ? "status-completed" : simulated ? "status-funding" : payment.status === "failed" ? "status-failed" : "status-created"}`}>{displayedStatus}</span><h1>${money.format(Number(payment.amount))} <small>{payment.asset}</small></h1><p>From {payment.business.name}</p></div></div>
      <div className="detail-rule"/>
      <dl className="details-list">
        <div><dt>Sender</dt><dd>{payment.business.name}</dd></div>
        <div><dt>Amount</dt><dd>${money.format(Number(payment.amount))} <span className="muted">{payment.asset}</span></dd></div>
        <div><dt>Payment status</dt><dd>{displayedStatus}</dd></div>
        <div><dt>Tempo funding</dt><dd>{fundingStatus}{network && funded && <small>{network} · transaction verified</small>}</dd></div>
        <div><dt>Settlement</dt><dd>{settlementStatus}{available && settlement?.settledAt && <small>{new Intl.DateTimeFormat("en", { dateStyle: "long", timeStyle: "short" }).format(settlement.settledAt)}</small>}</dd></div>
        <div><dt>Settlement destination</dt><dd>{available && settlement?.destinationAsset ? `${settlement.destinationAsset}${settlement.destinationChainId ? ` · chain ${settlement.destinationChainId}` : ""}` : "Not available yet"}</dd></div>
        <div><dt>Payment ID</dt><dd className="id-value">{payment.id}</dd></div>
        <div><dt>Created</dt><dd>{new Intl.DateTimeFormat("en", { dateStyle: "long", timeStyle: "short" }).format(payment.createdAt)}</dd></div>
      </dl>
      <div className={`payment-honesty${available ? " recipient-honesty-ready" : " recipient-honesty-pending"}`}><Check size={16}/><span>{available ? "Destination settlement is verified. You can now choose how to receive this payment." : simulated ? "This was a test simulation. No funds moved and this payment is not available." : "Funds are not available until destination settlement is independently verified."}</span></div>
    </section>
    {available ? <RecipientPreferenceForm paymentId={payment.id} preference={payment.recipientPreference}/> : <p className="details-caption">Your preference can be selected after a real destination settlement is verified.</p>}
    {available && payment.recipientPreference && <section className="recipient-next-step"><p className="eyebrow">NEXT STEP</p><strong>{payment.recipientPreference === "KEEP_STABLECOIN" ? `Keep ${payment.asset}` : "Convert to NGN"}</strong><p>{payment.recipientPreference === "KEEP_STABLECOIN" ? "Your preference is saved. No additional transfer was started." : "Your preference is saved. NGN conversion and bank payout have not started and are not available yet."}</p></section>}
  </main></div>;
}
