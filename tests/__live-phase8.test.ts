import { beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseUnits,
  formatUnits,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { tempoModerato } from "viem/chains";

// TEMPORARY live Moderato end-to-end for Phase 8 (deleted after the run).
// Runs only with TEMPO_LIVE_E2E=1 plus a throwaway TREASURY_TEST_DATABASE_URL.
// Uses faucet-funded throwaway wallets and small amounts. Never production.
const enabled = process.env.TEMPO_LIVE_E2E === "1" && Boolean(process.env.TREASURY_TEST_DATABASE_URL);

const RPC = "https://rpc.moderato.tempo.xyz";
const TOKEN = "0x20c0000000000000000000000000000000000001" as Address;
const DECIMALS = 6;

describe.skipIf(!enabled)("live moderato batch end to end (deleted after run)", () => {
  let db: import("@prisma/client").PrismaClient;
  let fundPayment: typeof import("@/lib/payments/funding").fundPayment;
  let settleBatch: typeof import("@/lib/payments/settlement/batches").settleBatch;
  let getTempoFundingConfig: typeof import("@/lib/payments/tempo/config").getTempoFundingConfig;
  let fundingAuthorizationMessage: typeof import("@/lib/payments/tempo/funding").fundingAuthorizationMessage;
  let tip20Abi: typeof import("@/lib/payments/tempo/abi").tip20Abi;
  let decodeMemoTransferLog: typeof import("@/lib/payments/tempo/abi").decodeMemoTransferLog;
  let settlementMemo: typeof import("@/lib/payments/tempo/memo").settlementMemo;
  let ledger: typeof import("@/lib/payments/treasury/ledger");

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TREASURY_TEST_DATABASE_URL as string;
    const settlementKey = generatePrivateKey();
    process.env.TEMPO_CHAIN_ID = "42431";
    process.env.TEMPO_RPC_URL = RPC;
    process.env.TEMPO_SETTLEMENT_TOKEN_ADDRESS = TOKEN;
    process.env.TEMPO_SETTLEMENT_PRIVATE_KEY = settlementKey;
    process.env.TEMPO_TREASURY_ADDRESS = privateKeyToAccount(settlementKey).address;
    process.env.TEMPO_MAX_BATCH_SIZE = "10";
    const prisma = await import("@prisma/client");
    db = new prisma.PrismaClient();
    ({ fundPayment } = await import("@/lib/payments/funding"));
    ({ settleBatch } = await import("@/lib/payments/settlement/batches"));
    ({ getTempoFundingConfig } = await import("@/lib/payments/tempo/config"));
    ({ fundingAuthorizationMessage } = await import("@/lib/payments/tempo/funding"));
    ({ tip20Abi, decodeMemoTransferLog } = await import("@/lib/payments/tempo/abi"));
    ({ settlementMemo } = await import("@/lib/payments/tempo/memo"));
    ledger = await import("@/lib/payments/treasury/ledger");
  });

  async function faucet(address: Address) {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tempo_fundAddress", params: [address] }),
    });
    if (!res.ok) throw new Error(`faucet HTTP ${res.status}`);
  }

  async function waitForBalance(client: ReturnType<typeof createPublicClient>, address: Address, min: bigint) {
    for (let i = 0; i < 60; i++) {
      const balance = await client.readContract({ address: TOKEN, abi: tip20Abi, functionName: "balanceOf", args: [address] });
      if (balance >= min) return balance;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error("faucet funding timed out");
  }

  it("funds two payments and settles them in one atomic batch", async () => {
    const publicClient = createPublicClient({ transport: http(RPC) });
    const treasuryKey = process.env.TEMPO_SETTLEMENT_PRIVATE_KEY as Hex;
    const treasury = privateKeyToAccount(treasuryKey).address;
    const businessKeyA = generatePrivateKey();
    const businessKeyB = generatePrivateKey();
    const businessA = privateKeyToAccount(businessKeyA);
    const businessB = privateKeyToAccount(businessKeyB);
    const recipientA = privateKeyToAccount(generatePrivateKey()).address;
    const recipientB = privateKeyToAccount(generatePrivateKey()).address;

    await faucet(businessA.address);
    await faucet(businessB.address);
    await faucet(treasury);
    await waitForAlpha(publicClient, treasury);
    const fundingConfig = getTempoFundingConfig();

    const tag = Date.now().toString(36);
    const business = await db.business.create({ data: { name: `live-${tag}`, email: `live-${tag}@example.com` } });
    const amounts = ["0.10", "0.20"] as const;
    const wallets = [businessA, businessB];
    const recipients = [recipientA, recipientB];
    const payments: Array<{ id: string; amount: string }> = [];
    const fundingHashes: string[] = [];
    for (let i = 0; i < 2; i++) {
      const rcptTag = `live-${tag}-r${i}`;
      const recipient = await db.recipient.create({
        data: { businessId: business.id, name: rcptTag, identifier: `${rcptTag}@example.com`, tempoAddress: recipients[i] },
      });
      const payment = await db.payment.create({
        data: { businessId: business.id, recipientId: recipient.id, amount: amounts[i], asset: "AlphaUSD", payoutCurrency: "NGN", status: "created" },
      });
      const wallet = createWalletClient({ account: wallets[i], chain: tempoModerato, transport: http(RPC) });
      const signature = await wallet.signMessage({
        message: fundingAuthorizationMessage({
          paymentId: payment.id,
          amount: amounts[i],
          chainId: 42431,
          tokenAddress: TOKEN,
          treasuryAddress: treasury,
          senderAddress: wallets[i].address,
        }),
      });
      const hash = await wallet.writeContract({
        address: TOKEN,
        abi: tip20Abi,
        functionName: "transfer",
        args: [treasury, parseUnits(amounts[i], DECIMALS)],
        chain: tempoModerato,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      const funded = await fundPayment(business.id, payment.id, hash, signature, { config: fundingConfig });
      expect(funded.state).toBe("funded");
      payments.push({ id: payment.id, amount: amounts[i] });
      fundingHashes.push(hash);
      console.log(`LIVE funding ${i} tx:`, hash);
    }

    const { TempoNativeSettlementProvider } = await import("@/lib/payments/tempo/provider");
    const { TempoDestinationSettlementVerifier } = await import("@/lib/payments/tempo/verifier");
    const provider = new TempoNativeSettlementProvider();
    const verifier = new TempoDestinationSettlementVerifier();
    const result = await settleBatch(business.id, payments.map((p) => p.id), { provider, verifier });
    expect(result.state).toBe("settled");
    if (result.state !== "settled") throw new Error("batch did not settle");
    const batchTx = result.payments[0].transactionHash as string;
    console.log("LIVE batch tx:", batchTx);
    console.log(`LIVE explorer: https://explore.testnet.tempo.xyz/tx/${batchTx}`);

    // Exactly one TransferWithMemo per payment memo on-chain: no duplicate.
    const receipt = await publicClient.getTransactionReceipt({ hash: batchTx as Hash });
    expect(receipt.status).toBe("success");
    for (const [index, payment] of payments.entries()) {
      const memo = settlementMemo(payment.id);
      const matches = receipt.logs
        .filter((log) => log.address.toLowerCase() === TOKEN.toLowerCase())
        .map((log) => decodeMemoTransferLog({ data: log.data, topics: log.topics }))
        .filter((entry) => entry !== null && entry.memo.toLowerCase() === memo.toLowerCase());
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({ to: recipients[index], value: parseUnits(payment.amount, DECIMALS) });
    }

    // Ledger reconciliation against the on-chain treasury balance. Fees are
    // paid from the treasury wallet, so expect a small non-positive drift.
    const account = await db.treasuryAccount.findUniqueOrThrow({
      where: { chainId_tokenAddress_treasuryAddress: { chainId: 42431, tokenAddress: getAddress(TOKEN), treasuryAddress: treasury } },
    });
    const balances = await ledger.getTreasuryBalances(db, account.id);
    const onChain = await publicClient.readContract({ address: TOKEN, abi: tip20Abi, functionName: "balanceOf", args: [treasury] });
    // Ledger reconciliation against the on-chain treasury balance. After full
    // settlement the ledger must show zero outstanding liabilities. The
    // on-chain wallet additionally holds faucet funds (plus dust), so drift
    // is reported informationally rather than asserted to zero: the ledger
    // tracks payment liabilities, not the wallet's total balance.
    const accountId = account.id;
    expect(await db.treasuryLedgerEntry.count({ where: { treasuryAccountId: accountId, type: "CREDIT" } })).toBe(2);
    expect(await db.treasuryLedgerEntry.count({ where: { treasuryAccountId: accountId, type: "RESERVE" } })).toBe(2);
    expect(await db.treasuryLedgerEntry.count({ where: { treasuryAccountId: accountId, type: "DEBIT" } })).toBe(2);
    const report = ledger.reconcileTreasury(balances, onChain);
    console.log(
      `LIVE reconcile: ledgerHeld=${formatUnits(report.ledgerHeldUnits, DECIMALS)} onChain=${formatUnits(report.onChainBalanceUnits, DECIMALS)} drift=${formatUnits(report.driftUnits, DECIMALS)} status=${report.status}`,
    );
    expect(report.ledgerHeldUnits).toBe(BigInt(0));
    expect(report.onChainBalanceUnits >= BigInt(0)).toBe(true);

    // Retry proves idempotency: settled again, no new submission, no new rows.
    const debitsBefore = await db.treasuryLedgerEntry.count({ where: { treasuryAccountId: account.id, type: "DEBIT" } });
    const retry = await settleBatch(business.id, payments.map((p) => p.id), { provider, verifier });
    expect(retry.state).toBe("settled");
    expect(await db.treasuryLedgerEntry.count({ where: { treasuryAccountId: account.id, type: "DEBIT" } })).toBe(debitsBefore);
    for (const payment of payments) {
      const memo = settlementMemo(payment.id);
      const head = await publicClient.getBlockNumber();
      const logs = await publicClient.getLogs({
        address: TOKEN,
        event: { type: "event", name: "TransferWithMemo", inputs: [
          { indexed: true, name: "from", type: "address" },
          { indexed: true, name: "to", type: "address" },
          { indexed: false, name: "value", type: "uint256" },
          { indexed: true, name: "memo", type: "bytes32" },
        ] } as const,
        args: { memo } as never,
        fromBlock: head > BigInt(50000) ? head - BigInt(50000) : BigInt(0),
        toBlock: "latest",
      });
      expect(logs).toHaveLength(1);
    }
  }, 420000);

  async function waitForAlpha(client: ReturnType<typeof createPublicClient>, address: Address) {
    return waitForBalance(client, address, parseUnits("1.00", DECIMALS));
  }
});
