-- Who changed which settings area and which fields (never the values).
CREATE TABLE "food_settings_audit_logs" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "area" VARCHAR(64) NOT NULL,
    "action" VARCHAR(32) NOT NULL,
    "fields" TEXT[],
    "adminId" VARCHAR(24),
    "adminEmail" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "food_settings_audit_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "food_settings_audit_logs_area_createdAt_idx" ON "food_settings_audit_logs"("area", "createdAt");
