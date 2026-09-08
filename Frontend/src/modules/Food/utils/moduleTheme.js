/**
 * Which app a path belongs to, and therefore which theme it gets.
 *
 * One copy on purpose. There were two -- one in the config provider and one in
 * the router -- and only the first grew an `/admin` branch. Both run off
 * `location.pathname`, so on every admin navigation they raced and whichever
 * landed last decided the colour. That is the intermittent pink sidebar:
 * applyModulePowerScanning rewrites every bg-teal/emerald/green class with
 * !important, the admin sidebar is bg-teal-800, and the customer app is pink.
 *
 * Kept in a file of its own, with no imports, so it can be tested without
 * pulling the API client in behind it.
 */
export const resolveModuleFromPath = (pathname = "") => {
  const path = String(pathname || "");
  if (path.startsWith("/food/restaurant")) return "restaurant";
  if (path.startsWith("/food/delivery")) return "delivery";
  // Admin is internal tooling with a fixed brand, not a themeable storefront.
  if (path === "/admin" || path.startsWith("/admin/")) return "admin";
  return "user";
};
