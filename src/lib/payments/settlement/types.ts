export type SettlementCommand = {
  paymentId: string;
  idempotencyKey: string;
  sourceChainId: number | null;
  sourceAsset: string;
  sourceTokenAddress: string | null;
  sourceTransactionHash: string | null;
  sourceAmount: string;
  destinationAddress: string | null;
};

export type SettlementInitiation = {
  state: "pending" | "failed";
  sourceTransactionHash: string | null;
  destinationChainId: number | null;
  destinationAsset: string | null;
  destinationTokenAddress: string | null;
  destinationAmount: string | null;
  recipientAddress: string | null;
  bridgeMessageId: string | null;
  failureReason: string | null;
  retryable: boolean;
};

export type SettlementAttemptSnapshot = {
  id: string;
  paymentId: string;
  sourceChainId: number | null;
  destinationChainId: number | null;
  sourceAsset: string | null;
  sourceTokenAddress: string | null;
  destinationAsset: string | null;
  destinationTokenAddress: string | null;
  sourceAmount: string | null;
  destinationAmount: string | null;
  recipientAddress: string | null;
  sourceTransactionHash: string | null;
  destinationTransactionHash: string | null;
  bridgeMessageId: string | null;
};

export type SettlementExpectation = {
  destinationChainId: number;
  destinationTokenAddress: string;
  destinationAmount: string;
  recipientAddress: string;
  bridgeMessageId: string | null;
};

export type DestinationSettlementEvidence = {
  destinationChainId: number;
  transactionHash: string;
  transactionStatus: "success" | "failed";
  destinationTokenAddress: string;
  destinationAmount: string;
  recipientAddress: string;
  bridgeMessageId: string | null;
};

export type DestinationVerification =
  | { state: "verified"; evidence: DestinationSettlementEvidence }
  | { state: "simulated"; reason: string }
  | { state: "pending" }
  | { state: "failed"; reason: string; retryable: boolean };

export interface SettlementProvider {
  readonly id: string;
  readonly mode: "real" | "test";
  assertAvailable(): void;
  initiateSettlement(command: SettlementCommand): Promise<SettlementInitiation>;
}

export interface DestinationSettlementVerifier {
  verifyDestination(
    expected: SettlementExpectation | null,
    attempt: SettlementAttemptSnapshot,
  ): Promise<DestinationVerification>;
}
