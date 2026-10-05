-- One JSON document per settings area (page meta data, app settings, login
-- setup, notification channels, landing page, website).
CREATE TABLE "food_system_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "key" VARCHAR(64) NOT NULL,
    "value" JSONB NOT NULL DEFAULT '{}',
    "updatedBy" VARCHAR(24),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_system_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "food_system_settings_key_key" ON "food_system_settings"("key");
