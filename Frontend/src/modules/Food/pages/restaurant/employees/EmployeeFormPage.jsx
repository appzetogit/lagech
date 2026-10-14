import { useEffect, useRef, useState } from "react"
import { useNavigate, useParams, Link } from "react-router-dom"
import { Camera, Eye, EyeOff, Loader2, UserRound } from "lucide-react"
import { toast } from "sonner"
import { restaurantAPI, uploadAPI } from "@food/api"
import { StaffPage, permissionLabel, primaryButton, secondaryButton, inputClass } from "./shared"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const EMPTY = { firstName: "", lastName: "", phone: "", email: "", image: "", roleId: "", password: "", isActive: true }

/** Add or edit one employee (old store panel: Employees -> Add new / Edit). */
export default function EmployeeFormPage() {
  const { id } = useParams()
  const isNew = !id || id === "new"
  const navigate = useNavigate()
  const fileRef = useRef(null)
  const [form, setForm] = useState(EMPTY)
  const [roles, setRoles] = useState([])
  const [errors, setErrors] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  useEffect(() => {
    let alive = true
    const run = async () => {
      try {
        const [rolesRes, employeeRes] = await Promise.all([
          restaurantAPI.getEmployeeRoles(),
          isNew ? Promise.resolve(null) : restaurantAPI.getEmployee(id),
        ])
        if (!alive) return
        setRoles(rolesRes?.data?.data?.roles || [])
        const e = employeeRes?.data?.data?.employee
        if (e) {
          setForm({
            firstName: e.firstName || "", lastName: e.lastName || "", phone: e.phone || "", email: e.email || "",
            image: e.image || "", roleId: e.roleId || e.role?.id || "", password: "", isActive: e.isActive !== false,
          })
        }
      } catch {
        // shown by the API client
      } finally {
        if (alive) setLoading(false)
      }
    }
    run()
    return () => {
      alive = false
    }
  }, [id, isNew])

  const set = (key, value) => {
    setForm((f) => ({ ...f, [key]: value }))
    if (errors[key]) setErrors((e) => ({ ...e, [key]: "" }))
  }

  const upload = async (file) => {
    if (!file) return
    try {
      setUploading(true)
      const res = await uploadAPI.uploadMedia(file, { folder: "food/restaurants/employees" })
      const url = res?.data?.data?.url
      if (url) set("image", url)
    } catch {
      toast.error("Could not upload the photo")
    } finally {
      setUploading(false)
    }
  }

  const validate = () => {
    const next = {}
    if (!form.firstName.trim()) next.firstName = "First name is required"
    if (!EMAIL_RE.test(form.email.trim())) next.email = "Enter a valid email"
    const digits = form.phone.replace(/\D/g, "")
    if (digits.length < 10 || digits.length > 15) next.phone = "Enter a valid phone number"
    if (!form.roleId) next.roleId = "Choose a role"
    if (isNew && form.password.length < 6) next.password = "At least 6 characters"
    if (!isNew && form.password && form.password.length < 6) next.password = "At least 6 characters"
    setErrors(next)
    return !Object.keys(next).length
  }

  const save = async (e) => {
    e.preventDefault()
    if (!validate()) return
    const body = {
      firstName: form.firstName.trim(), lastName: form.lastName.trim(), phone: form.phone.trim(),
      email: form.email.trim().toLowerCase(), image: form.image, roleId: form.roleId, isActive: form.isActive,
      ...(form.password ? { password: form.password } : {}),
    }
    try {
      setSaving(true)
      if (isNew) await restaurantAPI.createEmployee(body)
      else await restaurantAPI.updateEmployee(id, body)
      toast.success(isNew ? "Employee added; they can sign in now" : "Employee saved")
      navigate("/food/restaurant/employees")
    } catch {
      // shown by the API client
    } finally {
      setSaving(false)
    }
  }

  const role = roles.find((r) => r.id === form.roleId)
  const field = (key, label, props = {}) => (
    <div>
      <label htmlFor={`emp-${key}`} className="mb-1 block text-sm font-semibold text-[#141820]">{label}</label>
      <input id={`emp-${key}`} value={form[key]} onChange={(e) => set(key, e.target.value)} className={`${inputClass} ${errors[key] ? "border-rose-400" : ""}`} {...props} />
      {errors[key] ? <p className="mt-1 text-xs text-rose-600">{errors[key]}</p> : null}
    </div>
  )

  return (
    <StaffPage title={isNew ? "Add employee" : "Edit employee"} subtitle="Their sign-in details and role" back="/food/restaurant/employees">
      {loading ? (
        <div className="py-16 text-center text-sm text-[#5c6775]">Loading...</div>
      ) : (
        <form onSubmit={save} className="max-w-3xl space-y-4">
          <div className="rounded-2xl border border-[#d6dce4] bg-white p-4 md:p-5">
            <div className="flex items-center gap-4 mb-4">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="relative h-20 w-20 shrink-0 overflow-hidden rounded-full bg-[#edf1f5] flex items-center justify-center border border-[#d6dce4]"
                aria-label="Upload photo"
              >
                {form.image ? <img src={form.image} alt="" className="h-full w-full object-cover" /> : <UserRound className="w-8 h-8 text-[#5c6775]" />}
                <span className="absolute bottom-0 inset-x-0 bg-black/50 py-0.5 flex justify-center">
                  {uploading ? <Loader2 className="w-3.5 h-3.5 text-white animate-spin" /> : <Camera className="w-3.5 h-3.5 text-white" />}
                </span>
              </button>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
              <div className="text-sm text-[#5c6775]">Photo (optional)</div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {field("firstName", "First name", { maxLength: 100, autoComplete: "off" })}
              {field("lastName", "Last name", { maxLength: 100, autoComplete: "off" })}
              {field("phone", "Phone", { inputMode: "tel", placeholder: "+91 98765 43210", maxLength: 20 })}
              {field("email", "Email", { type: "email", autoComplete: "off" })}
            </div>
          </div>

          <div className="rounded-2xl border border-[#d6dce4] bg-white p-4 md:p-5 space-y-3">
            <div>
              <label htmlFor="emp-role" className="mb-1 block text-sm font-semibold text-[#141820]">Role</label>
              <select id="emp-role" value={form.roleId} onChange={(e) => set("roleId", e.target.value)} className={`${inputClass} ${errors.roleId ? "border-rose-400" : ""}`}>
                <option value="">Choose a role</option>
                {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              {errors.roleId ? <p className="mt-1 text-xs text-rose-600">{errors.roleId}</p> : null}
              {!roles.length && (
                <p className="mt-1 text-xs text-[#5c6775]">
                  No roles yet. <Link to="/food/restaurant/employee-roles/new" className="font-semibold text-[#4f6f9a]">Create one</Link> first.
                </p>
              )}
              {role ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {role.permissions.map((key) => (
                    <span key={key} className="rounded-full bg-[#eef3f9] px-2.5 py-1 text-[11px] font-semibold text-[#2f5280]">{permissionLabel(key)}</span>
                  ))}
                </div>
              ) : null}
            </div>
            <div>
              <label htmlFor="emp-password" className="mb-1 block text-sm font-semibold text-[#141820]">
                {isNew ? "Password" : "New password (leave blank to keep the current one)"}
              </label>
              <div className={`flex items-center rounded-xl border bg-white ${errors.password ? "border-rose-400" : "border-[#c8d0da]"}`}>
                <input
                  id="emp-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={form.password}
                  onChange={(e) => set("password", e.target.value)}
                  className="h-11 w-full rounded-xl border-0 bg-transparent px-3 text-sm outline-none"
                />
                <button type="button" onClick={() => setShowPassword((v) => !v)} className="px-3 text-[#5c6775]" aria-label={showPassword ? "Hide password" : "Show password"}>
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {errors.password ? <p className="mt-1 text-xs text-rose-600">{errors.password}</p> : null}
            </div>
            <label className="flex items-center gap-2 text-sm text-[#141820]">
              <input type="checkbox" checked={form.isActive} onChange={(e) => set("isActive", e.target.checked)} className="h-4 w-4 accent-[#4f6f9a]" />
              Active (can sign in)
            </label>
          </div>

          <div className="flex gap-2">
            <button type="submit" disabled={saving || uploading} className={primaryButton}>
              {saving && <Loader2 className="w-4 h-4 animate-spin" />} {isNew ? "Add employee" : "Save"}
            </button>
            <button type="button" onClick={() => navigate("/food/restaurant/employees")} className={secondaryButton}>Cancel</button>
          </div>
        </form>
      )}
    </StaffPage>
  )
}
