CREATE TYPE "PaymentStatus" AS ENUM ('draft', 'created', 'funding', 'funded', 'settling', 'settled', 'payout_pending', 'completed', 'failed');
CREATE TYPE "PayoutCurrency" AS ENUM ('USDC', 'NGN');

CREATE TABLE "Business" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Business_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Recipient" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'NG',
    "payoutCurrency" "PayoutCurrency" NOT NULL DEFAULT 'NGN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Recipient_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "asset" TEXT NOT NULL DEFAULT 'USDC',
    "country" TEXT NOT NULL DEFAULT 'NG',
    "payoutCurrency" "PayoutCurrency" NOT NULL,
    "reference" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Business_email_key" ON "Business"("email");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_businessId_idx" ON "User"("businessId");
CREATE UNIQUE INDEX "AuthSession_tokenHash_key" ON "AuthSession"("tokenHash");
CREATE INDEX "AuthSession_userId_idx" ON "AuthSession"("userId");
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");
CREATE UNIQUE INDEX "Recipient_businessId_identifier_key" ON "Recipient"("businessId", "identifier");
CREATE INDEX "Recipient_businessId_idx" ON "Recipient"("businessId");
CREATE INDEX "Payment_businessId_createdAt_idx" ON "Payment"("businessId", "createdAt");
CREATE INDEX "Payment_recipientId_idx" ON "Payment"("recipientId");
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

ALTER TABLE "User" ADD CONSTRAINT "User_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Recipient" ADD CONSTRAINT "Recipient_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Recipient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
