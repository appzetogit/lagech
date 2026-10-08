-- Business Settings > Order "extra packaging charge" (a restaurant's own
-- packaging charge, paid to the restaurant) and Business info "additional
-- charge" (a flat platform charge per order, included in platformFee).
ALTER TABLE "food_restaurants" ADD COLUMN "extraPackagingEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "food_restaurants" ADD COLUMN "extraPackagingAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "food_restaurants" ADD COLUMN "extraPackagingRequired" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "food_orders" ADD COLUMN "additionalCharge" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "food_orders" ADD COLUMN "additionalChargeName" VARCHAR(60) NOT NULL DEFAULT '';
