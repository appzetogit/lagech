-- Admin-managed add-on categories, and an optional category on each add-on.
CREATE TABLE "food_addon_categories" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_addon_categories_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "food_addon_categories_isActive_sortOrder_idx" ON "food_addon_categories"("isActive", "sortOrder");

ALTER TABLE "food_addons" ADD COLUMN "categoryId" VARCHAR(24);
CREATE INDEX "food_addons_categoryId_idx" ON "food_addons"("categoryId");
ALTER TABLE "food_addons" ADD CONSTRAINT "food_addons_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "food_addon_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
