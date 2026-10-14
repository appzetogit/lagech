import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { Pencil, Plus, Search } from "@food/components/admin/theme/icons"
import { adminAPI } from "@food/api"
import {
  EmptyState, ErrorState, Pager, Panel, Pill, Spinner, TableBox, Toggle, errorMessage, mediaUrl, payload, rupees, td, th, titleCase,
} from "./shared"

/**
 * This restaurant's dishes, from the admin foods list filtered to it, with
 * the availability switch and a link to the dish's edit form on Foods.
 */

const LIMIT = 20

const editPath = (food, restaurantId) =>
  `/admin/food/foods?${new URLSearchParams({ editId: String(food.id || food._id), restaurantId: String(restaurantId), name: food.name || "" })}`

function AvailabilityToggle({ food, onChanged }) {
  const [saving, setSaving] = useState(false)
  const toggle = async (next) => {
    setSaving(true)
    try {
      await adminAPI.updateFood(food.id || food._id, { isAvailable: next })
      onChanged(next)
      toast.success(next ? "Item is available" : "Item is unavailable")
    } catch (err) {
      toast.error(errorMessage(err, "Could not update the item"))
    } finally {
      setSaving(false)
    }
  }
  return <Toggle checked={food.isAvailable !== false} disabled={saving} onChange={toggle} label="Available" />
}

export default function ItemsTab({ restaurantId }) {
  const [search, setSearch] = useState("")
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(1)
  const [state, setState] = useState({ loading: true, error: "", foods: [], total: 0 })

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: "" }))
    try {
      const data = payload(await adminAPI.getFoods({ restaurantId, page, limit: LIMIT, ...(query ? { search: query } : {}) }))
      setState({ loading: false, error: "", foods: data.foods || [], total: Number(data.total) || 0 })
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: errorMessage(err, "Could not load items") }))
    }
  }, [restaurantId, page, query])

  useEffect(() => {
    load()
  }, [load])

  const setAvailable = (id, isAvailable) =>
    setState((s) => ({ ...s, foods: s.foods.map((f) => ((f.id || f._id) === id ? { ...f, isAvailable } : f)) }))

  return (
    <Panel
      title={`Items${state.loading ? "" : ` (${state.total})`}`}
      bodyClassName=""
      actions={
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              setPage(1)
              setQuery(search.trim())
            }}
            className="flex min-w-0 flex-1 items-center gap-2 sm:flex-none"
          >
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Item or category"
              className="w-full min-w-0 rounded-lg border border-slate-300 px-3 py-1.5 text-sm sm:w-52"
            />
            <button type="submit" className="rounded-lg bg-slate-100 p-2 text-slate-600 hover:bg-slate-200" title="Search">
              <Search className="w-4 h-4" />
            </button>
          </form>
          <Link
            to="/admin/food/foods/add-new"
            className="inline-flex items-center gap-1 rounded-lg bg-teal-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-800"
          >
            <Plus className="w-4 h-4" /> Add item
          </Link>
        </div>
      }
    >
      {state.loading ? (
        <Spinner />
      ) : state.error ? (
        <ErrorState message={state.error} onRetry={load} />
      ) : state.foods.length === 0 ? (
        <EmptyState title="No items found">This restaurant has no dishes{query ? " matching that search" : ""}.</EmptyState>
      ) : (
        <>
          <TableBox>
            <thead>
              <tr>
                <th className={th}>SL</th>
                <th className={th}>Item</th>
                <th className={th}>Category</th>
                <th className={th}>Price</th>
                <th className={th}>Approval</th>
                <th className={th}>Available</th>
                <th className={`${th} text-center`}>Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {state.foods.map((food, index) => {
                const id = food.id || food._id
                const image = mediaUrl(food.image || food.images?.[0])
                return (
                  <tr key={id} className="hover:bg-slate-50">
                    <td className={td}>{(page - 1) * LIMIT + index + 1}</td>
                    <td className={td}>
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-slate-100">
                          {image && <img src={image} alt="" className="h-full w-full object-cover" />}
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium text-slate-800">{food.name}</p>
                          <p className="text-[11px] text-slate-500">{food.foodType}</p>
                        </div>
                      </div>
                    </td>
                    <td className={td}>{food.categoryName || "-"}</td>
                    <td className={`${td} whitespace-nowrap`}>{rupees(food.price)}</td>
                    <td className={td}>
                      <Pill tone={food.approvalStatus === "approved" ? "green" : food.approvalStatus === "rejected" ? "red" : "amber"}>
                        {titleCase(food.approvalStatus || "approved")}
                      </Pill>
                    </td>
                    <td className={td}>
                      <AvailabilityToggle food={food} onChanged={(next) => setAvailable(id, next)} />
                    </td>
                    <td className={`${td} text-center`}>
                      <Link
                        to={editPath(food, restaurantId)}
                        className="inline-flex rounded-lg border border-sky-200 p-1.5 text-sky-600 hover:bg-sky-50"
                        title="Edit item"
                      >
                        <Pencil className="w-4 h-4" />
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </TableBox>
          <Pager page={page} pages={Math.ceil(state.total / LIMIT) || 1} onPage={setPage} />
        </>
      )}
    </Panel>
  )
}
