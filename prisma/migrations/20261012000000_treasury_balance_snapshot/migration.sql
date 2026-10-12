-- Treasury balance snapshot: transactionally-maintained aggregate columns on
-- TreasuryAccount so hot-path ledger operations read O(1) instead of scanning
-- every TreasuryLedgerEntry. The append-only ledger remains authoritative;
-- these columns are a derived cache, backfilled below from existing history.

-- AlterTable: add snapshot columns (safe: additive, defaulted, no data loss)
ALTER TABLE "TreasuryAccount"
  ADD COLUMN "creditedUnits" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "reservedUnits" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "debitedUnits"  BIGINT NOT NULL DEFAULT 0;

-- CreateIndex: supports the bounded active-reservation lookup (consumer check)
CREATE INDEX "TreasuryLedgerEntry_reservationId_idx" ON "TreasuryLedgerEntry"("reservationId");

-- Backfill the snapshot from the append-only ledger. This mirrors
-- summarizeLedger exactly: credited = sum(CREDIT), debited = sum(DEBIT),
-- reserved = sum(RESERVE) whose reservation has not been consumed by a RELEASE
-- or DEBIT. Historical ledger rows are only read, never modified.
UPDATE "TreasuryAccount" a SET
  "creditedUnits" = COALESCE(
    (SELECT SUM(e."amountUnits") FROM "TreasuryLedgerEntry" e
       WHERE e."treasuryAccountId" = a.id AND e."type" = 'CREDIT'), 0),
  "debitedUnits" = COALESCE(
    (SELECT SUM(e."amountUnits") FROM "TreasuryLedgerEntry" e
       WHERE e."treasuryAccountId" = a.id AND e."type" = 'DEBIT'), 0),
  "reservedUnits" = COALESCE(
    (SELECT SUM(r."amountUnits") FROM "TreasuryLedgerEntry" r
       WHERE r."treasuryAccountId" = a.id AND r."type" = 'RESERVE'
         AND NOT EXISTS (
           SELECT 1 FROM "TreasuryLedgerEntry" c
             WHERE c."reservationId" = r.id AND c."type" IN ('RELEASE', 'DEBIT'))), 0);
