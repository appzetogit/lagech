-- Automatic restaurant payouts: a nightly batch of payout lines the admin pays
-- by bank or UPI, as the previous system did.

CREATE TYPE "PayoutBatchStatus" AS ENUM ('pending', 'partially_completed', 'completed', 'canceled');

CREATE TABLE "food_restaurant_payout_batches" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "number" SERIAL NOT NULL,
    "runDate" VARCHAR(10) NOT NULL,
    "cutoffAt" TIMESTAMP(3) NOT NULL,
    "status" "PayoutBatchStatus" NOT NULL DEFAULT 'pending',
    "totalAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "restaurantCount" INTEGER NOT NULL DEFAULT 0,
    "skipped" JSONB NOT NULL DEFAULT '[]',
    "triggeredBy" VARCHAR(32) NOT NULL DEFAULT 'schedule',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_restaurant_payout_batches_pkey" PRIMARY KEY ("id")
);
-- Payout numbers continue from the previous system's, which ended below 1000.
ALTER SEQUENCE "food_restaurant_payout_batches_number_seq" RESTART WITH 1001;
CREATE UNIQUE INDEX "food_restaurant_payout_batches_number_key" ON "food_restaurant_payout_batches"("number");
CREATE UNIQUE INDEX "food_restaurant_payout_batches_runDate_key" ON "food_restaurant_payout_batches"("runDate");
CREATE INDEX "food_restaurant_payout_batches_createdAt_idx" ON "food_restaurant_payout_batches"("createdAt" DESC);

CREATE TABLE "food_restaurant_payout_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "frequency" VARCHAR(16) NOT NULL DEFAULT 'daily',
    "weekday" INTEGER NOT NULL DEFAULT 6,
    "runTime" VARCHAR(5) NOT NULL DEFAULT '03:05',
    "waitingDays" INTEGER NOT NULL DEFAULT 1,
    "minAmount" DECIMAL(14,2) NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_restaurant_payout_settings_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "food_restaurant_withdrawals"
    ADD COLUMN "source" VARCHAR(16) NOT NULL DEFAULT 'manual',
    ADD COLUMN "batchId" VARCHAR(24);
CREATE INDEX "food_restaurant_withdrawals_batchId_idx" ON "food_restaurant_withdrawals"("batchId");
ALTER TABLE "food_restaurant_withdrawals"
    ADD CONSTRAINT "food_restaurant_withdrawals_batchId_fkey" FOREIGN KEY ("batchId")
    REFERENCES "food_restaurant_payout_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "food_restaurants" ADD COLUMN "payoutMethod" VARCHAR(16);
