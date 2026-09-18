-- Reusable sub-admin roles: a named set of sidebar pages and an access level.
CREATE TABLE "food_admin_roles" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "name" TEXT NOT NULL,
    "menuPaths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "accessLevel" VARCHAR(8) NOT NULL DEFAULT 'full',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_admin_roles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "food_admin_roles_name_key" ON "food_admin_roles"("name");

ALTER TABLE "food_admins" ADD COLUMN "roleId" VARCHAR(24);
CREATE INDEX "food_admins_roleId_idx" ON "food_admins"("roleId");
ALTER TABLE "food_admins" ADD CONSTRAINT "food_admins_roleId_fkey"
    FOREIGN KEY ("roleId") REFERENCES "food_admin_roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
