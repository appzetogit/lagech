-- Order issue reports reuse the customer support tickets: the reason picked and the photos.
ALTER TABLE "food_support_tickets" ADD COLUMN "reasonId" VARCHAR(24) NOT NULL DEFAULT '',
ADD COLUMN "images" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Customer refund requests.
CREATE TYPE "FoodRefundRequestStatus" AS ENUM ('pending', 'approved', 'refunded', 'rejected');

CREATE TABLE "food_refund_requests" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "orderId" VARCHAR(24) NOT NULL,
    "userId" VARCHAR(24) NOT NULL,
    "restaurantId" VARCHAR(24) NOT NULL,
    "reasonId" VARCHAR(24) NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requestedAmount" DECIMAL(14,2) NOT NULL,
    "status" "FoodRefundRequestStatus" NOT NULL DEFAULT 'pending',
    "refundedAmount" DECIMAL(14,2),
    "refundMethod" VARCHAR(16) NOT NULL DEFAULT '',
    "adminNote" TEXT NOT NULL DEFAULT '',
    "failureReason" TEXT NOT NULL DEFAULT '',
    "decidedById" VARCHAR(24),
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_refund_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "food_refund_requests_status_createdAt_idx" ON "food_refund_requests"("status", "createdAt" DESC);
CREATE INDEX "food_refund_requests_userId_createdAt_idx" ON "food_refund_requests"("userId", "createdAt" DESC);
CREATE INDEX "food_refund_requests_orderId_idx" ON "food_refund_requests"("orderId");
CREATE INDEX "food_refund_requests_restaurantId_createdAt_idx" ON "food_refund_requests"("restaurantId", "createdAt" DESC);

ALTER TABLE "food_refund_requests" ADD CONSTRAINT "food_refund_requests_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "food_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "food_refund_requests" ADD CONSTRAINT "food_refund_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "food_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
