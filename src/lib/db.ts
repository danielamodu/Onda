import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Interactive transactions carry the treasury guarded sections: an idempotency
// check, a full ledger scan, an insert, and the optimistic version bump — a
// handful of round-trips. Prisma's defaults (maxWait 2s, timeout 5s) assume a
// local Postgres and abort these legitimately against a network database such
// as Neon (latency + compute cold start). Raise both to a bounded safety net;
// the normal path still completes in well under a second.
export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    transactionOptions: { maxWait: 15_000, timeout: 30_000 },
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
