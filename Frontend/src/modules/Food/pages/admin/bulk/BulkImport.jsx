import { useRef, useState } from "react"
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Loader2, Upload, X } from "@food/components/admin/theme/icons"
import { toast } from "sonner"
import { adminCatalogExtrasAPI, blobErrorMessage, errorMessage, saveBlobResponse } from "@food/api/adminCatalogExtras"

const COPY = {
  categories: {
    title: "Category Bulk Import",
    what: "categories and sub-categories",
    tips: [
      "Leave Id blank to add a category; keep the Id from an export to update that category.",
      "To make a sub-category, put the name of an existing top-level category in Parent Category.",
      "Food Type is Veg, Non-Veg or Both. Active is Yes or No.",
    ],
  },
  addons: {
    title: "Addon Bulk Import",
    what: "add-ons",
    tips: [
      "Restaurant Id is required: export restaurants to look up each restaurant's id.",
      "Leave Id blank to add an add-on; keep the Id from an export to update that add-on.",
      "Imported add-ons are approved straight away. Addon Category must match an existing addon category name.",
    ],
  },
  restaurants: {
    title: "Restaurant Bulk Import",
    what: "restaurants",
    tips: [
      "Restaurant Name, Owner Name and Owner Phone are required, the same as Add New Restaurant.",
      "Imported restaurants are created approved. A phone number already used by a restaurant is rejected.",
      "Zone is the zone's name. Without one, the zone is found from Latitude and Longitude when given.",
    ],
  },
  foods: {
    title: "Food Bulk Import",
    what: "dishes",
    tips: [
      "Restaurant Id and Category Id come from the restaurant and category exports; Sub Category Id must be a sub-category of that category.",
      "Leave Id blank to add a dish; keep the Id from a food export to update that dish. Imported dishes are approved straight away.",
      "Food Type is Veg or Non-Veg. Tags, Nutrition and Allergens are comma-separated. A dish with sizes keeps its size prices.",
    ],
  },
}

