/**
 * Admin API for the customer wallet (add fund, report, top-up bonus), loyalty
 * points, the subscribed mail list and the user overview.
 */
import apiClient from "./axios.js"

const admin = { contextModule: "admin" }

/** A fresh id per form submit, so a double click or a retry credits once. */
export const newRequestId = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`)

export const customerExtrasAPI = {
  searchCustomers: (search, limit = 20) =>
    apiClient.get("/food/admin/customer-wallet/customers", { params: { search, limit }, ...admin }),
  addFund: (body) => apiClient.post("/food/admin/customer-wallet/add-fund", body, admin),
  getWalletTransactions: (params = {}) =>
    apiClient.get("/food/admin/customer-wallet/transactions", { params, ...admin }),

  getWalletBonuses: (params = {}) => apiClient.get("/food/admin/customer-wallet/bonuses", { params, ...admin }),
  createWalletBonus: (body) => apiClient.post("/food/admin/customer-wallet/bonuses", body, admin),
  updateWalletBonus: (id, body) => apiClient.patch(`/food/admin/customer-wallet/bonuses/${String(id)}`, body, admin),
  deleteWalletBonus: (id) => apiClient.delete(`/food/admin/customer-wallet/bonuses/${String(id)}`, admin),

  getLoyaltySettings: () => apiClient.get("/food/admin/loyalty-points/settings", admin),
  saveLoyaltySettings: (body) => apiClient.put("/food/admin/loyalty-points/settings", body, admin),
  getLoyaltyTransactions: (params = {}) =>
    apiClient.get("/food/admin/loyalty-points/transactions", { params, ...admin }),

  getSubscribers: (params = {}) => apiClient.get("/food/admin/newsletter-subscribers", { params, ...admin }),
  exportSubscribers: (params = {}) =>
    apiClient.get("/food/admin/newsletter-subscribers/export", { params, responseType: "blob", ...admin }),
  deleteSubscriber: (id) => apiClient.delete(`/food/admin/newsletter-subscribers/${String(id)}`, admin),

  getUserOverview: () => apiClient.get("/food/admin/user-overview", admin),
}

/** The `data` of a sendResponse() body. */
export const dataOf = (res) => res?.data?.data || {}

/** The server's message, or a fallback. */
export const errorMessage = (err, fallback) => err?.response?.data?.message || fallback

export const formatMoney = (value) =>
  `₹${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const formatDateTime = (value) =>
  value
    ? new Date(value).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : ""

export const formatDate = (value) =>
  value ? new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : ""

/** A Date as 'YYYY-MM-DD' in Indian time, for date inputs. */
export const istDateInput = (value) =>
  value ? new Date(new Date(value).getTime() + 330 * 60000).toISOString().slice(0, 10) : ""
