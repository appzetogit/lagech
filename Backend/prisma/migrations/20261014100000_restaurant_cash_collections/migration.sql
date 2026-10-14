-- Cash the admin collected from a restaurant (the old panel's "Collect Cash
-- From Store" on the restaurant details page). Counted toward the
-- restaurant's balance by restaurantFinance.getWalletSummaries, so a
-- restaurant that was overdrawn and paid it back is square again.
-- (restaurantId, requestKey) is unique so a double-submitted form records once;
-- rows without a key are not constrained (NULLs are distinct).
CREATE TABLE "food_restaurant_cash_collections" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "restaurantId" VARCHAR(24) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "paymentMethod" VARCHAR(24) NOT NULL DEFAULT 'cash',
    "reference" TEXT,
    "note" TEXT,
    "adminId" VARCHAR(24),
    "requestKey" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_restaurant_cash_collections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "food_restaurant_cash_collections_restaurantId_requestKey_key"
    ON "food_restaurant_cash_collections"("restaurantId", "requestKey");
CREATE INDEX "food_restaurant_cash_collections_restaurantId_createdAt_idx"
    ON "food_restaurant_cash_collections"("restaurantId", "createdAt" DESC);

ALTER TABLE "food_restaurant_cash_collections"
    ADD CONSTRAINT "food_restaurant_cash_collections_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
