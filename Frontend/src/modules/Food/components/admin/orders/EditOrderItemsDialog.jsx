import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Loader2, Plus, Search, Trash2, X } from "@food/components/admin/theme/icons"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@food/components/ui/dialog"
import { adminAPI } from "@food/api"

/**
 * Order Details "Edit", as on the old panel: change quantities, remove lines,
 * add dishes from the same restaurant's menu (size + add-ons). Every number
 * shown comes from the server (PUT /items?preview=1), priced by the same code
 * that priced the order, so what is saved is what was shown.
 */

const rupee = (value) => {
  const v = Math.round((Number(value) || 0) * 100) / 100
  return `₹ ${Number.isInteger(v) ? v : v.toFixed(2)}`
}

/** Same dish, size and add-ons = the same line. */
const lineKey = (l) => [l.itemId, l.variantId || "", [...(l.addons || [])].sort().join("+")].join("|")

const fromOrderItem = (it) => ({
  key: "",
  itemId: String(it.itemCampaignId || it.itemId),
  campaignId: it.itemCampaignId || "",
  variantId: it.variantId || "",
  variantName: it.variantName || "",
  name: it.name,
  quantity: Number(it.quantity) || 1,
  addons: (Array.isArray(it.addons) ? it.addons : []).map((a) => String(a.addonId || a.id || a.name || "")).filter(Boolean),
  addonNames: (Array.isArray(it.addons) ? it.addons : []).map((a) => a.name).filter(Boolean),
  unitPrice: Number(it.price) || 0,
  notes: it.notes || "",
  image: it.image || "",
})

const toPayload = (lines) =>
  lines.map((l) => ({
    itemId: l.itemId,
    ...(l.campaignId ? { campaignId: l.campaignId } : {}),
    ...(l.variantId ? { variantId: l.variantId } : {}),
    quantity: l.quantity,
    addons: l.addons,
    ...(l.notes ? { notes: l.notes } : {}),
  }))

/** Size and add-ons for one dish before it is added. */
function DishPicker({ dish, onAdd, onCancel }) {
  const [variantId, setVariantId] = useState(dish.variants?.[0]?.id || "")
  const [picked, setPicked] = useState([])
  const groups = dish.addonGroups || []

  const toggle = (group, optionId) => {
    setPicked((cur) => {
      if (cur.includes(optionId)) return cur.filter((id) => id !== optionId)
      const inGroup = group.options.map((o) => o.id)
      const already = cur.filter((id) => inGroup.includes(id))
      if (group.maxSelect <= 1) return [...cur.filter((id) => !inGroup.includes(id)), optionId]
      if (already.length >= group.maxSelect) return cur
      return [...cur, optionId]
    })
  }
  const missing = groups.find((g) => g.minSelect > 0 && picked.filter((id) => g.options.some((o) => o.id === id)).length < g.minSelect)
  const variant = dish.variants?.find((v) => v.id === variantId)
  const addonTotal = groups.flatMap((g) => g.options).filter((o) => picked.includes(o.id)).reduce((s, o) => s + (Number(o.price) || 0), 0)

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-3 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-slate-900">{dish.name}</p>
        <button type="button" onClick={onCancel} className="text-slate-500 hover:text-slate-800" aria-label="Close">
          <X className="w-4 h-4" />
        </button>
      </div>
      {dish.variants?.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-slate-600">Size</p>
          <div className="flex flex-wrap gap-2">
            {dish.variants.map((v) => (
              <label key={v.id} className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${variantId === v.id ? "border-blue-500 bg-white" : "border-slate-200 bg-white/60"}`}>
                <input type="radio" name={`size-${dish.id}`} checked={variantId === v.id} onChange={() => setVariantId(v.id)} />
                {v.name} · {rupee(v.price)}
              </label>
            ))}
          </div>
        </div>
      )}
      {groups.map((g) => (
        <div key={g.name || g.title}>
          <p className="mb-1 text-xs font-medium text-slate-600">{g.title} <span className="font-normal text-slate-400">({g.selectionLabel})</span></p>
          <div className="flex flex-wrap gap-2">
            {g.options.map((o) => (
              <label key={o.id} className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${picked.includes(o.id) ? "border-blue-500 bg-white" : "border-slate-200 bg-white/60"}`}>
                <input type={g.maxSelect <= 1 ? "radio" : "checkbox"} name={`addon-${dish.id}-${g.name}`} checked={picked.includes(o.id)} onChange={() => toggle(g, o.id)} />
                {o.name} · {rupee(o.price)}
              </label>
            ))}
          </div>
        </div>
      ))}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-slate-600">{rupee((variant ? variant.price : dish.price) + addonTotal)} each</span>
        <button
          type="button"
          disabled={Boolean(missing)}
          title={missing ? `Choose from ${missing.title}` : ""}
          onClick={() => onAdd({
            itemId: dish.id,
            campaignId: "",
            variantId: variant?.id || "",
            variantName: variant?.name || "",
            name: dish.name,
            quantity: 1,
            addons: picked,
            addonNames: groups.flatMap((g) => g.options).filter((o) => picked.includes(o.id)).map((o) => o.name),
            unitPrice: (variant ? variant.price : dish.price) + addonTotal,
            notes: "",
            image: dish.image,
          })}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          Add to order
        </button>
      </div>
    </div>
  )
}

