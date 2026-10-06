-- Bonus rules for customer wallet top-ups (old panel: Customer Wallet -> Bonus).
CREATE TABLE "food_wallet_bonuses" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "bonusType" VARCHAR(16) NOT NULL DEFAULT 'percentage',
    "bonusAmount" DECIMAL(14,2) NOT NULL,
    "minimumAddAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "maximumBonus" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_wallet_bonuses_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "food_wallet_bonuses_isActive_startDate_endDate_idx" ON "food_wallet_bonuses"("isActive", "startDate", "endDate");
