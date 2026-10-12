import { createPublicClient, http, isAddress, parseUnits, type Address, type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tip20Abi, decodeMemoTransferLog } from "@/lib/payments/tempo/abi";
import {
  RECEIVE_POLICY_GUARD_ADDRESS,
  getTempoSettlementConfig,
  type TempoSettlementConfig,
} from "@/lib/payments/tempo/config";
import { settlementMemo } from "@/lib/payments/tempo/memo";
import type {
  DestinationSettlementEvidence,
  DestinationVerification,
  SettlementAttemptSnapshot,
  SettlementExpectation,
  DestinationSettlementVerifier,
} from "@/lib/payments/settlement/types";

export type TempoTransferLog = {
  from: Address;
  to: Address;
  value: bigint;
  memo: Hex;
};

export type TempoReceiptData = {
  status: "success" | "failed";
  tokenLogs: TempoTransferLog[];
};

export type TempoVerifyGateway = {
  loadConfig: () => TempoSettlementConfig;
  deriveSender: (config: TempoSettlementConfig) => Address;
  getRpcChainId: (config: TempoSettlementConfig) => Promise<number>;
  getReceipt: (config: TempoSettlementConfig, hash: Hash) => Promise<TempoReceiptData | null>;
  getTransactionChainId: (config: TempoSettlementConfig, hash: Hash) => Promise<number | null>;
  getTokenDecimals: (config: TempoSettlementConfig, token: Address) => Promise<number>;
};

export function createLiveTempoVerifyGateway(): TempoVerifyGateway {
  const clientFor = (config: TempoSettlementConfig) => createPublicClient({ transport: http(config.rpcUrl) });
  return {
    loadConfig: getTempoSettlementConfig,
    deriveSender: (config) => privateKeyToAccount(config.settlementPrivateKey).address,
    getRpcChainId: async (config) => clientFor(config).getChainId(),
    getReceipt: async (config, hash) => {
      const publicClient = clientFor(config);
      let receipt;
      try {
        receipt = await publicClient.getTransactionReceipt({ hash });
      } catch (error) {
        if (error instanceof Error && /not found|could not be found/i.test(error.message)) return null;
        throw error;
      }
      const tokenLogs: TempoTransferLog[] = [];
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== config.tokenAddress.toLowerCase()) continue;
        const decoded = decodeMemoTransferLog({ data: log.data, topics: log.topics });
        if (!decoded) continue;
        tokenLogs.push({ from: decoded.from, to: decoded.to, value: decoded.value, memo: decoded.memo });
      }
      return { status: receipt.status === "success" ? "success" : "failed", tokenLogs };
    },
    getTransactionChainId: async (config, hash) => {
      const publicClient = clientFor(config);
      try {
        const transaction = await publicClient.getTransaction({ hash });
        return transaction.chainId ?? null;
      } catch (error) {
        if (error instanceof Error && /not found|could not be found/i.test(error.message)) return null;
        throw error;
      }
    },
    getTokenDecimals: async (config, token) => {
      const decimals = await clientFor(config).readContract({ address: token, abi: tip20Abi, functionName: "decimals" });
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("Invalid token decimals.");
      return decimals;
    },
  };
}

function failedVerification(reason: string, retryable: boolean): DestinationVerification {
  return { state: "failed", reason, retryable };
}

export class TempoDestinationSettlementVerifier implements DestinationSettlementVerifier {
  private readonly gateway: TempoVerifyGateway;

  constructor(gateway?: TempoVerifyGateway) {
    this.gateway = gateway ?? createLiveTempoVerifyGateway();
  }

  async verifyDestination(
    expected: SettlementExpectation | null,
    attempt: SettlementAttemptSnapshot,
  ): Promise<DestinationVerification> {
    const config = this.gateway.loadConfig();
    if (!expected) {
      return failedVerification("The settlement attempt has no recorded destination to verify. Retry settlement.", true);
    }
    if (!attempt.sourceTransactionHash || !/^0x[a-fA-F0-9]{64}$/.test(attempt.sourceTransactionHash)) {
      return failedVerification("The settlement attempt has no verifiable Tempo transaction. Retry settlement.", true);
    }
    if (!isAddress(expected.destinationTokenAddress) || !isAddress(expected.recipientAddress)) {
      return failedVerification("The recorded settlement destination is invalid.", false);
    }
    if (expected.destinationTokenAddress.toLowerCase() !== config.tokenAddress.toLowerCase()) {
      return failedVerification("The recorded settlement token does not match the configured settlement token.", false);
    }
    const hash = attempt.sourceTransactionHash as Hash;

    const rpcChainId = await this.gateway.getRpcChainId(config);
    if (rpcChainId !== config.chainId) {
      throw new Error("The configured Tempo RPC returned a different chain ID.");
    }

    const receipt = await this.gateway.getReceipt(config, hash);
    if (!receipt) return { state: "pending" };
    if (receipt.status !== "success") {
      return failedVerification("The Tempo settlement transaction did not succeed.", false);
    }

    const transactionChainId = await this.gateway.getTransactionChainId(config, hash);
    if (transactionChainId === null) return { state: "pending" };
    if (transactionChainId !== expected.destinationChainId || transactionChainId !== config.chainId) {
      return failedVerification("The settlement transaction is on the wrong network.", false);
    }

    let decimals: number;
    try {
      decimals = await this.gateway.getTokenDecimals(config, expected.destinationTokenAddress as Address);
    } catch {
      throw new Error("Tempo settlement token metadata is temporarily unavailable.");
    }
    let expectedAmount: bigint;
    try {
      expectedAmount = parseUnits(expected.destinationAmount, decimals);
    } catch {
      return failedVerification("The recorded settlement amount is invalid.", false);
    }

    const sender = this.gateway.deriveSender(config).toLowerCase();
    const expectedMemo = settlementMemo(attempt.paymentId).toLowerCase();
    const matched = receipt.tokenLogs.find((log) => {
      if (log.from.toLowerCase() !== sender) return false;
      if (log.to.toLowerCase() !== expected.recipientAddress.toLowerCase()) return false;
      if (log.value !== expectedAmount) return false;
      if (log.memo.toLowerCase() !== expectedMemo) return false;
      return true;
    });
    if (!matched) {
      return failedVerification("The Tempo transfer does not match the settlement quote or its payment reference.", false);
    }
    if (matched.to.toLowerCase() === RECEIVE_POLICY_GUARD_ADDRESS.toLowerCase()) {
      return failedVerification("The settlement was redirected by the recipient policy guard.", false);
    }

    const evidence: DestinationSettlementEvidence = {
      destinationChainId: expected.destinationChainId,
      transactionHash: hash,
      transactionStatus: "success",
      destinationTokenAddress: expected.destinationTokenAddress,
      destinationAmount: expected.destinationAmount,
      recipientAddress: expected.recipientAddress,
      bridgeMessageId: null,
    };
    return { state: "verified", evidence };
  }
}
