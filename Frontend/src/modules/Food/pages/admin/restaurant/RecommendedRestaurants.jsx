import { useEffect, useMemo, useState } from "react"
import { ArrowDown, ArrowUp, Flame, Loader2, Plus, Save, X } from "@food/components/admin/theme/icons"
import { toast } from "sonner"
import { adminAPI } from "@food/api"
import { adminCatalogExtrasAPI, errorMessage, loadRestaurantOptions } from "@food/api/adminCatalogExtras"

/** The admin's hand-picked restaurants for the customer app's "Recommended" row, in order. */
export default function RecommendedRestaurants() {
  const [picked, setPicked] = useState([])
  const [saved, setSaved] = useState([])
  const [restaurants, setRestaurants] = useState([])
  const [choice, setChoice] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    Promise.all([
      adminCatalogExtrasAPI.getRecommendedRestaurants(),
      loadRestaurantOptions(adminAPI).catch(() => []),
    ])
      .then(([res, options]) => {
        const list = res?.data?.data?.restaurants || []
        setPicked(list)
        setSaved(list.map((r) => r.id))
        setRestaurants(options.filter((r) => !r.status || r.status === "approved"))
      })
      .catch((err) => toast.error(errorMessage(err, "Failed to load recommended restaurants")))
      .finally(() => setLoading(false))
  }, [])

  const available = useMemo(() => restaurants.filter((r) => !picked.some((p) => p.id === r.id)), [restaurants, picked])
  const changed = picked.map((r) => r.id).join() !== saved.join()

  const add = () => {
    const r = restaurants.find((x) => x.id === choice)
    if (!r) return
    setPicked((list) => [...list, { id: r.id, name: r.name }])
    setChoice("")
  }
  const move = (index, delta) =>
    setPicked((list) => {
      const next = [...list]
      const [item] = next.splice(index, 1)
      next.splice(index + delta, 0, item)
      return next
    })
  const remove = (id) => setPicked((list) => list.filter((r) => r.id !== id))

  const save = async () => {
    try {
      setSaving(true)
      const res = await adminCatalogExtrasAPI.saveRecommendedRestaurants(picked.map((r) => r.id))
      const list = res?.data?.data?.restaurants || []
      setPicked(list)
      setSaved(list.map((r) => r.id))
      toast.success("Recommended restaurants saved")
    } catch (err) {
      toast.error(errorMessage(err, "Failed to save"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-3">
              <Flame className="w-5 h-5 text-blue-600" />
              <h1 className="text-2xl font-bold text-slate-900">Recommended Restaurants</h1>
            </div>
            <p className="text-sm text-slate-600 mt-1">
              Shown in this order in the customer app's Recommended row. Customers only see the ones that serve their area.
            </p>
          </div>
          <button type="button" onClick={save} disabled={!changed || saving} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
          </button>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 flex flex-wrap gap-2">
          <select value={choice} onChange={(e) => setChoice(e.target.value)} className="flex-1 min-w-[220px] rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white" aria-label="Restaurant to add">
            <option value="">Choose an approved restaurant</option>
            {available.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <button type="button" onClick={add} disabled={!choice || picked.length >= 50} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium disabled:opacity-50">
            <Plus className="w-4 h-4" /> Add
          </button>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200">
          {loading ? (
            <div className="py-16 text-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400 mx-auto" /></div>
          ) : !picked.length ? (
            <p className="py-16 text-center text-sm text-slate-500">No restaurants recommended. The app hides the row until some are added.</p>
          ) : (
            <ol className="divide-y divide-slate-100">
              {picked.map((r, i) => (
                <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="w-6 text-sm font-semibold text-slate-500">{i + 1}</span>
                  {r.logo ? <img src={r.logo} alt="" className="h-9 w-9 rounded-full object-cover border" /> : <div className="h-9 w-9 rounded-full bg-slate-100" />}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate">{r.name}</p>
                    {(r.zoneName || r.area) && <p className="text-xs text-slate-500 truncate">{[r.zoneName, r.area].filter(Boolean).join(" · ")}</p>}
                  </div>
                  <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="p-1.5 rounded hover:bg-slate-100 disabled:opacity-30" aria-label="Move up"><ArrowUp className="w-4 h-4" /></button>
                  <button type="button" disabled={i === picked.length - 1} onClick={() => move(i, 1)} className="p-1.5 rounded hover:bg-slate-100 disabled:opacity-30" aria-label="Move down"><ArrowDown className="w-4 h-4" /></button>
                  <button type="button" onClick={() => remove(r.id)} className="p-1.5 rounded text-rose-600 hover:bg-rose-50" aria-label="Remove"><X className="w-4 h-4" /></button>
                </li>
              ))}
            </ol>
          )}
        </div>
        {changed && <p className="text-sm text-amber-700">Unsaved changes.</p>}
      </div>
    </div>
  )
}
