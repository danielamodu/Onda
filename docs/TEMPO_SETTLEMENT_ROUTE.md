# Tempo settlement route: CCIP setup required

> Note (2026-10-09): Onda is now a Tempo-only product. The CCIP/Base-Sepolia
> route described below was abandoned — see
> [Tempo-native settlement](TEMPO_NATIVE_SETTLEMENT.md) for the implemented
> Tempo Moderato flow. This file is kept for audit history; its "next steps"
> must not be implemented.

Checked on 2026-10-08. Chainlink documents CCIP support for Tempo Moderato testnet, and its public testnet directory separately lists Base Sepolia USDC. However, the directory does not list a Tempo USDC token/pool or an already-wired Base Sepolia ↔ Tempo Moderato USDC route. The Tempo guide describes a custom token integration that must be provisioned before transfers can be sent. Onda's `TempoSettlementProvider` therefore remains fail-closed.

## Verified facts

- Source network: Base Sepolia, EVM chain ID `84532`.
- Destination network: Tempo Moderato testnet, EVM chain ID `42431`.
- CCIP's Tempo integration guide describes transfers to/from Tempo using BurnMint pools and CCIP v1.6.0. It requires Token Manager Expert Mode access from Chainlink support.
- The Tempo guide requires a Tempo token to be deployed and registered, a BurnMint pool to be activated, and the Tempo and remote-chain pools to be wired in both directions. It recommends testing through Transporter testnet.
- The CCIP directory lists a Base Sepolia USDC token and pool. Its current USDC testnet listing does not include Tempo Moderato.
- Onda's existing Base Sepolia funding asset is independently configured in `src/lib/payments/base/config.ts`. Do not treat the receiving Tempo TIP-20 as Circle-issued Base USDC; it would be a separately provisioned destination representation unless its issuer and redemption terms are verified.

## Why Onda has not implemented the adapter

There is no provisioned and auditable token-pool pair for this product, nor confirmed approval to wire the existing Base Sepolia USDC pool to a Tempo representation. The public guide establishes that custom setup is possible; it does not establish the contract addresses, exact asset mapping, liquidity/redemption guarantee, route limits, finality policy, or production support that Onda needs. A custom route is not interchangeable with a pre-existing, issuer-backed USDC route.

No contract addresses, route IDs, quotes, messages, or transfer hashes are fabricated here. `TempoSettlementProvider` and destination verification continue to reject real settlement while route configuration is absent. The explicit test provider remains simulation-only.

## Exact next steps to make a route implementable

1. Request Chainlink CCIP Token Manager Expert Mode access and confirm that Base Sepolia USDC may be connected to the selected Tempo token.
2. Decide whether Onda accepts a newly issued TIP-20 representation, including who issues, redeems, and backs it. Confirm asset naming and redemption terms with Tempo/Chainlink and relevant issuers.
3. Provision the Tempo token/pool and wire both token pools. Record the exact token and pool addresses on both chains, CCIP version, chain selectors, fee token, rate limits, and explorer verification links.
4. Complete a real testnet round trip in Transporter using the exact source asset and destination representation. Record source/destination transaction hashes and the message ID.
5. Confirm route-specific quote/status APIs (if used), source/destination confirmations, failure/refund handling, limits, and any credentials with Chainlink.
6. Only then implement `RealTempoProvider` behind `SettlementProvider`, with server-side source transaction submission, independent destination verification, idempotency, and failure tests.

Required testnet setup includes Base Sepolia ETH and the exact supported source token, Tempo Moderato alphaUSD for gas, a Tempo admin wallet, Token Manager Expert Mode access, and the provisioned/wired pools. No private key or API credential is currently added to the application.

## References

- [Chainlink CCIP Tempo integration guide](https://docs.chain.link/ccip/v1/evm/tools-resources/network-specific/tempo-integration-guide)
- [Chainlink CCIP testnet directory](https://docs.chain.link/ccip/directory/testnet)
- [Chainlink CCIP testnet USDC listing](https://docs.chain.link/ccip/directory/testnet/token/USDC)
- [Chainlink CCIP changelog: Tempo Moderato support](https://docs.chain.link/changelog?product=Nodes)

## Safe local testing

Set `SETTLEMENT_PROVIDER=test` only in a non-production environment. The test provider records `verificationStatus=simulated`, leaves bridge/destination fields null, and displays that no funds moved. Production rejects this provider selection. It is not a bridge test or evidence of Tempo settlement.
