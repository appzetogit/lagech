import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import {
  Download,
  FileSpreadsheet,
  FileText,
  Gift,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "@food/components/admin/theme/icons"
import { adminAPI } from "@food/api"
import { loadRestaurantOptions } from "@food/api/adminCatalogExtras"
import { Card, Field, PageFrame, Switch, errorMessage, inputClass } from "./system/SettingsUi"

/**
 * Promotions -> Coupons, laid out like the old panel's (6amMart) page: the
 * "Add New Coupon" form on top and the coupon list below it. Editing loads a
 * coupon back into the same form.
 *
 * Checkout rules for each type live in the backend (couponRules.js); this page
 * only collects the fields.
 */

const COUPON_TYPES = [
  { value: "store_wise", label: "Store wise" },
  { value: "zone_wise", label: "Zone wise" },
  { value: "free_delivery", label: "Free delivery" },
  { value: "first_order", label: "First order" },
  { value: "default", label: "Default" },
]
const TYPE_LABEL = Object.fromEntries(COUPON_TYPES.map((t) => [t.value, t.label]))

/** A date as the 'YYYY-MM-DD' calendar day in India. */
const istDay = (value) => {
  if (!value) return ""
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ""
  return new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10)
}
const todayIst = () => istDay(new Date())
const showDay = (value) => {
  const day = istDay(value)
  if (!day) return "-"
  const [y, m, d] = day.split("-")
  return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}
