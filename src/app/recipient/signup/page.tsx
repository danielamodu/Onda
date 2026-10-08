import Link from "next/link";
import { redirect } from "next/navigation";
import { Brand } from "@/components/brand";
import { RecipientAuthForm } from "@/components/recipient-auth-form";
import { getRecipientSessionAccount } from "@/lib/auth/recipient-session";

export default async function RecipientSignupPage() {
  if (await getRecipientSessionAccount()) redirect("/recipient");
  return <main className="auth-layout"><header className="auth-header"><Brand/><Link className="nav-link" href="/recipient/login">Sign in</Link></header><section className="auth-panel"><p className="eyebrow">RECIPIENT ACCESS</p><h1>Set up your recipient account.</h1><p className="subheading">Use the email the sender used for your payment.</p><RecipientAuthForm mode="signup"/><p className="fine-print auth-note">Your account connects payments that match your email. No funds move when you create an account.</p></section><div className="auth-side"><div className="side-orbit"><span>o</span><i/><b/></div><div className="side-copy"><span>MADE FOR RECIPIENTS</span><p>Every payment, with a clear status and next step.</p></div></div></main>;
}
