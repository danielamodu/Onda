"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PaymentStatus } from "@/lib/payments/domain";

type Attempt = {
  id: string;
  status: "pending" | "settled" | "failed";
  verificationStatus: "unverified" | "pending" | "verified" | "simulated" | "failed";
  isSimulation: boolean;
  retryable: boolean;
  destinationChainId: number | null;
  destinationAsset: string | null;
  destinationTokenAddress: string | null;
  destinationAmount: string | null;
  recipientAddress: string | null;
  destinationTransactionHash: string | null;
  settledAt: string | null;
  failureReason: string | null;
};

type Props = {
  paymentId: string;
  paymentStatus: PaymentStatus;
  providerMode: "test" | "unavailable";
  attempt: Attempt | null;
};

export function PaymentSettlement({ paymentId, paymentStatus, providerMode, attempt }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const visible = paymentStatus === "funded" || paymentStatus === "settling" || paymentStatus === "settled" || (!!attempt && paymentStatus === "failed");
  if (!visible) return null;

  async function settle() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/payments/${paymentId}/settlement`, { method: "POST" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 202) {
        setMessage(result.error ?? "Settlement could not be started.");
        return;
      }
      if (result.state === "settling") setMessage(result.isSimulation ? "Test simulation is processing; no funds have moved." : "Settling on Tempo…");
      if (result.state === "settled") setMessage(result.isSimulation ? "Test simulation complete. No funds moved and this is not a real settlement." : "Settlement verified on Tempo.");
      if (result.state === "failed") setMessage(result.reason ?? "Settlement failed.");
      router.refresh();
    } catch {
      setMessage("Settlement status is temporarily unavailable.");
    } finally {
      setBusy(false);
    }
  }

  const simulated = attempt?.isSimulation ?? false;
  const title = paymentStatus === "settled"
    ? simulated ? "Test settlement complete" : "Settled on Tempo"
    : paymentStatus === "failed" && attempt ? "Settlement failed" : paymentStatus === "settling" ? simulated ? "Test settlement" : "Settling on Tempo…" : "Ready for settlement";

  return <section className="settlement-panel" aria-live="polite">
    <div className="settlement-heading">
      <div>
        <span className="eyebrow">SETTLEMENT</span>
        <h2>{title}</h2>
      </div>
      <div className="settlement-steps" aria-label="Settlement progress"><span className="step-done">Funded</span><i/><span className={paymentStatus === "settling" || paymentStatus === "settled" ? "step-done" : ""}>Settling</span><i/><span className={paymentStatus === "settled" && !simulated ? "step-done" : ""}>Settled</span></div>
    </div>

    {paymentStatus === "funded" && providerMode === "test" && <p className="settlement-note">Test-only simulation. No funds will move and no Tempo transaction will be created.</p>}
    {paymentStatus === "funded" && providerMode === "unavailable" && <p className="settlement-note">Real Tempo settlement is unavailable until the route and destination asset are verified.</p>}
    {paymentStatus === "settling" && <p className="settlement-note">{simulated ? "Simulation only — no bridge transaction has been sent." : "Onda is checking the settlement provider. A submitted source transaction alone does not mean funds have settled."}</p>}
    {paymentStatus === "settled" && simulated && <p className="settlement-simulation">Test result only. No funds moved; this payment was not settled on Tempo.</p>}
    {paymentStatus === "failed" && attempt && <p className="settlement-failure">{attempt.failureReason ?? "Settlement failed."}{attempt.retryable ? " A retry is available." : ""}</p>}
    {attempt?.destinationTransactionHash && <div className="settlement-detail"><span>Tempo transaction</span><code>{attempt.destinationTransactionHash}</code></div>}
    {attempt?.destinationAmount && <div className="settlement-detail"><span>Destination amount</span><strong>{attempt.destinationAmount} {attempt.destinationAsset ?? ""}</strong></div>}
    {attempt?.settledAt && !simulated && <div className="settlement-detail"><span>Settled at</span><strong>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(attempt.settledAt))}</strong></div>}
    {message && <p className="settlement-note" role="status">{message}</p>}

    {paymentStatus === "funded" && providerMode === "test" && <button className="button button-quiet" type="button" disabled={busy} onClick={settle}>{busy ? "Running test…" : "Run test simulation"}</button>}
    {paymentStatus === "settling" && providerMode === "test" && <button className="button button-quiet" type="button" disabled={busy} onClick={settle}>{busy ? "Checking…" : "Check test settlement"}</button>}
    {paymentStatus === "settling" && providerMode === "unavailable" && <button className="button button-quiet" type="button" disabled>Tempo route not configured</button>}
    {paymentStatus === "failed" && attempt?.retryable && providerMode === "test" && <button className="button button-quiet" type="button" disabled={busy} onClick={settle}>{busy ? "Retrying…" : "Retry test simulation"}</button>}
  </section>;
}
