import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { getAddress, parseUnits, encodeAbiParameters, keccak256, pad, stringToBytes, type Address, type Hash, type Hex } from "viem";
import {
  TEMPO_MODERATO_CHAIN_ID,
  getTempoSettlementConfig,
  type TempoSettlementConfig,
} from "@/lib/payments/tempo/config";
import { settlementMemo, settlementAttemptKey } from "@/lib/payments/tempo/memo";
import { decodeMemoTransferLog } from "@/lib/payments/tempo/abi";
import { TempoNativeSettlementProvider, type TempoChainGateway } from "@/lib/payments/tempo/provider";
import { TempoDestinationSettlementVerifier, type TempoVerifyGateway } from "@/lib/payments/tempo/verifier";
import { createPaymentSchema } from "@/lib/payments/domain";

const SENDER = "0x1111111111111111111111111111111111111111" as Address;
const RECIPIENT = "0x2222222222222222222222222222222222222222" as Address;
const TOKEN = "0x20c0000000000000000000000000000000000001" as Address;
const PRIOR_HASH = `0x${"33".repeat(32)}` as Hash;
const SUBMIT_HASH = `0x${"44".repeat(32)}` as Hash;

const testConfig: TempoSettlementConfig = {
  chainId: TEMPO_MODERATO_CHAIN_ID,
  rpcUrl: "https://example.invalid",
  tokenAddress: TOKEN,
  settlementPrivateKey: `0x${"55".repeat(32)}` as Hex,
  explorerUrl: "https://explore.testnet.tempo.xyz",
};

function chainGateway(overrides: Partial<TempoChainGateway> = {}): TempoChainGateway & { calls: { submits: number; reconciles: number } } {
  const calls = { submits: 0, reconciles: 0 };
  return {
    calls,
    loadConfig: () => testConfig,
    deriveSender: () => SENDER,
    getTokenMeta: async () => ({ decimals: 6, symbol: "AlphaUSD" }),
    getSettlementBalance: async () => parseUnits("1000000", 6),
    findPriorTransfer: async () => {
      calls.reconciles += 1;
      return null;
    },
    submitTransfer: async () => {
      calls.submits += 1;
      return { transactionHash: SUBMIT_HASH, status: "success" as const };
    },
    ...overrides,
  };
}

function verifyGateway(overrides: Partial<TempoVerifyGateway> = {}): TempoVerifyGateway {
  return {
    loadConfig: () => testConfig,
    deriveSender: () => SENDER,
    getRpcChainId: async () => TEMPO_MODERATO_CHAIN_ID,
    getReceipt: async () => null,
    getTransactionChainId: async () => TEMPO_MODERATO_CHAIN_ID,
    getTokenDecimals: async () => 6,
    ...overrides,
  };
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    paymentId: "payment-tempo-1",
    idempotencyKey: settlementAttemptKey("payment-tempo-1", 1),
    sourceChainId: 84532,
    sourceAsset: "USDC",
    sourceTokenAddress: null,
    sourceTransactionHash: null,
    sourceAmount: "10.00",
    destinationAddress: RECIPIENT,
    ...overrides,
  };
}

function attemptSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "attempt-1",
    paymentId: "payment-tempo-1",
    sourceChainId: 84532,
    destinationChainId: TEMPO_MODERATO_CHAIN_ID,
    sourceAsset: "USDC",
    sourceTokenAddress: null,
    destinationAsset: "AlphaUSD",
    destinationTokenAddress: getAddress(TOKEN),
    sourceAmount: "10.00",
    destinationAmount: "10.00",
    recipientAddress: getAddress(RECIPIENT),
    sourceTransactionHash: SUBMIT_HASH,
    destinationTransactionHash: null,
    bridgeMessageId: null,
    ...overrides,
  };
}

function expectation(overrides: Record<string, unknown> = {}) {
  return {
    destinationChainId: TEMPO_MODERATO_CHAIN_ID,
    destinationTokenAddress: getAddress(TOKEN),
    destinationAmount: "10.00",
    recipientAddress: getAddress(RECIPIENT),
    bridgeMessageId: null,
    ...overrides,
  };
}

