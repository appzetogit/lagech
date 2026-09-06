-- CreateEnum
CREATE TYPE "RestaurantBillingMode" AS ENUM ('commission_overall', 'commission_dish', 'subscription');

-- AlterTable
ALTER TABLE "food_restaurants" ADD COLUMN     "billingMode" "RestaurantBillingMode" NOT NULL DEFAULT 'commission_overall';

-- AlterTable
ALTER TABLE "food_fee_settings" ADD COLUMN     "zoneId" VARCHAR(24);

-- AlterTable
ALTER TABLE "top_banners" ADD COLUMN     "zoneId" VARCHAR(24);

-- CreateTable
CREATE TABLE "food_item_commissions" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "itemId" VARCHAR(24) NOT NULL,
    "restaurantId" VARCHAR(24) NOT NULL,
    "commissionType" "CommissionValueType" NOT NULL DEFAULT 'percentage',
    "commissionValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_item_commissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_delivery_partner_sessions" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "deliveryPartnerId" VARCHAR(24) NOT NULL,
    "wentOnlineAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "wentOfflineAt" TIMESTAMP(3),
    "onlineLat" DOUBLE PRECISION,
    "onlineLng" DOUBLE PRECISION,
    "offlineLat" DOUBLE PRECISION,
    "offlineLng" DOUBLE PRECISION,
    "durationMinutes" INTEGER,
    "closedBySystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_delivery_partner_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "food_item_commissions_itemId_key" ON "food_item_commissions"("itemId");

-- CreateIndex
CREATE INDEX "food_item_commissions_restaurantId_status_idx" ON "food_item_commissions"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "food_delivery_partner_sessions_deliveryPartnerId_wentOnline_idx" ON "food_delivery_partner_sessions"("deliveryPartnerId", "wentOnlineAt" DESC);

-- CreateIndex
CREATE INDEX "food_delivery_partner_sessions_deliveryPartnerId_wentOfflin_idx" ON "food_delivery_partner_sessions"("deliveryPartnerId", "wentOfflineAt");

-- CreateIndex
CREATE INDEX "food_fee_settings_zoneId_isActive_createdAt_idx" ON "food_fee_settings"("zoneId", "isActive", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "top_banners_zoneId_idx" ON "top_banners"("zoneId");

-- AddForeignKey
ALTER TABLE "food_fee_settings" ADD CONSTRAINT "food_fee_settings_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "food_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_item_commissions" ADD CONSTRAINT "food_item_commissions_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "food_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_item_commissions" ADD CONSTRAINT "food_item_commissions_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_delivery_partner_sessions" ADD CONSTRAINT "food_delivery_partner_sessions_deliveryPartnerId_fkey" FOREIGN KEY ("deliveryPartnerId") REFERENCES "food_delivery_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "top_banners" ADD CONSTRAINT "top_banners_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "food_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

