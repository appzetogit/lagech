-- The admin's wording for emails the backend sends, keyed by email.
CREATE TABLE "food_email_templates" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "key" VARCHAR(64) NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" VARCHAR(24),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_email_templates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "food_email_templates_key_key" ON "food_email_templates"("key");

-- Social media profiles shown on the website and in the apps.
CREATE TABLE "food_social_media_links" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "platform" VARCHAR(40) NOT NULL,
    "url" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_social_media_links_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "food_social_media_links_isActive_sortOrder_idx" ON "food_social_media_links"("isActive", "sortOrder");
