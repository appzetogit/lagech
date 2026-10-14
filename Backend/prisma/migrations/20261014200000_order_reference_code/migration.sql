-- The admin's payment reference code on an order (Order Details "Reference
-- Code", as on the old 6amMart panel): e.g. the UPI / bank transaction ref of
-- a cash or offline payment. Nullable; existing orders have none.
ALTER TABLE "food_orders" ADD COLUMN "referenceCode" VARCHAR(100);
