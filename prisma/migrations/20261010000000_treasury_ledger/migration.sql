-- Treasury accounting ledger (Phase 7). Append-only; historical rows are never
-- updated or deleted. All money amounts are integer base units (BigInt).

CREATE TYPE "TreasuryEntryType" AS ENUM ('CREDIT', 'RESERVE', 'RELEASE', 'DEBIT', 'ADJUSTMENT');
CREATE TYPE "SettlementBatchStatus" AS ENUM ('pending', 'settled', 'failed');

CREATE TABLE "TreasuryAccount" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "tokenSymbol" TEXT NOT NULL,
    "tokenDecimals" INTEGER NOT NULL,
    "treasuryAddress" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TreasuryAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TreasuryAccount_chainId_tokenAddress_treasuryAddress_key" ON "TreasuryAccount"("chainId", "tokenAddress", "treasuryAddress");

CREATE TABLE "TreasuryLedgerEntry" (
    "id" TEXT NOT NULL,
    "treasuryAccountId" TEXT NOT NULL,
    "paymentId" TEXT,
    "type" "TreasuryEntryType" NOT NULL,
    "amountUnits" BIGINT NOT NULL,
    "balanceAfterUnits" BIGINT NOT NULL,
    "reservationId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TreasuryLedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TreasuryLedgerEntry_idempotencyKey_key" ON "TreasuryLedgerEntry"("idempotencyKey");
CREATE INDEX "TreasuryLedgerEntry_treasuryAccountId_type_idx" ON "TreasuryLedgerEntry"("treasuryAccountId", "type");
CREATE INDEX "TreasuryLedgerEntry_paymentId_idx" ON "TreasuryLedgerEntry"("paymentId");

ALTER TABLE "TreasuryLedgerEntry" ADD CONSTRAINT "TreasuryLedgerEntry_treasuryAccountId_fkey" FOREIGN KEY ("treasuryAccountId") REFERENCES "TreasuryAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TreasuryLedgerEntry" ADD CONSTRAINT "TreasuryLedgerEntry_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "TreasuryLedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SettlementBatch" (
    "id" TEXT NOT NULL,
    "treasuryAccountId" TEXT,
    "providerIdempotencyKey" TEXT NOT NULL,
    "paymentIds" TEXT[] NOT NULL,
    "status" "SettlementBatchStatus" NOT NULL DEFAULT 'pending',
    "transactionHash" TEXT,
    "failureReason" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),

    CONSTRAINT "SettlementBatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SettlementBatch_providerIdempotencyKey_key" ON "SettlementBatch"("providerIdempotencyKey");
CREATE UNIQUE INDEX "SettlementBatch_transactionHash_key" ON "SettlementBatch"("transactionHash");

ALTER TABLE "SettlementBatch" ADD CONSTRAINT "SettlementBatch_treasuryAccountId_fkey" FOREIGN KEY ("treasuryAccountId") REFERENCES "TreasuryAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PaymentSettlement" ADD COLUMN "batchId" TEXT;

ALTER TABLE "PaymentSettlement" ADD CONSTRAINT "PaymentSettlement_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "SettlementBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
