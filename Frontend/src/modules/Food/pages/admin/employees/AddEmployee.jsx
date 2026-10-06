import { Link, useNavigate } from "react-router-dom"
import { UserPlus } from "@food/components/admin/theme/icons"
import SubAdminCreateForm from "./SubAdminCreateForm"

/**
 * Employees -> Add new: creates a sub admin through the same API as the
 * Employees list, then returns to the list.
 */
export default function AddEmployee() {
  const navigate = useNavigate()
  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-teal-700" /> Add New Employee
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            A sub admin signs in to this panel with the email and password below and sees only the pages their role, or the pages ticked here, allow.
          </p>
        </div>
        <Link to="/admin/food/employees" className="px-3 py-2 border rounded-lg text-sm bg-white">Employee list</Link>
      </div>
      <SubAdminCreateForm onCreated={() => navigate("/admin/food/employees")} />
    </div>
  )
}
