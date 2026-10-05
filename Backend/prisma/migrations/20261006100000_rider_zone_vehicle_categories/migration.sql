-- Riders an admin adds carry the zone they work in, and the vehicle kinds riders
-- may use (with how far each may deliver) become an admin-managed list, as on
-- the previous panel.

ALTER TABLE "food_delivery_partners" ADD COLUMN "zoneId" VARCHAR(24);
CREATE INDEX "food_delivery_partners_zoneId_idx" ON "food_delivery_partners"("zoneId");

CREATE TABLE "food_delivery_vehicle_categories" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "type" VARCHAR(64) NOT NULL,
    "startingCoverageKm" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "maxCoverageKm" DECIMAL(8,2) NOT NULL,
    "extraCharges" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_delivery_vehicle_categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "food_delivery_vehicle_categories_type_key" ON "food_delivery_vehicle_categories"("type");
