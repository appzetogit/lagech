-- Store disbursements brought over from the previous system keep their number
-- there ("Disbursement # 1117"). Runs made here keep using "number"; the two
-- never share a column, so an imported batch cannot collide with one made here.

ALTER TABLE "food_restaurant_payout_batches" ADD COLUMN "legacyNumber" INTEGER;
CREATE UNIQUE INDEX "food_restaurant_payout_batches_legacyNumber_key" ON "food_restaurant_payout_batches"("legacyNumber");
