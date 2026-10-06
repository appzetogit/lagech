-- Basic campaigns (restaurants take part) and food campaigns (one special dish).
CREATE TABLE "food_campaigns" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "image" TEXT NOT NULL DEFAULT '',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_campaigns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "food_campaigns_isActive_startsAt_endsAt_idx" ON "food_campaigns"("isActive", "startsAt", "endsAt");

CREATE TABLE "food_campaign_restaurants" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "campaignId" VARCHAR(24) NOT NULL,
    "restaurantId" VARCHAR(24) NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "food_campaign_restaurants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "food_campaign_restaurants_campaignId_restaurantId_key" ON "food_campaign_restaurants"("campaignId", "restaurantId");
CREATE INDEX "food_campaign_restaurants_restaurantId_idx" ON "food_campaign_restaurants"("restaurantId");
ALTER TABLE "food_campaign_restaurants" ADD CONSTRAINT "food_campaign_restaurants_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "food_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "food_campaign_restaurants" ADD CONSTRAINT "food_campaign_restaurants_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "food_item_campaigns" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "restaurantId" VARCHAR(24) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "image" TEXT NOT NULL DEFAULT '',
    "price" DECIMAL(14,2) NOT NULL,
    "discountType" VARCHAR(16) NOT NULL DEFAULT 'percent',
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "foodType" "FoodType" NOT NULL DEFAULT 'Veg',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_item_campaigns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "food_item_campaigns_isActive_startsAt_endsAt_idx" ON "food_item_campaigns"("isActive", "startsAt", "endsAt");
CREATE INDEX "food_item_campaigns_restaurantId_idx" ON "food_item_campaigns"("restaurantId");
ALTER TABLE "food_item_campaigns" ADD CONSTRAINT "food_item_campaigns_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
