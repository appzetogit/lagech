/**
 * Admin API for the Transaction / Order report and the Restaurant-wise report.
 * Exports are produced server-side over the whole filtered set and come back
 * as a file.
 */
import apiClient from "./axios.js"

const admin = { contextModule: "admin" }
const A = "/food/admin/reports"

const filenameFrom = (res, fallback) => {
  const header = res?.headers?.["content-disposition"] || ""
  const match = header.match(/filename="?([^";]+)"?/i)
  return match ? match[1] : fallback
}

/** Saves a blob response as a download. */
export function saveDownload(res, fallback) {
  const url = URL.createObjectURL(res.data)
  const a = document.createElement("a")
  a.href = url
  a.download = filenameFrom(res, fallback)
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const adminOrderReportsAPI = {
  getOrderMoneyReport: (params = {}) => apiClient.get(`${A}/order-money`, { params, ...admin }),
  exportOrderMoneyReport: (params = {}) =>
    apiClient.get(`${A}/order-money/export`, { params, responseType: "blob", timeout: 300000, ...admin }),
  getRestaurantWiseReport: (params = {}) => apiClient.get(`${A}/restaurant-wise`, { params, ...admin }),
  exportRestaurantWiseReport: (params = {}) =>
    apiClient.get(`${A}/restaurant-wise/export`, { params, responseType: "blob", timeout: 300000, ...admin }),
}
