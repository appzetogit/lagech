import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { ArrowLeft, Loader2, Pencil, Plus, Shield, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { adminAPI } from "@food/api"
import SidebarAccessPicker, { permissionsForPages } from "./SidebarAccessPicker"

/**
 * Reusable sub-admin roles: a named set of sidebar pages and an access level.
 * Saving a role updates every sub-admin on it.
 */
export default function EmployeeRoles() {
  const [roles, setRoles] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null) // { id?, name, pages:Set, level }
  const [saving, setSaving] = useState(false)

  const load = async () => {
    try {
      setLoading(true)
      const res = await adminAPI.getAdminRoles()
      setRoles(res?.data?.data?.roles || [])
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to load roles")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const save = async () => {
    const name = editing.name.trim()
    if (!name) return toast.error("Give the role a name")
    if (!editing.pages.size) return toast.error("Tick at least one page")
    const menuPaths = [...editing.pages]
    const body = { name, accessLevel: editing.level, menuPaths, permissions: permissionsForPages(menuPaths, editing.level) }
    try {
      setSaving(true)
      if (editing.id) await adminAPI.updateAdminRole(editing.id, body)
      else await adminAPI.createAdminRole(body)
      toast.success(editing.id ? "Role saved; everyone on it now has this access" : "Role created")
      setEditing(null)
      load()
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to save the role")
    } finally {
      setSaving(false)
    }
  }

  const remove = async (role) => {
    const who = role.adminCount ? ` ${role.adminCount} sub admin(s) on it keep their current access.` : ""
    if (!window.confirm(`Delete the role "${role.name}"?${who}`)) return
    try {
      await adminAPI.deleteAdminRole(role.id)
      toast.success("Role deleted")
      load()
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to delete the role")
    }
  }

  if (editing) {
    return (
      <div className="p-4 lg:p-6 bg-slate-50 min-h-screen space-y-6">
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <button type="button" onClick={() => setEditing(null)} className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900">
            <ArrowLeft className="w-4 h-4" /> All roles
          </button>
          <h1 className="text-2xl font-bold text-slate-900">{editing.id ? "Edit role" : "New role"}</h1>
          <input
            value={editing.name}
            maxLength={60}
            onChange={(e) => setEditing((r) => ({ ...r, name: e.target.value }))}
            placeholder="Role name, e.g. Order desk"
            className="w-full max-w-md rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
          {editing.id && editing.adminCount > 0 && (
            <p className="text-xs text-amber-700">{editing.adminCount} sub admin(s) follow this role; saving changes their access too.</p>
          )}
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <SidebarAccessPicker
            selected={editing.pages}
            onChange={(pages) => setEditing((r) => ({ ...r, pages }))}
            level={editing.level}
            onLevelChange={(level) => setEditing((r) => ({ ...r, level }))}
          />
        </div>
        <div className="flex gap-2">
          <button type="button" disabled={saving} onClick={save} className="inline-flex items-center gap-2 px-4 py-2 bg-black text-white rounded-lg disabled:opacity-60">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />} Save role
          </button>
          <button type="button" onClick={() => setEditing(null)} className="px-4 py-2 border rounded-lg">Cancel</button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/admin/food/employees" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900 mb-2">
            <ArrowLeft className="w-4 h-4" /> Sub admins
          </Link>
          <h1 className="text-2xl font-bold text-slate-900">Employee Roles</h1>
          <p className="text-sm text-slate-600 mt-1">
            Define a role once, such as Order desk or Accounts, and give it to many sub admins. Changing a role changes everyone on it.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditing({ name: "", pages: new Set(), level: "full" })}
          className="inline-flex items-center gap-2 px-4 py-2 bg-black text-white rounded-lg text-sm"
        >
          <Plus className="w-4 h-4" /> New role
        </button>
      </div>
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        {loading ? (
          <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
        ) : !roles.length ? (
          <p className="text-sm text-slate-500">No roles yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {roles.map((role) => (
              <li key={role.id} className="flex flex-wrap items-center gap-3 py-3">
                <Shield className="w-4 h-4 text-slate-400" />
                <div className="flex-1 min-w-[200px]">
                  <p className="font-semibold text-slate-900">{role.name}</p>
                  <p className="text-xs text-slate-500">
                    {role.menuPaths.length} page(s) · {role.accessLevel === "view" ? "view only" : "full access"} · {role.adminCount} sub admin(s)
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setEditing({ id: role.id, name: role.name, pages: new Set(role.menuPaths), level: role.accessLevel, adminCount: role.adminCount })}
                  className="inline-flex items-center gap-1 px-3 py-2 border rounded-lg text-sm"
                >
                  <Pencil className="w-4 h-4" /> Edit
                </button>
                <button type="button" onClick={() => remove(role)} className="inline-flex items-center gap-1 px-3 py-2 border border-red-200 text-red-600 rounded-lg text-sm">
                  <Trash2 className="w-4 h-4" /> Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
