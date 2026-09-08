-- AlterEnum
ALTER TYPE "CustomerScope" ADD VALUE 'specific';

-- AlterTable
ALTER TABLE "food_offers" ADD COLUMN     "customerIds" TEXT[];

