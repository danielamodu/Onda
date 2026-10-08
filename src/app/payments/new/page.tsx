import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import { PaymentForm } from "@/components/payment-form";
import { getSessionUser } from "@/lib/auth/session";

export default async function NewPaymentPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return <div className="app-shell"><SiteHeader signedIn businessName={user.business.name}/><main className="page-wrap create-page"><Link className="back-link" href="/"><ChevronLeft size={17}/> All payments</Link><div className="page-heading create-heading"><div><p className="eyebrow">NEW PAYMENT</p><h1>Pay someone</h1><p className="subheading">Add a recipient and payment details.</p></div></div><PaymentForm/><aside className="inline-note"><span className="note-dot"/>Creating a payment records the details. Funds move only when you fund it.</aside></main></div>;
}
