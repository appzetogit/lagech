import { useEffect, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { Loader2, Pencil, Plus, Shield, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { restaurantAPI } from "@food/api"
import { StaffPage, PermissionPicker, permissionLabel, primaryButton, secondaryButton, inputClass } from "./shared"

const BASE = "/food/restaurant/employee-roles"

/**
 * Employee Role (old store panel): a name and the modules staff on it may use.
 * /employee-roles lists them; /employee-roles/new and /employee-roles/:id edit
 * one. Saving a role changes every employee on it at once.
 */
export default function EmployeeRolesPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const editing = Boolean(id)
  const [roles, setRoles] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ name: "", permissions: [] })
  const [saving, setSaving] = useState(false)

  const load = async () => {
    try {
      setLoading(true)
      const res = await restaurantAPI.getEmployeeRoles()
      const list = res?.data?.data?.roles || []
      setRoles(list)
      return list
    } catch {
      return []
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load().then((list) => {
      if (id && id !== "new") {
        const role = list.find((r) => r.id === id)
        if (role) setForm({ name: role.name, permissions: role.permissions || [] })
        else toast.error("Role not found")
      } else {
        setForm({ name: "", permissions: [] })
      }
    })
  }, [id])

  const save = async (e) => {
    e.preventDefault()
    const name = form.name.trim()
    if (!name) return toast.error("Give the role a name")
    if (!form.permissions.length) return toast.error("Tick at least one module")
    try {
      setSaving(true)
      if (id && id !== "new") await restaurantAPI.updateEmployeeRole(id, { name, permissions: form.permissions })
      else await restaurantAPI.createEmployeeRole({ name, permissions: form.permissions })
      toast.success(id && id !== "new" ? "Role saved; everyone on it now has this access" : "Role created")
      navigate(BASE)
    } catch {
      // The API client already shows the server's message.
    } finally {
      setSaving(false)
    }
  }

  const remove = async (role) => {
    if (!window.confirm(`Delete the role "${role.name}"?`)) return
    try {
      await restaurantAPI.deleteEmployeeRole(role.id)
      toast.success("Role deleted")
      load()
    } catch {
      // shown by the API client
    }
  }

  if (editing) {
    const current = roles.find((r) => r.id === id)
    return (
      <StaffPage title={id === "new" ? "New role" : "Edit role"} subtitle="Choose what staff on this role can open and do" back={BASE}>
        <form onSubmit={save} className="space-y-4 max-w-3xl">
          <div className="rounded-2xl border border-[#d6dce4] bg-white p-4 md:p-5 space-y-2">
            <label htmlFor="role-name" className="text-sm font-bold text-[#141820]">Role name</label>
            <input
              id="role-name"
              value={form.name}
              maxLength={60}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Manager, Order desk"
              className={inputClass}
            />
            {current?.employeeCount > 0 && (
              <p className="text-xs text-amber-700">{current.employeeCount} employee(s) are on this role; saving changes their access too.</p>
            )}
          </div>
          <div className="rounded-2xl border border-[#d6dce4] bg-white p-4 md:p-5">
            <PermissionPicker value={form.permissions} onChange={(permissions) => setForm((f) => ({ ...f, permissions }))} />
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={saving || loading} className={primaryButton}>
              {saving && <Loader2 className="w-4 h-4 animate-spin" />} Save role
            </button>
            <button type="button" onClick={() => navigate(BASE)} className={secondaryButton}>Cancel</button>
          </div>
        </form>
      </StaffPage>
    )
  }

  return (
    <StaffPage
      title="Employee roles"
      subtitle="Define a role once and give it to many employees"
      back="/food/restaurant/explore"
      action={
        <button type="button" onClick={() => navigate(`${BASE}/new`)} className={primaryButton}>
          <Plus className="w-4 h-4" /> <span className="hidden sm:inline">New role</span>
        </button>
      }
    >
      <div className="rounded-2xl border border-[#d6dce4] bg-white/80 p-3 md:p-5">
        {loading ? (
          <div className="py-16 text-center text-sm text-[#5c6775]">Loading roles...</div>
        ) : !roles.length ? (
          <div className="flex flex-col items-center justify-center text-center px-6 py-16">
            <Shield className="w-8 h-8 text-[#5c6775] mb-3" />
            <p className="text-base font-bold text-[#141820]">No roles yet</p>
            <p className="mt-1.5 text-sm text-[#5c6775] max-w-sm">Create a role, then add employees to it.</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {roles.map((role) => (
              <li key={role.id} className="rounded-2xl border border-[#d6dce4] bg-white p-4">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="flex-1 min-w-[180px]">
                    <p className="font-bold text-[#141820]">{role.name}</p>
                    <p className="text-xs text-[#5c6775] mt-0.5">{role.employeeCount} employee(s)</p>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => navigate(`${BASE}/${role.id}`)} className={secondaryButton}>
                      <Pencil className="w-4 h-4" /> Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(role)}
                      className="inline-flex items-center gap-1.5 rounded-full border border-rose-200 bg-white px-3 py-2 text-sm font-semibold text-rose-600 hover:bg-rose-50"
                    >
                      <Trash2 className="w-4 h-4" /> <span className="hidden sm:inline">Delete</span>
                    </button>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {(role.permissions || []).map((key) => (
                    <span key={key} className="rounded-full bg-[#eef3f9] px-2.5 py-1 text-[11px] font-semibold text-[#2f5280]">
                      {permissionLabel(key)}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </StaffPage>
  )
}
