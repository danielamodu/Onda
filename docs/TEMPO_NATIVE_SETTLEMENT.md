# Tempo-native settlement (Moderato)

Verified 2026-10-09. Onda is a Tempo-only product: settlement is a native
TIP-20 transfer on Tempo Moderato submitted from Onda's server settlement
wallet. No CCIP, bridges, or additional chains are involved.

## Verified network facts

| Field | Value | Source |
| --- | --- | --- |
| Network | Tempo Testnet (Moderato) | Tempo connection-details doc |
| Chain ID | `42431` (`0xa5bf`, confirmed live via `eth_chainId`) | docs + live RPC |
| RPC | `https://rpc.moderato.tempo.xyz` | docs + live |
| WebSocket | `wss://rpc.moderato.tempo.xyz` | docs |
| Explorer | `https://explore.testnet.tempo.xyz` | docs + live (tx pages return 200) |
| Gas | No native gas token. Fees are paid in TIP-20 stablecoins and converted via the Fee AMM. `eth_getBalance` returns a placeholder constant. | EVM-differences + fee spec docs |
| Finality | Simplex BFT, deterministic, ~1s block time. A successful receipt is final; no confirmation counting is required. | consensus + blockspace docs |
| SDK | `viem` (`viem/tempo` extension, `tempoModerato` chain) — already Onda's dependency, no new package. Server path uses `client.token.transferSync`; verification uses a plain `viem` public client on the configured RPC. | TypeScript SDK + payments docs |

## Verified settlement asset

Faucet mints all five test stablecoins via `tempo_fundAddress` (also
`POST https://tempo.xyz/developers/api/faucet`). All five contracts were
read live (`symbol`/`decimals`/`totalSupply`) before use:

| Asset | Address | Decimals |
| --- | --- | --- |
| OUSD | `0x20c0000000000000000000006a37da5c996874be` | 6 |
| pathUSD | `0x20c0000000000000000000000000000000000000` | 6 |
| AlphaUSD | `0x20c0000000000000000000000000000000000001` | 6 |
| BetaUSD | `0x20c0000000000000000000000000000000000002` | 6 |
| ThetaUSD | `0x20c0000000000000000000000000000000000003` | 6 |

Onda settles with `transferWithMemo` on the configured token
(`TEMPO_SETTLEMENT_TOKEN_ADDRESS`). The live runs below used AlphaUSD.
`TEMPO_CHAIN_ID` must be `42431`; mainnet (`4217`) and any other chain are
rejected. A missing/invalid RPC, token, or server key fails closed.

## Payment reference (memo)

The on-chain memo is `keccak256("onda-settlement:<paymentId>")` (exact
32 bytes, deterministic per payment, stable across attempts). Verification
requires a `TransferWithMemo` event carrying that memo. Never put PII in the
memo — the payment ID is an opaque `cuid`, reconciled against Onda's database.

## Live smoke tests (real Moderato transactions)

