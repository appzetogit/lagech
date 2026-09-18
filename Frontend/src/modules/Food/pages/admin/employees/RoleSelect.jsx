import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { adminAPI } from "@food/api"

/**
 * "Follow a role, or pick pages by hand." An empty value means by hand; the
 * checkbox picker is only shown for that.
 */
export default function RoleSelect({ value, onChange }) {
  const [roles, setRoles] = useState([])
  useEffect(() => {
    adminAPI
      .getAdminRoles()
      .then((res) => setRoles(res?.data?.data?.roles || []))
      .catch(() => setRoles([]))
  }, [])
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-sm font-semibold text-slate-800" htmlFor="sub-admin-role">Role</label>
      <select
        id="sub-admin-role"
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
      >
        <option value="">Custom (pick pages below)</option>
        {roles.map((role) => (
          <option key={role.id} value={role.id}>
            {role.name} · {role.menuPaths.length} page(s), {role.accessLevel === "view" ? "view only" : "full access"}
          </option>
        ))}
      </select>
      <Link to="/admin/food/employees/roles" className="text-xs text-teal-700 underline">Manage roles</Link>
    </div>
  )
}
