/**
 * Central API client for backend (auth and future APIs).
 * - baseURL from VITE_API_BASE_URL (e.g. http://localhost:5000/api/v1)
 * - When baseURL ends with /api/v1, request paths must NOT include /v1 (use /food/..., /auth/...)
 * - Attaches Bearer token (user or admin based on request URL)
 * - On 401: attempts refresh, retries once; on refresh failure logs out
 */

import axios from "axios";
import { toast } from "sonner";

// Prefer explicit env. If not set, use same-origin (works with a Vite proxy).
// This avoids hardcoding ports like 5000 that may conflict with local setups.
const baseURL =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_API_BASE_URL
    ? String(import.meta.env.VITE_API_BASE_URL).replace(/\/$/, "")
    : "";

const apiClient = axios.create({
  baseURL: baseURL || undefined,
  timeout: 30000,
  headers: { "Content-Type": "application/json" },
});

const ADMIN_PERMISSION_PATH_MAP = [
  { prefix: "/food/admin/sub-admins", section: "sub_admin_management" },
  { prefix: "/food/admin/customers", section: "customer_management" },
  { prefix: "/food/admin/support-tickets", section: "customer_management" },
  // Live chat rides on the same section as the rest of support. It is not
  // under /food/admin, so it needs saying explicitly.
  { prefix: "/food/chat", section: "customer_management" },
  { prefix: "/food/admin/restaurants", section: "restaurant_management" },
  { prefix: "/food/admin/restaurant-settings", section: "restaurant_management" },
  { prefix: "/food/admin/restaurant-subscription-settings", section: "restaurant_management" },
  { prefix: "/food/admin/restaurant-subscriptions", section: "restaurant_management" },
  { prefix: "/food/admin/zones", section: "restaurant_management" },
  { prefix: "/food/admin/categories", section: "food_management" },
  { prefix: "/food/admin/addons", section: "food_management" },
  { prefix: "/food/admin/foods", section: "food_management" },
  { prefix: "/food/admin/offers", section: "promotions_management" },
  { prefix: "/food/admin/orders", section: "order_management" },
  { prefix: "/food/admin/order-detect-delivery", section: "order_management" },
  { prefix: "/food/admin/sidebar-badges", section: "dashboard" },
  { prefix: "/food/admin/dashboard-stats", section: "dashboard" },
  { prefix: "/food/admin/referral-settings", section: "referral_rewards" },
  { prefix: "/food/admin/delivery", section: "delivery_management" },
  { prefix: "/food/admin/fee-settings", section: "delivery_management" },
  { prefix: "/food/admin/delivery-cash-limit", section: "delivery_management" },
  { prefix: "/food/admin/cash-limit-settlements", section: "delivery_management" },
  { prefix: "/food/admin/cash-limit-settlement", section: "delivery_management" },
  { prefix: "/food/admin/withdrawals", section: "transaction_management" },
  { prefix: "/food/admin/reports", section: "report_management" },
  { prefix: "/food/admin/feedback-experiences", section: "report_management" },
  { prefix: "/food/hero-banners", section: "banner_management" },
  { prefix: "/food/admin/contact-messages", section: "support_management" },
  { prefix: "/food/admin/safety-emergency-reports", section: "support_management" },
  { prefix: "/food/admin/feature-settings", section: "system_settings" },
  { prefix: "/food/admin/business-settings", section: "system_settings" },
  { prefix: "/food/admin/power-scanning", section: "system_settings" },
  { prefix: "/food/admin/notifications", section: "system_settings" },
  { prefix: "/food/admin/pages-social-media", section: "pages_social_media" },
];

const normalizePath = (url) => {
  const raw = String(url || "");
  const noQuery = raw.split("?")[0].split("#")[0];
  if (noQuery.startsWith("http://") || noQuery.startsWith("https://")) {
    try {
      const parsed = new URL(noQuery);
      return parsed.pathname || "/";
    } catch {
      return noQuery;
    }
  }
  return noQuery.startsWith("/") ? noQuery : `/${noQuery}`;
};

const resolveAdminSectionByApiPath = (url, method = "GET") => {
  const path = normalizePath(url).toLowerCase();
  const normalizedMethod = String(method || "GET").toUpperCase();
  if (path === "/food/admin/zones" && normalizedMethod === "GET") {
    return "restaurant_management";
  }
  const match = ADMIN_PERMISSION_PATH_MAP.find((item) => path.startsWith(item.prefix));
  return match?.section || null;
};

