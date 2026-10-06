-- Scheduled orders, takeaway and rider tips (Business Settings > Order / Deliveryman).
ALTER TABLE "food_orders" ADD COLUMN "releaseAt" TIMESTAMP(3);
ALTER TABLE "food_orders" ADD COLUMN "orderType" VARCHAR(16) NOT NULL DEFAULT 'delivery';
ALTER TABLE "food_orders" ADD COLUMN "riderTip" DECIMAL(14,2) NOT NULL DEFAULT 0;
CREATE INDEX "food_orders_releaseAt_idx" ON "food_orders"("releaseAt");

ALTER TABLE "food_transactions" ADD COLUMN "riderTip" DECIMAL(14,2) NOT NULL DEFAULT 0;

ALTER TABLE "food_restaurants" ADD COLUMN "takeawayEnabled" BOOLEAN NOT NULL DEFAULT true;
