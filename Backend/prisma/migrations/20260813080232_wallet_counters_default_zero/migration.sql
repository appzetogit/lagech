-- AlterTable
ALTER TABLE "delivery_fee_bands" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_addons" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_admin_reset_otps" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_admins" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_business_settings" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_cashback_settings" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_categories" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_chat_conversations" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_chat_messages" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_delivery_bonus_transactions" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_delivery_cash_deposits" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_delivery_cash_limits" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_delivery_commission_rules" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_delivery_emergency_help" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_delivery_order_emergency_requests" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_delivery_partners" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_delivery_support_tickets" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_delivery_withdrawals" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_dining_banners" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_dining_categories" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_dining_restaurants" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_driver_registration_fields" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_earning_addon_history" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_earning_addons" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_explore_icons" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_feature_settings" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_fee_settings" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_feedback_experiences" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_gourmet_restaurants" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_hero_banners" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_home_promotion_banners" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_item_variants" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_items" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_landing_settings" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_notification_broadcasts" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_notifications" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_offer_usages" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_offers" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_order_dispatch_offers" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_order_item_ratings" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_order_items" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_order_status_history" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_orders" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_otps" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_page_contents" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_referral_logs" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_referral_settings" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_refresh_tokens" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_restaurant_app_banners" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_restaurant_commissions" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_restaurant_menus" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_restaurant_outlet_timings" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_restaurant_subscription_history" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_restaurant_subscription_settings" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_restaurant_support_tickets" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_restaurant_withdrawals" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_restaurants" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_safety_emergency_reports" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_settings" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_subscription_billing_runs" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_subscription_invoices" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_subscription_transactions" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_support_tickets" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_transaction_history" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_transactions" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_under250_banners" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_unregistered_restaurants" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_user_addresses" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_user_carts" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_user_favorites" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_users" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "food_zones" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "payments" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "refunds" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "settlements" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "top_banners" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
ALTER TABLE "transactions" ALTER COLUMN "id" SET DEFAULT encode(gen_random_bytes(12), 'hex');

-- AlterTable
-- Existing rows carry NULL in these counters, and SET NOT NULL would fail on
-- them. Backfilling to 0 first is also the correction: a NULL counter was never
-- "unknown", it was "never incremented", because `increment` on NULL is a no-op.
UPDATE "wallets" SET
  "totalEarnings"    = COALESCE("totalEarnings", 0),
  "totalSettled"     = COALESCE("totalSettled", 0),
  "cashInHand"       = COALESCE("cashInHand", 0),
  "totalBonus"       = COALESCE("totalBonus", 0),
  "totalDeliveries"  = COALESCE("totalDeliveries", 0),
  "referralEarnings" = COALESCE("referralEarnings", 0),
  "totalRevenue"     = COALESCE("totalRevenue", 0),
  "totalPayouts"     = COALESCE("totalPayouts", 0),
  "totalRefunds"     = COALESCE("totalRefunds", 0);

ALTER TABLE "wallets" ALTER COLUMN "totalEarnings" SET NOT NULL,
ALTER COLUMN "totalEarnings" SET DEFAULT 0,
ALTER COLUMN "totalSettled" SET NOT NULL,
ALTER COLUMN "totalSettled" SET DEFAULT 0,
ALTER COLUMN "cashInHand" SET NOT NULL,
ALTER COLUMN "cashInHand" SET DEFAULT 0,
ALTER COLUMN "totalBonus" SET NOT NULL,
ALTER COLUMN "totalBonus" SET DEFAULT 0,
ALTER COLUMN "totalDeliveries" SET NOT NULL,
ALTER COLUMN "totalDeliveries" SET DEFAULT 0,
ALTER COLUMN "referralEarnings" SET NOT NULL,
ALTER COLUMN "referralEarnings" SET DEFAULT 0,
ALTER COLUMN "totalRevenue" SET NOT NULL,
ALTER COLUMN "totalRevenue" SET DEFAULT 0,
ALTER COLUMN "totalPayouts" SET NOT NULL,
ALTER COLUMN "totalPayouts" SET DEFAULT 0,
ALTER COLUMN "totalRefunds" SET NOT NULL,
ALTER COLUMN "totalRefunds" SET DEFAULT 0;

