"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export function PaymentForm() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const response = await fetch("/api/payments", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    }).catch(() => null);
    const result = response ? await response.json().catch(() => ({})) : {};
    if (!response?.ok) { setError(result.error ?? "We couldn’t save this payment. Check your connection and try again."); setBusy(false); return; }
    router.push(`/payments/${result.id}`); router.refresh();
  }

  return <form className="payment-form" onSubmit={submit}>
    <section className="form-section"><div className="section-number">01</div><div className="section-content"><h2>Who are you paying?</h2><p>Send to someone in Nigeria.</p>
      <div className="field-grid"><label className="wide-field">Recipient name<input name="recipientName" required minLength={2} maxLength={100} placeholder="Full name" /></label><label className="wide-field">Email or recipient ID<input name="identifier" required minLength={3} maxLength={254} placeholder="name@example.com" /></label><label>Country<select name="country" defaultValue="NG"><option value="NG">Nigeria</option></select></label><label>Payout preference<select name="payoutCurrency" defaultValue="NGN"><option value="NGN">Nigerian naira (NGN)</option><option value="USDC">USDC</option></select></label></div>
    </div></section>
    <section className="form-section"><div className="section-number">02</div><div className="section-content"><h2>Payment details</h2><p>Fund this payment in USDC.</p>
      <div className="field-grid"><label>Amount<input name="amount" type="number" min="0.01" max="1000000" step="0.01" required placeholder="500.00" /><span className="field-hint">USD equivalent</span></label><label>Payment asset<select name="asset" defaultValue="USDC"><option value="USDC">USDC</option></select></label><label className="wide-field">Reference <span className="optional">Optional</span><input name="reference" maxLength={140} placeholder="Invoice number or note" /></label></div>
    </div></section>
    <div className="form-submit">{error && <p className="form-error" role="alert">{error}</p>}<p className="fine-print">You’ll review the payment before any funds move. No funds are transferred at this stage.</p><button className="button button-primary" type="submit" disabled={busy}>{busy ? "Creating payment…" : "Create payment"}<span aria-hidden="true">→</span></button></div>
  </form>;
}
