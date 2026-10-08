-- Business Settings: what an order records when "free delivery over" waives
-- its delivery fee, and the new-customer discount (part of `discount`, borne
-- by the platform). The settings themselves are JSON documents in
-- food_system_settings and need no columns.

-- AlterTable
ALTER TABLE "food_orders"
    ADD COLUMN "freeDeliveryWaiver" DECIMAL(14,2) NOT NULL DEFAULT 0,
    ADD COLUMN "newCustomerDiscount" DECIMAL(14,2) NOT NULL DEFAULT 0;
