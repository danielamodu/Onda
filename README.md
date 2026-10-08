# Onda

Onda is a business payment MVP. It stores payment intents in PostgreSQL and supports direct USDC funding on Base. Settlement orchestration is present, but the real Base-to-Tempo bridge is not implemented until its route and destination asset are verified.

## Requirements

- Node.js 20.9 or newer
- PostgreSQL 14 or newer

## Run locally

1. Copy `.env.example` to `.env` and set `DATABASE_URL` and `BASE_FUNDING_ADDRESS` to a wallet address Onda controls.
2. Install dependencies with `npm install`.
3. Run `npm run db:deploy` to apply migrations, then `npm run dev`.
4. Open `http://localhost:3000` and create a business account.

Funding defaults to Base Sepolia (chain ID `84532`) and Circle test USDC. Testnet USDC has no financial value. Use an RPC endpoint in `BASE_RPC_URL`; the default public endpoint is suitable for development and may be rate-limited. Set `BASE_CONFIRMATIONS` to the number of blocks Onda should verify (default `2`).

Base mainnet is opt-in: set `BASE_CHAIN_ID=8453`, a Base mainnet `BASE_RPC_URL`, and the intended funding wallet address before use. The native Circle USDC contract is selected from the chain ID and cannot be overridden. Onda does not sign or custody wallet transactions; the connected browser wallet authorizes the payment details and submits transfers directly to `BASE_FUNDING_ADDRESS`. The authorization signature proves the transaction sender approved that specific payment and does not move funds.

Settlement defaults to the unavailable real Tempo adapter and fails closed. For local UI/service testing only, set `SETTLEMENT_PROVIDER=test` outside production. This provider performs a labeled simulation and sends no transaction or funds. The real route prerequisites are documented in [`docs/TEMPO_SETTLEMENT_ROUTE.md`](docs/TEMPO_SETTLEMENT_ROUTE.md).

During local development, `npm run db:migrate` applies pending migrations and can create new ones when the schema changes. For deployment, use `npm run db:deploy`.

## Checks

- `npm test`
- `npm run lint`
- `npm run typecheck`
- `npm run build`

Payment statuses progress from `created` to `funding` to `funded`. The server verifies the transaction on the configured Base RPC, including chain, native USDC contract, direct transfer calldata, destination, amount, successful receipt, transfer event, and confirmation count. Transaction hashes are unique across payment records.
