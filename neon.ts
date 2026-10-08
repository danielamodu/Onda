import { defineConfig } from "@neondatabase/config/v1";

export default defineConfig({
  // Prisma continues to use the standard DATABASE_URL for local or Neon Postgres.
  buckets: {
    uploads: { access: "private" },
  },
  functions: {
    health: {
      name: "Onda health check",
      source: "neon/functions/health.ts",
    },
  },
});