describe("tempo settlement configuration", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.TEMPO_CHAIN_ID = "42431";
    process.env.TEMPO_RPC_URL = "https://rpc.moderato.tempo.xyz";
    process.env.TEMPO_SETTLEMENT_TOKEN_ADDRESS = TOKEN;
    process.env.TEMPO_SETTLEMENT_PRIVATE_KEY = `0x${"55".repeat(32)}`;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("accepts a valid Moderato configuration", () => {
    expect(getTempoSettlementConfig()).toMatchObject({ chainId: 42431, tokenAddress: getAddress(TOKEN) });
  });

  it.each([
    [{ TEMPO_CHAIN_ID: "4217" }, "mainnet chain"],
    [{ TEMPO_CHAIN_ID: "84532" }, "Base chain"],
    [{ TEMPO_CHAIN_ID: "" }, "missing chain"],
    [{ TEMPO_RPC_URL: "" }, "missing RPC"],
    [{ TEMPO_RPC_URL: "wss://rpc.moderato.tempo.xyz" }, "non-HTTP RPC"],
    [{ TEMPO_SETTLEMENT_TOKEN_ADDRESS: "" }, "missing token"],
    [{ TEMPO_SETTLEMENT_TOKEN_ADDRESS: "not-an-address" }, "invalid token"],
    [{ TEMPO_SETTLEMENT_PRIVATE_KEY: "" }, "missing signing key"],
    [{ TEMPO_SETTLEMENT_PRIVATE_KEY: "0x1234" }, "malformed signing key"],
  ] as Array<[Record<string, string>, string]>)("rejects %s (%s)", (overrides) => {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === "") delete process.env[key];
      else process.env[key] = value as string;
    }
    expect(() => getTempoSettlementConfig()).toThrow();
  });

  it("fails closed through the provider when configuration is missing", () => {
    delete process.env.TEMPO_SETTLEMENT_PRIVATE_KEY;
    const provider = new TempoNativeSettlementProvider(chainGateway({ loadConfig: getTempoSettlementConfig }));
    expect(() => provider.assertAvailable()).toThrow(/TEMPO_SETTLEMENT_PRIVATE_KEY/);
  });
});

describe("settlement memo", () => {
  it("derives a deterministic 32-byte reference per payment", () => {
    const first = settlementMemo("payment-tempo-1");
    expect(first).toMatch(/^0x[a-f0-9]{64}$/);
    expect(settlementMemo("payment-tempo-1")).toBe(first);
    expect(settlementMemo("payment-tempo-2")).not.toBe(first);
  });

  it("decodes only genuine memo transfers and ignores plain transfers", () => {
    const memo = settlementMemo("payment-tempo-1");
    const value = parseUnits("10.00", 6);
    const data = encodeAbiParameters([{ type: "uint256" }], [value]);
    const memoSig = keccak256(stringToBytes("TransferWithMemo(address,address,uint256,bytes32)"));
    const transferSig = keccak256(stringToBytes("Transfer(address,address,uint256)"));
    const decoded = decodeMemoTransferLog({ data, topics: [memoSig, pad(SENDER), pad(RECIPIENT), memo] });
    expect(decoded).toMatchObject({ from: getAddress(SENDER), to: getAddress(RECIPIENT), value, memo });
    expect(decodeMemoTransferLog({ data, topics: [transferSig, pad(SENDER), pad(RECIPIENT)] })).toBeNull();
  });
});

