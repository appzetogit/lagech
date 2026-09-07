-- CreateEnum
CREATE TYPE "EarningAddonCriteria" AS ENUM ('orders', 'online_hours');

-- AlterTable
ALTER TABLE "food_earning_addons" ADD COLUMN     "criteria" "EarningAddonCriteria" NOT NULL DEFAULT 'orders',
ADD COLUMN     "requiredOnlineMinutes" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "requiredOrders" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "food_earning_addon_history" ADD COLUMN     "onlineMinutesCompleted" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "onlineMinutesRequired" INTEGER NOT NULL DEFAULT 0;

