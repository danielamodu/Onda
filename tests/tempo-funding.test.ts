import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import {
  encodeAbiParameters,
  keccak256,
  encodeFunctionData,
  pad,
  parseUnits,
  stringToBytes,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  TEMPO_CANONICAL_ASSET,
  TEMPO_MODERATO_CHAIN_ID,
  getTempoFundingConfig,
  getTempoPublicConfig,
  type TempoFundingConfig,
} from "@/lib/payments/tempo/config";
import {
  TempoFundingVerificationError,
  fundingAuthorizationMessage,
  verifyTempoFundingTransfer,
} from "@/lib/payments/tempo/funding";
import { tip20Abi } from "@/lib/payments/tempo/abi";
import { createPaymentSchema } from "@/lib/payments/domain";

const mockedDb = vi.hoisted(() => {
  const treasury = {
    account: null as null | { id: string; version: number; tokenDecimals: number; chainId: number; tokenAddress: string },
    entries: [] as Array<Record<string, unknown>>,
  };
  const tx = {
    payment: null as unknown,
    treasuryAccount: null as unknown,
    treasuryLedgerEntry: null as unknown,
  };
  const treasuryAccount = {
    findUnique: vi.fn(async () => (treasury.account ? { ...treasury.account } : null)),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (treasury.account) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint", { code: "P2002", clientVersion: "6.19.3" });
      }
      treasury.account = { id: "treasury-1", version: 0, tokenDecimals: 6, chainId: 42431, tokenAddress: data.tokenAddress as string };
      return { ...treasury.account };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (!treasury.account) return { count: 0 };
      if ((where as { version?: number }).version !== undefined && (where as { version?: number }).version !== treasury.account.version) {
        return { count: 0 };
      }
      Object.assign(treasury.account, data);
      return { count: 1 };
    }),
  };
  const treasuryLedgerEntry = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const input = data as Record<string, unknown>;
      if (treasury.entries.some((entry) => entry.idempotencyKey === input.idempotencyKey)) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint", { code: "P2002", clientVersion: "6.19.3" });
      }
      const entry = { ...input, id: `entry-${treasury.entries.length + 1}` };
      treasury.entries.push(entry);
      return { id: entry.id };
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return treasury.entries.find((entry) => Object.entries(where ?? {}).every(([key, value]) => entry[key] === value)) ?? null;
    }),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return treasury.entries.filter((entry) => Object.entries(where ?? {}).every(([key, value]) => entry[key] === value));
    }),
  };
  const paymentMocks = { findFirst: vi.fn(), updateMany: vi.fn() };
  tx.payment = paymentMocks;
  tx.treasuryAccount = treasuryAccount;
  tx.treasuryLedgerEntry = treasuryLedgerEntry;
  return {
    treasury,
    payment: paymentMocks as { findFirst: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> },
    treasuryAccount,
    treasuryLedgerEntry,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  };
});
vi.mock("@/lib/db", () => ({ db: mockedDb }));

import { fundPayment, FundingConflictError } from "@/lib/payments/funding";

const TOKEN = "0x20c0000000000000000000000000000000000001" as Address;
const TREASURY = "0x1111111111111111111111111111111111111111" as Address;
const TRANSFER_SIG = keccak256(stringToBytes("Transfer(address,address,uint256)"));
const FUNDING_HASH = `0x${"ab".repeat(32)}` as Hash;

const businessKey = generatePrivateKey();
const businessAccount = privateKeyToAccount(businessKey);
const attackerAccount = privateKeyToAccount(generatePrivateKey());

const fundingConfig: TempoFundingConfig = {
  chainId: TEMPO_MODERATO_CHAIN_ID,
  chainName: "Tempo Moderato",
  rpcUrl: "https://example.invalid",
  tokenAddress: TOKEN,
  tokenSymbol: TEMPO_CANONICAL_ASSET,
  treasuryAddress: TREASURY,
  explorerUrl: "https://explore.testnet.tempo.xyz",
};

function transferInput(to: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: tip20Abi, functionName: "transfer", args: [to, amount] });
}

