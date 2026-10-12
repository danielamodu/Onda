import Link from "next/link";
import { ArrowUpRight, Plus } from "lucide-react";
import { MarketingLanding } from "@/components/marketing-landing";
import { SiteHeader } from "@/components/site-header";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { paymentStatusLabel } from "@/lib/payments/domain";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const money = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" });

export default async function DashboardPage() {
  const user = await getSessionUser();
  if (!user) return <MarketingLanding />;

  const [payments, paymentCount] = await Promise.all([
    db.payment.findMany({ where: { businessId: user.businessId }, include: { recipient: true }, orderBy: { createdAt: "desc" }, take: 8 }),
    db.payment.count({ where: { businessId: user.businessId } }),
  ]);

  return (
    <div className="app-shell">
      <SiteHeader signedIn businessName={user.business.name} />
      <main className="dashboard page-wrap dashboard-premium">
        <div className="dashboard-premium-heading">
          <div>
            <p className="eyebrow">BUSINESS PAYMENTS <span className="dashboard-country">· NIGERIA</span></p>
            <h1>Good to see you, {user.name.split(" ")[0]}.</h1>
            <p className="subheading">A clear view of the payments your team has created.</p>
          </div>
          <Button render={<Link href="/payments/new" />} role="link">
            <Plus aria-hidden="true" size={17} /> Pay someone
          </Button>
        </div>

        <Card className="dashboard-activity-card">
          <CardHeader className="dashboard-activity-header flex flex-row items-center justify-between px-6 py-5">
            <div>
              <CardTitle className="font-semibold text-primary">Payment activity</CardTitle>
              <CardDescription className="mt-1 text-xs">Recent payments created by your business.</CardDescription>
            </div>
            <span className="dashboard-count"><strong>{paymentCount}</strong> {paymentCount === 1 ? "payment" : "payments"}</span>
          </CardHeader>
          <CardContent className="dashboard-activity-content px-0 pb-0">
            {payments.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Recipient</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead><span className="sr-only">Open payment</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.map((payment) => (
                    <TableRow key={payment.id}>
                      <TableCell>
                        <Link className="dashboard-recipient-link" href={`/payments/${payment.id}`}>
                          <span className="recipient-avatar">{payment.recipient.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase()}</span>
                          <span className="dashboard-recipient-copy"><strong>{payment.recipient.name}</strong><small>{payment.recipient.identifier}</small></span>
                        </Link>
                      </TableCell>
                      <TableCell><strong className="dashboard-amount">${money.format(Number(payment.amount))}</strong><small className="dashboard-asset">{payment.asset}</small></TableCell>
                      <TableCell className="dashboard-date">{dateFormat.format(payment.createdAt)}</TableCell>
                      <TableCell><Badge className={`status status-${payment.status}`} variant="outline">{paymentStatusLabel(payment.status)}</Badge></TableCell>
                      <TableCell><Link aria-label={`Open payment to ${payment.recipient.name}`} className="dashboard-open-link" href={`/payments/${payment.id}`}><ArrowUpRight aria-hidden="true" size={16} /></Link></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="dashboard-empty">
                <span className="dashboard-empty-index">01</span>
                <div><h2>Your first payment starts here.</h2><p>Create a payment to a recipient in Nigeria. It will appear here with its status and details.</p></div>
                <Button render={<Link href="/payments/new" />} role="link">
                  Pay someone <ArrowUpRight aria-hidden="true" size={15} />
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
        <p className="dashboard-honesty-note">Payments are shown with their verified status. Creating a payment record alone does not move funds.</p>
      </main>
    </div>
  );
}