/** Upload a CSV/Excel file of categories, add-ons, restaurants or foods, with per-row errors. */
export default function BulkImport({ entity }) {
  const copy = COPY[entity]
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState("")
  const [result, setResult] = useState(null)
  const inputRef = useRef(null)

  const template = async (format, withData = false) => {
    try {
      setBusy(`template-${withData ? "data-" : ""}${format}`)
      const res = await adminCatalogExtrasAPI.downloadBulkTemplate(entity, format, withData)
      saveBlobResponse(res, `${entity}_template${withData ? "_with_data" : ""}.${format}`)
    } catch (err) {
      toast.error(await blobErrorMessage(err, "Could not download the template"))
    } finally {
      setBusy("")
    }
  }

  const choose = (e) => {
    const picked = e.target.files?.[0]
    if (!picked) return
    if (!/\.(csv|xlsx)$/i.test(picked.name)) {
      toast.error("Choose a .csv or .xlsx file")
      e.target.value = ""
      return
    }
    setFile(picked)
    setResult(null)
  }

  const reset = () => {
    setFile(null)
    setResult(null)
    if (inputRef.current) inputRef.current.value = ""
  }

  const runImport = async () => {
    if (!file) return
    try {
      setBusy("import")
      const res = await adminCatalogExtrasAPI.bulkImport(entity, file)
      const data = res?.data?.data || {}
      setResult(data)
      const saved = (data.created || 0) + (data.updated || 0)
      if (data.failed) toast.warning(`${saved} saved, ${data.failed} row(s) need fixing`)
      else toast.success(`${saved} row(s) saved`)
    } catch (err) {
      toast.error(errorMessage(err, "Import failed"))
    } finally {
      setBusy("")
    }
  }

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex items-center gap-3">
            <FileSpreadsheet className="w-5 h-5 text-blue-600" />
            <h1 className="text-2xl font-bold text-slate-900">{copy.title}</h1>
          </div>
          <p className="text-sm text-slate-600 mt-1">Add or update {copy.what} from a CSV or Excel file.</p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
            <p className="text-xs font-semibold uppercase text-slate-500">Step 1</p>
            <h2 className="mt-1 font-semibold text-slate-900">Download the template</h2>
            <p className="mt-1 text-sm text-slate-600">The Excel template has a second sheet explaining every column.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={() => template("xlsx")} disabled={Boolean(busy)} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
                {busy === "template-xlsx" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Excel
              </button>
              <button type="button" onClick={() => template("csv")} disabled={Boolean(busy)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60">
                {busy === "template-csv" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} CSV
              </button>
            </div>
            <p className="mt-4 text-xs font-semibold text-slate-700">Template with existing data</p>
            <p className="mt-0.5 text-xs text-slate-500">
              {entity === "restaurants"
                ? "Every current restaurant in the import columns, for reference: the import only adds restaurants, so a row already saved is rejected as a duplicate."
                : `Every current record with its Id: edit the rows and upload them to update those ${copy.what}.`}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" onClick={() => template("xlsx", true)} disabled={Boolean(busy)} className="inline-flex items-center gap-1.5 rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700 disabled:opacity-60">
                {busy === "template-data-xlsx" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Excel
              </button>
              <button type="button" onClick={() => template("csv", true)} disabled={Boolean(busy)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60">
                {busy === "template-data-csv" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} CSV
              </button>
            </div>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
            <p className="text-xs font-semibold uppercase text-slate-500">Step 2</p>
            <h2 className="mt-1 font-semibold text-slate-900">Fill it in</h2>
            <ul className="mt-1 space-y-1 text-sm text-slate-600 list-disc pl-4">
              {copy.tips.map((tip) => <li key={tip}>{tip}</li>)}
              <li>Columns marked * are required. Up to 1,000 rows per file.</li>
            </ul>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
            <p className="text-xs font-semibold uppercase text-slate-500">Step 3</p>
            <h2 className="mt-1 font-semibold text-slate-900">Upload and import</h2>
            <p className="mt-1 text-sm text-slate-600">Good rows are saved; any row with a problem is listed below with what to fix.</p>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 px-4 py-10 text-center hover:border-blue-400">
            <Upload className="w-8 h-8 text-slate-400" />
            <span className="text-sm font-medium text-slate-700">{file ? file.name : "Choose a .csv or .xlsx file"}</span>
            {file && <span className="text-xs text-slate-500">{Math.ceil(file.size / 1024)} KB</span>}
            <input ref={inputRef} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" onChange={choose} />
          </label>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={reset} disabled={!file || Boolean(busy)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm disabled:opacity-50">Clear</button>
            <button type="button" onClick={runImport} disabled={!file || Boolean(busy)} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {busy === "import" && <Loader2 className="w-4 h-4 animate-spin" />} Import
            </button>
          </div>
        </div>

        {result && (
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 space-y-4">
            <div className="flex flex-wrap gap-3">
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-700">
                <CheckCircle2 className="w-4 h-4" /> {result.created || 0} added
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-blue-50 px-3 py-1.5 text-sm font-semibold text-blue-700">
                {result.updated || 0} updated
              </span>
              <span className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold ${result.failed ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-600"}`}>
                {result.failed ? <AlertTriangle className="w-4 h-4" /> : <X className="w-4 h-4" />} {result.failed || 0} not saved
              </span>
            </div>
            {Array.isArray(result.errors) && result.errors.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-slate-600">
                      <th className="py-2 pr-4 font-semibold">Row</th>
                      <th className="py-2 pr-4 font-semibold">Name</th>
                      <th className="py-2 font-semibold">What to fix</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.errors.map((e) => (
                      <tr key={`${e.row}-${e.name}`} className="border-b border-slate-100 align-top">
                        <td className="py-2 pr-4 font-mono text-slate-700">{e.row}</td>
                        <td className="py-2 pr-4 text-slate-800">{e.name || "—"}</td>
                        <td className="py-2 text-rose-700">
                          <ul className="list-disc pl-4 space-y-0.5">{(e.errors || []).map((msg) => <li key={msg}>{msg}</li>)}</ul>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