const rupees = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`

const generateCode = () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  const bytes = new Uint8Array(10)
  window.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")
}

const emptyForm = () => ({
  title: "",
  couponType: "default",
  restaurantId: "",
  zoneIds: [],
  allCustomers: true,
  customers: [],
  couponCode: "",
  perUserLimit: "",
  startDate: todayIst(),
  endDate: "",
  discountType: "amount",
  discountValue: "",
  maxDiscount: "",
  minOrderValue: "",
  restaurantBearPercentage: "0",
})

const formFromCoupon = (c) => ({
  title: c.title || "",
  couponType: c.couponType || "default",
  restaurantId: c.restaurantIds?.[0] || "",
  zoneIds: c.zoneIds || [],
  allCustomers: c.customerScope !== "specific",
  customers: (c.customers || []).map((u) => ({ id: u.id, name: u.name || "", phone: u.phone || "" })),
  couponCode: c.couponCode || "",
  perUserLimit: c.perUserLimit ? String(c.perUserLimit) : "",
  startDate: istDay(c.startDate),
  endDate: istDay(c.endDate),
  discountType: c.discountType === "percentage" ? "percent" : "amount",
  discountValue: c.couponType === "free_delivery" ? "" : String(c.discountValue ?? ""),
  maxDiscount: c.maxDiscount ? String(c.maxDiscount) : "",
  minOrderValue: c.minOrderValue ? String(c.minOrderValue) : "",
  restaurantBearPercentage: String(c.restaurantBearPercentage ?? 0),
})

const discountText = (c) => {
  if (c.couponType === "free_delivery") return "Free delivery"
  return c.discountType === "percentage" ? `${c.discountValue}%` : rupees(c.discountValue)
}

/* ── export ─────────────────────────────────────────────────────────────── */

const EXPORT_HEADERS = ["Sl", "Title", "Code", "Type", "Total Uses", "Min Purchase", "Max Discount", "Discount", "Discount Type", "Start Date", "Expire Date", "Status"]
const exportRows = (coupons) =>
  coupons.map((c, i) => [
    i + 1,
    c.title || "",
    c.couponCode,
    TYPE_LABEL[c.couponType] || c.couponType,
    c.totalUses,
    c.minOrderValue,
    c.discountType === "percentage" && c.maxDiscount ? c.maxDiscount : "",
    c.couponType === "free_delivery" ? "" : c.discountValue,
    c.couponType === "free_delivery" ? "Free delivery" : c.discountType === "percentage" ? "Percent" : "Amount",
    istDay(c.startDate),
    istDay(c.endDate),
    c.isExpired ? "Expired" : c.isActive ? "Active" : "Inactive",
  ])

const download = (blob, name) => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

const exportCsv = (coupons) => {
  const cell = (v) => {
    const s = String(v ?? "")
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [EXPORT_HEADERS, ...exportRows(coupons)].map((r) => r.map(cell).join(","))
  // BOM so Excel reads ₹ and emoji in titles correctly.
  download(new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" }), `coupons_${todayIst()}.csv`)
}

const exportExcel = (coupons) => {
  const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const html = `<html><head><meta charset="utf-8"></head><body><table border="1"><thead><tr>${EXPORT_HEADERS.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${exportRows(coupons)
    .map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></body></html>`
  download(new Blob([html], { type: "application/vnd.ms-excel;charset=utf-8" }), `coupons_${todayIst()}.xls`)
}

/* ── customer picker ────────────────────────────────────────────────────── */

function CustomerPicker({ all, selected, onChange }) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    const close = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [])

  useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        setLoading(true)
        const res = await adminAPI.getCustomers({ search: query.trim() || undefined, limit: 20, page: 1 })
        const list = res?.data?.data?.customers || []
        if (!cancelled) {
          setResults(
            list
              .map((c) => ({ id: String(c.id || c._id || ""), name: c.name || "", phone: c.phone || "" }))
              .filter((c) => c.id),
          )
        }
      } catch {
        if (!cancelled) setResults([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query, open])

  const chosen = new Set(selected.map((c) => c.id))
  const label = (c) => [c.name, c.phone].filter(Boolean).join(" · ") || "Unnamed customer"

  return (
    <div ref={rootRef} className="relative">
      <div
        className={`${inputClass} flex min-h-[38px] flex-wrap items-center gap-1.5 cursor-text`}
        onClick={() => setOpen(true)}
      >
        {all ? (
          <span className="inline-flex items-center gap-1 rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
            All customers
          </span>
        ) : (
          selected.map((c) => (
            <span key={c.id} className="inline-flex items-center gap-1 rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
              {label(c)}
              <button
                type="button"
                aria-label={`Remove ${label(c)}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onChange({ all: false, selected: selected.filter((x) => x.id !== c.id) })
                }}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))
        )}
        <input
          className="min-w-[8rem] flex-1 border-0 p-0 text-sm outline-none focus:ring-0"
          placeholder={all || selected.length ? "" : "Search by name or phone"}
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search customers"
        />
      </div>
      {open && (
        <div className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
          <button
            type="button"
            onClick={() => {
              onChange({ all: true, selected: [] })
              setOpen(false)
            }}
            className={`flex w-full items-center rounded px-3 py-2 text-left text-sm ${all ? "bg-blue-50 text-blue-700" : "hover:bg-slate-50"}`}
          >
            All customers
          </button>
          {loading ? (
            <div className="px-3 py-2 text-xs text-slate-500">Searching...</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-500">No customers found</div>
          ) : (
            results.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  const next = chosen.has(c.id) ? selected.filter((x) => x.id !== c.id) : [...selected, c]
                  onChange({ all: next.length === 0, selected: next })
                }}
                className={`flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm ${chosen.has(c.id) && !all ? "bg-blue-50 text-blue-700" : "hover:bg-slate-50"}`}
              >
                <span>{label(c)}</span>
                {chosen.has(c.id) && !all && <span className="text-xs">Selected</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

/* ── page ───────────────────────────────────────────────────────────────── */

export default function Coupons() {
  const [form, setForm] = useState(emptyForm)
  const [editingId, setEditingId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [coupons, setCoupons] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [appliedSearch, setAppliedSearch] = useState("")
  const [restaurants, setRestaurants] = useState([])
  const [zones, setZones] = useState([])
  const [busyId, setBusyId] = useState("")
  const [exportOpen, setExportOpen] = useState(false)
  const formRef = useRef(null)
  const exportRef = useRef(null)

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }))

  const load = useCallback(async () => {
    try {
      setLoading(true)
      const res = await adminAPI.getAllOffers(appliedSearch ? { search: appliedSearch } : {})
      setCoupons(res?.data?.data?.offers || [])
    } catch (err) {
      toast.error(errorMessage(err, "Failed to load coupons"))
    } finally {
      setLoading(false)
    }
  }, [appliedSearch])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    loadRestaurantOptions(adminAPI)
      .then((list) => setRestaurants(list.filter((r) => !r.status || r.status === "approved")))
      .catch(() => setRestaurants([]))
    adminAPI
      .getZones({ limit: 1000 })
      .then((res) => {
        const list = res?.data?.data?.zones || res?.data?.data || []
        setZones((Array.isArray(list) ? list : []).map((z) => ({ id: String(z.id || z._id), name: z.name || z.zoneName || "" })))
      })
      .catch(() => setZones([]))
  }, [])

  useEffect(() => {
    const close = (e) => {
      if (exportRef.current && !exportRef.current.contains(e.target)) setExportOpen(false)
    }
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [])

  const freeDelivery = form.couponType === "free_delivery"
  const percent = form.discountType === "percent"

  const reset = () => {
    setForm(emptyForm())
    setEditingId(null)
  }

  const startEdit = async (coupon) => {
    try {
      setBusyId(coupon.id)
      const res = await adminAPI.getAdminOffer(coupon.id)
      const full = res?.data?.data?.offer || coupon
      setForm(formFromCoupon(full))
      setEditingId(coupon.id)
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    } catch (err) {
      toast.error(errorMessage(err, "Could not load the coupon"))
    } finally {
      setBusyId("")
    }
  }

  const submit = async (e) => {
    e.preventDefault()
    if (form.couponType === "store_wise" && !form.restaurantId) return toast.error("Select a restaurant")
    if (form.couponType === "zone_wise" && form.zoneIds.length === 0) return toast.error("Select at least one zone")
    if (!form.allCustomers && form.customers.length === 0) return toast.error("Select customers, or choose all customers")
    if (!form.startDate || !form.endDate) return toast.error("Start date and expire date are required")
    if (form.endDate < form.startDate) return toast.error("Expire date must be on or after the start date")

    const body = {
      title: form.title.trim(),
      couponType: form.couponType,
      restaurantId: form.couponType === "store_wise" ? form.restaurantId : undefined,
      zoneIds: form.couponType === "zone_wise" ? form.zoneIds : [],
      customerScope: form.allCustomers ? "all" : "specific",
      customerIds: form.allCustomers ? [] : form.customers.map((c) => c.id),
      couponCode: form.couponCode.trim(),
      perUserLimit: form.perUserLimit === "" ? undefined : form.perUserLimit,
      startDate: form.startDate,
      endDate: form.endDate,
      discountType: freeDelivery ? undefined : form.discountType,
      discountValue: freeDelivery ? undefined : form.discountValue,
      maxDiscount: !freeDelivery && percent && form.maxDiscount !== "" ? form.maxDiscount : undefined,
      minOrderValue: form.minOrderValue === "" ? 0 : form.minOrderValue,
    }
    if (form.couponType === "store_wise") {
      const share = Number(form.restaurantBearPercentage) || 0
      body.restaurantBearPercentage = share
      body.adminBearPercentage = 100 - share
    } else if (!editingId) {
      body.adminBearPercentage = 100
      body.restaurantBearPercentage = 0
    }

    try {
      setSaving(true)
      if (editingId) {
        await adminAPI.updateAdminOffer(editingId, body)
        toast.success("Coupon updated")
      } else {
        await adminAPI.createAdminOffer(body)
        toast.success("Coupon added")
      }
      reset()
      load()
    } catch (err) {
      toast.error(errorMessage(err, "Could not save the coupon"))
    } finally {
      setSaving(false)
    }
  }

  const toggleStatus = async (coupon) => {
    const next = coupon.isActive ? "inactive" : "active"
    try {
      setBusyId(coupon.id)
      await adminAPI.setAdminOfferStatus(coupon.id, next)
      setCoupons((list) => list.map((c) => (c.id === coupon.id ? { ...c, isActive: next === "active" } : c)))
      toast.success(next === "active" ? "Coupon switched on" : "Coupon switched off")
    } catch (err) {
      toast.error(errorMessage(err, "Could not change the status"))
    } finally {
      setBusyId("")
    }
  }

  const remove = async (coupon) => {
    if (!window.confirm(`Delete coupon ${coupon.couponCode}? This cannot be undone.`)) return
    try {
      setBusyId(coupon.id)
      await adminAPI.deleteAdminOffer(coupon.id)
      if (editingId === coupon.id) reset()
      setCoupons((list) => list.filter((c) => c.id !== coupon.id))
      toast.success("Coupon deleted")
    } catch (err) {
      toast.error(errorMessage(err, "Could not delete the coupon"))
    } finally {
      setBusyId("")
    }
  }

  const zoneChoices = useMemo(() => zones.filter((z) => z.id), [zones])

  return (
    <PageFrame
      icon={Gift}
      title="Coupons"
      description="Discount codes customers enter at checkout. A coupon works between its start and expire dates while it is switched on."
    >
      <div ref={formRef}>
        <Card title={editingId ? "Edit Coupon" : "Add New Coupon"}>
          <form onSubmit={submit} className="space-y-5">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              <Field label="Title">
                <input className={inputClass} maxLength={191} value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="New coupon" required />
              </Field>
              <Field label="Coupon type">
                <select
                  className={inputClass}
                  value={form.couponType}
                  onChange={(e) => setForm((f) => ({ ...f, couponType: e.target.value }))}
                >
                  {COUPON_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </Field>

              {form.couponType === "store_wise" && (
                <Field label="Restaurant">
                  <select className={inputClass} value={form.restaurantId} onChange={(e) => set("restaurantId", e.target.value)} required>
                    <option value="">Select restaurant</option>
                    {restaurants.map((r) => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                </Field>
              )}

              {form.couponType === "zone_wise" && (
                <div className="space-y-1">
                  <span className="block text-xs font-semibold text-slate-600">Zone</span>
                  <div className="max-h-32 overflow-y-auto rounded-lg border border-slate-300 bg-white px-3 py-2">
                    {zoneChoices.length === 0 ? (
                      <p className="text-xs text-slate-500">No zones found</p>
                    ) : (
                      zoneChoices.map((z) => (
                        <label key={z.id} className="flex items-center gap-2 py-0.5 text-sm text-slate-700">
                          <input
                            type="checkbox"
                            checked={form.zoneIds.includes(z.id)}
                            onChange={(e) =>
                              set("zoneIds", e.target.checked ? [...form.zoneIds, z.id] : form.zoneIds.filter((id) => id !== z.id))
                            }
                          />
                          {z.name}
                        </label>
                      ))
                    )}
                  </div>
                </div>
              )}

              <div className="space-y-1">
                <span className="block text-xs font-semibold text-slate-600">Select customer</span>
                <CustomerPicker
                  all={form.allCustomers}
                  selected={form.customers}
                  onChange={({ all, selected }) => setForm((f) => ({ ...f, allCustomers: all, customers: selected }))}
                />
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="block text-xs font-semibold text-slate-600">Code</span>
                  <button type="button" onClick={() => set("couponCode", generateCode())} className="text-xs font-semibold text-blue-600 hover:underline">
                    Generate Code
                  </button>
                </div>
                <input
                  className={inputClass}
                  maxLength={64}
                  value={form.couponCode}
                  onChange={(e) => set("couponCode", e.target.value.toUpperCase())}
                  placeholder="e.g. SAVE50"
                  aria-label="Code"
                  required
                />
              </div>

              <Field label="Limit for same user" hint="Leave empty for no limit">
                <input type="number" min="1" step="1" className={inputClass} value={form.perUserLimit} onChange={(e) => set("perUserLimit", e.target.value)} placeholder="e.g. 1" />
              </Field>
              <Field label="Start date">
                <input type="date" className={inputClass} value={form.startDate} onChange={(e) => set("startDate", e.target.value)} required />
              </Field>
              <Field label="Expire date">
                <input type="date" className={inputClass} min={form.startDate || undefined} value={form.endDate} onChange={(e) => set("endDate", e.target.value)} required />
              </Field>

              {!freeDelivery && (
                <>
                  <Field label="Discount type">
                    <select className={inputClass} value={form.discountType} onChange={(e) => setForm((f) => ({ ...f, discountType: e.target.value, maxDiscount: e.target.value === "percent" ? f.maxDiscount : "" }))}>
                      <option value="amount">Amount (₹)</option>
                      <option value="percent">Percent (%)</option>
                    </select>
                  </Field>
                  <Field label={percent ? "Discount (%)" : "Discount (₹)"}>
                    <input
                      type="number"
                      min="0.01"
                      max={percent ? 100 : undefined}
                      step="0.01"
                      className={inputClass}
                      value={form.discountValue}
                      onChange={(e) => set("discountValue", e.target.value)}
                      required
                    />
                  </Field>
                  <Field label="Max discount (₹)" hint={percent ? "Leave empty for no cap" : "Only for a percent discount"}>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className={`${inputClass} disabled:bg-slate-100`}
                      value={form.maxDiscount}
                      onChange={(e) => set("maxDiscount", e.target.value)}
                      disabled={!percent}
                    />
                  </Field>
                </>
              )}

              <Field label="Min purchase (₹)" hint="On the item subtotal">
                <input type="number" min="0" step="0.01" className={inputClass} value={form.minOrderValue} onChange={(e) => set("minOrderValue", e.target.value)} placeholder="0" />
              </Field>

              {form.couponType === "store_wise" && !freeDelivery && (
                <Field label="Restaurant pays (%)" hint="Share of the discount taken from the restaurant; the platform pays the rest">
                  <input type="number" min="0" max="100" step="1" className={inputClass} value={form.restaurantBearPercentage} onChange={(e) => set("restaurantBearPercentage", e.target.value)} />
                </Field>
              )}
            </div>

            {freeDelivery && (
              <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700">
                Free delivery takes the delivery fee and the GST on it off the order. Item GST and the platform fee are still charged, and the rider is paid as usual.
              </p>
            )}

            <div className="flex justify-end gap-2">
              <button type="button" onClick={reset} className="rounded-lg border border-slate-300 px-5 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                {editingId ? "Cancel" : "Reset"}
              </button>
              <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                {editingId ? "Update" : "Submit"}
              </button>
            </div>
          </form>
        </Card>
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-slate-900">Coupon List</h2>
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700">{coupons.length}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <form
              onSubmit={(e) => {
                e.preventDefault()
                setAppliedSearch(search.trim())
              }}
              className="flex items-center rounded-lg border border-slate-300 bg-white"
            >
              <input
                className="w-56 rounded-l-lg px-3 py-2 text-sm outline-none"
                placeholder="Search by title or code"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search coupons"
              />
              <button type="submit" className="px-3 text-slate-500 hover:text-blue-600" aria-label="Search">
                <Search className="w-4 h-4" />
              </button>
            </form>
            <button type="button" onClick={load} className="rounded-lg border border-slate-300 p-2 text-slate-600 hover:bg-slate-50" title="Refresh" aria-label="Refresh">
              <RefreshCw className="w-4 h-4" />
            </button>
            <div ref={exportRef} className="relative">
              <button
                type="button"
                onClick={() => setExportOpen((o) => !o)}
                disabled={!coupons.length}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                <Download className="w-4 h-4" /> Export
              </button>
              {exportOpen && (
                <div className="absolute right-0 z-20 mt-1 w-40 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
                  <button type="button" onClick={() => { exportExcel(coupons); setExportOpen(false) }} className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-slate-50">
                    <FileSpreadsheet className="w-4 h-4" /> Excel
                  </button>
                  <button type="button" onClick={() => { exportCsv(coupons); setExportOpen(false) }} className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-slate-50">
                    <FileText className="w-4 h-4" /> CSV
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          {loading ? (
            <div className="py-16 text-center"><Loader2 className="mx-auto w-6 h-6 animate-spin text-slate-400" /></div>
          ) : !coupons.length ? (
            <p className="py-16 text-center text-sm text-slate-500">{appliedSearch ? "No coupons match your search." : "No coupons yet."}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase text-slate-600">
                  {["Sl", "Title", "Code", "Type", "Total Uses", "Min Purchase", "Max Discount", "Discount", "Discount Type", "Start Date", "Expire Date", "Status", "Action"].map((h) => (
                    <th key={h} className={`whitespace-nowrap px-3 py-3 font-semibold ${h === "Action" ? "text-right" : ""}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {coupons.map((c, i) => (
                  <tr key={c.id} className="border-b border-slate-100 align-middle">
                    <td className="px-3 py-3 text-slate-500">{i + 1}</td>
                    <td className="px-3 py-3">
                      <p className="max-w-[14rem] truncate font-medium text-slate-800" title={c.title}>{c.title || "-"}</p>
                      {c.couponType === "store_wise" && <p className="max-w-[14rem] truncate text-xs text-slate-500" title={c.restaurantName}>{c.restaurantName}</p>}
                      {c.couponType === "zone_wise" && <p className="max-w-[14rem] truncate text-xs text-slate-500">{(c.zones || []).map((z) => z.name).filter(Boolean).join(", ")}</p>}
                      {c.customerScope === "specific" && <p className="text-xs text-slate-500">{c.customerCount} customer{c.customerCount === 1 ? "" : "s"}</p>}
                      {c.createdByRole === "RESTAURANT" && <p className="text-xs text-slate-500">By restaurant</p>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 font-mono text-xs text-slate-800">{c.couponCode}</td>
                    <td className="whitespace-nowrap px-3 py-3">{TYPE_LABEL[c.couponType] || c.couponType}</td>
                    <td className="px-3 py-3">{c.totalUses}</td>
                    <td className="whitespace-nowrap px-3 py-3">{rupees(c.minOrderValue)}</td>
                    <td className="whitespace-nowrap px-3 py-3">{c.discountType === "percentage" && c.maxDiscount ? rupees(c.maxDiscount) : "-"}</td>
                    <td className="whitespace-nowrap px-3 py-3">{discountText(c)}</td>
                    <td className="whitespace-nowrap px-3 py-3">{c.couponType === "free_delivery" ? "-" : c.discountType === "percentage" ? "Percent" : "Amount"}</td>
                    <td className="whitespace-nowrap px-3 py-3">{showDay(c.startDate)}</td>
                    <td className="whitespace-nowrap px-3 py-3">
                      {showDay(c.endDate)}
                      {c.isExpired && <span className="ml-1.5 rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-600">Expired</span>}
                    </td>
                    <td className="px-3 py-3">
                      <Switch checked={c.isActive} disabled={busyId === c.id} onChange={() => toggleStatus(c)} label={`Switch ${c.couponCode} ${c.isActive ? "off" : "on"}`} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right">
                      <button type="button" onClick={() => startEdit(c)} disabled={busyId === c.id} className="rounded p-1.5 text-blue-600 hover:bg-blue-50" title="Edit" aria-label={`Edit ${c.couponCode}`}>
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button type="button" onClick={() => remove(c)} disabled={busyId === c.id} className="rounded p-1.5 text-rose-600 hover:bg-rose-50" title="Delete" aria-label={`Delete ${c.couponCode}`}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </PageFrame>
  )
}
