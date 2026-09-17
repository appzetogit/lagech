-- Admin on/off switches for GST, GST on the delivery fee, and the platform fee.
-- Null on a zone row inherits the default row; null on the default row is off.
ALTER TABLE "food_fee_settings"
    ADD COLUMN "gstEnabled" BOOLEAN,
    ADD COLUMN "deliveryFeeGstEnabled" BOOLEAN,
    ADD COLUMN "platformFeeEnabled" BOOLEAN;
