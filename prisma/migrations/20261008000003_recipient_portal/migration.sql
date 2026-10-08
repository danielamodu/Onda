CREATE TYPE "RecipientSettlementPreference" AS ENUM ('KEEP_STABLECOIN', 'CONVERT_TO_NGN');

CREATE TABLE "RecipientAccount" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RecipientAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecipientAuthSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "recipientAccountId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecipientAuthSession_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Recipient" ADD COLUMN "accountId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "recipientPreference" "RecipientSettlementPreference";
ALTER TABLE "Payment" ADD COLUMN "recipientPreferenceSelectedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "RecipientAccount_email_key" ON "RecipientAccount"("email");
CREATE UNIQUE INDEX "RecipientAuthSession_tokenHash_key" ON "RecipientAuthSession"("tokenHash");
CREATE INDEX "RecipientAuthSession_recipientAccountId_idx" ON "RecipientAuthSession"("recipientAccountId");
CREATE INDEX "RecipientAuthSession_expiresAt_idx" ON "RecipientAuthSession"("expiresAt");
CREATE INDEX "Recipient_accountId_idx" ON "Recipient"("accountId");

ALTER TABLE "Recipient" ADD CONSTRAINT "Recipient_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "RecipientAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RecipientAuthSession" ADD CONSTRAINT "RecipientAuthSession_recipientAccountId_fkey" FOREIGN KEY ("recipientAccountId") REFERENCES "RecipientAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
