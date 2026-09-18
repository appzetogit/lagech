-- Reasons offered when an order is cancelled, kept by the admin per who cancels.
CREATE TABLE "food_cancel_reasons" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "reason" TEXT NOT NULL,
    "userType" VARCHAR(16) NOT NULL DEFAULT 'admin',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_cancel_reasons_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "food_cancel_reasons_userType_isActive_sortOrder_idx" ON "food_cancel_reasons"("userType", "isActive", "sortOrder");
