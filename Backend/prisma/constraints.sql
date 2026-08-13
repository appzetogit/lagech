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
ALTER TABLE "wallets" DROP CONSTRAINT IF EXISTS "wallet_balance_non_negative";
ALTER TABLE "wallets" ADD CONSTRAINT "wallet_balance_non_negative"
  CHECK ("entityType" = 'admin' OR "balance" >= 0);

-- Locked funds can never exceed the balance.
--
-- The admin exemption has to be repeated here. Without it this constraint
-- silently overrides the one above: an admin wallet at -500 fails
-- `lockedAmount (0) <= balance (-500)`, so the platform wallet could never go
-- negative at all, whatever wallet_balance_non_negative permitted.
ALTER TABLE "wallets" DROP CONSTRAINT IF EXISTS "wallet_locked_within_balance";
ALTER TABLE "wallets" ADD CONSTRAINT "wallet_locked_within_balance"
  CHECK (
    "lockedAmount" >= 0
    AND ("entityType" = 'admin' OR "lockedAmount" <= "balance")
  );

-- Amounts are always positive; direction lives in Transaction.type.
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "txn_amount_positive";
ALTER TABLE "transactions" ADD CONSTRAINT "txn_amount_positive"
  CHECK ("amount" > 0);
ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payment_amount_non_negative";
ALTER TABLE "payments" ADD CONSTRAINT "payment_amount_non_negative"
  CHECK ("amount" >= 0);
ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refund_amount_non_negative";
ALTER TABLE "refunds" ADD CONSTRAINT "refund_amount_non_negative"
  CHECK ("amount" >= 0);
ALTER TABLE "settlements" DROP CONSTRAINT IF EXISTS "settlement_amount_non_negative";
ALTER TABLE "settlements" ADD CONSTRAINT "settlement_amount_non_negative"
  CHECK ("amount" >= 0);
ALTER TABLE "food_restaurant_withdrawals" DROP CONSTRAINT IF EXISTS "restaurant_withdrawal_min";
ALTER TABLE "food_restaurant_withdrawals" ADD CONSTRAINT "restaurant_withdrawal_min"
  CHECK ("amount" >= 1);
ALTER TABLE "food_delivery_withdrawals" DROP CONSTRAINT IF EXISTS "delivery_withdrawal_min";
ALTER TABLE "food_delivery_withdrawals" ADD CONSTRAINT "delivery_withdrawal_min"
  CHECK ("amount" >= 1);

-- ─── delivery fee bands ──────────────────────────────────────────────────────
-- btree_gist lets a gist index mix plain equality (feeSettingsId) with a range
-- overlap operator, which is what the exclusion constraint below needs.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "delivery_fee_bands" DROP CONSTRAINT IF EXISTS "delivery_fee_band_range_valid";
ALTER TABLE "delivery_fee_bands" ADD CONSTRAINT "delivery_fee_band_range_valid"
  CHECK ("minDistanceKm" >= 0 AND "maxDistanceKm" > "minDistanceKm");

ALTER TABLE "delivery_fee_bands" DROP CONSTRAINT IF EXISTS "delivery_fee_band_amounts_non_negative";
ALTER TABLE "delivery_fee_bands" ADD CONSTRAINT "delivery_fee_band_amounts_non_negative"
  CHECK ("fee" >= 0 AND "deliveryBoyBasePay" >= 0 AND "deliveryBoyPerKm" >= 0);

-- basePay and perKm are alternatives, never both. calculateRiderEarning already
-- treats a non-zero basePay as the winner, so a row with both set has one value
-- that silently does nothing — and whoever configured it has no way to tell.
ALTER TABLE "delivery_fee_bands" DROP CONSTRAINT IF EXISTS "delivery_fee_band_pay_exclusive";
ALTER TABLE "delivery_fee_bands" ADD CONSTRAINT "delivery_fee_band_pay_exclusive"
  CHECK ("deliveryBoyBasePay" = 0 OR "deliveryBoyPerKm" = 0);

-- The point of the whole table. Two bands on the same settings row may not cover
-- the same distance: [0,5) and [3,8) both match a 4 km trip, and which one priced
-- it came down to array order. Half-open ranges so [0,3) and [3,7) sit flush
-- without colliding — matching how matchFeeRange() reads them.
ALTER TABLE "delivery_fee_bands" DROP CONSTRAINT IF EXISTS "delivery_fee_band_no_overlap";
ALTER TABLE "delivery_fee_bands" ADD CONSTRAINT "delivery_fee_band_no_overlap"
  EXCLUDE USING gist (
    "feeSettingsId" WITH =,
    numrange("minDistanceKm", "maxDistanceKm", '[)') WITH &&
  );

