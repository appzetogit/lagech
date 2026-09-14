-- Rebrand: Minto Foods -> Lagech.
--
-- Same shape as the Switcheats -> Minto Foods move before it, and for the same
-- reason: companyName is the name the whole frontend renders, via
-- useCompanyName() reading business settings. The hardcoded source strings are
-- only the fallback shown before those settings load, so changing them alone
-- rebrands the first paint and nothing else.
--
-- Only the DEFAULT moves. A row already written keeps what it holds -- an
-- operator who set a name deliberately should not lose it to a deploy.
ALTER TABLE "food_business_settings" ALTER COLUMN "companyName" SET DEFAULT 'Lagech';
ALTER TABLE "food_business_settings" ALTER COLUMN "email" SET DEFAULT 'admin@lagech.in';

-- The singleton settings row, if it still carries the previous default, is the
-- one case where rewriting is right: nobody chose that value.
UPDATE "food_business_settings" SET "companyName" = 'Lagech' WHERE "companyName" = 'Minto Foods';
UPDATE "food_business_settings" SET "email" = 'admin@lagech.in' WHERE "email" = 'admin@mintofood.com';
