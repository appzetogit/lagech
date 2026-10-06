-- Payout method types the admin accepts, and each payee's chosen method with
-- the fields they filled in. Additive: the bank and UPI columns on
-- food_restaurants and food_delivery_partners are untouched.
CREATE TABLE "food_withdrawal_methods" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "name" VARCHAR(80) NOT NULL,
    "fields" JSONB NOT NULL DEFAULT '[]',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_withdrawal_methods_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "food_withdrawal_methods_isActive_sortOrder_idx" ON "food_withdrawal_methods"("isActive", "sortOrder");

CREATE TABLE "food_payout_method_details" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "ownerType" VARCHAR(16) NOT NULL,
    "ownerId" VARCHAR(24) NOT NULL,
    "methodId" VARCHAR(24) NOT NULL,
    "values" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_payout_method_details_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "food_payout_method_details_ownerType_ownerId_key" ON "food_payout_method_details"("ownerType", "ownerId");
CREATE INDEX "food_payout_method_details_methodId_idx" ON "food_payout_method_details"("methodId");
ALTER TABLE "food_payout_method_details"
    ADD CONSTRAINT "food_payout_method_details_methodId_fkey" FOREIGN KEY ("methodId")
    REFERENCES "food_withdrawal_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
