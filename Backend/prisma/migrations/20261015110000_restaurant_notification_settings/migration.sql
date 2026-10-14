-- A restaurant's own notification choices per event and channel (the old
-- 6amMart store "Notification Setup", store_notification_settings). A missing
-- row means the event's defaults. Status is 'active' or 'inactive'; 'disable'
-- marks a channel the event does not offer.
CREATE TABLE "food_restaurant_notification_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "restaurantId" VARCHAR(24) NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "mailStatus" VARCHAR(10) NOT NULL DEFAULT 'active',
    "smsStatus" VARCHAR(10) NOT NULL DEFAULT 'disable',
    "pushStatus" VARCHAR(10) NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_restaurant_notification_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "food_restaurant_notification_settings_restaurantId_key_key"
    ON "food_restaurant_notification_settings"("restaurantId", "key");

ALTER TABLE "food_restaurant_notification_settings"
    ADD CONSTRAINT "food_restaurant_notification_settings_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
