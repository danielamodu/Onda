ALTER TABLE "Payment"
    ADD COLUMN "transactionHash" TEXT,
    ADD COLUMN "fundingAuthorizationSignature" TEXT,
    ADD COLUMN "chainId" INTEGER,
    ADD COLUMN "tokenAddress" TEXT,
    ADD COLUMN "senderAddress" TEXT,
    ADD COLUMN "destinationAddress" TEXT,
    ADD COLUMN "blockNumber" BIGINT,
    ADD COLUMN "blockHash" TEXT,
    ADD COLUMN "confirmedAt" TIMESTAMP(3),
    ADD COLUMN "fundingError" TEXT;

CREATE UNIQUE INDEX "Payment_transactionHash_key" ON "Payment"("transactionHash");
