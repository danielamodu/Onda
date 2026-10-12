"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createWalletClient, custom, parseUnits, type EIP1193Provider, type Hash } from "viem";
import { tempoModerato } from "viem/chains";
import { tip20Abi } from "@/lib/payments/tempo/abi";
import { fundingAuthorizationMessage } from "@/lib/payments/tempo/funding";
import type { TempoFundingUiConfig } from "@/lib/payments/tempo/config";
import type { PaymentStatus } from "@/lib/payments/domain";

declare global {
  interface Window { ethereum?: EIP1193Provider }
}

type Props = {
  paymentId: string;
  amount: string;
  status: PaymentStatus;
  transactionHash: string | null;
  authorizationSignature: string | null;
  fundingError: string | null;
  config: TempoFundingUiConfig | null;
};

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function FundPayment({ paymentId, amount, status: initialStatus, transactionHash: initialHash, authorizationSignature: initialAuthorization, fundingError: initialError, config }: Props) {
  const [status, setStatus] = useState(initialStatus);
  const [transactionHash, setTransactionHash] = useState(initialHash);
  const [authorizationSignature, setAuthorizationSignature] = useState(initialAuthorization);
  const [fundingError, setFundingError] = useState(initialError);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const canStart = status === "created" && !!config;
  const canCheck = status === "funding" && !!transactionHash;

  async function verifyUntilSettled(hash: Hash, authorizationSignature: Hash) {
    setStatus("funding");
    setTransactionHash(hash);
    setAuthorizationSignature(authorizationSignature);
    setFundingError(null);
    setMessage("Transaction pending… Onda is checking Tempo.");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await fetch(`/api/payments/${paymentId}/funding`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionHash: hash, authorizationSignature }),
      }).catch(() => null);
      const result = response ? await response.json().catch(() => ({})) : {};
      if (response?.ok && result.state === "funded") {
        setStatus("funded");
        setMessage("Payment funded.");
        router.refresh();
        return;
      }
      if (response?.status === 422 && result.state === "failed") {
        setStatus("failed");
        setFundingError(result.reason ?? "This transfer could not be verified.");
        setMessage("");
        router.refresh();
        return;
      }
      if (!response || (response.status >= 500 && response.status !== 503)) {
        setMessage("Verification is temporarily unavailable. Check again shortly.");
        return;
      }
      if (response.status === 409 || response.status === 404) {
        setMessage(result.error ?? "This payment can’t accept that transaction.");
        return;
      }
      if (response.status === 503) {
        setMessage(result.error ?? "Tempo verification is temporarily unavailable. Check again shortly.");
        return;
      }
      if (response.status !== 202) {
        setMessage(result.error ?? "We couldn’t verify this transfer. Try again.");
        return;
      }
      await delay(3000);
    }
    setMessage("Still waiting for Tempo confirmation. Check again in a moment.");
  }

  async function startFunding() {
    setBusy(true);
    setMessage("");
    try {
      if (!config) throw new Error("Funding is not configured yet. Please contact your administrator.");
      if (!window.ethereum) throw new Error("Connect a browser wallet such as MetaMask or Coinbase Wallet to continue.");
      const wallet = createWalletClient({ chain: tempoModerato, transport: custom(window.ethereum) });
      const [account] = await wallet.requestAddresses();
      if (!account) throw new Error("No wallet account was selected.");
      const walletChainId = await wallet.getChainId();
      if (walletChainId !== config.chainId) throw new Error(`Switch your wallet to ${config.chainName}, then try again.`);

      setMessage(`Authorize this payment in your wallet, then confirm the ${config.tokenSymbol} transfer.`);
      const authorizationSignature = await wallet.signMessage({
        account,
        message: fundingAuthorizationMessage({
          paymentId,
          amount,
          chainId: config.chainId,
          tokenAddress: config.tokenAddress,
          treasuryAddress: config.treasuryAddress,
          senderAddress: account,
        }),
      });
      const hash = await wallet.writeContract({
        address: config.tokenAddress,
        abi: tip20Abi,
        functionName: "transfer",
        args: [config.treasuryAddress, parseUnits(amount, config.tokenDecimals)],
        account,
        chain: tempoModerato,
      });
      await verifyUntilSettled(hash, authorizationSignature);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Wallet transfer could not be started.");
    } finally {
      setBusy(false);
    }
  }

  async function checkFunding() {
    if (!transactionHash || !authorizationSignature) return;
    setBusy(true);
    await verifyUntilSettled(transactionHash as Hash, authorizationSignature as Hash);
    setBusy(false);
  }

  return <section className="funding-panel" aria-live="polite">
    <div className="funding-copy">
      <strong>{status === "funded" ? "Payment funded" : status === "funding" ? "Transaction pending…" : status === "failed" ? "Funding failed" : "Ready to fund"}</strong>
      <span>{!config ? "Tempo funding is not configured yet." : status === "created" ? `Send ${amount} ${config.tokenSymbol} on ${config.chainName} to the Onda treasury.` : status === "funding" ? `Waiting for Tempo confirmation.` : status === "funded" ? `${config.tokenSymbol} received and verified on Tempo.` : fundingError ?? "This funding attempt could not be verified."}</span>
      {message && <span className="funding-message" role="status">{message}</span>}
      {transactionHash && config && <a className="tx-link" href={`${config.explorerUrl.replace(/\/$/, "")}/tx/${transactionHash}`} target="_blank" rel="noreferrer">View Tempo transaction <span aria-hidden="true">↗</span></a>}
      {status === "created" && !config && <span className="funding-warning">Funding is not configured. Set TEMPO_TREASURY_ADDRESS and the settlement token to enable transfers.</span>}
    </div>
    {canStart && <button className="button button-primary" type="button" disabled={busy} onClick={startFunding}>{busy ? "Waiting for wallet…" : "Fund payment"}<span aria-hidden="true">→</span></button>}
    {canCheck && <button className="button button-quiet" type="button" disabled={busy} onClick={checkFunding}>{busy ? "Checking…" : "Check confirmation"}</button>}
  </section>;
}
