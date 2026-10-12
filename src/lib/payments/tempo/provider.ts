import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  parseUnits,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createClient } from "viem/tempo";
import { tempoModerato } from "viem/chains";
import { tip20Abi, decodeMemoTransferLog } from "@/lib/payments/tempo/abi";
import {
  RECEIVE_POLICY_GUARD_ADDRESS,
  getTempoSettlementConfig,
  type TempoSettlementConfig,
} from "@/lib/payments/tempo/config";
import { settlementMemo } from "@/lib/payments/tempo/memo";
import { SettlementConfigurationError } from "@/lib/payments/settlement/errors";
import type {
  SettlementCommand,
  SettlementInitiation,
  SettlementProvider,
} from "@/lib/payments/settlement/types";

export type TokenMeta = { decimals: number; symbol: string };

export type TempoChainGateway = {
  loadConfig: () => TempoSettlementConfig;
  deriveSender: (config: TempoSettlementConfig) => Address;
  getTokenMeta: (config: TempoSettlementConfig) => Promise<TokenMeta>;
  getSettlementBalance: (config: TempoSettlementConfig) => Promise<bigint>;
  findPriorTransfer: (input: {
    config: TempoSettlementConfig;
    memo: Hex;
    to: Address;
    amount: bigint;
  }) => Promise<Hash | null>;
  submitTransfer: (input: {
    config: TempoSettlementConfig;
    amount: bigint;
    to: Address;
    memo: Hex;
  }) => Promise<{ transactionHash: Hash; status: "success" | "reverted" | "pending" }>;
  submitBatchTransfer?: (input: {
    config: TempoSettlementConfig;
    transfers: Array<{ to: Address; amount: bigint; memo: Hex }>;
  }) => Promise<{ transactionHash: Hash; status: "success" | "reverted" | "pending" }>;
};

export function createLiveTempoGateway(): TempoChainGateway {
  return {
    loadConfig: getTempoSettlementConfig,
    deriveSender: (config) => privateKeyToAccount(config.settlementPrivateKey).address,
    getTokenMeta: async (config) => {
      const publicClient = createPublicClient({ transport: http(config.rpcUrl) });
      const [decimals, symbol] = await Promise.all([
        publicClient.readContract({ address: config.tokenAddress, abi: tip20Abi, functionName: "decimals" }),
        publicClient.readContract({ address: config.tokenAddress, abi: tip20Abi, functionName: "symbol" }),
      ]);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
        throw new Error(`TIP-20 token at ${config.tokenAddress} returned invalid decimals.`);
      }
      return { decimals, symbol };
    },
    getSettlementBalance: async (config) => {
      const publicClient = createPublicClient({ transport: http(config.rpcUrl) });
      const sender = privateKeyToAccount(config.settlementPrivateKey).address;
      return publicClient.readContract({ address: config.tokenAddress, abi: tip20Abi, functionName: "balanceOf", args: [sender] });
    },
    findPriorTransfer: async ({ config, memo, to, amount }) => {
      const publicClient = createPublicClient({ transport: http(config.rpcUrl) });
      const event = {
        type: "event",
        name: "TransferWithMemo",
        inputs: [
          { indexed: true, name: "from", type: "address" },
          { indexed: true, name: "to", type: "address" },
          { indexed: false, name: "value", type: "uint256" },
          { indexed: true, name: "memo", type: "bytes32" },
        ],
      } as const;
      // The public RPC caps eth_getLogs at 100,000 blocks per request, so scan
      // backwards from the head in chunks. The bound (~35 days at 1s blocks)
      // covers every realistic settlement retry window; older attempts are
      // already recorded with their transaction hash.
      const chunk = BigInt(100000);
      const lookback = BigInt(3000000);
      const head = await publicClient.getBlockNumber();
      const oldest = head > lookback ? head - lookback : BigInt(0);
      const ranges: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
      let toBlock = head;
      for (;;) {
        const fromBlock = toBlock - oldest + BigInt(1) > chunk ? toBlock - chunk + BigInt(1) : oldest;
        ranges.push({ fromBlock, toBlock });
        if (fromBlock <= oldest) break;
        toBlock = fromBlock - BigInt(1);
      }
      const checkLogs = async (logs: readonly { data: Hex; topics: readonly Hex[]; transactionHash: Hash }[]) => {
        for (const log of logs) {
          const decoded = decodeMemoTransferLog({ data: log.data, topics: log.topics });
          if (!decoded) continue;
          if (decoded.to.toLowerCase() !== to.toLowerCase()) continue;
          if (decoded.memo.toLowerCase() !== memo.toLowerCase()) continue;
          if (decoded.value !== amount) continue;
          const receipt = await publicClient.getTransactionReceipt({ hash: log.transactionHash });
          if (receipt.status !== "success") continue;
          return log.transactionHash;
        }
        return null;
      };
      for (let index = 0; index < ranges.length; index += 6) {
        const batch = ranges.slice(index, index + 6);
        const pages = await Promise.all(
          batch.map(({ fromBlock, toBlock: batchTo }) =>
            publicClient.getLogs({ address: config.tokenAddress, event, args: { memo }, fromBlock, toBlock: batchTo }),
          ),
        );
        for (const logs of pages) {
          const found = await checkLogs(logs);
          if (found) return found;
        }
      }
      return null;
    },
    submitTransfer: async ({ config, amount, to, memo }) => {
      const account = privateKeyToAccount(config.settlementPrivateKey);
      const client = createClient({ account, chain: tempoModerato, transport: http(config.rpcUrl) });
      const result = await client.token.transferSync({ amount, to, token: config.tokenAddress, memo });
      return { transactionHash: result.receipt.transactionHash, status: result.receipt.status };
    },
    submitBatchTransfer: async ({ config, transfers }) => {
      if (transfers.length === 0) throw new Error("Batch transfers must not be empty.");
      const account = privateKeyToAccount(config.settlementPrivateKey);
      const client = createClient({ account, chain: tempoModerato, transport: http(config.rpcUrl) });
      // One native Tempo transaction carrying every transferWithMemo call.
      // The protocol executes all calls atomically: all succeed or all revert.
      const calls = transfers.map((transfer) => ({
        to: config.tokenAddress,
        data: encodeFunctionData({
          abi: tip20Abi,
          functionName: "transferWithMemo",
          args: [transfer.to, transfer.amount, transfer.memo],
        }),
      }));
      const receipt = await client.sendTransactionSync({ calls });
      return { transactionHash: receipt.transactionHash, status: receipt.status };
    },
  };
}

