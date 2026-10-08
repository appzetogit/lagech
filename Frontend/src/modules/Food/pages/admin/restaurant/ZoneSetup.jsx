import { useState, useEffect, useMemo } from "react"
import { useNavigate } from "react-router-dom"
import { MapPin, Plus, Search, Edit, Trash2, Eye, Map, Bike, Download, ChevronDown, Star } from "@food/components/admin/theme/icons"
import { adminAPI } from "@food/api"
import { exportZonesToCSV, exportZonesToExcel } from "@food/components/admin/zones/zonesExportUtils"

const zoneIdOf = (zone) => String(zone?._id || zone?.id || "")

/** A small on/off switch, the shape the old Zone setup table used. */
function Switch({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
        checked ? "bg-blue-600" : "bg-slate-300"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  )
}

export default function ZoneSetup() {
  const navigate = useNavigate()
  const [zones, setZones] = useState([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")
  const [busyId, setBusyId] = useState("")
  const [exportOpen, setExportOpen] = useState(false)

  useEffect(() => {
    fetchZones()
  }, [])

  const fetchZones = async () => {
    try {
      setLoading(true)
      const response = await adminAPI.getZones({ limit: 1000 })
      setZones(response.data?.data?.zones || [])
    } catch {
      setZones([])
    } finally {
      setLoading(false)
    }
  }

  /** One PATCH per switch; the row is replaced with what the server saved. */
  const patchZone = async (zone, body) => {
    const id = zoneIdOf(zone)
    try {
      setBusyId(id)
      const response = await adminAPI.updateZone(id, body)
      const saved = response.data?.data?.zone
      if (body.isDefault) {
        // The default moved: every other row lost it.
        await fetchZones()
      } else if (saved) {
        setZones((prev) => prev.map((z) => (zoneIdOf(z) === id ? { ...z, ...saved } : z)))
      }
    } catch (error) {
      alert(error.response?.data?.message || "Failed to update zone")
    } finally {
      setBusyId("")
    }
  }

  const handleDeleteZone = async (zone) => {
    if (!window.confirm("Are you sure you want to delete this zone?")) return
    try {
      await adminAPI.deleteZone(zoneIdOf(zone))
      fetchZones()
    } catch (error) {
      alert(error.response?.data?.message || "Failed to delete zone")
    }
  }

  const filteredZones = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return zones
    return zones.filter((zone) =>
      [zone.name, zone.zoneName, zone.serviceLocation, zoneIdOf(zone)]
        .some((value) => String(value || "").toLowerCase().includes(q))
    )
  }, [zones, searchQuery])

  const exportRows = () =>
    filteredZones.map((zone) => ({
      zoneId: zoneIdOf(zone),
      name: zone.name || "",
      displayName: zone.serviceLocation || zone.zoneName || "",
      restaurants: zone.restaurantCount ?? 0,
      deliverymen: zone.deliveryPartnerCount ?? 0,
      isDefault: Boolean(zone.isDefault),
      status: Boolean(zone.isActive),
    }))

  const runExport = (kind) => {
    setExportOpen(false)
    if (!filteredZones.length) {
      alert("No zones to export")
      return
    }
    if (kind === "csv") exportZonesToCSV(exportRows(), "zones")
    else exportZonesToExcel(exportRows(), "zones")
  }

  return (
    <div className="p-2 lg:p-3 bg-slate-50 min-h-screen">
      <div className="w-full mx-auto max-w-7xl">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between mb-6 gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-red-500 flex items-center justify-center">
              <MapPin className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">Zone Setup</h1>
              <p className="text-sm text-slate-600">Delivery zones, their payment methods and the default zone</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => navigate("/admin/food/zone-setup/delivery-boy-view")}
              className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
            >
              <Bike className="w-5 h-5" />
              <span>Delivery Boy View</span>
            </button>
            <button
              onClick={() => navigate("/admin/food/zone-setup/map")}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
            >
              <Map className="w-5 h-5" />
              <span>View Map</span>
            </button>
            <button
              onClick={() => navigate("/admin/food/zone-setup/add")}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              <Plus className="w-5 h-5" />
              <span>Add Zone</span>
            </button>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-slate-200">
          {/* Toolbar */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 border-b border-slate-200">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-slate-900">Zone List</h2>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700">
                {filteredZones.length}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative flex-1 sm:w-72">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search by name or id"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setExportOpen((open) => !open)}
                  className="flex items-center gap-2 px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white hover:bg-slate-50"
                >
                  <Download className="w-4 h-4" />
                  <span>Export</span>
                  <ChevronDown className="w-3 h-3" />
                </button>
                {exportOpen && (
                  <div className="absolute right-0 mt-1 w-36 bg-white border border-slate-200 rounded-lg shadow-lg z-10">
                    <button type="button" onClick={() => runExport("excel")} className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-50">Excel</button>
                    <button type="button" onClick={() => runExport("csv")} className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-50">CSV</button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {loading ? (
            <div className="p-8 text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
              <p className="text-slate-600">Loading zones...</p>
            </div>
          ) : filteredZones.length === 0 ? (
            <div className="p-12 text-center">
              <MapPin className="w-16 h-16 text-slate-400 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-slate-900 mb-2">No zones found</h3>
              <p className="text-slate-600">
                {searchQuery ? "Try adjusting your search query" : "Create your first delivery zone to get started"}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr className="text-left text-[11px] font-bold text-slate-700 uppercase tracking-wider">
                    <th className="px-4 py-3">SL</th>
                    <th className="px-4 py-3">Zone</th>
                    <th className="px-4 py-3 text-center">Restaurants</th>
                    <th className="px-4 py-3 text-center">Deliverymen</th>
                    <th className="px-4 py-3 text-center">Default</th>
                    <th className="px-4 py-3 text-center">Status</th>
                    <th className="px-4 py-3 text-center">Digital Payment</th>
                    <th className="px-4 py-3 text-center">Cash On Delivery</th>
                    <th className="px-4 py-3 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredZones.map((zone, index) => {
                    const id = zoneIdOf(zone)
                    const busy = busyId === id
                    return (
                      <tr key={id} className="hover:bg-slate-50">
                        <td className="px-4 py-3 text-slate-700">{index + 1}</td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-slate-900">{zone.name || "Unnamed Zone"}</div>
                          <div className="text-xs text-slate-500">
                            {zone.serviceLocation && zone.serviceLocation !== zone.name ? `${zone.serviceLocation} · ` : ""}
                            <span className="font-mono">{id.slice(-6)}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-center text-slate-700">{zone.restaurantCount ?? 0}</td>
                        <td className="px-4 py-3 text-center text-slate-700">{zone.deliveryPartnerCount ?? 0}</td>
                        <td className="px-4 py-3 text-center">
                          {zone.isDefault ? (
                            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
                              <Star className="w-3 h-3" /> Default
                            </span>
                          ) : (
                            <button
                              type="button"
                              disabled={busy || !zone.isActive}
                              title={zone.isActive ? "Make this the default zone" : "Only an active zone can be the default"}
                              onClick={() => patchZone(zone, { isDefault: true })}
                              className="px-2 py-1 rounded-lg border border-slate-300 text-xs text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                            >
                              Make default
                            </button>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <Switch
                            label="Status"
                            checked={Boolean(zone.isActive)}
                            disabled={busy || (zone.isDefault && zone.isActive)}
                            onChange={() => patchZone(zone, { isActive: !zone.isActive })}
                          />
                        </td>
                        <td className="px-4 py-3 text-center">
                          <Switch
                            label="Digital Payment"
                            checked={zone.digitalPayment !== false}
                            disabled={busy}
                            onChange={() => patchZone(zone, { digitalPayment: zone.digitalPayment === false })}
                          />
                        </td>
                        <td className="px-4 py-3 text-center">
                          <Switch
                            label="Cash On Delivery"
                            checked={zone.cashOnDelivery !== false}
                            disabled={busy}
                            onChange={() => patchZone(zone, { cashOnDelivery: zone.cashOnDelivery === false })}
                          />
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              onClick={() => navigate(`/admin/food/zone-setup/view/${id}`)}
                              className="p-2 text-slate-600 hover:text-blue-600 hover:bg-blue-50 rounded-lg"
                              title="View"
                            >
                              <Eye className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => navigate(`/admin/food/zone-setup/edit/${id}`)}
                              className="p-2 text-slate-600 hover:text-green-600 hover:bg-green-50 rounded-lg"
                              title="Edit"
                            >
                              <Edit className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleDeleteZone(zone)}
                              disabled={zone.isDefault}
                              className="p-2 text-slate-600 hover:text-red-600 hover:bg-red-50 rounded-lg disabled:opacity-40"
                              title={zone.isDefault ? "The default zone cannot be deleted" : "Delete"}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="px-4 py-3 text-xs text-slate-500 border-t border-slate-100">
            Digital Payment and Cash On Delivery decide which payment methods customers can use for orders in a zone.
            The default zone is used for orders at restaurants that have no zone.
          </p>
        </div>
      </div>
    </div>
  )
}