1. Basic transfer, wallet A → wallet B, 1.00 AlphaUSD:
   `0x23aece2034c41fda4a53209858ac032a2ba162c705e26b8ac5000c96c574ff53`
   ([explorer](https://explore.testnet.tempo.xyz/tx/0x23aece2034c41fda4a53209858ac032a2ba162c705e26b8ac5000c96c574ff53)).
   Verified independently: chain 42431, receipt success, `Transfer` event
   sender → recipient for exactly 1,000,000 base units, recipient balance check.
2. Memo transfer, 0.50 AlphaUSD with reference `ONDA-TEST-001`:
   `0xa7e30b42b188e71829155b97e2cfde329950b1ebbd2e4192d8388025995a5031`
   ([explorer](https://explore.testnet.tempo.xyz/tx/0xa7e30b42b188e71829155b97e2cfde329950b1ebbd2e4192d8388025995a5031)).
   `TransferWithMemo` event verified via independent RPC with matching memo.
3. Full provider path (`TempoNativeSettlementProvider` + verifier, no mocks):
   payment `onda-live-*`, 0.25 AlphaUSD —
   `0x285463dfd644c8c2fa277cc4acc766878c098e4bc3dbacfc853864a07b40b8a0`
   and, after a decoder fix, again —
   `0x20628b8a9eacf6443589ae59c81da8fe4b4165d600537c26e85eec6c6652b472`
   ([explorer](https://explore.testnet.tempo.xyz/tx/0x20628b8a9eacf6443589ae59c81da8fe4b4165d600537c26e85eec6c6652b472)).
   Duplicate initiation returned the same hash without resubmitting;
   verification returned `verified`; a wrong-amount expectation returned `failed`.

## Provider design (`src/lib/payments/tempo/`)

- `config.ts` — env loading, fail-closed validation. The private key only
  exists server-side; the UI uses `getTempoPublicConfig` / `getSettlementUiMode`.
- `memo.ts` — deterministic per-payment memo + attempt idempotency keys.
- `abi.ts` — minimal TIP-20 ABI plus `decodeMemoTransferLog`, which strictly
  requires a bytes32 memo. (viem's `decodeEventLog` leniently decodes a plain
  `Transfer` as `TransferWithMemo` with `memo: undefined`; the helper rejects that.)
- `provider.ts` — `TempoNativeSettlementProvider` (`tempo-native`, real mode).
  Reconcile-first: scans `TransferWithMemo` logs for the payment memo before
  submitting, so retries and duplicate requests never double-pay. The public
  RPC caps `eth_getLogs` at 100k blocks, so the scan pages backwards from the
  head in parallel chunks (bound ~3M blocks ≈ 35 days). Transport failures are
  retryable; invalid recipient/amount fail terminally.
- `verifier.ts` — independent verification over plain RPC: receipt exists and
  succeeded, transaction chain is 42431, token matches the recorded token,
  a memo-bound log credits the exact recipient and amount from Onda's
  settlement wallet, and the recipient is not the `ReceivePolicyGuard`
  (`0xB10C…0000`). Missing receipts stay `pending`; mismatches fail closed.
  A payment is marked `settled` only after this passes.

State machine unchanged (`funded → settling → settled/failed`). One
field-semantics correction, documented here: `SettlementCommand`
`destinationAddress` is now the recipient's Tempo address
(`Recipient.tempoAddress`, new nullable column + migration
`20261009000000_recipient_tempo_address`), collected optionally at payment
creation. Previously the service fed Onda's own Base treasury address through
that field, which must never be a settlement destination. Settlement refuses
to start while the address is missing, leaving the payment `funded`.

`sourceTransactionHash` on the attempt holds the submitted Tempo transaction
hash at initiation; on verification it is copied to
`destinationTransactionHash`. `bridgeMessageId` stays null — there is no bridge.

## Tempo-native capabilities assessed

- **TIP-20 payments** — implemented (verified live).
- **Memos** — implemented as the payment reference (verified live).
- **Batch payments** — supported by Tempo Transactions (`calls` array,
  atomic). Not yet implemented in Onda; recommended next feature for payroll /
  multi-recipient payouts.
- **Scheduled payments** — supported via `validAfter`/`validBefore` windows
  (max ~5 min) plus expiring nonces. Useful for short execution windows, not
  for true recurring billing; needs an off-chain scheduler for that.
- **Fee sponsorship** — supported natively (`feePayer`, plus the public
  Moderato sponsor at `https://sponsor.moderato.tempo.xyz` for testnet).
  Recommended follow-up so recipients never need gas.

## Known limitations (not yet blockers for testnet)

- NGN conversion/bank payout has no provider yet; preferences stay
  preferences only.

## Phase 6 update (2026-10-10): Tempo-native funding, canonical asset, Base removal

Funding is now Tempo-native and settlement is gated on it:

- The business browser wallet (Tempo Moderato, chain 42431) signs a
  payment-bound authorization message and sends an AlphaUSD `transfer` to the
  controlled Onda treasury (`TEMPO_TREASURY_ADDRESS`). The server verifies the
  funding transaction independently against the configured Tempo RPC: chain,
  receipt success, token contract, calldata (`transfer`/`transferWithMemo`),
  exact amount in live token decimals, sender-signed authorization, and
  exactly one matching `Transfer` event. See `src/lib/payments/tempo/funding.ts`.
- Settlement refuses any payment not funded with the configured Tempo asset
  (`chainId == 42431` and recorded token address match); legacy Base-funded
  rows fail closed with a conflict error. The provider additionally checks
  the settlement wallet balance before submitting (retryable fail-fast).
- `Payment.asset` is now canonically `AlphaUSD` (creation literal, form, and
  all Tempo UI copy). `PayoutCurrency` enum values are retained for record
  compatibility; the NGN payout path remains unimplemented.
- Removed: `src/lib/payments/base/`, `BASE_*` env, Base funding tests. The
  funding orchestration (`fundPayment`) is unchanged in behavior and now
  Tempo-typed. Retained untouched: settlement orchestration, evidence checker,
  state machine, `SettlementProvider` interface, recipient portal, auth.
- No Prisma migration was required: funding reuses the existing funding
  columns and the rail is derived from the verified `chainId`/`tokenAddress`.
- Residual risks: omnibus treasury with no per-payment consumption ledger
  (documented; testnet single-wallet approved); faucet/test keys are test-only
  (config requires explicit treasury + key, no defaults); mainnet needs an
  asset registry beyond the Moderato-scoped literal.
