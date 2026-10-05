import { useEffect, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { Loader2, Upload, UserPlus, X } from "lucide-react"
import { toast } from "sonner"
import { adminAPI, uploadAPI } from "@food/api"
import { adminRiderExtrasAPI } from "@food/api/adminRiderExtras"

const EMPTY = {
  name: "",
  phone: "",
  email: "",
  zoneId: "",
  address: "",
  city: "",
  state: "",
  vehicleType: "",
  vehicleName: "",
  vehicleNumber: "",
  aadharNumber: "",
  panNumber: "",
  drivingLicenseNumber: "",
  profilePhoto: "",
  aadharPhoto: "",
  panPhoto: "",
  drivingLicensePhoto: "",
  bankAccountHolderName: "",
  bankAccountNumber: "",
  bankIfscCode: "",
  bankName: "",
  upiId: "",
}

const DOCUMENTS = [
  ["profilePhoto", "Profile photo", "food/delivery/profile"],
  ["aadharPhoto", "Aadhaar card", "food/delivery/aadhar"],
  ["panPhoto", "PAN card", "food/delivery/pan"],
  ["drivingLicensePhoto", "Driving licence", "food/delivery/license"],
]

const input =
  "w-full px-3 py-2.5 border border-slate-300 rounded-lg bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"

function Field({ label, required, hint, children }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-sm font-semibold text-slate-700">
        {label} {required && <span className="text-red-500">*</span>}
      </span>
      {children}
      {hint && <span className="block text-xs text-slate-500">{hint}</span>}
    </label>
  )
}

