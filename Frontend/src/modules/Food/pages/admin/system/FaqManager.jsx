import { useEffect, useState } from "react"
import { ChevronDown, ChevronUp, HelpCircle, Loader2, Pencil, Plus, Search, Trash2 } from "@food/components/admin/theme/icons"
import { toast } from "sonner"
import { adminSystemExtrasAPI } from "@food/api/adminSystemExtras"
import { PageFrame, Card, Field, Switch, Loading, inputClass, errorMessage, formatDateTime } from "./SettingsUi"

const AUDIENCES = [
  { value: "", label: "Everyone" },
  { value: "customer", label: "Customer" },
  { value: "restaurant", label: "Restaurant" },
  { value: "rider", label: "Delivery man" },
]
const audienceLabel = (value) => AUDIENCES.find((a) => a.value === (value || ""))?.label || "Everyone"

const EMPTY = { question: "", answer: "", audience: "customer", isActive: true }

/**
 * The old panel's FAQ list: questions and answers shown on the customer help
 * page and handed to the apps (GET /food/faqs?audience=...). Switched-off
 * questions are kept but not shown; the order here is the order shown.
 */
export default function FaqManager() {
  const [faqs, setFaqs] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState(EMPTY)
  const [editingId, setEditingId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [moving, setMoving] = useState(false)
  const [audience, setAudience] = useState("all")
  const [search, setSearch] = useState("")

  const load = async () => {
    try {
      setLoading(true)
      const res = await adminSystemExtrasAPI.getFaqs()
      setFaqs(res?.data?.data?.faqs || [])
    } catch (err) {
      toast.error(errorMessage(err, "Failed to load FAQs"))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const reset = () => {
    setForm(EMPTY)
    setEditingId(null)
  }

  const save = async (e) => {
    e.preventDefault()
    try {
      setSaving(true)
      if (editingId) await adminSystemExtrasAPI.updateFaq(editingId, form)
      else await adminSystemExtrasAPI.createFaq(form)
      toast.success(editingId ? "FAQ saved" : "FAQ added")
      reset()
      load()
    } catch (err) {
      toast.error(errorMessage(err, "Failed to save"))
    } finally {
      setSaving(false)
    }
  }

  const edit = (faq) => {
    setEditingId(faq.id)
    setForm({ question: faq.question, answer: faq.answer, audience: faq.audience || "", isActive: faq.isActive })
    window.scrollTo({ top: 0, behavior: "smooth" })
  }

  const toggle = async (faq, isActive) => {
    try {
      await adminSystemExtrasAPI.updateFaq(faq.id, { isActive })
      setFaqs((list) => list.map((f) => (f.id === faq.id ? { ...f, isActive } : f)))
    } catch (err) {
      toast.error(errorMessage(err, "Failed to update"))
    }
  }

  const remove = async (faq) => {
    if (!window.confirm(`Delete "${faq.question}"?`)) return
    try {
      await adminSystemExtrasAPI.deleteFaq(faq.id)
      if (editingId === faq.id) reset()
      setFaqs((list) => list.filter((f) => f.id !== faq.id))
      toast.success("FAQ deleted")
    } catch (err) {
      toast.error(errorMessage(err, "Failed to delete"))
    }
  }

  // Moves within the whole list, so the order holds whatever filter is on.
  const move = async (faq, step) => {
    const from = faqs.findIndex((f) => f.id === faq.id)
    const to = from + step
    if (from < 0 || to < 0 || to >= faqs.length) return
    const next = [...faqs]
    ;[next[from], next[to]] = [next[to], next[from]]
    setFaqs(next)
    try {
      setMoving(true)
      const res = await adminSystemExtrasAPI.reorderFaqs(next.map((f) => f.id))
      setFaqs(res?.data?.data?.faqs || next)
    } catch (err) {
      toast.error(errorMessage(err, "Failed to save the order"))
      load()
    } finally {
      setMoving(false)
    }
  }

  const q = search.trim().toLowerCase()
  const shown = faqs.filter(
    (f) =>
      (audience === "all" || (f.audience || "") === audience) &&
      (!q || f.question.toLowerCase().includes(q) || f.answer.toLowerCase().includes(q)),
  )

  return (
    <PageFrame
      icon={HelpCircle}
      title="FAQ"
      description="Questions and answers shown on the customer help page and in the apps. Pick who each one is for; switched-off ones are kept but not shown. Use the arrows to change the order."
    >
      <Card title={editingId ? "Edit FAQ" : "Add an FAQ"}>
        <form onSubmit={save} className="space-y-3">
          <Field label="Question">
            <input
              className={inputClass}
              maxLength={255}
              value={form.question}
              onChange={(e) => setForm((f) => ({ ...f, question: e.target.value }))}
              required
            />
          </Field>
          <Field label="Answer">
            <textarea
              className={`${inputClass} min-h-[96px]`}
              maxLength={5000}
              value={form.answer}
              onChange={(e) => setForm((f) => ({ ...f, answer: e.target.value }))}
              required
            />
          </Field>
          <div className="flex flex-wrap items-end gap-4">
            <Field label="Shown to" className="w-full sm:w-56">
              <select className={inputClass} value={form.audience} onChange={(e) => setForm((f) => ({ ...f, audience: e.target.value }))}>
                {AUDIENCES.map((a) => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>
            </Field>
            <div className="flex items-center gap-2 pb-2">
              <Switch checked={form.isActive} onChange={(v) => setForm((f) => ({ ...f, isActive: v }))} label="Active" />
              <span className="text-sm text-slate-700">Active</span>
            </div>
            <div className="flex gap-2 ml-auto">
              {editingId && (
                <button type="button" onClick={reset} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">Cancel</button>
              )}
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : !editingId && <Plus className="w-4 h-4" />} {editingId ? "Save" : "Add"}
              </button>
            </div>
          </div>
        </form>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input className={`${inputClass} pl-9`} placeholder="Search questions and answers" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <select className={`${inputClass} w-full sm:w-48`} value={audience} onChange={(e) => setAudience(e.target.value)} aria-label="Shown to">
            <option value="all">All audiences</option>
            {AUDIENCES.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </select>
          <span className="text-xs text-slate-500">{shown.length} of {faqs.length}</span>
        </div>

        {loading ? (
          <Loading />
        ) : !shown.length ? (
          <p className="py-10 text-center text-sm text-slate-500">{faqs.length ? "No FAQ matches." : "No FAQs yet."}</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {shown.map((faq) => {
              const index = faqs.findIndex((f) => f.id === faq.id)
              return (
                <li key={faq.id} className="py-3 flex gap-3">
                  <div className="flex flex-col gap-1 shrink-0">
                    <button type="button" onClick={() => move(faq, -1)} disabled={moving || index === 0} className="rounded border border-slate-200 p-1 disabled:opacity-30" aria-label="Move up">
                      <ChevronUp className="w-4 h-4" />
                    </button>
                    <button type="button" onClick={() => move(faq, 1)} disabled={moving || index === faqs.length - 1} className="rounded border border-slate-200 p-1 disabled:opacity-30" aria-label="Move down">
                      <ChevronDown className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-slate-400 tabular-nums">#{index + 1}</span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">{audienceLabel(faq.audience)}</span>
                      {!faq.isActive && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">Off</span>}
                    </div>
                    <p className="mt-1 text-sm font-semibold text-slate-900 break-words">{faq.question}</p>
                    <p className="mt-0.5 text-sm text-slate-600 whitespace-pre-line break-words">{faq.answer}</p>
                    <p className="mt-1 text-[11px] text-slate-400">Updated {formatDateTime(faq.updatedAt)}</p>
                  </div>
                  <div className="flex flex-col items-end gap-2 shrink-0">
                    <Switch checked={faq.isActive} onChange={(v) => toggle(faq, v)} label="Active" />
                    <div className="flex gap-1.5">
                      <button type="button" onClick={() => edit(faq)} className="rounded border border-slate-300 p-1.5" aria-label="Edit">
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button type="button" onClick={() => remove(faq)} className="rounded border border-slate-300 p-1.5 text-slate-500 hover:text-red-600" aria-label="Delete">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </PageFrame>
  )
}
