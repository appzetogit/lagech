import { useEffect, useState } from "react"
import { Loader2, Plus, Share2 } from "lucide-react"
import { toast } from "sonner"
import { adminSystemExtrasAPI } from "@food/api/adminSystemExtras"
import { PageFrame, Card, Field, Switch, Loading, inputClass, errorMessage } from "./SettingsUi"

const PLATFORMS = ["Facebook", "Instagram", "X (Twitter)", "LinkedIn", "YouTube", "Pinterest", "WhatsApp", "Telegram"]

/** Social media profiles shown on the website footer and in the apps. */
export default function SocialMedia() {
  const [links, setLinks] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ platform: "", url: "" })
  const [editingId, setEditingId] = useState(null)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    try {
      setLoading(true)
      const res = await adminSystemExtrasAPI.getSocialLinks()
      setLinks(res?.data?.data?.links || [])
    } catch (err) {
      toast.error(errorMessage(err, "Failed to load social media links"))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const reset = () => {
    setForm({ platform: "", url: "" })
    setEditingId(null)
  }

  const save = async (e) => {
    e.preventDefault()
    try {
      setSaving(true)
      if (editingId) await adminSystemExtrasAPI.updateSocialLink(editingId, form)
      else await adminSystemExtrasAPI.createSocialLink({ ...form, sortOrder: links.length })
      toast.success(editingId ? "Link saved" : "Link added")
      reset()
      load()
    } catch (err) {
      toast.error(errorMessage(err, "Failed to save"))
    } finally {
      setSaving(false)
    }
  }

  const toggle = async (link, isActive) => {
    try {
      await adminSystemExtrasAPI.updateSocialLink(link.id, { isActive })
      setLinks((list) => list.map((l) => (l.id === link.id ? { ...l, isActive } : l)))
    } catch (err) {
      toast.error(errorMessage(err, "Failed to update"))
    }
  }

  const remove = async (link) => {
    if (!window.confirm(`Delete the ${link.platform} link?`)) return
    try {
      await adminSystemExtrasAPI.deleteSocialLink(link.id)
      if (editingId === link.id) reset()
      load()
    } catch (err) {
      toast.error(errorMessage(err, "Failed to delete"))
    }
  }

  return (
    <PageFrame icon={Share2} title="Social Media" description="Links to your social media profiles. Switched-on links appear on the website and in the apps, in this order.">
      <Card title={editingId ? "Edit link" : "Add a link"}>
        <form onSubmit={save} className="grid gap-3 md:grid-cols-[1fr_2fr_auto] md:items-end">
          <Field label="Platform">
            <input className={inputClass} list="social-platforms" maxLength={40} value={form.platform} onChange={(e) => setForm((f) => ({ ...f, platform: e.target.value }))} required />
            <datalist id="social-platforms">{PLATFORMS.map((p) => <option key={p} value={p} />)}</datalist>
          </Field>
          <Field label="Link">
            <input className={inputClass} type="url" placeholder="https://" value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} required />
          </Field>
          <div className="flex gap-2">
            {editingId && <button type="button" onClick={reset} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">Cancel</button>}
            <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : !editingId && <Plus className="w-4 h-4" />} {editingId ? "Save" : "Add"}
            </button>
          </div>
        </form>
      </Card>
      <Card>
        {loading ? (
          <Loading />
        ) : !links.length ? (
          <p className="py-10 text-center text-sm text-slate-500">No social media links yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>{["Platform", "Link", "Shown", ""].map((h) => <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-700">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {links.map((link) => (
                  <tr key={link.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-sm font-medium text-slate-900">{link.platform}</td>
                    <td className="px-4 py-3 text-sm"><a href={link.url} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline break-all">{link.url}</a></td>
                    <td className="px-4 py-3"><Switch checked={link.isActive} onChange={(v) => toggle(link, v)} label="Shown" /></td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button type="button" onClick={() => { setEditingId(link.id); setForm({ platform: link.platform, url: link.url }) }} className="rounded border border-slate-300 px-2.5 py-1 text-xs">Edit</button>
                      <button type="button" onClick={() => remove(link)} className="ml-1.5 rounded border border-slate-300 px-2.5 py-1 text-xs text-slate-500 hover:text-red-600">Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </PageFrame>
  )
}
