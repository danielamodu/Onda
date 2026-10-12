"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { RecipientPreference } from "@/lib/recipients/validation";

export function RecipientPreferenceForm({ paymentId, preference }: { paymentId: string; preference: RecipientPreference | null }) {
  const [selected, setSelected] = useState<RecipientPreference | null>(preference);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const router = useRouter();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError("");
    setMessage("");
    const response = await fetch(`/api/recipient/payments/${paymentId}/preference`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preference: selected }),
    }).catch(() => null);
    const result = response ? await response.json().catch(() => ({})) : {};
    if (!response?.ok) {
      setError(result.error ?? "Your preference could not be saved. Try again.");
      setBusy(false);
      return;
    }
    setMessage(result.message);
    setBusy(false);
    router.refresh();
  }

  return <form className="recipient-choice" onSubmit={submit}>
    <p className="eyebrow">YOUR PREFERENCE</p>
    <h2>How do you want to receive this?</h2>
    <label className={`preference-option${selected === "KEEP_STABLECOIN" ? " preference-selected" : ""}`}>
      <input type="radio" name="preference" value="KEEP_STABLECOIN" checked={selected === "KEEP_STABLECOIN"} onChange={() => setSelected("KEEP_STABLECOIN")} />
      <span><strong>Keep AlphaUSD</strong><small>Leave the payment in AlphaUSD on Tempo.</small></span>
    </label>
    <label className={`preference-option${selected === "CONVERT_TO_NGN" ? " preference-selected" : ""}`}>
      <input type="radio" name="preference" value="CONVERT_TO_NGN" checked={selected === "CONVERT_TO_NGN"} onChange={() => setSelected("CONVERT_TO_NGN")} />
      <span><strong>Convert to NGN</strong><small>Convert your payment to Nigerian naira and withdraw to a bank account.</small></span>
    </label>
    {selected === "CONVERT_TO_NGN" && <p className="payout-coming">NGN payouts are coming later. Saving this preference does not convert or withdraw your payment.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {message && <p className="recipient-success" role="status">{message}</p>}
    <button className="button button-primary" type="submit" disabled={!selected || busy}>{busy ? "Saving…" : preference ? "Update preference" : "Save preference"}</button>
  </form>;
}
