/**
 * Admin API for withdrawal methods, restaurant payments, the money reports,
 * email templates, system settings, social media and the gallery.
 */
import apiClient from "./axios.js"

const admin = { contextModule: "admin" }
const A = "/food/admin"

export const adminSystemExtrasAPI = {
  // Withdrawal methods
  getWithdrawalMethods: (params = {}) => apiClient.get(`${A}/withdrawals/methods`, { params, ...admin }),
  createWithdrawalMethod: (body) => apiClient.post(`${A}/withdrawals/methods`, body, admin),
  updateWithdrawalMethod: (id, body) => apiClient.patch(`${A}/withdrawals/methods/${id}`, body, admin),
  deleteWithdrawalMethod: (id) => apiClient.delete(`${A}/withdrawals/methods/${id}`, admin),

  // Restaurant payments
  getRestaurantPayments: (params = {}) => apiClient.get(`${A}/withdrawals/restaurant-payments`, { params, ...admin }),
  getRestaurantPayable: (restaurantId) =>
    apiClient.get(`${A}/withdrawals/restaurant-payments/payable/${restaurantId}`, admin),
  recordRestaurantPayment: (body) => apiClient.post(`${A}/withdrawals/restaurant-payments`, body, admin),

  // Reports
  getDisbursementReport: (params = {}) => apiClient.get(`${A}/reports/disbursements`, { params, ...admin }),
  getRestaurantEarningReport: (params = {}) => apiClient.get(`${A}/reports/restaurant-earnings`, { params, ...admin }),
  getRestaurantVatReport: (params = {}) => apiClient.get(`${A}/reports/restaurant-vat`, { params, ...admin }),

  // Email templates
  getEmailTemplates: () => apiClient.get(`${A}/email-templates`, admin),
  saveEmailSettings: (body) => apiClient.put(`${A}/email-templates-settings`, body, admin),
  saveEmailTemplate: (key, body) => apiClient.put(`${A}/email-templates/${key}`, body, admin),
  resetEmailTemplate: (key) => apiClient.delete(`${A}/email-templates/${key}`, admin),
  previewEmailTemplate: (key, body) => apiClient.post(`${A}/email-templates/${key}/preview`, body, admin),

  // Settings areas: page_meta, app_settings, login_setup, notification_channels, landing_page, website
  getSettings: (area) => apiClient.get(`${A}/system-settings/${area}`, admin),
  saveSettings: (area, value) => apiClient.put(`${A}/system-settings/${area}`, { value }, admin),

  // Social media
  getSocialLinks: () => apiClient.get(`${A}/social-media`, admin),
  createSocialLink: (body) => apiClient.post(`${A}/social-media`, body, admin),
  updateSocialLink: (id, body) => apiClient.patch(`${A}/social-media/${id}`, body, admin),
  deleteSocialLink: (id) => apiClient.delete(`${A}/social-media/${id}`, admin),

  // Gallery
  getGalleryFiles: (params = {}) => apiClient.get(`${A}/gallery`, { params, ...admin }),
  getGalleryFileUsage: (path) => apiClient.get(`${A}/gallery/usage`, { params: { path }, ...admin }),
  deleteGalleryFile: (path) => apiClient.delete(`${A}/gallery`, { data: { path }, ...admin }),
}

export default adminSystemExtrasAPI
