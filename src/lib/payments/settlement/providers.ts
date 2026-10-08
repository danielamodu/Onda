import type {
  DestinationVerification,
  DestinationSettlementVerifier,
  SettlementAttemptSnapshot,
  SettlementExpectation,
  SettlementCommand,
  SettlementProvider,
  SettlementInitiation,
} from "@/lib/payments/settlement/types";

export class SettlementConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementConfigurationError";
  }
}

export class TempoSettlementProvider implements SettlementProvider {
  readonly id = "tempo";
  readonly mode = "real" as const;

  assertAvailable(): never {
    throw new SettlementConfigurationError(
      "Real Tempo settlement is unavailable until the Base Sepolia to Tempo testnet route and destination asset are authoritatively verified.",
    );
  }

  async initiateSettlement(command: SettlementCommand): Promise<SettlementInitiation> {
    void command;
    this.assertAvailable();
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
  async verifyDestination(expected: SettlementExpectation | null, attempt: SettlementAttemptSnapshot): Promise<DestinationVerification> {
    void expected;
    void attempt;
    throw new SettlementConfigurationError(
      "Tempo destination verification is unavailable until the route, destination token, and confirmation policy are verified.",
    );
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

export function getSettlementUiMode(): "test" | "unavailable" {
  return process.env.SETTLEMENT_PROVIDER === "test" && process.env.NODE_ENV !== "production" ? "test" : "unavailable";
}
