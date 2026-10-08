import Link from "next/link";
import { redirect } from "next/navigation";
import { Brand, BrandEmblem } from "@/components/brand";
import { RecipientAuthForm } from "@/components/recipient-auth-form";
import { getRecipientSessionAccount } from "@/lib/auth/recipient-session";

export default async function RecipientSignupPage() {
  if (await getRecipientSessionAccount()) redirect("/recipient");
  return <main className="auth-layout"><header className="auth-header"><Brand/><Link className="nav-link" href="/recipient/login">Sign in</Link></header><section className="auth-panel"><p className="eyebrow">RECIPIENT ACCOUNT</p><h1>Set up your recipient account.</h1><p className="subheading">Use the email address the sender used for your payment.</p><RecipientAuthForm mode="signup"/><p className="fine-print auth-note">Your account shows payments addressed to this email. Creating an account does not move funds.</p></section><div className="auth-side"><div className="side-orbit"><BrandEmblem/></div><div className="side-copy"><span>ONDA PAYMENTS</span><p>Cross-border payments, made clear.</p></div></div></main>;
}
