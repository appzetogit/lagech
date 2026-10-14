-- FAQs managed from the admin panel (the old 6amMart f_a_q_s), shown on the
-- customer help page and by GET /api/v1/food/faqs. "audience" is 'customer',
-- 'restaurant' or 'rider'; NULL shows the question to everyone.
CREATE TABLE "food_faqs" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "question" VARCHAR(255) NOT NULL,
    "answer" TEXT NOT NULL,
    "audience" VARCHAR(16),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_faqs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "food_faqs_isActive_sortOrder_idx" ON "food_faqs"("isActive", "sortOrder");
