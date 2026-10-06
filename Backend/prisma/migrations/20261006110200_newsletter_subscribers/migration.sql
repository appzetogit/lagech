-- Newsletter subscribers (old panel: Subscribed Mail List).
CREATE TABLE "food_newsletter_subscribers" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "email" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_newsletter_subscribers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "food_newsletter_subscribers_email_key" ON "food_newsletter_subscribers"("email");
CREATE INDEX "food_newsletter_subscribers_createdAt_idx" ON "food_newsletter_subscribers"("createdAt" DESC);
