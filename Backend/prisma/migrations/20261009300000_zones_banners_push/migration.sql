-- Zones: the old Zone setup's per-zone payment switches and default zone.
ALTER TABLE "food_zones"
  ADD COLUMN "cashOnDelivery" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "digitalPayment" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "isDefault"      BOOLEAN NOT NULL DEFAULT false;

-- At most one default zone.
CREATE UNIQUE INDEX IF NOT EXISTS "food_zones_one_default" ON "food_zones" ((true)) WHERE "isDefault";

-- Home banners: zone, type (store wise / item wise / default link), dish, featured.
CREATE TYPE "HeroBannerType" AS ENUM ('restaurant', 'food', 'link');

ALTER TABLE "food_hero_banners"
  ADD COLUMN "bannerType"   "HeroBannerType" NOT NULL DEFAULT 'restaurant',
  ADD COLUMN "linkedFoodId" VARCHAR(24),
  ADD COLUMN "zoneId"       VARCHAR(24),
  ADD COLUMN "isFeatured"   BOOLEAN NOT NULL DEFAULT false;

-- A banner with no restaurant was only ever a picture or a link.
UPDATE "food_hero_banners" SET "bannerType" = 'link'
WHERE COALESCE(cardinality("linkedRestaurantIds"), 0) = 0;

ALTER TABLE "food_hero_banners"
  ADD CONSTRAINT "food_hero_banners_zoneId_fkey" FOREIGN KEY ("zoneId")
  REFERENCES "food_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "food_hero_banners_zoneId_isActive_idx" ON "food_hero_banners"("zoneId", "isActive");

-- Push notifications: image, zone, on/off, resend count.
ALTER TABLE "food_notification_broadcasts"
  ADD COLUMN "image"      TEXT NOT NULL DEFAULT '',
  ADD COLUMN "zoneId"     VARCHAR(24),
  ADD COLUMN "isActive"   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "sendCount"  INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "lastSentAt" TIMESTAMP(3);

ALTER TABLE "food_notification_broadcasts"
  ADD CONSTRAINT "food_notification_broadcasts_zoneId_fkey" FOREIGN KEY ("zoneId")
  REFERENCES "food_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;
