-- AlterEnum
ALTER TYPE "BroadcastTargetType" ADD VALUE 'LAPSED';

-- AlterTable
ALTER TABLE "food_notification_broadcasts" ADD COLUMN     "couponCode" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "couponId" VARCHAR(24);

