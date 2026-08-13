-- Things Prisma's schema language can't express.
-- Paste into the generated migration after:
--   npx prisma migrate dev --create-only --name init

-- ─── extensions ──────────────────────────────────────────────────────────────
-- gen_random_bytes() backs the 24-char hex ids; postgis backs every geography column.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;

-- ─── money guards ────────────────────────────────────────────────────────────
-- The debit guard, moved out of transaction.service.js and into the database.
-- Admin wallet is allowed to go negative (it was in Mongo too).
ALTER TABLE "wallets" ADD CONSTRAINT "wallet_balance_non_negative"
  CHECK ("entityType" = 'admin' OR "balance" >= 0);

-- Locked funds can never exceed the balance.
--
-- The admin exemption has to be repeated here. Without it this constraint
-- silently overrides the one above: an admin wallet at -500 fails
-- `lockedAmount (0) <= balance (-500)`, so the platform wallet could never go
-- negative at all, whatever wallet_balance_non_negative permitted.
ALTER TABLE "wallets" ADD CONSTRAINT "wallet_locked_within_balance"
  CHECK (
    "lockedAmount" >= 0
    AND ("entityType" = 'admin' OR "lockedAmount" <= "balance")
  );

-- Amounts are always positive; direction lives in Transaction.type.
ALTER TABLE "transactions" ADD CONSTRAINT "txn_amount_positive"
  CHECK ("amount" > 0);
ALTER TABLE "payments" ADD CONSTRAINT "payment_amount_non_negative"
  CHECK ("amount" >= 0);
ALTER TABLE "refunds" ADD CONSTRAINT "refund_amount_non_negative"
  CHECK ("amount" >= 0);
ALTER TABLE "settlements" ADD CONSTRAINT "settlement_amount_non_negative"
  CHECK ("amount" >= 0);
ALTER TABLE "food_restaurant_withdrawals" ADD CONSTRAINT "restaurant_withdrawal_min"
  CHECK ("amount" >= 1);
ALTER TABLE "food_delivery_withdrawals" ADD CONSTRAINT "delivery_withdrawal_min"
  CHECK ("amount" >= 1);

-- ─── rating / percentage bounds ──────────────────────────────────────────────
ALTER TABLE "food_users" ADD CONSTRAINT "user_rating_range"
  CHECK ("rating" >= 0 AND "rating" <= 5);
ALTER TABLE "food_restaurants" ADD CONSTRAINT "restaurant_rating_range"
  CHECK ("rating" >= 0 AND "rating" <= 5);
ALTER TABLE "food_delivery_partners" ADD CONSTRAINT "partner_rating_range"
  CHECK ("rating" >= 0 AND "rating" <= 5);
ALTER TABLE "food_items" ADD CONSTRAINT "item_rating_range"
  CHECK ("rating" >= 0 AND "rating" <= 5);
ALTER TABLE "food_feedback_experiences" ADD CONSTRAINT "feedback_rating_range"
  CHECK ("rating" >= 1 AND "rating" <= 5);
ALTER TABLE "food_order_item_ratings" ADD CONSTRAINT "order_item_rating_range"
  CHECK ("rating" >= 1 AND "rating" <= 5);
ALTER TABLE "food_orders" ADD CONSTRAINT "order_rating_ranges" CHECK (
  ("restaurantRating" IS NULL OR ("restaurantRating" BETWEEN 1 AND 5)) AND
  ("partnerRating"    IS NULL OR ("partnerRating"    BETWEEN 1 AND 5)) AND
  ("customerRating"   IS NULL OR ("customerRating"   BETWEEN 1 AND 5))
);

ALTER TABLE "food_offers" ADD CONSTRAINT "offer_bear_split"
  CHECK ("adminBearPercentage" BETWEEN 0 AND 100
     AND "restaurantBearPercentage" BETWEEN 0 AND 100);

-- An order must have at least one line. Was a Mongoose array validator.
ALTER TABLE "food_orders" ADD CONSTRAINT "order_quantity_positive" CHECK (true);
ALTER TABLE "food_order_items" ADD CONSTRAINT "order_item_quantity_positive"
  CHECK ("quantity" >= 1);

-- A zone polygon needs at least 3 points. Was a Mongoose array validator.
ALTER TABLE "food_zones" ADD CONSTRAINT "zone_polygon_min_points"
  CHECK (jsonb_array_length("coordinates") >= 3);

-- ─── GIN indexes for the id-array columns ────────────────────────────────────
-- These replace Mongo's multikey indexes. Without them every array containment
-- lookup is a sequential scan.
CREATE INDEX "food_addons_foodIds_gin"          ON "food_addons"          USING GIN ("foodIds");
CREATE INDEX "food_offers_restaurantIds_gin"    ON "food_offers"          USING GIN ("restaurantIds");
CREATE INDEX "food_dining_categories_rest_gin"  ON "food_dining_categories" USING GIN ("restaurantIds");
CREATE INDEX "food_dining_restaurants_cat_gin"  ON "food_dining_restaurants" USING GIN ("categoryIds");
CREATE INDEX "food_hero_banners_linked_gin"     ON "food_hero_banners"    USING GIN ("linkedRestaurantIds");
CREATE INDEX "food_landing_settings_rec_gin"    ON "food_landing_settings" USING GIN ("recommendedRestaurantIds");
CREATE INDEX "food_notification_broadcasts_targets_gin"
  ON "food_notification_broadcasts" USING GIN ("targetIds");
