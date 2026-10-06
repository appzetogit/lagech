-- Food campaign dishes ordered at the campaign price: the platform-funded
-- discount on the order, and which campaign a line came from.
ALTER TABLE "food_orders" ADD COLUMN "campaignDiscount" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "food_order_items" ADD COLUMN "itemCampaignId" VARCHAR(24);

-- A restaurant's reply to the review a customer left on an order.
ALTER TABLE "food_orders" ADD COLUMN "restaurantReply" TEXT NOT NULL DEFAULT '';
ALTER TABLE "food_orders" ADD COLUMN "restaurantRepliedAt" TIMESTAMP(3);
