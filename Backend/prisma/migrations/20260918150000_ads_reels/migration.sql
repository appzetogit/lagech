-- Restaurant advertisements (requested by restaurants, approved by the admin) and reels.
CREATE TABLE "food_advertisements" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "restaurantId" VARCHAR(24) NOT NULL,
    "type" VARCHAR(16) NOT NULL DEFAULT 'restaurant',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "coverImage" TEXT NOT NULL DEFAULT '',
    "logoImage" TEXT NOT NULL DEFAULT '',
    "videoUrl" TEXT NOT NULL DEFAULT '',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "priority" INTEGER,
    "showRating" BOOLEAN NOT NULL DEFAULT true,
    "showReviews" BOOLEAN NOT NULL DEFAULT true,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "note" TEXT NOT NULL DEFAULT '',
    "createdBy" VARCHAR(16) NOT NULL DEFAULT 'restaurant',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_advertisements_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "food_advertisements_status_startDate_endDate_idx" ON "food_advertisements"("status", "startDate", "endDate");
CREATE INDEX "food_advertisements_restaurantId_idx" ON "food_advertisements"("restaurantId");
ALTER TABLE "food_advertisements" ADD CONSTRAINT "food_advertisements_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "food_reels" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "restaurantId" VARCHAR(24) NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "videoUrl" TEXT NOT NULL,
    "thumbnail" TEXT NOT NULL DEFAULT '',
    "alwaysVisible" BOOLEAN NOT NULL DEFAULT true,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "views" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "restaurantVisits" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_reels_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "food_reels_isActive_sortOrder_idx" ON "food_reels"("isActive", "sortOrder");
CREATE INDEX "food_reels_restaurantId_idx" ON "food_reels"("restaurantId");
ALTER TABLE "food_reels" ADD CONSTRAINT "food_reels_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
