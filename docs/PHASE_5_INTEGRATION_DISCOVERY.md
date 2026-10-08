# Phase 5 integration discovery

Research date: 2026-10-08. This records what is currently supported by provider documentation and what is missing from Onda's actual payment path. No provider API was called and no funds were moved.

## Track A — Base Sepolia to Tempo Moderato

**Finding:** Chainlink CCIP supports Tempo Moderato testnet, but Onda has no provisioned Base Sepolia USDC-to-Tempo asset route. Do not enable a real adapter yet.

| Field | Verified result |
| --- | --- |
| Source chain | Base Sepolia, chain ID `84532` |
| Destination chain | Tempo Moderato, chain ID `42431` |
| Provider | Chainlink CCIP, standard BurnMint mechanism; Tempo guide uses CCIP v1.6.0 |
| Source asset | Base Sepolia USDC is listed in the CCIP testnet directory |
| Destination asset | None provisioned for Onda. CCIP's Tempo guide describes deploying/registering a Tempo TIP-20 representation and its BurnMint pool. |
| Route / lane | No Onda-specific, ready-wired Base Sepolia ↔ Tempo USDC token route found in the public directory |
| Addresses / selectors / quote or status API | Must be read from the provisioned CCIP directory/configuration and actual pools. No route-specific values are configured in Onda. |
| Confirmation/finality | Must use CCIP lane and route configuration after the token pools exist; this research did not establish Onda-specific confirmation requirements. |
| Access / credentials | Token Manager Expert Mode access is required from Chainlink support. Setup also requires a Tempo admin wallet and native-fee token (`alphaUSD`) on Moderato. |
| Test method | Chainlink documents Transporter testnet for transfers after the pools are activated and wired. No transfer was sent. |

The distinction matters: Chainlink's guide shows how to set up a CCIP token on Tempo; it does not show that a Tempo representation is Circle-issued USDC or automatically redeemable for Base USDC. Before wiring pools, Onda must select the destination asset, issuer/admin, redemption/backing model, and transfer limits. The adapter needs the deployed route details and an end-to-end test transfer. Until then, `TempoSettlementProvider` and destination verification remain fail-closed. See [the route setup note](TEMPO_SETTLEMENT_ROUTE.md).

## Track B — NGN payout providers

### Best sandbox candidate: Yellow Card

Yellow Card's partner API documentation covers NGN bank sends and a real sandbox. It is the strongest candidate found for a controlled integration, but its documented stablecoin top-up/payout networks currently do not include Tempo. Onda has no settled funds on a Yellow Card balance or Yellow Card vault, so wiring a send call now would not complete Onda's recipient payout path.

| Requirement | Verified capability |
| --- | --- |
| Provider | Yellow Card Partner API |
| Stablecoins / networks | USDC top-ups are documented on Ethereum, XLM, Solana, Base, and Celo. The documented balance payout table omits Tempo. |
| NGN | Nigeria bank transfer is listed for sends; current corridor page describes it as instant. Channel availability should be fetched per account at runtime. |
| Quote | Send quote flow provides USD/local amount and rate; a quote is created by `POST /business/send`, then accepted/denied. |
| Bank-account verification | `POST /business/details/bank` resolves account number and bank network to confirm the account holder name; docs say this endpoint is currently required for Nigeria. |
| Payout | `POST /business/send`, then accept the send request. The provider debits the partner's USD stablecoin balance. |
| Status / confirmation | Lookup and webhook events expose transaction state; sandbox docs describe signed webhook and status validation. This confirms Yellow Card's provider-side payout state, not a bank-issued independent receipt. |
| Sandbox | Yes: `https://sandbox.api.yellowcard.io/business`; test account values can simulate success/failure. |
| Authentication | API key + secret, per-request `YcHmacV1` HMAC with timestamp; production requires static IP allowlisting. |
| Onboarding / compliance | Intro call, business pre-integration form, KYB documents, AML process review, signed agreement; sandbox credentials follow approval. Production credentials follow sandbox review/signoff. |
| Hackathon fit | Good for mocked and approved sandbox testing; not immediately runnable without partner onboarding/credentials. It requires USDC funding into Yellow Card's partner balance, and Onda's current settled asset is on Tempo. |

### Secondary candidate: Paycrest

Paycrest Sender API v2 documents USDC on Base → NGN bank payout, quote/rates, optional bank account name verification, order polling, and HMAC-SHA256 webhook verification. A sender account must complete KYB to obtain an API key and API secret. Its docs explicitly state that Paycrest runs on mainnet only; testing is via minimum $0.50 real orders on supported chains. The API's `validated` state means the provider confirms fiat payout; `settled` is order completion. Onda cannot safely conduct that real-money smoke test in this phase, and Paycrest's documented source networks do not include Tempo.

### Integration decision