describe("tempo native settlement provider", () => {
  it("submits a memo-bound transfer and returns a pending initiation", async () => {
    const gateway = chainGateway();
    let submitted: { amount: bigint; to: Address; memo: Hex } | null = null;
    gateway.submitTransfer = async (input) => {
      gateway.calls.submits += 1;
      submitted = { amount: input.amount, to: input.to, memo: input.memo };
      return { transactionHash: SUBMIT_HASH, status: "success" };
    };
    const provider = new TempoNativeSettlementProvider(gateway);
    const result = await provider.initiateSettlement(command());
    expect(result).toMatchObject({
      state: "pending",
      sourceTransactionHash: SUBMIT_HASH,
      destinationChainId: 42431,
      destinationAsset: "AlphaUSD",
      destinationTokenAddress: getAddress(TOKEN),
      destinationAmount: "10.00",
      recipientAddress: getAddress(RECIPIENT),
      bridgeMessageId: null,
    });
    expect(submitted).toMatchObject({ amount: parseUnits("10.00", 6), to: getAddress(RECIPIENT), memo: settlementMemo("payment-tempo-1") });
  });

  it("reuses a prior transfer instead of resubmitting", async () => {
    const gateway = chainGateway({ findPriorTransfer: async () => PRIOR_HASH });
    const provider = new TempoNativeSettlementProvider(gateway);
    const result = await provider.initiateSettlement(command());
    expect(result).toMatchObject({ state: "pending", sourceTransactionHash: PRIOR_HASH });
    expect(gateway.calls.submits).toBe(0);
  });

  it("fails closed when the recipient Tempo address is missing or invalid", async () => {
    const provider = new TempoNativeSettlementProvider(chainGateway());
    for (const destinationAddress of [null, "", "not-an-address"]) {
      const result = await provider.initiateSettlement(command({ destinationAddress }));
      expect(result).toMatchObject({ state: "failed", retryable: false });
    }
    expect(chainGateway().calls.submits).toBe(0);
  });

  it("fails closed when the recipient is the settlement wallet itself", async () => {
    const provider = new TempoNativeSettlementProvider(chainGateway());
    const result = await provider.initiateSettlement(command({ destinationAddress: SENDER }));
    expect(result).toMatchObject({ state: "failed", retryable: false });
  });

  it("fails closed on an invalid amount", async () => {
    const provider = new TempoNativeSettlementProvider(chainGateway());
    const result = await provider.initiateSettlement(command({ sourceAmount: "0.00" }));
    expect(result).toMatchObject({ state: "failed", retryable: false });
  });

  it("marks transport failures retryable so a later attempt reconciles first", async () => {
    const submitFails = new TempoNativeSettlementProvider(chainGateway({
      submitTransfer: async () => { throw new Error("RPC timeout"); },
    }));
    await expect(submitFails.initiateSettlement(command())).resolves.toMatchObject({ state: "failed", retryable: true });

    const reconcileFails = new TempoNativeSettlementProvider(chainGateway({
      findPriorTransfer: async () => { throw new Error("RPC timeout"); },
    }));
    await expect(reconcileFails.initiateSettlement(command())).resolves.toMatchObject({ state: "failed", retryable: true });

    const metaFails = new TempoNativeSettlementProvider(chainGateway({
      getTokenMeta: async () => { throw new Error("RPC timeout"); },
    }));
    await expect(metaFails.initiateSettlement(command())).resolves.toMatchObject({ state: "failed", retryable: true });
  });

  it("marks a reverted transfer retryable without recording success", async () => {
    const provider = new TempoNativeSettlementProvider(chainGateway({
      submitTransfer: async () => ({ transactionHash: SUBMIT_HASH, status: "reverted" as const }),
    }));
    await expect(provider.initiateSettlement(command())).resolves.toMatchObject({ state: "failed", retryable: true });
  });

  it("refuses to submit when the settlement balance is insufficient", async () => {
    const gateway = chainGateway({ getSettlementBalance: async () => parseUnits("1.00", 6) });
    const provider = new TempoNativeSettlementProvider(gateway);
    await expect(provider.initiateSettlement(command())).resolves.toMatchObject({ state: "failed", retryable: true });
    expect(gateway.calls.submits).toBe(0);
  });

  it("treats an unreadable settlement balance as retryable", async () => {
    const provider = new TempoNativeSettlementProvider(chainGateway({
      getSettlementBalance: async () => { throw new Error("RPC timeout"); },
    }));
    await expect(provider.initiateSettlement(command())).resolves.toMatchObject({ state: "failed", retryable: true });
  });
});

