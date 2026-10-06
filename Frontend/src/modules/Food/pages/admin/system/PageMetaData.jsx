import { useState } from "react"
import { FileSearch } from "lucide-react"
import { PageFrame, Card, Field, ImageInput, SaveButton, Loading, inputClass, setIn, formatDateTime, useSettingsArea } from "./SettingsUi"

/** SEO title, description, keywords and share image for each public page. */
export default function PageMetaData() {
  const { value, setValue, catalog, updatedAt, loading, saving, save } = useSettingsArea("page_meta")
  const pages = catalog.pages || []
  const [current, setCurrent] = useState("")
  const key = current || pages[0]?.key
  const page = value?.pages?.[key] || {}
  const set = (field, next) => setValue((v) => setIn(v, ["pages", key, field], next))

  return (
    <PageFrame
      icon={FileSearch}
      title="Page Meta Data"
      description="What search engines and link previews show for each page of the website. Blank fields fall back to the website's defaults."
      actions={<SaveButton saving={saving} onClick={() => save()} disabled={loading} />}
    >
      {loading || !value ? (
        <Card><Loading /></Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
          <Card className="h-fit">
            <ul className="space-y-1">
              {pages.map((p) => {
                const filled = Boolean(value.pages?.[p.key]?.title)
                return (
                  <li key={p.key}>
                    <button type="button" onClick={() => setCurrent(p.key)} className={`w-full rounded-lg px-3 py-2 text-left text-sm ${p.key === key ? "bg-blue-50 text-blue-800 font-semibold" : "text-slate-700 hover:bg-slate-50"}`}>
                      {p.label}
                      <span className="block text-[11px] font-normal text-slate-500">{filled ? "Set" : "Not set"}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </Card>
          <Card title={pages.find((p) => p.key === key)?.label} description={updatedAt ? `Last saved ${formatDateTime(updatedAt)}` : "Not saved yet"}>
            <div className="space-y-4">
              <Field label="Meta title" hint={`${(page.title || "").length}/70 characters. Shown as the search result headline.`}>
                <input className={inputClass} maxLength={70} value={page.title || ""} onChange={(e) => set("title", e.target.value)} />
              </Field>
              <Field label="Meta description" hint={`${(page.description || "").length}/200 characters. Shown under the headline.`}>
                <textarea className={inputClass} rows={3} maxLength={200} value={page.description || ""} onChange={(e) => set("description", e.target.value)} />
              </Field>
              <Field label="Keywords" hint="Separate with commas.">
                <input className={inputClass} maxLength={300} value={page.keywords || ""} onChange={(e) => set("keywords", e.target.value)} />
              </Field>
              <div className="space-y-1">
                <span className="block text-xs font-semibold text-slate-600">Share image</span>
                <ImageInput value={page.image || ""} onChange={(url) => set("image", url)} folder="food/site/meta" />
                <span className="block text-[11px] text-slate-500">Shown when the page is shared on social media. 1200 × 630 works best.</span>
              </div>
              {(page.title || page.description) && (
                <div className="rounded-lg border border-slate-200 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2">Search result preview</p>
                  <p className="text-base text-blue-800 truncate">{page.title}</p>
                  <p className="text-sm text-slate-600 line-clamp-2">{page.description}</p>
                </div>
              )}
            </div>
          </Card>
        </div>
      )}
    </PageFrame>
  )
}
