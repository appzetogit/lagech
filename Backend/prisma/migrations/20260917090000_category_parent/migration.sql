-- Sub-categories.
--
-- A category may now sit under another one: "Hotel VEG" -> "Starter", "Rice",
-- "Roti". The previous system held 21 of these and nothing deeper, so this is
-- one level; the service keeps the parent top-level, since a foreign key cannot
-- say anything about the row it points at.
--
-- Nullable, so every existing category simply stays top-level.
ALTER TABLE "food_categories" ADD COLUMN "parentId" VARCHAR(24);

-- Children are listed by parent on every admin load and every public category
-- query, so this is not optional.
CREATE INDEX "food_categories_parentId_idx" ON "food_categories"("parentId");

-- RESTRICT: removing a parent must fail while it still has sub-categories,
-- rather than cascade away the children and orphan the dishes filed under them.
ALTER TABLE "food_categories" ADD CONSTRAINT "food_categories_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "food_categories"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
