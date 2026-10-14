import { useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Pencil, Plus, Search, Shield, Trash2, UserRound } from "lucide-react"
import { toast } from "sonner"
import { restaurantAPI } from "@food/api"
import { getRestaurantStaffSession } from "@food/utils/restaurantPermissions"
import { StaffPage, primaryButton, secondaryButton } from "./shared"

/** Employees (old store panel): staff who sign in with email or phone + password. */
export default function EmployeesPage() {
  const navigate = useNavigate()
  const me = getRestaurantStaffSession().employeeId
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")

  const load = async () => {
    try {
      setLoading(true)
      const res = await restaurantAPI.getEmployees()
      setItems(res?.data?.data?.employees || [])
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter((e) => [e.name, e.email, e.phone, e.role?.name].some((v) => String(v || "").toLowerCase().includes(q)))
  }, [items, search])

  const toggle = async (employee) => {
    try {
      await restaurantAPI.setEmployeeStatus(employee.id, !employee.isActive)
      toast.success(employee.isActive ? "Employee switched off; they are signed out" : "Employee switched on")
      load()
    } catch {
      // shown by the API client
    }
  }

  const remove = async (employee) => {
    if (!window.confirm(`Delete ${employee.name || employee.email}? They will no longer be able to sign in.`)) return
    try {
      await restaurantAPI.deleteEmployee(employee.id)
      toast.success("Employee deleted")
      load()
    } catch {
      // shown by the API client
    }
  }

  return (
    <StaffPage
      title="Employees"
      subtitle="Staff sign in with their email or phone and the password you set"
      back="/food/restaurant/explore"
      action={
        <div className="flex gap-2">
          <button type="button" onClick={() => navigate("/food/restaurant/employee-roles")} className={secondaryButton}>
            <Shield className="w-4 h-4" /> <span className="hidden sm:inline">Roles</span>
          </button>
          <button type="button" onClick={() => navigate("/food/restaurant/employees/new")} className={primaryButton}>
            <Plus className="w-4 h-4" /> <span className="hidden sm:inline">Add employee</span>
          </button>
        </div>
      }
    >
      <div className="relative mb-4 w-full md:max-w-sm">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#5c6775]" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, email, phone or role"
          className="h-11 w-full rounded-full border border-[#c8d0da] bg-white pl-9 pr-4 text-sm outline-none focus:ring-2 focus:ring-[#4f6f9a]/30"
        />
      </div>

      <div className="rounded-2xl border border-[#d6dce4] bg-white/80 p-3 md:p-5">
        {loading ? (
          <div className="py-16 text-center text-sm text-[#5c6775]">Loading employees...</div>
        ) : !filtered.length ? (
          <div className="flex flex-col items-center justify-center text-center px-6 py-16">
            <UserRound className="w-8 h-8 text-[#5c6775] mb-3" />
            <p className="text-base font-bold text-[#141820]">{items.length ? "No match" : "No employees yet"}</p>
            <p className="mt-1.5 text-sm text-[#5c6775] max-w-sm">Add an employee and choose their role.</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {filtered.map((e) => (
              <li key={e.id} className="rounded-2xl border border-[#d6dce4] bg-white p-4">
                <div className="flex items-start gap-3">
                  <div className="h-11 w-11 shrink-0 overflow-hidden rounded-full bg-[#edf1f5] flex items-center justify-center">
                    {e.image ? <img src={e.image} alt="" className="h-full w-full object-cover" /> : <UserRound className="w-5 h-5 text-[#5c6775]" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-bold text-[#141820] truncate">{e.name || e.email}</p>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${e.isActive ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>
                        {e.isActive ? "Active" : "Off"}
                      </span>
                    </div>
                    <p className="text-xs text-[#5c6775] truncate">{e.email}{e.phone ? ` · ${e.phone}` : ""}</p>
                    <p className="text-xs text-[#2f5280] mt-0.5">{e.role?.name || "No role"}</p>
                  </div>
                </div>
                {e.id !== me && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <label className="inline-flex items-center gap-2 text-sm text-[#141820] mr-auto">
                      <input type="checkbox" checked={e.isActive} onChange={() => toggle(e)} className="h-4 w-4 accent-[#4f6f9a]" />
                      Can sign in
                    </label>
                    <button type="button" onClick={() => navigate(`/food/restaurant/employees/${e.id}`)} className={secondaryButton}>
                      <Pencil className="w-4 h-4" /> Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(e)}
                      className="inline-flex items-center gap-1.5 rounded-full border border-rose-200 bg-white px-3 py-2 text-sm font-semibold text-rose-600 hover:bg-rose-50"
                    >
                      <Trash2 className="w-4 h-4" /> <span className="hidden sm:inline">Delete</span>
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </StaffPage>
  )
}
