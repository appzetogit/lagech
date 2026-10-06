-- AlterTable
ALTER TABLE "food_restaurants" ADD COLUMN "displayPosition" INTEGER;

-- CreateIndex
CREATE INDEX "food_restaurants_displayPosition_idx" ON "food_restaurants"("displayPosition");