describe("tempo destination verifier", () => {
  const memo = settlementMemo("payment-tempo-1");
  const matchingLog = { from: SENDER, to: getAddress(RECIPIENT), value: parseUnits("10.00", 6), memo };

  function successGateway() {
    return verifyGateway({
      getReceipt: async () => ({ status: "success" as const, tokenLogs: [matchingLog] }),
    });
  }

  it("verifies a matching transfer and echoes auditable evidence", async () => {
    const verifier = new TempoDestinationSettlementVerifier(successGateway());
    const result = await verifier.verifyDestination(expectation(), attemptSnapshot());
    expect(result).toEqual({
      state: "verified",
      evidence: {
        destinationChainId: 42431,
        transactionHash: SUBMIT_HASH,
        transactionStatus: "success",
        destinationTokenAddress: getAddress(TOKEN),
        destinationAmount: "10.00",
        recipientAddress: getAddress(RECIPIENT),
        bridgeMessageId: null,
      },
    });
  });

  it("reports pending while the transaction is unconfirmed", async () => {
    const verifier = new TempoDestinationSettlementVerifier(verifyGateway());
    await expect(verifier.verifyDestination(expectation(), attemptSnapshot())).resolves.toEqual({ state: "pending" });
  });

  it("fails a reverted transaction without retry", async () => {
    const verifier = new TempoDestinationSettlementVerifier(verifyGateway({
      getReceipt: async () => ({ status: "failed" as const, tokenLogs: [] }),
    }));
    await expect(verifier.verifyDestination(expectation(), attemptSnapshot())).resolves.toMatchObject({ state: "failed", retryable: false });
  });

  it.each([
    ["wrong chain", { txChain: 4217 }, /wrong network/],
    ["wrong token", { token: "0x3333333333333333333333333333333333333333" }, /token/],
    ["wrong recipient", { recipient: "0x4444444444444444444444444444444444444444" }, /does not match/],
    ["wrong amount", { amount: "9.99" }, /does not match/],
    ["wrong memo", { logMemo: `0x${"99".repeat(32)}` }, /payment reference/],
    ["plain transfer without memo", { logMemo: null }, /payment reference/],
  ])("rejects a transfer with %s", async (_label, variant: Record<string, unknown>, reason: RegExp) => {
    const expected = expectation({
      ...(variant.token ? { destinationTokenAddress: getAddress(variant.token as string) } : {}),
      ...(variant.recipient ? { recipientAddress: getAddress(variant.recipient as string) } : {}),
      ...(variant.amount ? { destinationAmount: variant.amount as string } : {}),
    });
    const expectedTxChain = (variant.txChain as number | undefined) ?? 42431;
    const includeLog = !("logMemo" in variant && variant.logMemo === null);
    const log = {
      ...matchingLog,
      memo: ("logMemo" in variant ? variant.logMemo : memo) as Hex,
    };
    const verifier = new TempoDestinationSettlementVerifier(verifyGateway({
      getReceipt: async () => ({ status: "success" as const, tokenLogs: includeLog ? [log] : [] }),
      getTransactionChainId: async () => expectedTxChain,
    }));
    const attempt = attemptSnapshot({ destinationTokenAddress: expected.destinationTokenAddress });
    await expect(verifier.verifyDestination(expected, attempt)).resolves.toMatchObject({ state: "failed", reason });
  });

  it("rejects funds redirected to the receive-policy guard", async () => {
    const guard = getAddress("0xB10C000000000000000000000000000000000000");
    const verifier = new TempoDestinationSettlementVerifier(verifyGateway({
      getReceipt: async () => ({ status: "success" as const, tokenLogs: [{ from: SENDER, to: guard, value: parseUnits("10.00", 6), memo }] }),
    }));
    const expected = expectation({ recipientAddress: guard });
    await expect(verifier.verifyDestination(expected, attemptSnapshot())).resolves.toMatchObject({ state: "failed" });
  });

  it("asks for a retry when the attempt has no verifiable transaction yet", async () => {
    const verifier = new TempoDestinationSettlementVerifier(successGateway());
    await expect(verifier.verifyDestination(expectation(), attemptSnapshot({ sourceTransactionHash: null }))).resolves.toMatchObject({
      state: "failed",
      retryable: true,
    });
    await expect(verifier.verifyDestination(null, attemptSnapshot())).resolves.toMatchObject({ state: "failed", retryable: true });
  });

  it("propagates RPC failures so the service keeps the attempt pending", async () => {
    const verifier = new TempoDestinationSettlementVerifier(verifyGateway({
      getReceipt: async () => { throw new Error("RPC timeout"); },
    }));
    await expect(verifier.verifyDestination(expectation(), attemptSnapshot())).rejects.toThrow("RPC timeout");
  });

  it("throws when the RPC serves the wrong chain", async () => {
    const verifier = new TempoDestinationSettlementVerifier(verifyGateway({ getRpcChainId: async () => 4217 }));
    await expect(verifier.verifyDestination(expectation(), attemptSnapshot())).rejects.toThrow(/different chain ID/);
  });
});

describe("recipient tempo address validation", () => {
  const base = {
    recipientName: "Ada Okafor",
    identifier: "ada@example.com",
    country: "NG",
    payoutCurrency: "NGN",
    amount: 500,
    asset: "AlphaUSD",
    reference: "",
  };

  it("accepts a valid Tempo address and rejects a missing one", () => {
    expect(createPaymentSchema.safeParse({ ...base, tempoAddress: RECIPIENT }).success).toBe(true);
    expect(createPaymentSchema.safeParse({ ...base, tempoAddress: "" }).success).toBe(false);
    expect(createPaymentSchema.safeParse({ ...base }).success).toBe(false);
  });

  it("rejects a malformed Tempo address", () => {
    expect(createPaymentSchema.safeParse({ ...base, tempoAddress: "0x123" }).success).toBe(false);
    expect(createPaymentSchema.safeParse({ ...base, tempoAddress: "not-an-address" }).success).toBe(false);
  });
});
