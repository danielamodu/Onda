import type {
  DestinationVerification,
  DestinationSettlementVerifier,
  SettlementAttemptSnapshot,
  SettlementExpectation,
  SettlementCommand,
  SettlementProvider,
  SettlementInitiation,
} from "@/lib/payments/settlement/types";
import { SettlementConfigurationError } from "@/lib/payments/settlement/errors";
import { TempoNativeSettlementProvider } from "@/lib/payments/tempo/provider";
import { TempoDestinationSettlementVerifier as TempoDestinationVerifier } from "@/lib/payments/tempo/verifier";
import { getTempoSettlementConfig } from "@/lib/payments/tempo/config";

export { SettlementConfigurationError };

import type { TempoChainGateway } from "@/lib/payments/tempo/provider";

export class TempoSettlementProvider implements SettlementProvider {
  private readonly inner = new TempoNativeSettlementProvider();
  readonly id = this.inner.id;
  readonly mode = this.inner.mode;

  assertAvailable(): void {
    this.inner.assertAvailable();
  }

  get batchGateway(): TempoChainGateway {
    return this.inner.batchGateway;
  }

  async initiateSettlement(command: SettlementCommand): Promise<SettlementInitiation> {
    return this.inner.initiateSettlement(command);
  }
}

export class TestSettlementProvider implements SettlementProvider {
  readonly id = "test-simulation";
  readonly mode = "test" as const;

  assertAvailable() {}

  async initiateSettlement(command: SettlementCommand): Promise<SettlementInitiation> {
    void command;
    return {
      state: "pending",
      sourceTransactionHash: null,
      destinationChainId: null,
      destinationAsset: null,
      destinationTokenAddress: null,
      destinationAmount: null,
      recipientAddress: null,
      bridgeMessageId: null,
      failureReason: null,
      retryable: false,
    };
  }
}

export class TempoDestinationSettlementVerifier implements DestinationSettlementVerifier {
  private readonly inner = new TempoDestinationVerifier();

  async verifyDestination(expected: SettlementExpectation | null, attempt: SettlementAttemptSnapshot): Promise<DestinationVerification> {
    return this.inner.verifyDestination(expected, attempt);
  }
}

export class TestDestinationSettlementVerifier implements DestinationSettlementVerifier {
  async verifyDestination() {
    return { state: "simulated" as const, reason: "Test-only simulation; no bridge transaction or funds were sent." };
  }
}

export function getSettlementRuntime() {
  const selection = process.env.SETTLEMENT_PROVIDER ?? "tempo";
  if (selection === "test") {
    if (process.env.NODE_ENV === "production") {
      throw new SettlementConfigurationError("The test settlement provider is disabled in production.");
    }
    return { provider: new TestSettlementProvider(), verifier: new TestDestinationSettlementVerifier() };
  }
  if (selection !== "tempo") throw new SettlementConfigurationError("SETTLEMENT_PROVIDER must be tempo or test.");
  return { provider: new TempoSettlementProvider(), verifier: new TempoDestinationSettlementVerifier() };
}

export function getSettlementUiMode(): "tempo" | "test" | "unavailable" {
  if (process.env.SETTLEMENT_PROVIDER === "test" && process.env.NODE_ENV !== "production") return "test";
  if ((process.env.SETTLEMENT_PROVIDER ?? "tempo") !== "tempo") return "unavailable";
  try {
    getTempoSettlementConfig();
    return "tempo";
  } catch {
    return "unavailable";
  }
}