function failedInitiation(reason: string, retryable: boolean): SettlementInitiation {
  return {
    state: "failed",
    sourceTransactionHash: null,
    destinationChainId: null,
    destinationAsset: null,
    destinationTokenAddress: null,
    destinationAmount: null,
    recipientAddress: null,
    bridgeMessageId: null,
    failureReason: reason,
    retryable,
  };
}

export class TempoNativeSettlementProvider implements SettlementProvider {
  readonly id = "tempo-native";
  readonly mode = "real" as const;
  readonly gateway: TempoChainGateway;

  constructor(gateway?: TempoChainGateway) {
    this.gateway = gateway ?? createLiveTempoGateway();
  }

  get batchGateway(): TempoChainGateway {
    return this.gateway;
  }

  assertAvailable(): void {
    this.gateway.loadConfig();
  }

  async initiateSettlement(command: SettlementCommand): Promise<SettlementInitiation> {
    let config: TempoSettlementConfig;
    try {
      config = this.gateway.loadConfig();
    } catch (error) {
      throw error instanceof SettlementConfigurationError
        ? error
        : new SettlementConfigurationError("Tempo settlement is not configured.");
    }

    if (!command.destinationAddress || !isAddress(command.destinationAddress)) {
      return failedInitiation("This payment has no valid recipient Tempo address, so settlement cannot start.", false);
    }
    const recipient = getAddress(command.destinationAddress);
    const sender = this.gateway.deriveSender(config);
    if (recipient.toLowerCase() === sender.toLowerCase()) {
      return failedInitiation("The settlement destination must not be the settlement wallet itself.", false);
    }
    if (recipient.toLowerCase() === RECEIVE_POLICY_GUARD_ADDRESS.toLowerCase()) {
      return failedInitiation("The settlement destination is not a payable recipient address.", false);
    }
    if (!/^\d+(?:\.\d+)?$/.test(command.sourceAmount)) {
      return failedInitiation("The settlement amount is invalid.", false);
    }

    let meta: TokenMeta;
    try {
      meta = await this.gateway.getTokenMeta(config);
    } catch {
      return failedInitiation("Tempo settlement token metadata is temporarily unavailable. Retry shortly.", true);
    }
    let amount: bigint;
    try {
      amount = parseUnits(command.sourceAmount, meta.decimals);
    } catch {
      return failedInitiation("The settlement amount is invalid for the configured token.", false);
    }
    if (amount <= BigInt(0)) return failedInitiation("The settlement amount must be greater than zero.", false);

    let balance: bigint;
    try {
      balance = await this.gateway.getSettlementBalance(config);
    } catch {
      return failedInitiation("The settlement balance is temporarily unavailable. Retry shortly.", true);
    }
    if (balance < amount) {
      return failedInitiation("The settlement wallet does not hold enough of the settlement asset for this payment.", true);
    }

    const memo = settlementMemo(command.paymentId);
    const tokenAddress = getAddress(config.tokenAddress);

    let priorHash: Hash | null;
    try {
      priorHash = await this.gateway.findPriorTransfer({ config, memo, to: recipient, amount });
    } catch {
      return failedInitiation("A prior settlement transfer could not be checked. Retry shortly instead of resubmitting.", true);
    }
    if (priorHash) {
      return {
        state: "pending",
        sourceTransactionHash: priorHash,
        destinationChainId: config.chainId,
        destinationAsset: meta.symbol,
        destinationTokenAddress: tokenAddress,
        destinationAmount: command.sourceAmount,
        recipientAddress: recipient,
        bridgeMessageId: null,
        failureReason: null,
        retryable: false,
      };
    }

    let submission: { transactionHash: Hash; status: "success" | "reverted" | "pending" };
    try {
      submission = await this.gateway.submitTransfer({ config, amount, to: recipient, memo });
    } catch {
      return failedInitiation("The Tempo transfer could not be submitted. Retry shortly; a duplicate will be reconciled, not repaid.", true);
    }
    if (submission.status === "pending") {
      return failedInitiation("The Tempo transfer was submitted but its inclusion is not confirmed. Retry shortly; a duplicate will be reconciled, not repaid.", true);
    }
    if (submission.status !== "success") {
      return failedInitiation("The Tempo transfer reverted. Check the settlement balance, then retry.", true);
    }
    return {
      state: "pending",
      sourceTransactionHash: submission.transactionHash,
      destinationChainId: config.chainId,
      destinationAsset: meta.symbol,
      destinationTokenAddress: tokenAddress,
      destinationAmount: command.sourceAmount,
      recipientAddress: recipient,
      bridgeMessageId: null,
      failureReason: null,
      retryable: false,
    };
  }
}