const resolveActionByMethod = (method) => {
  const normalized = String(method || "get").toUpperCase();
  if (normalized === "GET") return "view";
  if (normalized === "POST") return "create";
  if (normalized === "DELETE") return "delete";
  if (normalized === "PATCH" || normalized === "PUT") return "edit";
  return "view";
};

const getAdminUser = () => {
  try {
    const raw = localStorage.getItem("admin_user");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const isAdminAllowedForAction = (section, action) => {
  const adminUser = getAdminUser();
  const adminType = String(adminUser?.adminType || "").trim().toLowerCase();
  if (adminType === "super_admin") return true;
  if (!section) return false;
  const permissions = adminUser?.effectivePermissions || adminUser?.permissions || {};
  const actions = Array.isArray(permissions?.[section]) ? permissions[section] : [];
  return actions.includes(action);
};

const hasAdminAction = (adminUser, section, action = "view") => {
  const permissions = adminUser?.effectivePermissions || adminUser?.permissions || {};
  const actions = Array.isArray(permissions?.[section]) ? permissions[section] : [];
  return actions.includes(action);
};

function getModuleFromUrl(url = "") {
  const u = typeof url === "string" ? url : (url?.url || "");
  if (!u) return "user";
  
  const normalized = u.toLowerCase();
  
  // Admin detection
  if (
    normalized.includes("/admin/") ||
    normalized.includes("/food/admin/") ||
    normalized.includes("/food/auth/admin") ||
    normalized.includes("/auth/admin") ||
    normalized.includes("admin/login")
  ) return "admin";

  // Landing/banner management lives at /food/hero-banners and /food/top-banners rather
  // than under /food/admin, so it fell through to "user" and was sent with no token at
  // all (admin login only writes admin_accessToken). Anything here that is NOT a
  // /public read is an admin operation and must carry the admin token.
  if (
    (normalized.includes("/food/hero-banners") || normalized.includes("/food/top-banners")) &&
    !normalized.includes("/public")
  ) return "admin";
  
  // Delivery detection - Catch all delivery-specific functional and auth routes
  if (
    normalized.includes("/food/delivery") || 
    normalized.includes("/auth/delivery") || 
    normalized.includes("/delivery/")
  ) return "delivery";
  
  // Restaurant detection - Catch all restaurant-specific functional and auth routes
  if (
    normalized.includes("/food/restaurant/") || 
    normalized.includes("/auth/restaurant") || 
    normalized.includes("/restaurant/")
  ) {
    // Exception: /food/restaurants (plural) is usually a public user app route
    if (normalized.includes("/food/restaurants") && !normalized.includes("/food/restaurant/")) {
       return "user";
    }
    return "restaurant";
  }
  
  return "user";
}

function getModuleFromConfig(config) {
  if (config?.contextModule) return config.contextModule;
  return getModuleFromUrl(config?.url);
}

function getAccessToken(config) {
  const module = getModuleFromConfig(config);
  const key = `${module}_accessToken`;
  try {
    // 1. Try module-specific token first
    const moduleToken = localStorage.getItem(key);
    if (moduleToken) return moduleToken;
    
    // 2. Fallback to generic token only for non-admin modules
    if (module !== "admin") {
      return localStorage.getItem("accessToken") || null;
    }
    return null;
  } catch {
    return null;
  }
}

function getRefreshToken(module) {
  try {
    // 1. Try module-specific refresh token
    const moduleRefreshToken = localStorage.getItem(`${module}_refreshToken`);
    if (moduleRefreshToken) return moduleRefreshToken;
    
    // 2. Fallback to generic refresh token only for non-admin modules
    if (module !== "admin") {
      return localStorage.getItem("refreshToken") || null;
    }
    return null;
  } catch {
    return null;
  }
}

function clearModuleAuth(module) {
  try {
    localStorage.removeItem(`${module}_accessToken`);
    localStorage.removeItem(`${module}_refreshToken`);
    localStorage.removeItem(`${module}_authenticated`);
    localStorage.removeItem(`${module}_user`);
  } catch (_) {}
}

let isRefreshing = false;
let refreshSubscribers = [];

function subscribeToRefresh(cb) {
  refreshSubscribers.push(cb);
}

function onRefreshed(newToken, module) {
  refreshSubscribers.forEach((cb) => cb(newToken, module));
  refreshSubscribers = [];
}

function onRefreshFailed(module) {
  clearModuleAuth(module);
  // Fail any queued requests that were waiting for this refresh
  refreshSubscribers.forEach((cb) => cb(null, module));
  refreshSubscribers = [];
  
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("authRefreshFailed", { detail: { module } }));
  }
}