No provider has a documented end-to-end path that consumes Onda's future Tempo-settled asset and pays NGN to the recipient's bank. Yellow Card is sandbox-capable but supports stablecoin partner balances on Base and other documented networks, not Tempo. Paycrest supports USDC on Base and NGN payout but has no sandbox and no Tempo support. Therefore the existing `UnavailableRecipientPayoutProvider` remains in place and no payout records or schema changes are introduced. This avoids presenting a Base-funded side path as the promised Tempo → recipient → NGN path.

## Nigerian compliance items to resolve before live integration

This is a product integration checklist, not legal advice. Onda's business model, custody/fund-flow, counterparties, and whether it is acting as a VASP or another regulated intermediary need Nigerian counsel and regulator/provider confirmation before launch.

- Yellow Card requires KYB and an AML-process review before partner credentials, plus its legal agreement. Its travel-rule, recipient identity, transaction monitoring, and account ownership requirements must be mapped to Onda's data flow.
- Paycrest requires Sender KYB; its docs state sender and liquidity-provider verification applies. It handles local payout through its providers, but this does not determine Onda's own licensing obligations.
- SEC Nigeria's ARIP VASP checklist describes scope for VASPs/DISPs offering services in or to Nigeria and lists operational controls including AML/CFT/CPF (including travel-rule), NFIU registration, reporting, and other onboarding material. Whether Onda falls within scope is a legal classification question.
- CBN's 2023 VASP bank-account guidelines address bank-account operations for VASPs; their current effect and interaction with the SEC framework should be reviewed with counsel and the chosen banking/payout provider.

## Exact actions to unblock real end-to-end testing

1. Obtain Chainlink Token Manager Expert Mode approval and confirm/wire the exact source/destination token pools. Decide and document Tempo token issuer, backing/redemption, representation, and route limits. Perform a Transporter testnet transfer and share its transaction/message IDs.
2. Select Yellow Card or another provider with the recipient flow's actual source chain supported. If selecting Yellow Card, complete its KYB/AML onboarding, obtain sandbox keys, confirm account-specific NGN send and top-up rails, and run the documented sandbox transaction lifecycle. If selecting Paycrest, obtain KYB credentials and explicitly authorize a minimum real-money mainnet test (not performed here).
3. Confirm how funds move from the settled Tempo asset into the selected provider. If the provider only accepts Base, prove an authorized and independently verifiable route from Tempo to its Base funding address; do not infer that ticker equality provides this.
4. Have Nigerian counsel determine Onda's registration, bank, AML/CFT, Travel Rule, data-protection, record-retention, and consumer disclosures. Complete provider compliance acceptance.
5. Implement the chosen route and payout adapter only after the provider, token contracts, account model, credentials, webhook/status semantics, and sandbox lifecycle are confirmed. Keep recipient success dependent on authenticated provider status, and persist idempotency/audit details before enabling payout actions.

## References

- [Chainlink Tempo CCIP integration guide](https://docs.chain.link/ccip/v1/evm/tools-resources/network-specific/tempo-integration-guide)
- [CCIP testnet directory](https://docs.chain.link/ccip/directory/testnet)
- [CCIP testnet USDC listing](https://docs.chain.link/ccip/directory/testnet/token/USDC)
- [Yellow Card onboarding](https://docs.yellowcard.engineering/docs/getting-started-api)
- [Yellow Card authentication](https://docs.yellowcard.engineering/docs/authentication-api)
- [Yellow Card sandbox/production environments](https://docs.yellowcard.engineering/docs/environments-api)
- [Yellow Card Nigeria payout channels](https://docs.yellowcard.engineering/v1.0.36/docs/channels-api)
- [Yellow Card Nigeria account resolution](https://docs.yellowcard.engineering/reference/resolve-bank-account)
- [Yellow Card send API](https://docs.yellowcard.engineering/reference/submit-send)
- [Yellow Card send lifecycle](https://docs.yellowcard.engineering/docs/disbursement-user-journey)
- [Yellow Card stablecoin balance top-up and payout networks](https://docs.yellowcard.engineering/docs/settlement-api)
- [Paycrest Sender API integration guide](https://docs.paycrest.io/implementation-guides/sender-api-integration)
- [Paycrest supported stablecoins](https://docs.paycrest.io/resources/supported-stablecoins)
- [Paycrest NGN corridors](https://docs.paycrest.io/resources/supported-currencies)
- [SEC Nigeria ARIP checklist for VASPs](https://sec.gov.ng/about/resources/checklists/accelerated-regulatory-incubation-program-arip-checklist-for-vasp-onboarding/)
- [CBN VASP bank-account guidelines (2023)](https://www.cbn.gov.ng/out/2024/fprd/guidelines%20on%20operations%20of%20bank%20accounts%20for%20virtual%20asset%20providers.pdf)
