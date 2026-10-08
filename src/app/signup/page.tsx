import Link from "next/link";
import { redirect } from "next/navigation";
import { Brand } from "@/components/brand";
import { AuthForm } from "@/components/auth-form";
import { getSessionUser } from "@/lib/auth/session";

export default async function SignupPage() {
  if (await getSessionUser()) redirect("/");
  return <main className="auth-layout"><header className="auth-header"><Brand/><Link className="nav-link" href="/login">Sign in</Link></header><section className="auth-panel"><p className="eyebrow">START WITH ONDA</p><h1>Set up your business.</h1><p className="subheading">Create an account to start preparing payments to Nigeria.</p><AuthForm mode="signup"/><p className="fine-print auth-note">By continuing, you’re setting up a payment workspace. No funds are moved during this phase.</p></section><div className="auth-side"><div className="side-orbit"><span>o</span><i/><b/></div><div className="side-copy"><span>BUILT FOR CLARITY</span><p>Know what’s happening with every payment.</p></div></div></main>;
}
