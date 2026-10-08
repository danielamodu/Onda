import Link from "next/link";
import { redirect } from "next/navigation";
import { Brand, BrandEmblem } from "@/components/brand";
import { AuthForm } from "@/components/auth-form";
import { getSessionUser } from "@/lib/auth/session";

export default async function LoginPage() {
  if (await getSessionUser()) redirect("/");
  return <main className="auth-layout"><header className="auth-header"><Brand/><Link className="nav-link" href="/signup">Create account</Link></header><section className="auth-panel"><p className="eyebrow">BUSINESS ACCOUNT</p><h1>Sign in to Onda.</h1><p className="subheading">See your payments to Nigeria.</p><AuthForm mode="login"/></section><div className="auth-side"><div className="side-orbit"><BrandEmblem/></div><div className="side-copy"><span>ONDA PAYMENTS</span><p>Cross-border payments, made clear.</p></div></div></main>;
}