function Section({ number, title, note, children }) {
  return (
    <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
      <h2 className="text-lg font-semibold text-slate-900">
        {number}. {title}
      </h2>
      {note && <p className="text-sm text-slate-500 mt-1">{note}</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-5">{children}</div>
    </section>
  )
}

/** Add an approved delivery man directly; they log in to the rider app with this phone number. */
export default function AddDeliveryman() {
  const navigate = useNavigate()
  const [form, setForm] = useState(EMPTY)
  const [zones, setZones] = useState([])
  const [vehicles, setVehicles] = useState(null)
  const [uploading, setUploading] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    adminAPI
      .getZones({ isActive: true })
      .then((res) => {
        const list = res?.data?.data?.zones || []
        setZones(list.map((z) => ({ id: z.id || z._id, name: z.name || z.zoneName })).filter((z) => z.id))
      })
      .catch(() => toast.error("Failed to load zones"))
    adminRiderExtrasAPI
      .getVehicleCategories({ active: "true" })
      .then((res) => setVehicles(res?.data?.data?.categories || []))
      .catch(() => {
        setVehicles([])
        toast.error("Failed to load vehicle categories")
      })
  }, [])

  const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))

  const upload = async (key, folder, event) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return
    if (!file.type.startsWith("image/")) {
      toast.error("Choose an image file")
      return
    }
    try {
      setUploading(key)
      const res = await uploadAPI.uploadMedia(file, { folder })
      const url = res?.data?.data?.url
      if (!url) throw new Error("Upload failed")
      set(key, url)
    } catch (err) {
      toast.error(err?.response?.data?.message || "Upload failed")
    } finally {
      setUploading("")
    }
  }

  const submit = async (event) => {
    event.preventDefault()
    if (form.phone.replace(/\D/g, "").length !== 10) {
      toast.error("Enter a 10-digit phone number")
      return
    }
    try {
      setSaving(true)
      const res = await adminRiderExtrasAPI.createRider(form)
      const rider = res?.data?.data?.rider
      toast.success(`${rider?.name || "Delivery man"} added. They can log in to the rider app with ${rider?.phone || "this phone number"}.`)
      navigate("/admin/food/delivery-partners")
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to add the delivery man")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <form onSubmit={submit} className="max-w-5xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex items-center gap-3">
            <UserPlus className="w-5 h-5 text-teal-700" />
            <h1 className="text-2xl font-bold text-slate-900">Add Delivery Man</h1>
          </div>
          <p className="text-sm text-slate-600 mt-1 max-w-3xl">
            The delivery man is approved straight away and logs in to the rider app with this phone number by OTP. Each
            phone number and vehicle number can belong to only one delivery man.
          </p>
        </div>

        <Section number={1} title="General info">
          <Field label="Full name" required>
            <input className={input} value={form.name} maxLength={100} onChange={(e) => set("name", e.target.value)} required />
          </Field>
          <Field label="Phone" required hint="10-digit mobile number">
            <div className="flex">
              <span className="inline-flex items-center rounded-l-lg border border-r-0 border-slate-300 bg-slate-50 px-3 text-sm text-slate-600">+91</span>
              <input
                className={`${input} rounded-l-none`}
                inputMode="numeric"
                value={form.phone}
                maxLength={10}
                onChange={(e) => set("phone", e.target.value.replace(/\D/g, ""))}
                required
              />
            </div>
          </Field>
          <Field label="Email">
            <input type="email" className={input} value={form.email} onChange={(e) => set("email", e.target.value)} />
          </Field>
          <Field label="Zone" required>
            <select className={input} value={form.zoneId} onChange={(e) => set("zoneId", e.target.value)} required>
              <option value="">{zones.length ? "Choose a zone" : "No active zones"}</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>{z.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Address">
            <input className={input} value={form.address} maxLength={500} onChange={(e) => set("address", e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="City">
              <input className={input} value={form.city} maxLength={100} onChange={(e) => set("city", e.target.value)} />
            </Field>
            <Field label="State">
              <input className={input} value={form.state} maxLength={100} onChange={(e) => set("state", e.target.value)} />
            </Field>
          </div>
        </Section>

        <Section number={2} title="Vehicle">
          <Field label="Vehicle type" required>
            {vehicles === null ? (
              <div className="py-2"><Loader2 className="w-4 h-4 animate-spin text-slate-400" /></div>
            ) : vehicles.length ? (
              <select className={input} value={form.vehicleType} onChange={(e) => set("vehicleType", e.target.value)} required>
                <option value="">Choose a vehicle type</option>
                {vehicles.map((v) => (
                  <option key={v.id} value={v.type}>{v.type}</option>
                ))}
              </select>
            ) : (
              <p className="text-sm text-slate-600 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                No vehicle types are switched on.{" "}
                <Link to="/admin/food/delivery-partners/vehicle-categories" className="font-semibold text-blue-600 underline">
                  Add one under Vehicles Category
                </Link>{" "}
                first.
              </p>
            )}
          </Field>
          <Field label="Vehicle name / model">
            <input className={input} value={form.vehicleName} maxLength={100} onChange={(e) => set("vehicleName", e.target.value)} />
          </Field>
          <Field label="Vehicle number" hint="Registration number, e.g. MH12AB1234">
            <input className={`${input} uppercase`} value={form.vehicleNumber} maxLength={20} onChange={(e) => set("vehicleNumber", e.target.value)} />
          </Field>
        </Section>

        <Section number={3} title="Identity and documents">
          <Field label="Aadhaar number" hint="12 digits">
            <input className={input} inputMode="numeric" value={form.aadharNumber} maxLength={14} onChange={(e) => set("aadharNumber", e.target.value)} />
          </Field>
          <Field label="PAN number" hint="e.g. ABCDE1234F">
            <input className={`${input} uppercase`} value={form.panNumber} maxLength={10} onChange={(e) => set("panNumber", e.target.value)} />
          </Field>
          <Field label="Driving licence number">
            <input className={`${input} uppercase`} value={form.drivingLicenseNumber} maxLength={20} onChange={(e) => set("drivingLicenseNumber", e.target.value)} />
          </Field>
          <div className="md:col-span-2 grid grid-cols-2 lg:grid-cols-4 gap-4">
            {DOCUMENTS.map(([key, label, folder]) => (
              <div key={key} className="space-y-2">
                <span className="block text-sm font-semibold text-slate-700">{label}</span>
                <div className="relative aspect-[4/3] rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 overflow-hidden">
                  {form[key] ? (
                    <>
                      <img src={form[key]} alt={label} className="h-full w-full object-cover" />
                      <button
                        type="button"
                        onClick={() => set(key, "")}
                        className="absolute top-1.5 right-1.5 rounded-full bg-white/90 p-1 shadow"
                        aria-label={`Remove ${label}`}
                      >
                        <X className="w-3.5 h-3.5 text-slate-700" />
                      </button>
                    </>
                  ) : (
                    <label className="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-1 text-xs text-slate-500 hover:bg-slate-100">
                      {uploading === key ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
                      {uploading === key ? "Uploading…" : "Upload image"}
                      <input
                        type="file"
                        accept="image/*"
                        className="sr-only"
                        disabled={Boolean(uploading)}
                        onChange={(e) => upload(key, folder, e)}
                      />
                    </label>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section
          number={4}
          title="Payout details"
          note="Where disbursements are paid. Enter a bank account (number and IFSC) or a UPI id; without either the delivery man is left out of disbursements."
        >
          <Field label="Account holder name">
            <input className={input} value={form.bankAccountHolderName} maxLength={100} onChange={(e) => set("bankAccountHolderName", e.target.value)} />
          </Field>
          <Field label="Bank name">
            <input className={input} value={form.bankName} maxLength={100} onChange={(e) => set("bankName", e.target.value)} />
          </Field>
          <Field label="Account number">
            <input className={input} inputMode="numeric" value={form.bankAccountNumber} maxLength={20} onChange={(e) => set("bankAccountNumber", e.target.value.replace(/\D/g, ""))} />
          </Field>
          <Field label="IFSC">
            <input className={`${input} uppercase`} value={form.bankIfscCode} maxLength={11} onChange={(e) => set("bankIfscCode", e.target.value)} />
          </Field>
          <Field label="UPI id">
            <input className={input} value={form.upiId} maxLength={100} onChange={(e) => set("upiId", e.target.value.trim())} />
          </Field>
        </Section>

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={() => setForm(EMPTY)}
            className="rounded-lg border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Reset
          </button>
          <button
            type="submit"
            disabled={saving || Boolean(uploading) || !vehicles?.length}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />} Add delivery man
          </button>
        </div>
      </form>
    </div>
  )
}
