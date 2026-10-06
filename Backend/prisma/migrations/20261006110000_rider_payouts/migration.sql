-- Delivery man disbursements and payments. Both are rows in the rider
-- withdrawals table, told apart by "source", so every way a rider is paid
-- counts against the one withdrawable balance and cannot be paid twice.

CREATE TABLE "food_delivery_payout_batches" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "number" SERIAL NOT NULL,
    "totalAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "riderCount" INTEGER NOT NULL DEFAULT 0,
    "minAmount" DECIMAL(14,2) NOT NULL DEFAULT 1,
    "skipped" JSONB NOT NULL DEFAULT '[]',
    "createdById" VARCHAR(24),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_delivery_payout_batches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "food_delivery_payout_batches_number_key" ON "food_delivery_payout_batches"("number");
CREATE INDEX "food_delivery_payout_batches_createdAt_idx" ON "food_delivery_payout_batches"("createdAt" DESC);

ALTER TABLE "food_delivery_withdrawals"
    ADD COLUMN "source" VARCHAR(16) NOT NULL DEFAULT 'manual',
    ADD COLUMN "batchId" VARCHAR(24),
    ADD COLUMN "processedBy" VARCHAR(24);
CREATE INDEX "food_delivery_withdrawals_batchId_idx" ON "food_delivery_withdrawals"("batchId");
CREATE INDEX "food_delivery_withdrawals_source_createdAt_idx" ON "food_delivery_withdrawals"("source", "createdAt" DESC);
ALTER TABLE "food_delivery_withdrawals"
    ADD CONSTRAINT "food_delivery_withdrawals_batchId_fkey" FOREIGN KEY ("batchId")
    REFERENCES "food_delivery_payout_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
