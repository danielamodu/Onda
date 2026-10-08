import Link from "next/link";
import { redirect } from "next/navigation";
import { Brand } from "@/components/brand";
import { AuthForm } from "@/components/auth-form";
import { getSessionUser } from "@/lib/auth/session";

export default async function LoginPage() {
  if (await getSessionUser()) redirect("/");
  return <main className="auth-layout"><header className="auth-header"><Brand/><Link className="nav-link" href="/signup">Create account</Link></header><section className="auth-panel"><p className="eyebrow">WELCOME BACK</p><h1>Sign in to Onda.</h1><p className="subheading">Pick up where you left off.</p><AuthForm mode="login"/></section><div className="auth-side"><div className="side-orbit"><span>o</span><i/><b/></div><div className="side-copy"><span>BUILT FOR CLARITY</span><p>Know what’s happening with every payment.</p></div></div></main>;
}