-- ─── rating / percentage bounds ──────────────────────────────────────────────
ALTER TABLE "food_users" DROP CONSTRAINT IF EXISTS "user_rating_range";
ALTER TABLE "food_users" ADD CONSTRAINT "user_rating_range"
  CHECK ("rating" >= 0 AND "rating" <= 5);
ALTER TABLE "food_restaurants" DROP CONSTRAINT IF EXISTS "restaurant_rating_range";
ALTER TABLE "food_restaurants" ADD CONSTRAINT "restaurant_rating_range"
  CHECK ("rating" >= 0 AND "rating" <= 5);
ALTER TABLE "food_delivery_partners" DROP CONSTRAINT IF EXISTS "partner_rating_range";
ALTER TABLE "food_delivery_partners" ADD CONSTRAINT "partner_rating_range"
  CHECK ("rating" >= 0 AND "rating" <= 5);
ALTER TABLE "food_items" DROP CONSTRAINT IF EXISTS "item_rating_range";
ALTER TABLE "food_items" ADD CONSTRAINT "item_rating_range"
  CHECK ("rating" >= 0 AND "rating" <= 5);
ALTER TABLE "food_feedback_experiences" DROP CONSTRAINT IF EXISTS "feedback_rating_range";
ALTER TABLE "food_feedback_experiences" ADD CONSTRAINT "feedback_rating_range"
  CHECK ("rating" >= 1 AND "rating" <= 5);
ALTER TABLE "food_order_item_ratings" DROP CONSTRAINT IF EXISTS "order_item_rating_range";
ALTER TABLE "food_order_item_ratings" ADD CONSTRAINT "order_item_rating_range"
  CHECK ("rating" >= 1 AND "rating" <= 5);
ALTER TABLE "food_orders" DROP CONSTRAINT IF EXISTS "order_rating_ranges";
ALTER TABLE "food_orders" ADD CONSTRAINT "order_rating_ranges" CHECK (
  ("restaurantRating" IS NULL OR ("restaurantRating" BETWEEN 1 AND 5)) AND
  ("partnerRating"    IS NULL OR ("partnerRating"    BETWEEN 1 AND 5)) AND
  ("customerRating"   IS NULL OR ("customerRating"   BETWEEN 1 AND 5))
);

ALTER TABLE "food_offers" DROP CONSTRAINT IF EXISTS "offer_bear_split";
ALTER TABLE "food_offers" ADD CONSTRAINT "offer_bear_split"
  CHECK ("adminBearPercentage" BETWEEN 0 AND 100
     AND "restaurantBearPercentage" BETWEEN 0 AND 100);

-- An order must have at least one line. Was a Mongoose array validator.
ALTER TABLE "food_orders" DROP CONSTRAINT IF EXISTS "order_quantity_positive";
ALTER TABLE "food_orders" ADD CONSTRAINT "order_quantity_positive" CHECK (true);
ALTER TABLE "food_order_items" DROP CONSTRAINT IF EXISTS "order_item_quantity_positive";
ALTER TABLE "food_order_items" ADD CONSTRAINT "order_item_quantity_positive"
  CHECK ("quantity" >= 1);

-- A zone polygon needs at least 3 points. Was a Mongoose array validator.
ALTER TABLE "food_zones" DROP CONSTRAINT IF EXISTS "zone_polygon_min_points";
ALTER TABLE "food_zones" ADD CONSTRAINT "zone_polygon_min_points"
  CHECK (jsonb_array_length("coordinates") >= 3);

