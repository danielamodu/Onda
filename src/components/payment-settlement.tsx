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
  batchId: string | null;
  destinationChainId: number | null;
  destinationAsset: string | null;
  destinationTokenAddress: string | null;
  destinationAmount: string | null;
  recipientAddress: string | null;
  sourceTransactionHash: string | null;
  destinationTransactionHash: string | null;
  settledAt: string | null;
  failureReason: string | null;
};

type Props = {
  paymentId: string;
  paymentStatus: PaymentStatus;
  providerMode: "tempo" | "test" | "unavailable";
  attempt: Attempt | null;
  explorerBaseUrl: string | null;
};

export function PaymentSettlement({ paymentId, paymentStatus, providerMode, attempt, explorerBaseUrl }: Props) {
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
      if (result.state === "settling") setMessage(result.isSimulation ? "Test simulation is processing; no funds have moved." : "Tempo transfer submitted. Onda is verifying it independently.");
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
  const real = providerMode === "tempo";
  const title = paymentStatus === "settled"
    ? simulated ? "Test settlement complete" : "Settled on Tempo"
    : paymentStatus === "failed" && attempt ? "Settlement failed" : paymentStatus === "settling" ? simulated ? "Test settlement" : "Settling on Tempo…" : "Ready for settlement";
  const visibleHash = attempt?.destinationTransactionHash ?? attempt?.sourceTransactionHash ?? null;
  const explorerHref = visibleHash && explorerBaseUrl ? `${explorerBaseUrl.replace(/\/$/, "")}/tx/${visibleHash}` : null;

  return <section className="settlement-panel" aria-live="polite">
    <div className="settlement-heading">
      <div>
        <span className="eyebrow">SETTLEMENT</span>
        <h2>{title}</h2>
      </div>
      <div className="settlement-steps" aria-label="Settlement progress"><span className="step-done">Funded</span><i/><span className={paymentStatus === "settling" || paymentStatus === "settled" ? "step-done" : ""}>Settling</span><i/><span className={paymentStatus === "settled" && !simulated ? "step-done" : ""}>Settled</span></div>
    </div>

    {paymentStatus === "funded" && providerMode === "test" && <p className="settlement-note">Test-only simulation. No funds will move and no Tempo transaction will be created.</p>}
    {paymentStatus === "funded" && providerMode === "tempo" && <p className="settlement-note">Settling sends this payment’s amount in the configured Tempo settlement token to the recipient’s Tempo address, then verifies the transfer independently.</p>}
    {paymentStatus === "funded" && providerMode === "unavailable" && <p className="settlement-note">Real Tempo settlement is unavailable until the settlement wallet, token, and RPC are configured.</p>}
    {paymentStatus === "settling" && <p className="settlement-note">{simulated ? "Simulation only — no bridge transaction has been sent." : "A submitted Tempo transfer alone does not mean funds have settled. This payment completes only after independent verification."}</p>}
    {paymentStatus === "settled" && simulated && <p className="settlement-simulation">Test result only. No funds moved; this payment was not settled on Tempo.</p>}
    {paymentStatus === "failed" && attempt && <p className="settlement-failure">{attempt.failureReason ?? "Settlement failed."}{attempt.retryable ? " A retry is available." : ""}</p>}
    {explorerHref && <div className="settlement-detail"><span>Tempo transaction</span><a className="tx-link" href={explorerHref} target="_blank" rel="noreferrer"><code>{visibleHash}</code> <span aria-hidden="true">↗</span></a></div>}
    {!explorerHref && visibleHash && <div className="settlement-detail"><span>Tempo transaction</span><code>{visibleHash}</code></div>}
    {attempt?.destinationAmount && <div className="settlement-detail"><span>Destination amount</span><strong>{attempt.destinationAmount} {attempt.destinationAsset ?? ""}</strong></div>}
    {attempt?.batchId && <div className="settlement-detail"><span>Batch</span><code>{attempt.batchId}</code></div>}
    {attempt?.recipientAddress && !simulated && <div className="settlement-detail"><span>Recipient</span><code>{attempt.recipientAddress}</code></div>}
    {attempt?.settledAt && !simulated && <div className="settlement-detail"><span>Settled at</span><strong>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(attempt.settledAt))}</strong></div>}
    {message && <p className="settlement-note" role="status">{message}</p>}

    {paymentStatus === "funded" && providerMode === "test" && <button className="button button-quiet" type="button" disabled={busy} onClick={settle}>{busy ? "Running test…" : "Run test simulation"}</button>}
    {paymentStatus === "funded" && real && <button className="button button-quiet" type="button" disabled={busy} onClick={settle}>{busy ? "Settling…" : "Settle on Tempo"}</button>}
    {paymentStatus === "settling" && providerMode === "test" && <button className="button button-quiet" type="button" disabled={busy} onClick={settle}>{busy ? "Checking…" : "Check test settlement"}</button>}
    {paymentStatus === "settling" && real && <button className="button button-quiet" type="button" disabled={busy} onClick={settle}>{busy ? "Checking…" : "Check Tempo settlement"}</button>}
    {paymentStatus === "settling" && providerMode === "unavailable" && <button className="button button-quiet" type="button" disabled>Tempo settlement not configured</button>}
    {paymentStatus === "failed" && attempt?.retryable && providerMode === "test" && <button className="button button-quiet" type="button" disabled={busy} onClick={settle}>{busy ? "Retrying…" : "Retry test simulation"}</button>}
    {paymentStatus === "failed" && attempt?.retryable && real && <button className="button button-quiet" type="button" disabled={busy} onClick={settle}>{busy ? "Retrying…" : "Retry Tempo settlement"}</button>}
  </section>;
}
