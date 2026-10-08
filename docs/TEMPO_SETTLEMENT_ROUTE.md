# Tempo settlement route: verification required

The real Tempo adapter is intentionally not implemented. The project has no authoritative route configuration for Base Sepolia to Tempo Moderato, and unknown route or asset values are not filled in with guesses. `TempoSettlementProvider` fails closed before changing a payment state.

## Required before implementing the real adapter

- An authoritative confirmation that Base Sepolia can bridge to Tempo Moderato, including the exact supported route.
- Destination network name and chain ID for that route.
- The exact destination token representation and contract address. Do not assume Tempo USDC is the same token as Base USDC.
- The bridge/provider, route identifier, and route-specific configuration.
- Source and destination contract addresses and ABIs, verified against current provider documentation or deployment metadata.
- Required API credentials and the authenticated quote/status API requirements. LayerZero's Value Transfer API documents public chain/token discovery, but requires an API key for quotes and transfer status.
- The quote's source amount, minimum/actual destination amount, destination address, and fees, with an explicit policy for whether destination amount may differ from the funded amount.
- Required source and destination confirmations/finality rules.
- A Tempo settlement address and its authorization/signing design. Any signing secret must be supplied through a secrets manager or protected environment variable and must never be added to the frontend or repository.
- Test funds for the Base Sepolia source transfer and whatever destination-side fees the verified Tempo test environment requires.

## Current discovery result

As checked on 2026-10-08, the LayerZero deployment directory includes Tempo Mainnet and Base Sepolia among its listed chains, but does not list Tempo Moderato as a testnet deployment. This does not prove that no private or separately operated test route exists; it means Onda does not have authoritative public evidence to configure one. Stargate's legacy API documentation is deprecated in favor of LayerZero's Value Transfer API.

No Tempo token address, endpoint ID, pool, route ID, quote, API response, or transaction hash is configured here. Chain IDs and assets must come from the verified route's current metadata, not from assumptions.

## Safe local testing

Set `SETTLEMENT_PROVIDER=test` only in a non-production environment. The test provider records `verificationStatus=simulated`, leaves bridge/destination fields null, and displays that no funds moved. It does not generate synthetic transaction hashes or message identifiers. Production rejects this provider selection. It is not a bridge test or evidence of Tempo settlement.
