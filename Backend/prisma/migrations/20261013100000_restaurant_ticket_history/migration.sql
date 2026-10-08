-- Restaurant support tickets outlive the restaurant: deleting a restaurant
-- account detaches its tickets (restaurantId -> NULL) instead of erasing them,
-- and restaurantName keeps who raised them. respondedAt records when the admin
-- answered, for the restaurant app.
ALTER TABLE "food_restaurant_support_tickets"
    ALTER COLUMN "restaurantId" DROP NOT NULL,
    ADD COLUMN "restaurantName" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "respondedAt" TIMESTAMP(3);

ALTER TABLE "food_restaurant_support_tickets" DROP CONSTRAINT "food_restaurant_support_tickets_restaurantId_fkey";
ALTER TABLE "food_restaurant_support_tickets" ADD CONSTRAINT "food_restaurant_support_tickets_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "food_restaurant_support_tickets" t
   SET "restaurantName" = r."restaurantName"
  FROM "food_restaurants" r
 WHERE r."id" = t."restaurantId";

UPDATE "food_restaurant_support_tickets"
   SET "respondedAt" = "updatedAt"
 WHERE "adminResponse" <> '';