export default function EditOrderItemsDialog({ order, onClose, onSaved }) {
  const id = order._id || order.id
  const initial = useMemo(() => (order.items || []).map(fromOrderItem).map((l) => ({ ...l, key: lineKey(l) })), [order])
  const [lines, setLines] = useState(initial)
  const [menu, setMenu] = useState(null)
  const [search, setSearch] = useState("")
  const [picking, setPicking] = useState(null)
  const [preview, setPreview] = useState(null)
  const [previewError, setPreviewError] = useState("")
  const [previewing, setPreviewing] = useState(false)
  const [saving, setSaving] = useState(false)
  const seq = useRef(0)

  const changed = JSON.stringify(toPayload(lines)) !== JSON.stringify(toPayload(initial))

  useEffect(() => {
    adminAPI
      .getOrderEditMenu(id)
      .then((res) => setMenu(res?.data?.data?.items || []))
      .catch(() => setMenu([]))
  }, [id])

  // Server-side preview, debounced; the latest request wins.
  useEffect(() => {
    if (!changed || lines.length === 0) {
      setPreview(null)
      setPreviewError(lines.length === 0 ? "At least one item must remain on the order." : "")
      return undefined
    }
    const mine = ++seq.current
    setPreviewing(true)
    const timer = setTimeout(async () => {
      try {
        const res = await adminAPI.editOrderItems(id, toPayload(lines), { preview: true })
        if (mine !== seq.current) return
        setPreview(res?.data?.data?.edit || null)
        setPreviewError("")
      } catch (err) {
        if (mine !== seq.current) return
        setPreview(null)
        setPreviewError(err?.response?.data?.message || "Could not price these items")
      } finally {
        if (mine === seq.current) setPreviewing(false)
      }
    }, 400)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, changed, id])

  const setQty = (key, quantity) =>
    setLines((cur) => cur.map((l) => (l.key === key ? { ...l, quantity: Math.max(1, Math.min(100, quantity)) } : l)))
  const remove = (key) => setLines((cur) => cur.filter((l) => l.key !== key))
  const add = (line) => {
    const key = lineKey(line)
    setLines((cur) => (cur.some((l) => l.key === key)
      ? cur.map((l) => (l.key === key ? { ...l, quantity: Math.min(100, l.quantity + 1) } : l))
      : [...cur, { ...line, key }]))
    setPicking(null)
    setSearch("")
  }
  const choose = (dish) => {
    if (dish.variants?.length || dish.addonGroups?.length) setPicking(dish)
    else add({ itemId: dish.id, campaignId: "", variantId: "", variantName: "", name: dish.name, quantity: 1, addons: [], addonNames: [], unitPrice: dish.price, notes: "", image: dish.image })
  }

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q || !menu) return []
    return menu.filter((d) => `${d.name} ${d.categoryName}`.toLowerCase().includes(q)).slice(0, 20)
  }, [menu, search])

  const save = async () => {
    if (!changed || saving || previewError || previewing) return
    setSaving(true)
    try {
      const res = await adminAPI.editOrderItems(id, toPayload(lines))
      const edit = res?.data?.data?.edit
      toast.success(`Order updated. New total ${rupee(edit?.after?.total)}`)
      if (edit?.couponNote) toast.message(edit.couponNote)
      onSaved(res?.data?.data)
    } catch (err) {
      toast.error(err?.response?.data?.message || "Could not update the order")
    } finally {
      setSaving(false)
    }
  }

  // Unit prices from the server's pricing once a preview is in (same order as sent).
  const priced = preview?.items || null
  const before = preview?.before?.total ?? order.pricing?.total
  const after = preview?.after

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-w-2xl w-[calc(100vw-24px)] max-h-[92vh] overflow-y-auto bg-white p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>Edit order #{order.orderId}</DialogTitle>
          <DialogDescription>Change quantities, remove items or add dishes from this store. The customer, store and deliveryman are told about the change.</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {lines.map((l, index) => {
            const unit = priced?.[index]?.unitPrice ?? l.unitPrice
            return (
              <div key={l.key} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-900 break-words">{l.name}</p>
                  {(l.variantName || l.addonNames?.length > 0) && (
                    <p className="text-xs text-slate-500 break-words">
                      {[l.variantName && `Size: ${l.variantName}`, l.addonNames?.length && `Add-ons: ${l.addonNames.join(", ")}`].filter(Boolean).join(" · ")}
                    </p>
                  )}
                  <p className="text-xs text-slate-500">{rupee(unit)} each</p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex items-center rounded-lg border border-slate-300">
                    <button type="button" aria-label="Less" disabled={l.quantity <= 1} onClick={() => setQty(l.key, l.quantity - 1)} className="h-8 w-8 text-lg leading-none text-slate-700 disabled:opacity-40">−</button>
                    <span className="w-8 text-center text-sm font-semibold">{l.quantity}</span>
                    <button type="button" aria-label="More" disabled={l.quantity >= 100} onClick={() => setQty(l.key, l.quantity + 1)} className="h-8 w-8 text-lg leading-none text-slate-700 disabled:opacity-40">+</button>
                  </div>
                  <span className="w-20 text-right text-sm font-medium text-slate-900">{rupee(unit * l.quantity)}</span>
                  <button type="button" aria-label="Remove" onClick={() => remove(l.key)} disabled={lines.length <= 1} title={lines.length <= 1 ? "At least one item must remain" : "Remove"} className="flex h-8 w-8 items-center justify-center rounded-lg text-rose-600 hover:bg-rose-50 disabled:opacity-40">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        {/* Add item */}
        <div className="mt-2 space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPicking(null)
              }}
              placeholder={menu === null ? "Loading the menu…" : "Add item: search this store's menu"}
              disabled={menu === null}
              className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm"
            />
          </div>
          {picking ? (
            <DishPicker dish={picking} onAdd={add} onCancel={() => setPicking(null)} />
          ) : search.trim() && menu ? (
            matches.length === 0 ? (
              <p className="px-1 text-xs text-slate-500">No dish matches.</p>
            ) : (
              <div className="max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
                {matches.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    disabled={!d.isAvailable}
                    onClick={() => choose(d)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-slate-50 disabled:opacity-50"
                  >
                    {d.image ? <img src={d.image} alt="" className="h-9 w-9 shrink-0 rounded object-cover" /> : <span className="h-9 w-9 shrink-0 rounded bg-slate-100" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-slate-900">{d.name}</span>
                      <span className="block text-xs text-slate-500">
                        {d.variants?.length ? `from ${rupee(Math.min(...d.variants.map((v) => v.price)))}` : rupee(d.price)}
                        {!d.isAvailable && " · unavailable"}
                      </span>
                    </span>
                    <Plus className="w-4 h-4 shrink-0 text-blue-600" />
                  </button>
                ))}
              </div>
            )
          ) : null}
        </div>

        {/* New amounts, from the server */}
        <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm">
          {!changed ? (
            <p className="text-slate-500">Make a change to see the new total.</p>
          ) : previewError ? (
            <p className="text-rose-600">{previewError}</p>
          ) : previewing || !after ? (
            <p className="flex items-center gap-2 text-slate-500"><Loader2 className="w-4 h-4 animate-spin" /> Working out the new total…</p>
          ) : (
            <div className="space-y-1">
              {[
                ["Items", after.subtotal],
                after.discount > 0 && [`Discount${after.couponCode ? ` (${after.couponCode})` : ""}`, -after.discount],
                after.packagingFee > 0 && ["Extra packaging", after.packagingFee],
                after.tax > 0 && ["GST", after.tax],
                (after.deliveryFee > 0 || after.deliveryFeeGst > 0) && ["Delivery", after.deliveryFee + after.deliveryFeeGst],
                after.platformFee > 0 && ["Platform fee", after.platformFee],
                after.riderTip > 0 && ["Tip", after.riderTip],
              ].filter(Boolean).map(([label, amount]) => (
                <div key={label} className="flex justify-between gap-4 text-slate-600">
                  <span>{label}</span>
                  <span>{amount < 0 ? `- ${rupee(-amount)}` : rupee(amount)}</span>
                </div>
              ))}
              <div className="flex justify-between gap-4 border-t border-slate-200 pt-2 font-semibold text-slate-900">
                <span>New total</span>
                <span>{rupee(after.total)}</span>
              </div>
              <div className="flex justify-between gap-4 text-xs text-slate-500">
                <span>Was {rupee(before)}</span>
                <span>{preview.difference >= 0 ? "+" : "-"} {rupee(Math.abs(preview.difference))}</span>
              </div>
              {preview.couponNote && <p className="pt-1 text-xs text-amber-700">{preview.couponNote}</p>}
            </div>
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 pt-3 sm:flex-row sm:justify-end">
          <button type="button" onClick={onClose} disabled={saving} className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700">Cancel</button>
          <button
            type="button"
            onClick={save}
            disabled={!changed || saving || previewing || Boolean(previewError) || !after}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Save changes
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