function transferLog(from: Address, to: Address, value: bigint) {
  return {
    address: TOKEN,
    blockHash: null,
    blockNumber: null,
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false,
    topics: [TRANSFER_SIG, pad(from), pad(to)] as [Hex, Hex, Hex],
  };
}

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    chainId: TEMPO_MODERATO_CHAIN_ID,
    to: TOKEN,
    from: businessAccount.address,
    input: transferInput(TREASURY, parseUnits("500.00", 6)),
    hash: FUNDING_HASH,
    ...overrides,
  };
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    transactionHash: FUNDING_HASH,
    status: "success" as const,
    blockNumber: BigInt(99),
    blockHash: `0x${"cd".repeat(32)}` as Hash,
    logs: [transferLog(businessAccount.address, TREASURY, parseUnits("500.00", 6))],
    ...overrides,
  };
}

async function signatureFor(paymentId: string, from = businessAccount) {
  return from.signMessage({
    message: fundingAuthorizationMessage({
      paymentId,
      amount: "500.00",
      chainId: TEMPO_MODERATO_CHAIN_ID,
      tokenAddress: TOKEN,
      treasuryAddress: TREASURY,
      senderAddress: from.address,
    }),
  });
}

function fundingInput(overrides: Record<string, unknown> = {}) {
  return {
    transaction: transaction(),
    receipt: receipt(),
    paymentId: "payment-1",
    authorizationSignature: `0x${"ef".repeat(65)}` as Hex,
    chainId: TEMPO_MODERATO_CHAIN_ID,
    tokenAddress: TOKEN,
    tokenSymbol: TEMPO_CANONICAL_ASSET,
    treasuryAddress: TREASURY,
    expectedAmount: "500.00",
    tokenDecimals: 6,
    ...overrides,
  };
}

describe("tempo funding configuration", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.TEMPO_CHAIN_ID = "42431";
    process.env.TEMPO_RPC_URL = "https://rpc.moderato.tempo.xyz";
    process.env.TEMPO_SETTLEMENT_TOKEN_ADDRESS = TOKEN;
    process.env.TEMPO_SETTLEMENT_PRIVATE_KEY = `0x${"55".repeat(32)}`;
    process.env.TEMPO_TREASURY_ADDRESS = TREASURY;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("exposes the treasury address to funding and the UI", () => {
    expect(getTempoFundingConfig()).toMatchObject({ treasuryAddress: TREASURY, tokenSymbol: "AlphaUSD" });
    expect(getTempoPublicConfig()).toMatchObject({ treasuryAddress: TREASURY });
  });

  it("reports no treasury when unconfigured", () => {
    delete process.env.TEMPO_TREASURY_ADDRESS;
    expect(getTempoPublicConfig().treasuryAddress).toBeNull();
    expect(() => getTempoFundingConfig()).toThrow(/TEMPO_TREASURY_ADDRESS/);
  });

  it("rejects a malformed treasury address", () => {
    process.env.TEMPO_TREASURY_ADDRESS = "not-an-address";
    expect(() => getTempoFundingConfig()).toThrow(/TEMPO_TREASURY_ADDRESS/);
  });

  it("keeps the canonical asset identical to the payment schema asset", () => {
    expect(TEMPO_CANONICAL_ASSET).toBe("AlphaUSD");
    expect(createPaymentSchema.parse({
      recipientName: "Ada Okafor",
      identifier: "ada@example.com",
      tempoAddress: TREASURY,
      country: "NG",
      payoutCurrency: "NGN",
      amount: 500,
      asset: TEMPO_CANONICAL_ASSET,
      reference: "",
    })).toMatchObject({ asset: "AlphaUSD" });
  });
});

describe("tempo funding authorization", () => {
  it("binds the payment, amount, network, token, treasury, and sender", async () => {
    const signature = await signatureFor("payment-1");
    const message = fundingAuthorizationMessage({
      paymentId: "payment-1",
      amount: "500.00",
      chainId: TEMPO_MODERATO_CHAIN_ID,
      tokenAddress: TOKEN,
      treasuryAddress: TREASURY,
      senderAddress: businessAccount.address,
    });
    expect(message).toContain("Payment: payment-1");
    expect(message).toContain("500.00 AlphaUSD");
    expect(message).toContain("Tempo (42431)");
    expect(message).toContain(TREASURY.toLowerCase());
    expect(signature).toMatch(/^0x[a-f0-9]{130}$/);
  });

  it("rejects a signature from an unauthorized wallet", async () => {
    const attackerSignature = await signatureFor("payment-1", attackerAccount);
    await expect(verifyTempoFundingTransfer({
      ...fundingInput(),
      transaction: transaction({ from: businessAccount.address }),
      authorizationSignature: attackerSignature,
    })).rejects.toThrow(/did not authorize/);
  });

  it("rejects a signature bound to a different payment", async () => {
    const otherSignature = await signatureFor("payment-2");
    await expect(verifyTempoFundingTransfer({ ...fundingInput(), authorizationSignature: otherSignature }))
      .rejects.toThrow(/did not authorize/);
  });
});