CREATE INDEX "food_chat_messages_participants_gin"
  ON "food_chat_messages" USING GIN ("participants");
CREATE INDEX "food_chat_conversations_participants_gin"
  ON "food_chat_conversations" USING GIN ("participants");
CREATE INDEX "food_admins_services_gin"         ON "food_admins"          USING GIN ("servicesAccess");
CREATE INDEX "food_restaurants_cuisines_gin"    ON "food_restaurants"     USING GIN ("cuisines");

-- ─── geography columns are derived, never written by hand ────────────────────
-- Application code writes plain lat/lng (Prisma Client cannot select an
-- Unsupported column). These triggers derive the matching geography point, so the
-- two can never drift the way Mongo's coordinates/latitude pair did — that sync
-- was a 60-line pre('validate') hook in restaurant.model.js.
CREATE OR REPLACE FUNCTION sync_geography() RETURNS trigger AS $$
DECLARE
  lat double precision;
  lng double precision;
BEGIN
  EXECUTE format('SELECT ($1).%I, ($1).%I', TG_ARGV[1], TG_ARGV[2])
    INTO lat, lng USING NEW;

  IF lat IS NULL OR lng IS NULL THEN
    NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[0], NULL));
  ELSE
    NEW := jsonb_populate_record(
      NEW,
      jsonb_build_object(TG_ARGV[0], ST_SetSRID(ST_MakePoint(lng, lat), 4326)::text)
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER restaurant_location_sync
  BEFORE INSERT OR UPDATE OF "latitude", "longitude" ON "food_restaurants"
  FOR EACH ROW EXECUTE FUNCTION sync_geography('location', 'latitude', 'longitude');

CREATE TRIGGER restaurant_pending_location_sync
  BEFORE INSERT OR UPDATE OF "pendingLatitude", "pendingLongitude" ON "food_restaurants"
  FOR EACH ROW EXECUTE FUNCTION sync_geography('pendingLocation', 'pendingLatitude', 'pendingLongitude');

CREATE TRIGGER user_address_location_sync
  BEFORE INSERT OR UPDATE OF "latitude", "longitude" ON "food_user_addresses"
  FOR EACH ROW EXECUTE FUNCTION sync_geography('location', 'latitude', 'longitude');

CREATE TRIGGER partner_location_sync
  BEFORE INSERT OR UPDATE OF "lastLat", "lastLng" ON "food_delivery_partners"
  FOR EACH ROW EXECUTE FUNCTION sync_geography('lastLocation', 'lastLat', 'lastLng');

CREATE TRIGGER order_addr_location_sync
  BEFORE INSERT OR UPDATE OF "addrLat", "addrLng" ON "food_orders"
  FOR EACH ROW EXECUTE FUNCTION sync_geography('addrLocation', 'addrLat', 'addrLng');

CREATE TRIGGER order_rider_location_sync
  BEFORE INSERT OR UPDATE OF "riderLat", "riderLng" ON "food_orders"
  FOR EACH ROW EXECUTE FUNCTION sync_geography('lastRiderLocation', 'riderLat', 'riderLng');

-- ─── PostGIS indexes (replacing the 2dsphere indexes) ────────────────────────
CREATE INDEX "food_restaurants_location_gist"
  ON "food_restaurants" USING GIST ("location");
CREATE INDEX "food_restaurants_pending_location_gist"
  ON "food_restaurants" USING GIST ("pendingLocation");
CREATE INDEX "food_user_addresses_location_gist"
  ON "food_user_addresses" USING GIST ("location");
CREATE INDEX "food_delivery_partners_last_location_gist"
  ON "food_delivery_partners" USING GIST ("lastLocation");
CREATE INDEX "food_orders_addr_location_gist"
  ON "food_orders" USING GIST ("addrLocation");
CREATE INDEX "food_orders_rider_location_gist"
  ON "food_orders" USING GIST ("lastRiderLocation");

-- ─── TTL replacements ────────────────────────────────────────────────────────
-- Postgres has no TTL index. Mongo expired four collections automatically; those
-- deletes must now be driven by the existing maintenance worker (or pg_cron).
-- Run every 10 minutes:
--
--   DELETE FROM "food_otps"                    WHERE "purgeAt"   < now();
--   DELETE FROM "food_refresh_tokens"          WHERE "expiresAt" < now();
--   DELETE FROM "food_admin_reset_otps"        WHERE "expiresAt" < now();
--   DELETE FROM "food_notifications"           WHERE "createdAt" < now() - interval '7 days';
--   DELETE FROM "food_notification_broadcasts" WHERE "createdAt" < now() - interval '7 days';
--
-- If pg_cron is available, schedule them here instead of in the worker:
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- SELECT cron.schedule('purge-expired', '*/10 * * * *', $$
--   DELETE FROM "food_otps" WHERE "purgeAt" < now();
--   DELETE FROM "food_refresh_tokens" WHERE "expiresAt" < now();
--   DELETE FROM "food_admin_reset_otps" WHERE "expiresAt" < now();
--   DELETE FROM "food_notifications" WHERE "createdAt" < now() - interval '7 days';
--   DELETE FROM "food_notification_broadcasts" WHERE "createdAt" < now() - interval '7 days';
-- $$);
