import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { RecipientPortalHeader } from "@/components/recipient-portal-header";
import { getRecipientSessionAccount } from "@/lib/auth/recipient-session";
import { getRecipientDashboard, isRecipientPaymentSettled, type IncomingPayment } from "@/lib/recipients/service";

const money = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function statusLabel(payment: NonNullable<IncomingPayment>) {
  if (isRecipientPaymentSettled(payment)) return "Settled";
  if (payment.status === "settled" && payment.settlements[0]?.isSimulation) return "Test simulation · funds unavailable";
  if (payment.status === "settled") return "Settlement not verified";
  return payment.status === "failed" ? "Failed" : "Waiting for sender";
}

export default async function RecipientDashboardPage() {
  const account = await getRecipientSessionAccount();
  if (!account) redirect("/recipient/login");
  const dashboard = await getRecipientDashboard(account.id);

  return <div className="app-shell"><RecipientPortalHeader name={account.name}/><main className="dashboard page-wrap recipient-dashboard">
    <div className="page-heading"><div><p className="eyebrow">RECIPIENT OVERVIEW</p><h1>Welcome, {account.name.split(" ")[0]}.</h1><p className="subheading">Payments addressed to {account.email}.</p></div></div>
    <div className="recipient-stats"><div><span>INCOMING</span><strong>{dashboard.total}</strong></div><div><span>PENDING</span><strong>{dashboard.pending}</strong></div><div><span>SETTLED</span><strong>{dashboard.settled}</strong></div></div>
    <div className="dashboard-meta"><span>RECENT PAYMENTS</span><span>{dashboard.total} {dashboard.total === 1 ? "payment" : "payments"}</span></div>
    {dashboard.recent.length ? <div className="payment-list">{dashboard.recent.map((payment) => <Link className="payment-row recipient-payment-row" href={`/recipient/payments/${payment.id}`} key={payment.id}>
      <div className="recipient-avatar">{payment.business.name.slice(0, 1).toUpperCase()}</div>
      <div className="payment-person"><strong>{payment.business.name}</strong><span>Received {new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" }).format(payment.createdAt)}</span></div>
      <div className="payment-row-amount"><strong>${money.format(Number(payment.amount))} <small>{payment.asset}</small></strong><span>{payment.recipient.name}</span></div>
      <span className={`status ${isRecipientPaymentSettled(payment) ? "status-completed" : payment.status === "failed" ? "status-failed" : "status-funding"}`}>{statusLabel(payment)}</span><ArrowUpRight className="row-arrow" size={17}/>
    </Link>)}</div> : <section className="empty-state"><div className="empty-mark">o</div><h2>No incoming payments yet</h2><p>Payments sent to {account.email} will appear here.</p></section>}
    <p className="dashboard-caption">A payment is available only after destination settlement is independently verified.</p>
  </main></div>;
}