-- ─── GIN indexes for the id-array columns ────────────────────────────────────
-- These replace Mongo's multikey indexes. Without them every array containment
-- lookup is a sequential scan.
CREATE INDEX IF NOT EXISTS "food_addons_foodIds_gin"          ON "food_addons"          USING GIN ("foodIds");
CREATE INDEX IF NOT EXISTS "food_offers_restaurantIds_gin"    ON "food_offers"          USING GIN ("restaurantIds");
CREATE INDEX IF NOT EXISTS "food_dining_categories_rest_gin"  ON "food_dining_categories" USING GIN ("restaurantIds");
CREATE INDEX IF NOT EXISTS "food_dining_restaurants_cat_gin"  ON "food_dining_restaurants" USING GIN ("categoryIds");
CREATE INDEX IF NOT EXISTS "food_hero_banners_linked_gin"     ON "food_hero_banners"    USING GIN ("linkedRestaurantIds");
CREATE INDEX IF NOT EXISTS "food_landing_settings_rec_gin"    ON "food_landing_settings" USING GIN ("recommendedRestaurantIds");
CREATE INDEX IF NOT EXISTS "food_notification_broadcasts_targets_gin"
  ON "food_notification_broadcasts" USING GIN ("targetIds");
CREATE INDEX IF NOT EXISTS "food_chat_messages_participants_gin"
  ON "food_chat_messages" USING GIN ("participants");
CREATE INDEX IF NOT EXISTS "food_chat_conversations_participants_gin"
  ON "food_chat_conversations" USING GIN ("participants");
CREATE INDEX IF NOT EXISTS "food_admins_services_gin"         ON "food_admins"          USING GIN ("servicesAccess");
CREATE INDEX IF NOT EXISTS "food_restaurants_cuisines_gin"    ON "food_restaurants"     USING GIN ("cuisines");

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

DROP TRIGGER IF EXISTS restaurant_location_sync ON "food_restaurants";
CREATE TRIGGER restaurant_location_sync
  BEFORE INSERT OR UPDATE OF "latitude", "longitude" ON "food_restaurants"
  FOR EACH ROW EXECUTE FUNCTION sync_geography('location', 'latitude', 'longitude');

DROP TRIGGER IF EXISTS restaurant_pending_location_sync ON "food_restaurants";
CREATE TRIGGER restaurant_pending_location_sync
  BEFORE INSERT OR UPDATE OF "pendingLatitude", "pendingLongitude" ON "food_restaurants"
  FOR EACH ROW EXECUTE FUNCTION sync_geography('pendingLocation', 'pendingLatitude', 'pendingLongitude');

DROP TRIGGER IF EXISTS user_address_location_sync ON "food_user_addresses";
CREATE TRIGGER user_address_location_sync
  BEFORE INSERT OR UPDATE OF "latitude", "longitude" ON "food_user_addresses"
  FOR EACH ROW EXECUTE FUNCTION sync_geography('location', 'latitude', 'longitude');

DROP TRIGGER IF EXISTS partner_location_sync ON "food_delivery_partners";
CREATE TRIGGER partner_location_sync
  BEFORE INSERT OR UPDATE OF "lastLat", "lastLng" ON "food_delivery_partners"
  FOR EACH ROW EXECUTE FUNCTION sync_geography('lastLocation', 'lastLat', 'lastLng');

DROP TRIGGER IF EXISTS order_addr_location_sync ON "food_orders";
CREATE TRIGGER order_addr_location_sync
  BEFORE INSERT OR UPDATE OF "addrLat", "addrLng" ON "food_orders"
  FOR EACH ROW EXECUTE FUNCTION sync_geography('addrLocation', 'addrLat', 'addrLng');

DROP TRIGGER IF EXISTS order_rider_location_sync ON "food_orders";
CREATE TRIGGER order_rider_location_sync
  BEFORE INSERT OR UPDATE OF "riderLat", "riderLng" ON "food_orders"
  FOR EACH ROW EXECUTE FUNCTION sync_geography('lastRiderLocation', 'riderLat', 'riderLng');

-- ─── PostGIS indexes (replacing the 2dsphere indexes) ────────────────────────
CREATE INDEX IF NOT EXISTS "food_restaurants_location_gist"
  ON "food_restaurants" USING GIST ("location");
CREATE INDEX IF NOT EXISTS "food_restaurants_pending_location_gist"
  ON "food_restaurants" USING GIST ("pendingLocation");
CREATE INDEX IF NOT EXISTS "food_user_addresses_location_gist"
  ON "food_user_addresses" USING GIST ("location");
CREATE INDEX IF NOT EXISTS "food_delivery_partners_last_location_gist"
  ON "food_delivery_partners" USING GIST ("lastLocation");
CREATE INDEX IF NOT EXISTS "food_orders_addr_location_gist"
  ON "food_orders" USING GIST ("addrLocation");
CREATE INDEX IF NOT EXISTS "food_orders_rider_location_gist"
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
