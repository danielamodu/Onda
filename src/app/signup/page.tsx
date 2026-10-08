import Link from "next/link";
import { redirect } from "next/navigation";
import { Brand, BrandEmblem } from "@/components/brand";
import { AuthForm } from "@/components/auth-form";
import { getSessionUser } from "@/lib/auth/session";

export default async function SignupPage() {
  if (await getSessionUser()) redirect("/");
  return <main className="auth-layout"><header className="auth-header"><Brand/><Link className="nav-link" href="/login">Sign in</Link></header><section className="auth-panel"><p className="eyebrow">BUSINESS ACCOUNT</p><h1>Set up your business.</h1><p className="subheading">Create an account to pay recipients in Nigeria.</p><AuthForm mode="signup"/><p className="fine-print auth-note">Creating an account does not move funds.</p></section><div className="auth-side"><div className="side-orbit"><BrandEmblem/></div><div className="side-copy"><span>ONDA PAYMENTS</span><p>Cross-border payments, made clear.</p></div></div></main>;
}
