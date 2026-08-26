-- Rebrand: Switcheats -> Minto Foods.
--
-- companyName is the name the whole frontend renders: useCompanyName() reads it
-- from business settings and every hardcoded string was only ever a fallback for
-- before those settings load. Changing the column default is therefore the part
-- that actually rebrands the running product; the source strings just stop
-- flashing the wrong name on first paint.
--
-- Only the DEFAULT moves. Any row already written keeps whatever it holds --
-- an operator who set a name deliberately should not have it overwritten by a
-- deploy.
ALTER TABLE "food_business_settings" ALTER COLUMN "companyName" SET DEFAULT 'Minto Foods';
ALTER TABLE "food_business_settings" ALTER COLUMN "email" SET DEFAULT 'admin@mintofood.com';

-- The singleton settings row, if it exists and still carries the old default,
-- is the one case where rewriting is right: nobody chose that value.
UPDATE "food_business_settings" SET "companyName" = 'Minto Foods' WHERE "companyName" = 'Switcheats';
UPDATE "food_business_settings" SET "email" = 'admin@mintofood.com' WHERE "email" = 'admin@switcheats.com';
