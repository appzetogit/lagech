-- Offline payment (bank transfer, UPI, ...) as an order payment method.
ALTER TYPE "OrderPaymentMethod" ADD VALUE IF NOT EXISTS 'offline';

-- What the customer paid with and filled in, and the admin's verification.
ALTER TABLE "food_orders" ADD COLUMN "offlinePayment" JSONB;
