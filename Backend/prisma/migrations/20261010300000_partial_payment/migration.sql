-- Partial payment (wallet + online or cash): the wallet part of the order total.
ALTER TABLE "food_orders" ADD COLUMN "walletAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "food_transactions" ADD COLUMN "walletAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;
