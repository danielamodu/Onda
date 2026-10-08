import Link from "next/link";
import { redirect } from "next/navigation";
import { Brand } from "@/components/brand";
import { RecipientAuthForm } from "@/components/recipient-auth-form";
import { getRecipientSessionAccount } from "@/lib/auth/recipient-session";

export default async function RecipientLoginPage() {
  if (await getRecipientSessionAccount()) redirect("/recipient");
  return <main className="auth-layout"><header className="auth-header"><Brand/><Link className="nav-link" href="/recipient/signup">Create recipient account</Link></header><section className="auth-panel"><p className="eyebrow">RECIPIENT ACCESS</p><h1>Your incoming payments.</h1><p className="subheading">Sign in to see payments sent to your email.</p><RecipientAuthForm mode="login"/><p className="fine-print auth-note">Only payments addressed to this email can be viewed in this account.</p></section><div className="auth-side"><div className="side-orbit"><span>o</span><i/><b/></div><div className="side-copy"><span>MADE FOR RECIPIENTS</span><p>See what arrived and choose how you want to receive it.</p></div></div></main>;
}
