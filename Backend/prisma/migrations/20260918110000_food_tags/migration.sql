-- Search tags on dishes; a GIN index so "has this tag" stays fast.
ALTER TABLE "food_items" ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
CREATE INDEX "food_items_tags_idx" ON "food_items" USING GIN ("tags");
