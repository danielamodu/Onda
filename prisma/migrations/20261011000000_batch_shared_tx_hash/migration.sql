-- Phase 8: one atomic batch transaction backs every attempt in the batch,
-- so sibling attempts legitimately share destinationTransactionHash. The
-- global unique constraint made every multi-payment batch impossible.
-- Double-record protection lives in the debit idempotency keys
-- (settle:<providerIdempotencyKey>) plus per-payment memo verification.
DROP INDEX IF EXISTS "PaymentSettlement_destinationTransactionHash_key";
CREATE INDEX "PaymentSettlement_destinationTransactionHash_idx" ON "PaymentSettlement"("destinationTransactionHash");
