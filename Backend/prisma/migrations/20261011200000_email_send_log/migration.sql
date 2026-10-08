-- One row per transactional email event (template + entity + version), so a
-- retried request, a double click or two servers handling the same event send
-- the email once. A failed send may be claimed again (up to 3 attempts).
CREATE TABLE "food_email_send_logs" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "eventKey" VARCHAR(191) NOT NULL,
    "templateKey" VARCHAR(64) NOT NULL,
    "recipient" TEXT NOT NULL DEFAULT '',
    "status" VARCHAR(16) NOT NULL DEFAULT 'sending',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "error" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "food_email_send_logs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "food_email_send_logs_eventKey_key" ON "food_email_send_logs"("eventKey");
CREATE INDEX "food_email_send_logs_templateKey_createdAt_idx" ON "food_email_send_logs"("templateKey", "createdAt");
