CREATE TYPE "SettlementAttemptStatus" AS ENUM ('pending', 'settled', 'failed');
CREATE TYPE "SettlementVerificationStatus" AS ENUM ('unverified', 'pending', 'verified', 'simulated', 'failed');

CREATE TABLE "PaymentSettlement" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "providerIdempotencyKey" TEXT NOT NULL,
    "status" "SettlementAttemptStatus" NOT NULL DEFAULT 'pending',
    "verificationStatus" "SettlementVerificationStatus" NOT NULL DEFAULT 'unverified',
    "isSimulation" BOOLEAN NOT NULL DEFAULT false,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "sourceChainId" INTEGER,
    "destinationChainId" INTEGER,
    "sourceAsset" TEXT,
    "sourceTokenAddress" TEXT,
    "destinationAsset" TEXT,
    "destinationTokenAddress" TEXT,
    "sourceAmount" DECIMAL(36,18),
    "destinationAmount" DECIMAL(36,18),
    "recipientAddress" TEXT,
    "sourceTransactionHash" TEXT,
    "destinationTransactionHash" TEXT,
    "bridgeMessageId" TEXT,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentSettlement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PaymentSettlement_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PaymentSettlement_destinationTransactionHash_key" ON "PaymentSettlement"("destinationTransactionHash");
CREATE UNIQUE INDEX "PaymentSettlement_bridgeMessageId_key" ON "PaymentSettlement"("bridgeMessageId");
CREATE UNIQUE INDEX "PaymentSettlement_providerIdempotencyKey_key" ON "PaymentSettlement"("providerIdempotencyKey");
CREATE UNIQUE INDEX "PaymentSettlement_paymentId_attemptNumber_key" ON "PaymentSettlement"("paymentId", "attemptNumber");
CREATE INDEX "PaymentSettlement_paymentId_status_idx" ON "PaymentSettlement"("paymentId", "status");
