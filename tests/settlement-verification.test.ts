import { describe, expect, it } from "vitest";
import { verifyDestinationEvidence } from "@/lib/payments/settlement/verification";
import type { DestinationSettlementEvidence, SettlementExpectation } from "@/lib/payments/settlement/types";

const expected: SettlementExpectation = {
  destinationChainId: 42431,
  destinationTokenAddress: "test-token",
  destinationAmount: "500.00",
  recipientAddress: "test-recipient",
  bridgeMessageId: "test-message-1",
};

const evidence: DestinationSettlementEvidence = {
  destinationChainId: 42431,
  transactionHash: `0x${"11".repeat(32)}`,
  transactionStatus: "success",
  destinationTokenAddress: "test-token",
  destinationAmount: "500",
  recipientAddress: "test-recipient",
  bridgeMessageId: "test-message-1",
};

describe("destination settlement evidence verification", () => {
  it("accepts matching destination evidence", () => {
    expect(verifyDestinationEvidence(expected, evidence)).toEqual({ state: "verified", evidence });
  });

  it("rejects a wrong destination chain", () => {
    expect(verifyDestinationEvidence(expected, { ...evidence, destinationChainId: 84532 })).toMatchObject({ state: "failed", reason: expect.stringContaining("chain") });
  });

  it("rejects a wrong destination token", () => {
    expect(verifyDestinationEvidence(expected, { ...evidence, destinationTokenAddress: "other-test-token" })).toMatchObject({ state: "failed", reason: expect.stringContaining("token") });
  });

  it("rejects a wrong recipient", () => {
    expect(verifyDestinationEvidence(expected, { ...evidence, recipientAddress: "other-test-recipient" })).toMatchObject({ state: "failed", reason: expect.stringContaining("recipient") });
  });

  it("rejects an incorrect destination amount", () => {
    expect(verifyDestinationEvidence(expected, { ...evidence, destinationAmount: "499.99" })).toMatchObject({ state: "failed", reason: expect.stringContaining("amount") });
  });

  it("rejects a failed destination transaction", () => {
    expect(verifyDestinationEvidence(expected, { ...evidence, transactionStatus: "failed" })).toMatchObject({ state: "failed", reason: expect.stringContaining("did not succeed") });
  });

  it("rejects an invalid or unknown bridge message", () => {
    expect(verifyDestinationEvidence(expected, { ...evidence, bridgeMessageId: "unknown-message" })).toMatchObject({ state: "failed", reason: expect.stringContaining("unknown bridge message") });
    expect(verifyDestinationEvidence(expected, { ...evidence, transactionHash: "invalid-hash" })).toMatchObject({ state: "failed", reason: expect.stringContaining("hash is invalid") });
  });
});