describe("tempo funding transfer verification", () => {
  it("accepts a valid treasury funding transfer", async () => {
    const authorizationSignature = await signatureFor("payment-1");
    await expect(verifyTempoFundingTransfer({ ...fundingInput(), authorizationSignature })).resolves.toMatchObject({
      chainId: 42431,
      transactionHash: FUNDING_HASH,
      tokenAddress: TOKEN,
      tokenSymbol: "AlphaUSD",
      senderAddress: businessAccount.address,
      treasuryAddress: TREASURY,
      blockNumber: BigInt(99),
    });
  });

  it.each([
    ["wrong network", { transaction: transaction({ chainId: 84532 }) }, /wrong network/],
    ["failed transaction", { receipt: receipt({ status: "reverted" }) }, /did not succeed/],
    ["wrong token contract", { transaction: transaction({ to: "0x9999999999999999999999999999999999999999" }) }, /did not call/],
    ["wrong treasury", { transaction: transaction({ input: transferInput("0x3333333333333333333333333333333333333333", parseUnits("500.00", 6)) }) }, /wrong destination/],
    ["wrong amount", { transaction: transaction({ input: transferInput(TREASURY, parseUnits("499.99", 6)) }) }, /amount does not match/],
    ["invalid calldata", { transaction: transaction({ input: "0xdeadbeef" }) }, /not a valid/],
    ["receipt mismatch", { receipt: receipt({ transactionHash: `0x${"99".repeat(32)}` }) }, /does not belong/],
    ["missing event", { receipt: receipt({ logs: [] }) }, /funding event does not match/],
    ["duplicate events", {
      receipt: receipt({ logs: [
        transferLog(businessAccount.address, TREASURY, parseUnits("500.00", 6)),
        transferLog(businessAccount.address, TREASURY, parseUnits("500.00", 6)),
      ] }),
    }, /funding event does not match/],
  ])("rejects funding with %s", async (_label, overrides: Record<string, unknown>, reason: RegExp) => {
    const authorizationSignature = await signatureFor("payment-1");
    await expect(verifyTempoFundingTransfer({ ...fundingInput(), ...overrides, authorizationSignature }))
      .rejects.toThrow(reason);
  });
});

