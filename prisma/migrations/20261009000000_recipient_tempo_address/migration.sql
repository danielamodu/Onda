-- Tempo-native settlement needs the recipient's own Tempo address as the
-- on-chain payout destination. Previously Payment.destinationAddress only ever
-- held Onda's Base treasury address from funding, which must never be used as
-- a settlement recipient. Nullable: existing recipients predate this field and
-- settlement fails closed until a valid address is recorded.
ALTER TABLE "Recipient" ADD COLUMN "tempoAddress" TEXT;
