-- Sidebar pages a sub-admin is shown, chosen item by item. Empty means no narrowing.
ALTER TABLE "food_admins" ADD COLUMN "menuPaths" TEXT[] DEFAULT ARRAY[]::TEXT[];
