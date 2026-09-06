-- CreateEnum
CREATE TYPE "RecommendedOrderMode" AS ENUM ('manual', 'nearest');

-- AlterTable
ALTER TABLE "food_landing_settings" ADD COLUMN     "recommendedOrderMode" "RecommendedOrderMode" NOT NULL DEFAULT 'manual';

-- CreateTable
CREATE TABLE "food_landing_zone_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "zoneId" VARCHAR(24) NOT NULL,
    "recommendedRestaurantIds" TEXT[],
    "recommendedOrderMode" "RecommendedOrderMode" NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_landing_zone_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "food_landing_zone_settings_zoneId_key" ON "food_landing_zone_settings"("zoneId");

-- AddForeignKey
ALTER TABLE "food_landing_zone_settings" ADD CONSTRAINT "food_landing_zone_settings_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "food_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

