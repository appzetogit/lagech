-- Restaurant staff, like the old store panel's Employee Role + Employees.
-- A role is a name and the panel sections (permission keys) staff on it may
-- use; an employee signs in with email or phone + password and gets the
-- restaurant's token limited to their role. Both go with the restaurant.
-- The employee -> role key is NO ACTION (checked at the end of the statement),
-- so deleting a restaurant cascades through both tables, while deleting a role
-- someone is still on fails.
CREATE TABLE "food_restaurant_roles" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "restaurantId" VARCHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_restaurant_roles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "food_restaurant_roles_restaurantId_name_key"
    ON "food_restaurant_roles"("restaurantId", "name");

ALTER TABLE "food_restaurant_roles"
    ADD CONSTRAINT "food_restaurant_roles_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "food_restaurant_employees" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "restaurantId" VARCHAR(24) NOT NULL,
    "roleId" VARCHAR(24) NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL,
    "phone" VARCHAR(20) NOT NULL DEFAULT '',
    "phoneLast10" VARCHAR(10) NOT NULL DEFAULT '',
    "image" TEXT NOT NULL DEFAULT '',
    "password" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_restaurant_employees_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "food_restaurant_employees_email_key" ON "food_restaurant_employees"("email");
CREATE INDEX "food_restaurant_employees_restaurantId_idx" ON "food_restaurant_employees"("restaurantId");
CREATE INDEX "food_restaurant_employees_roleId_idx" ON "food_restaurant_employees"("roleId");
CREATE INDEX "food_restaurant_employees_phoneLast10_idx" ON "food_restaurant_employees"("phoneLast10");

ALTER TABLE "food_restaurant_employees"
    ADD CONSTRAINT "food_restaurant_employees_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "food_restaurant_employees"
    ADD CONSTRAINT "food_restaurant_employees_roleId_fkey"
    FOREIGN KEY ("roleId") REFERENCES "food_restaurant_roles"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
