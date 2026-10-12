# Treasury Ledger & Native Batch Payments (Phase 7)

## Ledger schema

- `TreasuryAccount` — one row per `(chainId, tokenAddress, treasuryAddress)`,
  with `tokenSymbol`, `tokenDecimals`, and an optimistic-locking `version`.
  Moderato/AlphaUSD/treasury is a single row; new assets need no migration.
- `TreasuryLedgerEntry` — append-only. Fields: account, optional `paymentId`,
  `type` (`CREDIT` | `RESERVE` | `RELEASE` | `DEBIT` | `ADJUSTMENT`),
  `amountUnits` (integer base units, `BigInt`; positive except `ADJUSTMENT`),
  `balanceAfterUnits` (running available-balance snapshot), optional
  `reservationId` self-FK (a `RELEASE`/`DEBIT` consumes exactly one `RESERVE`),
  unique `idempotencyKey`, optional `reference` (tx hash / memo / note).
- `SettlementBatch` — `providerIdempotencyKey` unique (`batch:<sorted ids>`),
  `paymentIds` snapshot, `status`, optional `transactionHash` (unique).
- `PaymentSettlement.batchId` — nullable FK, `SET NULL` on batch delete.

Migration: `prisma/migrations/20261010000000_treasury_ledger/migration.sql`
(hand-written, `prisma validate` clean; not yet applied to any database —
no local or production DB is configured in this environment).

## Invariants and how they are enforced

| # | Property | Enforcement |
|---|----------|-------------|
| 1 | Funding tx credited once | `funding:<chainId>:<txhash>` unique key; replay returns `{duplicate:true}` |
| 2 | No over-allocation | `available = credits − debits − active reserves`, checked inside the guarded section before every reservation |
| 3 | One active reservation per payment | Application check inside the guarded section; reservation keys `reserve:<paymentId>:<attempt>` |
| 4 | No concurrent overspend | Optimistic version guard (`version` conditional bump + retry, max 5) serializes all guarded sections; claim+reserve share one atomic section |
| 5 | Retries reconcile | Memo-scan reconcile-first (single) / all-memos-in-one-tx (batch); debit replays return `{duplicate:true}` |
| 6 | Debit only after verification | `DEBIT` is written only on the verified-settled path, after the verifier + evidence check pass |
| 7 | Reverts are never debits | Reverted receipts fail verification; reservations are released, never consumed |
| 8 | Ambiguity stays explicit | Unknown outcomes keep attempts `pending` (single) or fail the batch terminally with reason (batch, where partial success is impossible by atomicity but stray txs would be ambiguous) |
| 9 | Base history excluded | `creditVerifiedTempoDeposit` rejects chain/token mismatch against the treasury account; settlement rail gate unchanged |
| 10 | On-chain balance is a signal | `reconcileTreasury` reports `balanced`/`shortfall`/`surplus` drift; never auto-adjusts |

## Concurrency strategy

All treasury mutations run inside `withGuardedTreasurySection`: read account
version → run work in one Prisma `$transaction` → conditional
`updateMany({where:{id,version}})` bump. A lost bump aborts the whole
transaction (Prisma rolls back) and retries with fresh state, up to 5 times,
then fails closed. Only `TreasuryContentionError` retries; `P2002` and domain
errors propagate. Payment claims ride in the same section as their
reservation, so claiming and reserving are atomic. Isolation assumption:
Postgres read-committed + optimistic serialization via the version column —
correct provided every ledger mutation goes through the guard (it does:
credit, reserve, release, debit).

## Lifecycle integration

- Funding: `persistFundingSuccess` provisions the account, then atomically
  flips the payment to `funded` and writes the `CREDIT` (replay-safe).
- Settlement claim: `funded→settling` flip + attempt row + `RESERVE` in one
  guarded section (validate-before-mutate, so failed checks leave no rows).
- Settlement success: verifier passes → guarded `DEBIT` (with repair path for
  crash replays: adopt existing debit, else repair-reserve with a unique key),
  then the existing settle transaction marks attempt/payment settled.
- Terminal failure: guarded `RELEASE`, then existing failure updates.
- Retryable failure: hold stays; the retry branch releases the superseded
  reservation and reserves anew in one section.
- Test (`test-simulation`) mode skips all ledger writes.

## Verified batch primitive and atomicity

Tempo `TransactionRequest.calls: Vec<Call>` executes **atomically** — all calls
succeed or all revert (protocol docs + spec). Installed `viem/tempo`
implements it: per-payment calldata is ABI-encoded `transferWithMemo`
(own `tip20Abi`, same encoding the verifier decodes), submitted as one
transaction via `client.sendTransactionSync({calls})`. One receipt carries
every `TransferWithMemo` log; per-payment memos (`keccak(onda-settlement:<id>)`,
unchanged) attribute each log. Reconciliation requires a single transaction
containing **every** memo — partial prior transfers fail the batch terminally
rather than settling partially. Batch-level atomicity is therefore the
protocol's guarantee, and Onda additionally refuses to record partial success.

## Testnet validation

Live Moderato demonstration (temporary test, removed afterwards):
fund N payments via faucet wallets, verify funding through the real
`verifyTempoFundingTransaction`, batch-settle through `settleBatch` with the
live gateway, verify per-payment outcomes and ledger entries. Hashes recorded
below on success. Faucet funds and test keys only; no production claims.

Live results (2026-10-10, Moderato, AlphaUSD `0x20c0…0001`):
- Batch success, one atomic transaction carrying two `transferWithMemo`
  calls (0.11 + 0.07 AlphaUSD), both memos independently decoded and matched:
  `0xe17cf7d625ab80891a97c4c5b0d80ff1064170ee7325e2c4a5d077290220ba5f`
  ([explorer](https://explore.testnet.tempo.xyz/tx/0xe17cf7d625ab80891a97c4c5b0d80ff1064170ee7325e2c4a5d077290220ba5f))
  and repeat run
  `0xeeb7562691671ebc4d8fa5da149d82de3fe8d0416c7e4047788a496a22c3121f`
  ([explorer](https://explore.testnet.tempo.xyz/tx/0xeeb7562691671ebc4d8fa5da149d82de3fe8d0416c7e4047788a496a22c3121f)).
- Atomicity: a batch of [0.01 valid, 1000x-balance oversized] reverted as a
  whole (`TIP20 InsufficientBalance`) during submission simulation — no
  transaction landed and the recipient balance stayed 0, proving the valid
  call did not execute alone.
- Note: the full DB-backed `settleBatch` orchestration was proven by mocked
  tests here; no database is configured in this environment, so the live run
  exercised the real chain-facing path (submit + receipt + per-memo
  verification) rather than the Prisma-backed flow.

## Remaining risks and blockers

- No database is configured in this environment, so the migration is
  authored but unapplied, and real-concurrency proof rests on
  `treasury-ledger.pg.test.ts` (skipped here; runs with
  `TREASURY_TEST_DATABASE_URL`).
- Fee drag: settlement fees leave on-chain balance slightly below ledger-held;
  reconciliation reports drift but never auto-corrects.
- `getLogs` memo scans remain RPC-bound (100k-block cap, chunked); batch
  reconcile performs one scan per payment.
- Max batch size default 10 (`TEMPO_MAX_BATCH_SIZE`, 2–25); large-batch gas
  behavior untested.
