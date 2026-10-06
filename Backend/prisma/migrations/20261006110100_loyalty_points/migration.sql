-- Customer loyalty points: settings (one row), each customer's balance, and the
-- points ledger (earned on delivered orders, converted into wallet balance).
CREATE TABLE "food_loyalty_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "pointsPerHundred" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "pointsPerRupee" INTEGER NOT NULL DEFAULT 0,
    "minimumConvertPoints" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_loyalty_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "food_loyalty_point_accounts" (
    "userId" VARCHAR(24) NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "totalEarned" INTEGER NOT NULL DEFAULT 0,
    "totalConverted" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_loyalty_point_accounts_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "food_loyalty_point_transactions" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "userId" VARCHAR(24) NOT NULL,
    "type" VARCHAR(8) NOT NULL,
    "points" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "orderId" VARCHAR(24),
    "walletAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "food_loyalty_point_transactions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "food_loyalty_point_transactions_idempotencyKey_key" ON "food_loyalty_point_transactions"("idempotencyKey");
CREATE INDEX "food_loyalty_point_transactions_userId_createdAt_idx" ON "food_loyalty_point_transactions"("userId", "createdAt" DESC);
CREATE INDEX "food_loyalty_point_transactions_createdAt_idx" ON "food_loyalty_point_transactions"("createdAt" DESC);
