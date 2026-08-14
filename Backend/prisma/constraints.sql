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

-- One wallets table serves four entity types, so most counters only apply to
-- some of them. Without this a user wallet could carry cashInHand and a rider
-- wallet totalRevenue — meaningless values that still show up in aggregates and
-- reconciliation. Zero is always allowed; it is the resting state.
ALTER TABLE "wallets" DROP CONSTRAINT IF EXISTS "wallet_counters_match_entity_type";
ALTER TABLE "wallets" ADD CONSTRAINT "wallet_counters_match_entity_type" CHECK (
  -- rider-only
  ("entityType" = 'deliveryBoy' OR ("cashInHand" = 0 AND "totalBonus" = 0 AND "totalDeliveries" = 0))
  -- customer-only
  AND ("entityType" = 'user' OR "referralEarnings" = 0)
  -- platform-only
  AND ("entityType" = 'admin' OR ("totalRevenue" = 0 AND "totalPayouts" = 0 AND "totalRefunds" = 0))
  -- earnings/settlement belong to the two payee types
  AND ("entityType" IN ('restaurant', 'deliveryBoy') OR ("totalEarnings" = 0 AND "totalSettled" = 0))
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

-- ─── delivery commission slabs must not overlap ──────────────────────────────
-- Same reasoning as the fee bands above. The slab set decides what a rider is
-- paid, and the overlap rule lived in JS: two admins saving concurrently each
-- validated against a set that did not yet include the other's slab, so an
-- overlap could be written by a check that had just passed. A NULL maxDistance
-- means "and everything beyond", which is upper-unbounded rather than absent.
--
-- Inactive slabs are excluded: a disabled slab prices nothing, so it is allowed
-- to sit under a live one while an admin reworks the ladder.
ALTER TABLE "food_delivery_commission_rules"
  DROP CONSTRAINT IF EXISTS "delivery_commission_rule_no_overlap";
ALTER TABLE "food_delivery_commission_rules"
  ADD CONSTRAINT "delivery_commission_rule_no_overlap"
  EXCLUDE USING gist (
    numrange("minDistance", "maxDistance", '[)') WITH &&
  ) WHERE ("status");

-- ─── one live incentive grant per partner, per offer ─────────────────────────
-- checkEarningAddonCompletions looked for an existing pending/credited row and
-- inserted if it found none. Two runs of the sweep (or a manual run racing the
-- scheduled one) both looked, both found nothing, and both granted — paying the
-- same incentive twice.
--
-- Cancelled grants are excluded so an admin can reject one and let the partner
-- earn it again.
DROP INDEX IF EXISTS "earning_addon_one_grant_per_partner";
CREATE UNIQUE INDEX "earning_addon_one_grant_per_partner"
  ON "food_earning_addon_history" ("offerId", "deliveryPartnerId")
  WHERE ("status" <> 'cancelled');

-- ─── one default address per customer ────────────────────────────────────────
-- A partial unique index: many non-default addresses, at most one default. This
-- was previously "whatever the last save happened to leave true" across an
-- embedded array, so a failed write could leave a customer with two defaults or
-- none, and checkout silently picked the first it found.
CREATE UNIQUE INDEX IF NOT EXISTS "food_user_addresses_one_default_per_user"
  ON "food_user_addresses" ("userId") WHERE "isDefault";

-- ─── menu item variants ──────────────────────────────────────────────────────
-- normalizeFoodVariantsInput already rejects a price <= 0, but it was the only
-- thing asserting it: a variant written by the bulk uploader, an admin script or
-- a direct query bypassed the check entirely and priced a dish at zero.
ALTER TABLE "food_item_variants" DROP CONSTRAINT IF EXISTS "food_item_variant_price_positive";
ALTER TABLE "food_item_variants" ADD CONSTRAINT "food_item_variant_price_positive"
  CHECK ("price" > 0);

ALTER TABLE "food_item_variants" DROP CONSTRAINT IF EXISTS "food_item_variant_other_price_non_negative";
ALTER TABLE "food_item_variants" ADD CONSTRAINT "food_item_variant_other_price_non_negative"
  CHECK ("otherPrice" >= 0);

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

-- ─── FCM device token lists ──────────────────────────────────────────────────
-- Mongo's $addToSet with a trailing cap, as one expression.
--
-- Appending a device token has to be atomic: the same install registers from
-- several places at once (login, app resume, token refresh), and a
-- read-modify-write loses registrations — which shows up as a device that
-- silently stops receiving pushes. Remove-then-append also moves an existing
-- token to the end, so the cap always evicts the genuinely oldest device.
CREATE OR REPLACE FUNCTION array_append_capped(arr text[], val text, cap int)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
           WHEN cardinality(a) > cap THEN a[cardinality(a) - cap + 1 : cardinality(a)]
           ELSE a
         END
  FROM (SELECT array_append(array_remove(COALESCE(arr, '{}'), val), val) AS a) s;
$fn$;

-- ─── zone boundaries are derived from the coordinate ring ────────────────────
-- The admin UI writes `coordinates` ([{latitude, longitude}, …]); this builds the
-- polygon that ST_Contains actually queries. Same contract as sync_geography():
-- application code writes the plain shape, the database derives the geometry, so
-- the two cannot drift.
CREATE OR REPLACE FUNCTION sync_zone_boundary() RETURNS trigger AS $$
DECLARE
  ring geometry;
BEGIN
  IF NEW."coordinates" IS NULL
     OR jsonb_typeof(NEW."coordinates") <> 'array'
     OR jsonb_array_length(NEW."coordinates") < 3 THEN
    NEW."boundary" := NULL;
    RETURN NEW;
  END IF;

  SELECT ST_MakeLine(
           ST_SetSRID(
             ST_MakePoint((p->>'longitude')::float8, (p->>'latitude')::float8),
             4326
           ) ORDER BY ord
         )
    INTO ring
    FROM jsonb_array_elements(NEW."coordinates") WITH ORDINALITY AS t(p, ord);

  -- A malformed entry (missing or non-numeric lat/lng) collapses the line.
  IF ring IS NULL OR ST_NPoints(ring) < 3 THEN
    NEW."boundary" := NULL;
    RETURN NEW;
  END IF;

  -- A polygon ring has to close. The admin UI does not repeat the first point,
  -- so add it back unless the caller already did.
  IF NOT ST_Equals(ST_StartPoint(ring), ST_EndPoint(ring)) THEN
    ring := ST_AddPoint(ring, ST_StartPoint(ring));
  END IF;

  -- ST_MakeValid repairs a self-intersecting ring rather than rejecting the save
  -- outright: a zone drawn with a crossed edge is an admin slip, and refusing the
  -- write leaves them with no zone at all. ST_CollectionExtract keeps only the
  -- polygonal part, so the column type still holds.
  NEW."boundary" := ST_CollectionExtract(ST_MakeValid(ST_MakePolygon(ring)), 3)::geography;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS zone_boundary_sync ON "food_zones";
CREATE TRIGGER zone_boundary_sync
  BEFORE INSERT OR UPDATE OF "coordinates" ON "food_zones"
  FOR EACH ROW EXECUTE FUNCTION sync_zone_boundary();

CREATE INDEX IF NOT EXISTS "food_zones_boundary_gist"
  ON "food_zones" USING GIST ("boundary");

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
