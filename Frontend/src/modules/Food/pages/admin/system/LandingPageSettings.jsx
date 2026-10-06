import { LayoutTemplate, Plus, Trash2 } from "@food/components/admin/theme/icons"
import { PageFrame, Card, Field, Switch, ImageInput, SaveButton, Loading, inputClass, setIn, formatDateTime, useSettingsArea } from "./SettingsUi"

const APP_LINKS = [
  ["customerAndroid", "Customer app — Play Store"],
  ["customerIos", "Customer app — App Store"],
  ["restaurantAndroid", "Restaurant app — Play Store"],
  ["restaurantIos", "Restaurant app — App Store"],
  ["riderAndroid", "Rider app — Play Store"],
  ["riderIos", "Rider app — App Store"],
]

/**
 * The public website's landing page: hero, features, app download links and
 * testimonials. The website reads it from GET /food/public/landing.
 */
export default function LandingPageSettings() {
  const { value, setValue, updatedAt, loading, saving, save } = useSettingsArea("landing_page")
  const set = (path, next) => setValue((v) => setIn(v, path, next))
  const features = value?.features || []
  const testimonials = value?.testimonials || []

  return (
    <PageFrame
      icon={LayoutTemplate}
      title="Landing Page"
      description="What the website's landing page shows. Sections can be hidden without losing what is entered in them."
      actions={<SaveButton saving={saving} onClick={() => save()} disabled={loading} />}
    >
      {loading || !value ? (
        <Card><Loading /></Card>
      ) : (
        <>
          <Card title="Hero" description="The first thing visitors see.">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Title">
                <input className={inputClass} maxLength={120} value={value.hero.title} onChange={(e) => set(["hero", "title"], e.target.value)} />
              </Field>
              <Field label="Subtitle">
                <input className={inputClass} maxLength={300} value={value.hero.subtitle} onChange={(e) => set(["hero", "subtitle"], e.target.value)} />
              </Field>
              <div className="space-y-1 md:col-span-2">
                <span className="block text-xs font-semibold text-slate-600">Image</span>
                <ImageInput value={value.hero.image} onChange={(url) => set(["hero", "image"], url)} folder="food/site/landing" />
              </div>
            </div>
          </Card>

          <Card title="Features">
            <div className="mb-4 flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <Switch checked={value.sections.showFeatures} onChange={(v) => set(["sections", "showFeatures"], v)} label="Show features" /> Show this section
              </label>
              <button type="button" disabled={features.length >= 12} onClick={() => set(["features"], [...features, { title: "", description: "", image: "" }])} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium disabled:opacity-50">
                <Plus className="w-3.5 h-3.5" /> Add feature
              </button>
            </div>
            {!features.length && <p className="text-sm text-slate-500">No features yet.</p>}
            <div className="space-y-3">
              {features.map((feature, i) => (
                <div key={i} className="grid gap-3 rounded-lg border border-slate-200 p-3 md:grid-cols-[1fr_2fr_auto]">
                  <Field label="Title"><input className={inputClass} maxLength={80} value={feature.title} onChange={(e) => set(["features", i, "title"], e.target.value)} /></Field>
                  <Field label="Description"><input className={inputClass} maxLength={300} value={feature.description} onChange={(e) => set(["features", i, "description"], e.target.value)} /></Field>
                  <button type="button" onClick={() => set(["features"], features.filter((_, j) => j !== i))} className="self-end mb-1 rounded-lg border border-slate-300 p-2 text-slate-500 hover:text-red-600" aria-label="Remove feature"><Trash2 className="w-4 h-4" /></button>
                  <div className="md:col-span-3"><ImageInput value={feature.image} onChange={(url) => set(["features", i, "image"], url)} folder="food/site/landing" label="Icon" /></div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-slate-500">Features without a title are not saved.</p>
          </Card>

          <Card title="App download links" description="Left blank, a link falls back to the store link on App Settings.">
            <label className="mb-4 flex items-center gap-2 text-sm text-slate-700">
              <Switch checked={value.sections.showAppLinks} onChange={(v) => set(["sections", "showAppLinks"], v)} label="Show app links" /> Show this section
            </label>
            <div className="grid gap-3 md:grid-cols-2">
              {APP_LINKS.map(([key, label]) => (
                <Field key={key} label={label}>
                  <input className={inputClass} type="url" placeholder="https://" value={value.appLinks[key]} onChange={(e) => set(["appLinks", key], e.target.value)} />
                </Field>
              ))}
            </div>
          </Card>

          <Card title="Testimonials">
            <div className="mb-4 flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <Switch checked={value.sections.showTestimonials} onChange={(v) => set(["sections", "showTestimonials"], v)} label="Show testimonials" /> Show this section
              </label>
              <button type="button" disabled={testimonials.length >= 20} onClick={() => set(["testimonials"], [...testimonials, { name: "", role: "", quote: "", image: "", rating: null }])} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium disabled:opacity-50">
                <Plus className="w-3.5 h-3.5" /> Add testimonial
              </button>
            </div>
            {!testimonials.length && <p className="text-sm text-slate-500">No testimonials yet.</p>}
            <div className="space-y-3">
              {testimonials.map((t, i) => (
                <div key={i} className="grid gap-3 rounded-lg border border-slate-200 p-3 md:grid-cols-3">
                  <Field label="Name"><input className={inputClass} maxLength={80} value={t.name} onChange={(e) => set(["testimonials", i, "name"], e.target.value)} /></Field>
                  <Field label="Role or city"><input className={inputClass} maxLength={80} value={t.role} onChange={(e) => set(["testimonials", i, "role"], e.target.value)} /></Field>
                  <Field label="Rating">
                    <select className={inputClass} value={t.rating ?? ""} onChange={(e) => set(["testimonials", i, "rating"], e.target.value ? Number(e.target.value) : null)}>
                      <option value="">No rating</option>
                      {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} star{n > 1 ? "s" : ""}</option>)}
                    </select>
                  </Field>
                  <Field label="What they said" className="md:col-span-3"><textarea className={inputClass} rows={2} maxLength={600} value={t.quote} onChange={(e) => set(["testimonials", i, "quote"], e.target.value)} /></Field>
                  <div className="md:col-span-3 flex flex-wrap items-center justify-between gap-3">
                    <ImageInput value={t.image} onChange={(url) => set(["testimonials", i, "image"], url)} folder="food/site/landing" label="Photo" />
                    <button type="button" onClick={() => set(["testimonials"], testimonials.filter((_, j) => j !== i))} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-500 hover:text-red-600"><Trash2 className="w-3.5 h-3.5" /> Remove</button>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-slate-500">Testimonials need a name and what they said to be saved.</p>
          </Card>
          <p className="text-xs text-slate-500">{updatedAt ? `Last saved ${formatDateTime(updatedAt)}` : "Not saved yet"}</p>
        </>
      )}
    </PageFrame>
  )
}
