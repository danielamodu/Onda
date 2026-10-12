import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Postgres-gated suites (`*.pg.test.ts`) run against a real database — a
// throwaway Neon branch or local Postgres — via `npm run test:pg`. They need
// network-tolerant timeouts (remote round-trips plus Neon compute cold start)
// and a .env loader; the default `npm test` leaves them skipped unless
// TREASURY_TEST_DATABASE_URL is set in the environment.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/**/*.pg.test.ts"],
    setupFiles: ["tests/pg-setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Shared throwaway database: the suites use globally unique ids and derive
    // amounts from the live balance, so they are safe interleaved, but keeping
    // a single worker makes the concurrency assertions deterministic.
    fileParallelism: false,
  },
});