/**
 * How long before expiry a token is treated as already spent.
 *
 * Access tokens last about fifteen minutes. Waiting for one to actually
 * expire means the next request 401s, the interceptor below refreshes, and
 * the request is replayed -- it works, but the browser has already logged the
 * failed attempt, so the console fills with 401s that nothing went wrong for.
 * A minute is long enough to cover a slow refresh and a slow request behind
 * it, and short enough that it does not refresh on every call.
 */
const REFRESH_LEEWAY_SECONDS = 60;

/**
 * When a JWT says it expires, in epoch seconds.
 *
 * Read rather than trusted: a token that cannot be parsed returns null and is
 * simply sent as-is, which lands back on the 401 path. Nothing here decides
 * whether a token is valid -- only whether it is worth refreshing early.
 */
function expiryOf(token) {
  try {
    const payload = String(token || '').split('.')[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const exp = Number(JSON.parse(json)?.exp);
    return Number.isFinite(exp) ? exp : null;
  } catch (_) {
    return null;
  }
}

function isExpiringSoon(token) {
  const exp = expiryOf(token);
  if (exp === null) return false;
  return exp - Date.now() / 1000 <= REFRESH_LEEWAY_SECONDS;
}

/**
 * One refresh per module at a time.
 *
 * Every request that notices the token is nearly out waits on the same
 * promise. Without that, a screen firing six calls at once would send six
 * refreshes, five of them presenting a refresh token the first has already
 * rotated -- which is what "Invalid refresh token" in the logs is.
 */
const pendingRefresh = new Map();

function refreshModuleToken(module) {
  if (pendingRefresh.has(module)) return pendingRefresh.get(module);

  const refreshToken = getRefreshToken(module);
  if (!refreshToken) return Promise.resolve(null);

  const run = (async () => {
    // Relative when there is no baseURL, so the dev proxy works too, and
    // plain axios so this does not re-enter the interceptors.
    const refreshUrl = baseURL
      ? `${baseURL}/food/auth/refresh-token`
      : '/api/v1/food/auth/refresh-token';
    const { data } = await axios.post(refreshUrl, { refreshToken }, { timeout: 10000 });
    const newAccessToken = data?.data?.accessToken || data?.accessToken;
    if (!newAccessToken) throw new Error("Refresh returned no token");

    try {
      localStorage.setItem(`${module}_accessToken`, newAccessToken);
      window.dispatchEvent(new CustomEvent('authRefreshed', {
        detail: { module, token: newAccessToken },
      }));
    } catch (_) {}

    onRefreshed(newAccessToken, module);
    return newAccessToken;
  })()
    .catch(() => {
      // Only the reactive path signs the person out. Here the old token may
      // still have seconds left on it, and one failed refresh -- a flaky
      // network, a rotation race -- should not end the session.
      return null;
    })
    .finally(() => {
      pendingRefresh.delete(module);
    });

  pendingRefresh.set(module, run);
  return run;
}

apiClient.interceptors.request.use(
  async (config) => {
    config.contextModule = getModuleFromConfig(config);

    // Client-side RBAC safety net for sub-admins across all admin APIs.
    if (config.contextModule === "admin") {
      const path = normalizePath(config?.url);
      const normalizedPath = String(path || "").toLowerCase();
      const isPublicAdminEndpoint =
        normalizedPath.startsWith("/food/admin/") &&
        normalizedPath.endsWith("/public");
      const isAuthEndpoint =
        path.includes("/food/auth/admin/login") ||
        path.includes("/food/auth/me") ||
        path.includes("/food/auth/refresh-token") ||
        path.includes("/food/auth/logout");

      if (!isAuthEndpoint && !isPublicAdminEndpoint) {
        const action = resolveActionByMethod(config?.method);
        const isRestaurantListRead = normalizedPath === "/food/admin/restaurants" && action === "view";
        const isRestaurantDetailRead =
          /^\/food\/admin\/restaurants\/[^/]+$/.test(normalizedPath) && action === "view";
        const isRestaurantAnalyticsRead =
          /^\/food\/admin\/restaurants\/[^/]+\/analytics$/.test(normalizedPath) && action === "view";
        const isOrdersRead = normalizedPath === "/food/admin/orders" && action === "view";
        const isCustomersRead = normalizedPath === "/food/admin/customers" && action === "view";
        const isZonesRead = normalizedPath === "/food/admin/zones" && action === "view";
        const isZoneDetailRead =
          /^\/food\/admin\/zones\/[^/]+$/.test(normalizedPath) && action === "view";

        // POS dropdown needs restaurant list read access.
        if (isRestaurantListRead || isRestaurantDetailRead || isRestaurantAnalyticsRead) {
          const adminUser = getAdminUser();
          const adminType = String(adminUser?.adminType || "").trim().toLowerCase();
          const isAllowed =
            adminType === "super_admin" ||
            hasAdminAction(adminUser, "restaurant_management", "view") ||
            hasAdminAction(adminUser, "point_of_sale", "view") ||
            hasAdminAction(adminUser, "report_management", "view") ||
            hasAdminAction(adminUser, "banner_management", "view");
          if (!isAllowed) {
            const error = new Error("Insufficient permissions for this action");
            error.response = {
              status: 403,
              data: { message: "Insufficient permissions for this action" },
            };
            return Promise.reject(error);
          }
        } else if (isZonesRead || isZoneDetailRead) {
          const adminUser = getAdminUser();
          const adminType = String(adminUser?.adminType || "").trim().toLowerCase();
          const isAllowed =
            adminType === "super_admin" ||
            hasAdminAction(adminUser, "dashboard", "view") ||
            hasAdminAction(adminUser, "restaurant_management", "view") ||
            hasAdminAction(adminUser, "point_of_sale", "view") ||
            hasAdminAction(adminUser, "food_management", "view") ||
            hasAdminAction(adminUser, "delivery_management", "view") ||
            hasAdminAction(adminUser, "report_management", "view");
          if (!isAllowed) {
            const error = new Error("Insufficient permissions for this action");
            error.response = {
              status: 403,
              data: { message: "Insufficient permissions for this action" },
            };
            return Promise.reject(error);
          }
        } else if (isOrdersRead) {
          const adminUser = getAdminUser();
          const adminType = String(adminUser?.adminType || "").trim().toLowerCase();
          const isAllowed =
            adminType === "super_admin" ||
            hasAdminAction(adminUser, "order_management", "view") ||
            hasAdminAction(adminUser, "report_management", "view");
          if (!isAllowed) {
            const error = new Error("Insufficient permissions for this action");
            error.response = {
              status: 403,
              data: { message: "Insufficient permissions for this action" },
            };
            return Promise.reject(error);
          }
        } else if (isCustomersRead) {
          const adminUser = getAdminUser();
          const adminType = String(adminUser?.adminType || "").trim().toLowerCase();
          const isAllowed =
            adminType === "super_admin" ||
            hasAdminAction(adminUser, "customer_management", "view") ||
            hasAdminAction(adminUser, "report_management", "view");
          if (!isAllowed) {
            const error = new Error("Insufficient permissions for this action");
            error.response = {
              status: 403,
              data: { message: "Insufficient permissions for this action" },
            };
            return Promise.reject(error);
          }
        } else {
          const section = resolveAdminSectionByApiPath(path, config?.method);
          if (!isAdminAllowedForAction(section, action)) {
            const error = new Error("Insufficient permissions for this action");
            error.response = {
              status: 403,
              data: { message: "Insufficient permissions for this action" },
            };
            return Promise.reject(error);
          }
        }
      }
    }

    // If sending FormData, let the browser set proper multipart boundary.
    if (config.data instanceof FormData) {
      if (config.headers && config.headers["Content-Type"]) {
        delete config.headers["Content-Type"];
      }
    }

    let token = getAccessToken(config);

    // Renew just before expiry rather than after it. The refresh call itself
    // is exempt: it authenticates with the refresh token, and waiting on a
    // refresh to send a refresh would deadlock.
    const isRefreshCall = String(config.url || '').includes('/auth/refresh-token');
    if (token && !isRefreshCall && isExpiringSoon(token)) {
      const fresh = await refreshModuleToken(config.contextModule);
      // A failed refresh leaves the old token in place: it may still have a
      // few seconds on it, and if it does not, the 401 path below handles it.
      if (fresh) token = fresh;
    }

    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (err) => Promise.reject(err)
);

/**
 * A message worth showing a person, from whatever shape the failure arrived in.
 *
 * Roughly two thirds of the catch blocks in the admin panel only log, so a
 * failed save used to leave the screen looking as though nothing had happened.
 * Surfacing it here covers every call at once rather than editing 200 of them.
 */
const readableApiError = (err) => {
  if (err?.rateLimitMessage) return err.rateLimitMessage;

  const data = err?.response?.data;
  const fromBody =
    data?.message ||
    data?.error ||
    (Array.isArray(data?.errors) ? data.errors[0]?.message || data.errors[0] : null);
  if (typeof fromBody === "string" && fromBody.trim()) return fromBody.trim();

  const status = err?.response?.status;
  if (status === 401) return "Your session has expired. Please sign in again.";
  if (status === 403) return "You do not have permission to do that.";
  if (status === 404) return "That item no longer exists.";
  if (status === 413) return "That file is too large.";
  if (status >= 500) return "The server had a problem completing that. Please try again.";

  if (err?.code === "ECONNABORTED") return "That request timed out. Please try again.";
  if (err?.message === "Network Error") return "Cannot reach the server. Check your connection.";
  return "Something went wrong. Please try again.";
};

/**
 * One toast per distinct message. Call sites that already show their own error
 * pass the same text, and sonner treats a repeated id as the same toast rather
 * than stacking a second one, so nothing is announced twice.
 */
const notifyApiError = (err) => {
  if (err?.config?.suppressErrorToast) return;
  const message = readableApiError(err);
  err.userMessage = message;
  const id = `api-error-${message.slice(0, 60).replace(/\s+/g, "-").toLowerCase()}`;
  try {
    toast.error(message, { id, duration: 5000 });
  } catch (_) {
    // Toasts are a nicety; never let one break the request path.
  }
};

apiClient.interceptors.response.use(
  (response) => response,
  async (err) => {
    const original = err?.config;
    if (err?.response?.status === 429) {
      const retryAfter = err?.response?.data?.retryAfterSeconds;
      const message =
        err?.response?.data?.message ||
        "Too many requests. Please wait and try again.";
      err.rateLimitMessage = retryAfter
        ? `${message} (retry in ~${retryAfter}s)`
        : message;
      notifyApiError(err);
      return Promise.reject(err);
    }
    if (err?.response?.status !== 401 || !original || original._retry) {
      // A 401 that has already been retried means the refresh did not help, so
      // it belongs here too -- the person needs to know they are signed out.
      notifyApiError(err);
      return Promise.reject(err);
    }
    const module = original.contextModule || getModuleFromUrl(original.url);
    const refreshToken = getRefreshToken(module);
    if (!refreshToken) {
      clearModuleAuth(module);
      notifyApiError(err);
      return Promise.reject(err);
    }

    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        subscribeToRefresh((newToken) => {
          if (newToken) {
            original.headers.Authorization = `Bearer ${newToken}`;
            resolve(apiClient(original));
          } else {
            reject(err);
          }
        });
      });
    }

    original._retry = true;

    // A refresh may already be in flight from the request interceptor; join
    // it rather than starting a second one against a token it has rotated.
    if (pendingRefresh.has(module)) {
      const joined = await pendingRefresh.get(module);
      if (joined) {
        original.headers.Authorization = `Bearer ${joined}`;
        return apiClient(original);
      }
    }

    isRefreshing = true;

    try {
      // Use relative URL so this works both with an explicit baseURL and with a dev proxy.
      // Use plain axios to avoid interceptor recursion.
      const refreshUrl = baseURL ? `${baseURL}/food/auth/refresh-token` : "/api/v1/food/auth/refresh-token";
      const { data } = await axios.post(refreshUrl, { refreshToken }, { timeout: 10000 });
      const newAccessToken = data?.data?.accessToken || data?.accessToken;
      if (newAccessToken) {
        try {
          localStorage.setItem(`${module}_accessToken`, newAccessToken);
          // Dispatch a custom event specifically for the module that refreshed
          window.dispatchEvent(new CustomEvent("authRefreshed", { 
            detail: { module, token: newAccessToken } 
          }));
        } catch (_) {}
        onRefreshed(newAccessToken, module);
        original.headers.Authorization = `Bearer ${newAccessToken}`;
        return apiClient(original);
      }
    } catch (_) {
      onRefreshFailed(module);
      return Promise.reject(err);
    } finally {
      isRefreshing = false;
    }

    onRefreshFailed(module);
    return Promise.reject(err);
  }
);

export default apiClient;
