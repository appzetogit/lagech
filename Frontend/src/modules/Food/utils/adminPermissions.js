import { canAdminAccess, isSuperAdmin } from "@food/utils/adminRbac"

/**
 * Access checks for the two admin areas that are not ordinary CRUD pages.
 *
 * These used to be gated on a single hardcoded email address left over from the
 * original build. That was wrong in both directions: it was a backdoor for
 * whoever held that address, and since the account does not exist in this
 * deployment it also meant the SUPER POWERS section was invisible to everyone,
 * super admins included. Both now go through the same permission model as every
 * other section.
 */

/** Feature settings sit under system_settings, like business setup and power scanning. */
export function canAccessFeatureSettings(adminUser) {
  if (isSuperAdmin(adminUser)) return true
  return canAdminAccess(adminUser, "system_settings", "view")
}

/**
 * Super powers are destructive/global tools and are not delegable: super admin
 * only, never granted through a role.
 */
export function canAccessSuperPowers(adminUser) {
  return isSuperAdmin(adminUser)
}
