import Link from "next/link";
import { ArrowUpRight, Plus } from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import { BrandEmblem } from "@/components/brand";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { paymentStatusLabel } from "@/lib/payments/domain";

const money = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default async function DashboardPage() {
  const user = await getSessionUser();
  if (!user) return <main className="landing"><SiteHeader /><div className="landing-content"><p className="eyebrow"><span className="eyebrow-dot" />PAYMENTS TO NIGERIA</p><h1>Pay across borders.<br /><em>Keep it clear.</em></h1><p className="landing-copy">Create a payment. Your recipient chooses whether to keep USDC or receive naira.</p><div className="landing-actions"><Link className="button button-primary" href="/signup">Create account <span>→</span></Link><Link className="button button-quiet" href="/login">Sign in</Link></div><div className="flow-note"><span>01&nbsp; Pay someone</span><span className="flow-line"/><span>02&nbsp; Recipient chooses</span></div></div><footer className="landing-footer"><span>ONDA · PAYMENTS TO NIGERIA</span><span>BUSINESS PAYS · RECIPIENT CHOOSES</span></footer></main>;

  const [payments, paymentCount] = await Promise.all([
    db.payment.findMany({ where: { businessId: user.businessId }, include: { recipient: true }, orderBy: { createdAt: "desc" }, take: 8 }),
    db.payment.count({ where: { businessId: user.businessId } }),
  ]);
  return <div className="app-shell"><SiteHeader signedIn businessName={user.business.name} /><main className="dashboard page-wrap"><div className="page-heading"><div><p className="eyebrow">OVERVIEW</p><h1>Good to see you, {user.name.split(" ")[0]}.</h1><p className="subheading">Your payments, all in one place.</p></div><Link className="button button-primary" href="/payments/new"><Plus size={17}/> Pay someone</Link></div>
    <div className="dashboard-meta"><span>RECENT PAYMENTS</span><span>{paymentCount} {paymentCount === 1 ? "payment" : "payments"}</span></div>
    {payments.length ? <div className="payment-list">{payments.map((payment) => <Link className="payment-row" href={`/payments/${payment.id}`} key={payment.id}><div className="recipient-avatar">{payment.recipient.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase()}</div><div className="payment-person"><strong>{payment.recipient.name}</strong><span>{payment.recipient.identifier}</span></div><div className="payment-row-amount"><strong>${money.format(Number(payment.amount))} <small>USDC</small></strong><span>{new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" }).format(payment.createdAt)}</span></div><span className={`status status-${payment.status}`}>{paymentStatusLabel(payment.status)}</span><ArrowUpRight className="row-arrow" size={17}/></Link>)}</div> : <section className="empty-state"><BrandEmblem className="empty-mark"/><h2>Your payments will show up here</h2><p>Send your first payment to Nigeria when you’re ready.</p><Link className="button button-primary" href="/payments/new">Pay someone <span>→</span></Link></section>}
    <p className="dashboard-caption">Payments created here are recorded for review. No funds move yet.</p>
  </main></div>;
}
