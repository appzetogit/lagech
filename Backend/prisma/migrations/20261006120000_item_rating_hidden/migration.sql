-- An admin can hide an abusive dish review; hidden ones stay out of public listings.
ALTER TABLE "food_order_item_ratings" ADD COLUMN "isHidden" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "hiddenAt" TIMESTAMP(3);
CREATE INDEX "food_order_item_ratings_ratedAt_idx" ON "food_order_item_ratings"("ratedAt" DESC);
