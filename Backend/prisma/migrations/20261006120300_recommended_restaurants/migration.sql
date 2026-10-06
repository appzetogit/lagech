-- Restaurants the admin picks for the customer app's "Recommended" row.
ALTER TABLE "food_restaurants" ADD COLUMN "isRecommended" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "recommendedSortOrder" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "food_restaurants_isRecommended_recommendedSortOrder_idx" ON "food_restaurants"("isRecommended", "recommendedSortOrder");
