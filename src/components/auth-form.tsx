"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export function AuthForm({ mode }: { mode: "signup" | "login" }) {
  const signup = mode === "signup";
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const response = await fetch(`/api/auth/${signup ? "register" : "login"}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    }).catch(() => null);
    const result = response ? await response.json().catch(() => ({})) : {};
    if (!response?.ok) { setError(result.error ?? "Couldn’t connect. Check your connection and try again."); setBusy(false); return; }
    router.push("/"); router.refresh();
  }

  return <form className="form-stack" onSubmit={submit}>
    {signup && <><label>Your name<input name="name" autoComplete="name" required minLength={2} maxLength={100} placeholder="Ada Okafor" /></label><label>Business name<input name="businessName" autoComplete="organization" required minLength={2} maxLength={120} placeholder="Acme Studio" /></label></>}
    <label>Work email<input name="email" type="email" autoComplete="email" required maxLength={254} placeholder="you@company.com" /></label>
    <label>Password<input name="password" type="password" autoComplete={signup ? "new-password" : "current-password"} required minLength={signup ? 10 : 1} maxLength={100} placeholder={signup ? "At least 10 characters" : "Your password"} /></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="button button-primary full-width" type="submit" disabled={busy}>{busy ? "Please wait…" : signup ? "Create business account" : "Sign in"}</button>
    <p className="form-footnote">{signup ? <>Already have an account? <Link href="/login">Sign in</Link></> : <>New to Onda? <Link href="/signup">Create an account</Link></>}</p>
  </form>;
}
