-- Coupon types from the previous system (6amMart): Store wise, Zone wise,
-- Free delivery, First order, Default.

-- CreateEnum
CREATE TYPE "FoodCouponType" AS ENUM ('default', 'store_wise', 'zone_wise', 'free_delivery', 'first_order');

-- AlterTable
ALTER TABLE "food_offers"
    ADD COLUMN "title" VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN "couponType" "FoodCouponType" NOT NULL DEFAULT 'default',
    ADD COLUMN "zoneIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Existing coupons get the type their older columns already describe, so the
-- admin list labels them correctly. Checkout still reads restaurantScope and
-- isFirstOrderOnly, so nothing about how they apply changes.
UPDATE "food_offers" SET "couponType" = 'store_wise' WHERE "restaurantScope" = 'selected';
UPDATE "food_offers" SET "couponType" = 'first_order'
 WHERE "couponType" = 'default' AND ("isFirstOrderOnly" = true OR "customerScope" = 'first-time');

-- CreateIndex
CREATE INDEX "food_offers_couponType_idx" ON "food_offers"("couponType");

-- AlterTable
ALTER TABLE "food_orders"
    ADD COLUMN "couponId" VARCHAR(24),
    ADD COLUMN "couponDeliveryWaiver" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- Orders placed before this column existed: a stored code with a discount was
-- an applied coupon (a rejected code was stored with no discount). Cancelled
-- and unpaid orders are linked too; the counting queries leave them out.
UPDATE "food_orders" o
   SET "couponId" = f."id"
  FROM "food_offers" f
 WHERE o."couponId" IS NULL
   AND o."couponCode" IS NOT NULL
   AND UPPER(TRIM(o."couponCode")) = f."couponCode"
   AND o."discount" > 0;

-- CreateIndex
CREATE INDEX "food_orders_couponId_userId_idx" ON "food_orders"("couponId", "userId");

-- AddForeignKey
ALTER TABLE "food_orders" ADD CONSTRAINT "food_orders_couponId_fkey"
    FOREIGN KEY ("couponId") REFERENCES "food_offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
