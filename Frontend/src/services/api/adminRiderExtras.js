import apiClient from "./axios.js"

/**
 * Admin calls for the delivery man pages: Add Delivery Man, Vehicles Category,
 * Delivery Man Disbursement, Delivery Man Payments and the Deliveryman
 * Earning Report.
 */
const admin = { contextModule: "admin" }
const BASE = "/food/admin"

export const adminRiderExtrasAPI = {
  createRider: (body) => apiClient.post(`${BASE}/delivery/partners`, body, admin),

  getVehicleCategories: (params = {}) => apiClient.get(`${BASE}/delivery/vehicle-categories`, { params, ...admin }),
  createVehicleCategory: (body) => apiClient.post(`${BASE}/delivery/vehicle-categories`, body, admin),
  updateVehicleCategory: (id, body) => apiClient.patch(`${BASE}/delivery/vehicle-categories/${id}`, body, admin),
  deleteVehicleCategory: (id) => apiClient.delete(`${BASE}/delivery/vehicle-categories/${id}`, admin),

  getDisbursements: (params = {}) => apiClient.get(`${BASE}/withdrawals/delivery-disbursements`, { params, ...admin }),
  generateDisbursement: (body = {}) => apiClient.post(`${BASE}/withdrawals/delivery-disbursements/generate`, body, admin),
  getDisbursement: (batchId, params = {}) =>
    apiClient.get(`${BASE}/withdrawals/delivery-disbursements/${batchId}`, { params, ...admin }),
  decideDisbursementPayouts: (batchId, body) =>
    apiClient.patch(`${BASE}/withdrawals/delivery-disbursements/${batchId}/payouts`, body, admin),

  getPayments: (params = {}) => apiClient.get(`${BASE}/withdrawals/delivery-payments`, { params, ...admin }),
  getPayableRiders: (params = {}) => apiClient.get(`${BASE}/withdrawals/delivery-payments/riders`, { params, ...admin }),
  recordPayment: (body) => apiClient.post(`${BASE}/withdrawals/delivery-payments`, body, admin),

  getEarningReport: (params = {}) => apiClient.get(`${BASE}/reports/deliveryman-earnings`, { params, ...admin }),
}

export default adminRiderExtrasAPI
