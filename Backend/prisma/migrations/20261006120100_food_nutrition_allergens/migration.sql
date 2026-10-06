-- Free-text nutrition facts and allergens on dishes.
ALTER TABLE "food_items" ADD COLUMN "nutrition" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[];
