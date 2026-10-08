"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createWalletClient, custom, parseUnits, type Address, type EIP1193Provider, type Hash } from "viem";
import { usdcTransferAbi } from "@/lib/payments/base/abi";
import { fundingAuthorizationMessage } from "@/lib/payments/base/authorization";
import { base, baseSepolia } from "@/lib/payments/base/chains";
import type { BasePublicConfig } from "@/lib/payments/base/config";
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
  config: BasePublicConfig;
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
  const chain = config.chainId === 8453 ? base : baseSepolia;
  const canStart = status === "created" && !!config.destinationAddress;
  const canCheck = status === "funding" && !!transactionHash;

  async function verifyUntilSettled(hash: Hash, authorizationSignature: Hash) {
    setStatus("funding");
    setTransactionHash(hash);
    setAuthorizationSignature(authorizationSignature);
    setFundingError(null);
    setMessage("Transaction pending… Onda is checking Base.");
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
        setMessage(result.error ?? "Base verification is temporarily unavailable. Check again shortly.");
        return;
      }
      if (response.status !== 202) {
        setMessage(result.error ?? "We couldn’t verify this transfer. Try again.");
        return;
      }
      await delay(3000);
    }
    setMessage("Still waiting for Base confirmations. Check again in a moment.");
  }

  async function startFunding() {
    setBusy(true);
    setMessage("");
    try {
      if (!config.destinationAddress) throw new Error("Funding is not configured yet. Please contact your administrator.");
      if (!window.ethereum) throw new Error("Connect a browser wallet such as MetaMask or Coinbase Wallet to continue.");
      const wallet = createWalletClient({ chain, transport: custom(window.ethereum) });
      const [account] = await wallet.requestAddresses();
      if (!account) throw new Error("No wallet account was selected.");
      const walletChainId = await wallet.getChainId();
      if (walletChainId !== config.chainId) throw new Error(`Switch your wallet to ${config.chainName}, then try again.`);

      setMessage("Authorize this payment in your wallet, then confirm the USDC transfer.");
      const authorizationSignature = await wallet.signMessage({
        account,
        message: fundingAuthorizationMessage({
          paymentId,
          amount,
          chainId: config.chainId,
          tokenAddress: config.tokenAddress,
          destinationAddress: config.destinationAddress,
          senderAddress: account,
        }),
      });
      const hash = await wallet.writeContract({
        address: config.tokenAddress,
        abi: usdcTransferAbi,
        functionName: "transfer",
        args: [config.destinationAddress as Address, parseUnits(amount, 6)],
        account,
        chain,
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
      <span>{status === "created" ? `Send ${amount} USDC on ${config.chainName}.` : status === "funding" ? `Waiting for ${config.confirmations} Base confirmations.` : status === "funded" ? "USDC received and verified on Base." : fundingError ?? "This funding attempt could not be verified."}</span>
      {message && <span className="funding-message" role="status">{message}</span>}
      {transactionHash && <a className="tx-link" href={`${config.chainId === 8453 ? "https://basescan.org" : "https://sepolia.basescan.org"}/tx/${transactionHash}`} target="_blank" rel="noreferrer">View Base transaction <span aria-hidden="true">↗</span></a>}
      {status === "created" && !config.destinationAddress && <span className="funding-warning">Funding is not configured. Set BASE_FUNDING_ADDRESS to enable transfers.</span>}
    </div>
    {canStart && <button className="button button-primary" type="button" disabled={busy} onClick={startFunding}>{busy ? "Waiting for wallet…" : "Fund payment"}<span aria-hidden="true">→</span></button>}
    {canCheck && <button className="button button-quiet" type="button" disabled={busy} onClick={checkFunding}>{busy ? "Checking…" : "Check confirmation"}</button>}
  </section>;
}
