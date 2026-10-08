import Link from "next/link";
import { redirect } from "next/navigation";
import { Brand, BrandEmblem } from "@/components/brand";
import { RecipientAuthForm } from "@/components/recipient-auth-form";
import { getRecipientSessionAccount } from "@/lib/auth/recipient-session";

export default async function RecipientLoginPage() {
  if (await getRecipientSessionAccount()) redirect("/recipient");
  return <main className="auth-layout"><header className="auth-header"><Brand/><Link className="nav-link" href="/recipient/signup">Create account</Link></header><section className="auth-panel"><p className="eyebrow">RECIPIENT ACCOUNT</p><h1>Your incoming payments.</h1><p className="subheading">Sign in to see payments sent to your email address.</p><RecipientAuthForm mode="login"/><p className="fine-print auth-note">Only payments addressed to this email can be viewed in your account.</p></section><div className="auth-side"><div className="side-orbit"><BrandEmblem/></div><div className="side-copy"><span>ONDA PAYMENTS</span><p>Cross-border payments, made clear.</p></div></div></main>;
}
