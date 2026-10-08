import type { DestinationSettlementEvidence, DestinationVerification, SettlementExpectation } from "@/lib/payments/settlement/types";

function normalizeAmount(value: string) {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return `${whole.replace(/^0+(?=\d)/, "")}.${fraction.replace(/0+$/, "") || "0"}`;
}

export function verifyDestinationEvidence(
  expected: SettlementExpectation,
  evidence: DestinationSettlementEvidence,
): DestinationVerification {
  if (!/^0x[a-fA-F0-9]{64}$/.test(evidence.transactionHash)) {
    return { state: "failed", reason: "Destination transaction hash is invalid.", retryable: false };
  }
  if (evidence.transactionStatus !== "success") {
    return { state: "failed", reason: "Destination transaction did not succeed.", retryable: false };
  }
  if (evidence.destinationChainId !== expected.destinationChainId) {
    return { state: "failed", reason: "Destination chain does not match the settlement route.", retryable: false };
  }
  if (evidence.destinationTokenAddress.toLowerCase() !== expected.destinationTokenAddress.toLowerCase()) {
    return { state: "failed", reason: "Destination token does not match the settlement route.", retryable: false };
  }
  if (evidence.recipientAddress.toLowerCase() !== expected.recipientAddress.toLowerCase()) {
    return { state: "failed", reason: "Destination recipient does not match the payment.", retryable: false };
  }
  const actualAmount = normalizeAmount(evidence.destinationAmount);
  const expectedAmount = normalizeAmount(expected.destinationAmount);
  if (actualAmount === null || expectedAmount === null || actualAmount !== expectedAmount) {
    return { state: "failed", reason: "Destination amount does not match the settlement quote.", retryable: false };
  }
  if (expected.bridgeMessageId && evidence.bridgeMessageId !== expected.bridgeMessageId) {
    return { state: "failed", reason: "Destination transaction references an unknown bridge message.", retryable: false };
  }
  return { state: "verified", evidence };
}
