/**
 * Admin API for 3rd Party settings (SMS, mail, maps, reCAPTCHA, social
 * logins, storage, payment). Super admin only. Secrets are never returned:
 * the backend sends a mask and hasValue, and an empty secret on save keeps
 * the saved one.
 */
import apiClient from "./axios.js"

const admin = { contextModule: "admin" }
const B = "/food/admin/system-settings/third-party"

export const adminThirdPartyAPI = {
  getAll: () => apiClient.get(B, admin),
  getArea: (area) => apiClient.get(`${B}/${area}`, admin),
  saveArea: (area, { values = {}, clear = [] } = {}) => apiClient.put(`${B}/${area}`, { values, clear }, admin),
  importArea: (area, overwrite = false) => apiClient.post(`${B}/${area}/import`, { overwrite }, admin),
  importAll: (overwrite = false) => apiClient.post(`${B}/import`, { overwrite }, admin),
  testSms: (phone) => apiClient.post(`${B}/sms/test`, { phone }, admin),
  testMail: (email) => apiClient.post(`${B}/mail/test`, { email }, admin),
  getAudit: (limit = 30) => apiClient.get(`${B}/audit`, { params: { limit }, ...admin }),
}
