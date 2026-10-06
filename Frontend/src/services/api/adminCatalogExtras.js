/**
 * Admin API for the catalog and promotion pages carried over from the previous
 * admin panel: dish reviews, food gallery, addon categories, recommended
 * restaurants, bulk import/export and campaigns.
 */
import apiClient from "./axios.js"

const admin = { contextModule: "admin" }
const id = (value) => encodeURIComponent(String(value))

/** categories | addons | restaurants | foods -> the admin path they live under. */
const BULK_BASE = {
  categories: "/food/admin/categories/bulk",
  addons: "/food/admin/addons/bulk",
  restaurants: "/food/admin/restaurants/bulk",
  foods: "/food/admin/foods/bulk",
}

export const adminCatalogExtrasAPI = {
  // Dish reviews
  getFoodReviews: (params = {}) => apiClient.get("/food/admin/foods/reviews", { params, ...admin }),
  setFoodReviewHidden: (reviewId, hidden) =>
    apiClient.patch(`/food/admin/foods/reviews/${id(reviewId)}/visibility`, { hidden }, admin),

  // Food gallery
  getFoodGallery: (params = {}) => apiClient.get("/food/admin/foods/gallery", { params, ...admin }),

  // Addon categories
  getAddonCategories: (params = {}) => apiClient.get("/food/admin/addons/categories", { params, ...admin }),
  createAddonCategory: (body) => apiClient.post("/food/admin/addons/categories", body, admin),
  updateAddonCategory: (categoryId, body) => apiClient.patch(`/food/admin/addons/categories/${id(categoryId)}`, body, admin),
  deleteAddonCategory: (categoryId) => apiClient.delete(`/food/admin/addons/categories/${id(categoryId)}`, admin),
  setAddonCategory: (addonId, categoryId) =>
    apiClient.patch(`/food/admin/addons/${id(addonId)}/category`, { categoryId: categoryId || null }, admin),

  // Recommended restaurants
  getRecommendedRestaurants: () => apiClient.get("/food/admin/restaurants/recommended", admin),
  saveRecommendedRestaurants: (restaurantIds) =>
    apiClient.put("/food/admin/restaurants/recommended", { restaurantIds }, admin),
  /** 1 = first in the customer app's restaurant list; null = no fixed place. */
  setRestaurantDisplayPosition: (restaurantId, position) =>
    apiClient.patch(`/food/admin/restaurants/${id(restaurantId)}/display-position`, { position }, admin),

  // Bulk import / export
  /** withData: the "Template with existing data" (current records in import columns). */
  downloadBulkTemplate: (entity, format = "xlsx", withData = false) =>
    apiClient.get(`${BULK_BASE[entity]}/template`, {
      params: { format, ...(withData ? { withData: 1 } : {}) },
      responseType: "blob",
      ...admin,
    }),
  bulkImport: (entity, file) => {
    const formData = new FormData()
    formData.append("file", file)
    return apiClient.post(`${BULK_BASE[entity]}/import`, formData, {
      headers: { "Content-Type": "multipart/form-data" },
      ...admin,
    })
  },
  bulkExport: (entity, params = {}) =>
    apiClient.get(`${BULK_BASE[entity]}/export`, { params, responseType: "blob", ...admin }),

  // Order lists' Export: every order matching the list's filters, built on the server.
  exportOrders: (params = {}, format = "xlsx") =>
    apiClient.get("/food/admin/orders/export", {
      params: { ...params, format: format === "csv" ? "csv" : "xlsx" },
      responseType: "blob",
      timeout: 300000,
      ...admin,
    }),

  // Restaurant list: Featured toggle and Verify all (approve every pending restaurant).
  setRestaurantFeatured: (restaurantId, isFeatured) =>
    apiClient.patch(`/food/admin/restaurants/${id(restaurantId)}/featured`, { isFeatured: Boolean(isFeatured) }, admin),
  approveAllPendingRestaurants: () => apiClient.post("/food/admin/restaurants/approve-pending", {}, admin),

  // Campaigns
  getBasicCampaigns: (params = {}) => apiClient.get("/food/admin/campaigns/basic", { params, ...admin }),
  createBasicCampaign: (body) => apiClient.post("/food/admin/campaigns/basic", body, admin),
  updateBasicCampaign: (campaignId, body) => apiClient.patch(`/food/admin/campaigns/basic/${id(campaignId)}`, body, admin),
  deleteBasicCampaign: (campaignId) => apiClient.delete(`/food/admin/campaigns/basic/${id(campaignId)}`, admin),
  getCampaignRestaurants: (campaignId) => apiClient.get(`/food/admin/campaigns/basic/${id(campaignId)}/restaurants`, admin),
  addCampaignRestaurant: (campaignId, restaurantId) =>
    apiClient.put(`/food/admin/campaigns/basic/${id(campaignId)}/restaurants/${id(restaurantId)}`, {}, admin),
  removeCampaignRestaurant: (campaignId, restaurantId) =>
    apiClient.delete(`/food/admin/campaigns/basic/${id(campaignId)}/restaurants/${id(restaurantId)}`, admin),
  getFoodCampaigns: (params = {}) => apiClient.get("/food/admin/campaigns/food", { params, ...admin }),
  createFoodCampaign: (body) => apiClient.post("/food/admin/campaigns/food", body, admin),
  updateFoodCampaign: (campaignId, body) => apiClient.patch(`/food/admin/campaigns/food/${id(campaignId)}`, body, admin),
  deleteFoodCampaign: (campaignId) => apiClient.delete(`/food/admin/campaigns/food/${id(campaignId)}`, admin),
}

/** Save a blob response as a file, using the server's filename when it sent one. */
export function saveBlobResponse(response, fallbackName) {
  const disposition = response?.headers?.["content-disposition"] || ""
  const match = /filename="?([^";]+)"?/i.exec(disposition)
  const url = window.URL.createObjectURL(new Blob([response.data]))
  const link = document.createElement("a")
  link.href = url
  link.setAttribute("download", match?.[1] || fallbackName)
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(url)
}

/** Load every restaurant (id + name) for pickers. */
export async function loadRestaurantOptions(adminAPI, params = {}) {
  const res = await adminAPI.getRestaurants({ limit: 1000, ...params })
  const d = res?.data?.data || {}
  const list = d.restaurants || d.items || d.docs || []
  return list
    .map((r) => ({ id: r.id || r._id, name: r.restaurantName || r.name || "", status: r.status }))
    .filter((r) => r.id)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The message an API error carries, or a fallback. */
export const errorMessage = (err, fallback) => err?.response?.data?.message || err?.message || fallback

/** Same, for a request made with responseType "blob", whose error body is a Blob. */
export async function blobErrorMessage(err, fallback) {
  const data = err?.response?.data
  if (data instanceof Blob) {
    try {
      return JSON.parse(await data.text())?.message || fallback
    } catch {
      return fallback
    }
  }
  return errorMessage(err, fallback)
}