describe("tempo funding persistence", () => {
  const signature = `0x${"ef".repeat(65)}` as Hex;
  function payment(overrides: Record<string, unknown> = {}) {
    return { id: "payment-1", businessId: "business-1", amount: { toFixed: () => "500.00" }, status: "created", transactionHash: null, fundingAuthorizationSignature: null, fundingError: null, ...overrides };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockedDb.treasury.account = null;
    mockedDb.treasury.entries = [];
  });

  it("does not fund an already-funded payment again", async () => {
    mockedDb.payment.findFirst.mockResolvedValue(payment({ status: "funded", transactionHash: FUNDING_HASH.toLowerCase() }));
    const verify = vi.fn();
    await expect(fundPayment("business-1", "payment-1", FUNDING_HASH, signature, { config: fundingConfig, verify })).resolves.toEqual({ state: "funded", transactionHash: FUNDING_HASH.toLowerCase() });
    expect(verify).not.toHaveBeenCalled();
    expect(mockedDb.payment.updateMany).not.toHaveBeenCalled();
  });

  it("rejects reuse of the hash unique to another payment", async () => {
    mockedDb.payment.findFirst.mockResolvedValue(payment());
    mockedDb.payment.updateMany.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("Unique constraint", { code: "P2002", clientVersion: "6.19.3" }));
    await expect(fundPayment("business-1", "payment-1", FUNDING_HASH, signature, { config: fundingConfig, verify: vi.fn() })).rejects.toBeInstanceOf(FundingConflictError);
  });

  it("persists the hash before verification and stores verified Tempo funding data", async () => {
    mockedDb.payment.findFirst.mockResolvedValue(payment());
    mockedDb.payment.updateMany.mockResolvedValue({ count: 1 });
    const verifiedFunding = {
      chainId: 42431,
      transactionHash: FUNDING_HASH,
      tokenAddress: TOKEN,
      tokenSymbol: "AlphaUSD",
      tokenDecimals: 6,
      senderAddress: businessAccount.address,
      treasuryAddress: TREASURY,
      blockNumber: BigInt(99),
      blockHash: `0x${"cd".repeat(32)}` as Hash,
    };
    const verify = vi.fn().mockResolvedValue({ state: "verified", funding: verifiedFunding });
    await expect(fundPayment("business-1", "payment-1", FUNDING_HASH, signature, { config: fundingConfig, verify })).resolves.toEqual({ state: "funded", transactionHash: FUNDING_HASH.toLowerCase() });
    expect(mockedDb.payment.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { id: "payment-1", businessId: "business-1", status: "created", transactionHash: null },
      data: expect.objectContaining({ status: "funding", transactionHash: FUNDING_HASH.toLowerCase(), fundingAuthorizationSignature: signature }),
    }));
    expect(mockedDb.payment.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { id: "payment-1", businessId: "business-1", status: "funding", transactionHash: FUNDING_HASH.toLowerCase() },
      data: expect.objectContaining({ status: "funded", chainId: 42431, tokenAddress: TOKEN, senderAddress: businessAccount.address, destinationAddress: TREASURY }),
    }));
    expect(mockedDb.treasuryLedgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        type: "CREDIT",
        paymentId: "payment-1",
        amountUnits: BigInt("500000000"),
        idempotencyKey: `funding:42431:${FUNDING_HASH.toLowerCase()}`,
      }),
    }));
  });

  it("credits a funding deposit exactly once across retries", async () => {
    mockedDb.payment.findFirst.mockResolvedValue(payment());
    mockedDb.payment.updateMany.mockResolvedValue({ count: 1 });
    mockedDb.payment.updateMany.mockResolvedValue({ count: 1 });
    const verifiedFunding = {
      chainId: 42431,
      transactionHash: FUNDING_HASH,
      tokenAddress: TOKEN,
      tokenSymbol: "AlphaUSD",
      tokenDecimals: 6,
      senderAddress: businessAccount.address,
      treasuryAddress: TREASURY,
      blockNumber: BigInt(99),
      blockHash: `0x${"cd".repeat(32)}` as Hash,
    };
    const verify = vi.fn().mockResolvedValue({ state: "verified", funding: verifiedFunding });
    await expect(fundPayment("business-1", "payment-1", FUNDING_HASH, signature, { config: fundingConfig, verify })).resolves.toMatchObject({ state: "funded" });
    mockedDb.payment.findFirst.mockResolvedValue(payment({ status: "funding", transactionHash: FUNDING_HASH.toLowerCase(), fundingAuthorizationSignature: signature }));
    await expect(fundPayment("business-1", "payment-1", FUNDING_HASH, signature, { config: fundingConfig, verify })).resolves.toMatchObject({ state: "funded" });
    const credits = mockedDb.treasury.entries.filter((entry) => entry.type === "CREDIT");
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({ amountUnits: BigInt("500000000") });
  });

  it("moves a pending attempt to failed when independent verification rejects it", async () => {
    mockedDb.payment.findFirst.mockResolvedValue(payment());
    mockedDb.payment.updateMany.mockResolvedValue({ count: 1 });
    const verify = vi.fn().mockRejectedValue(new TempoFundingVerificationError("The funding transfer amount does not match this payment."));
    await expect(fundPayment("business-1", "payment-1", FUNDING_HASH, signature, { config: fundingConfig, verify })).resolves.toMatchObject({ state: "failed", transactionHash: FUNDING_HASH.toLowerCase() });
    expect(mockedDb.payment.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ data: expect.objectContaining({ status: "failed", fundingError: expect.stringContaining("amount") }) }));
  });
});
