import { useEffect, useState } from "react"
import { Copy, FileText, Film, Images, Loader2, Search, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { adminSystemExtrasAPI } from "@food/api/adminSystemExtras"
import { PageFrame, Card, Field, Loading, inputClass, errorMessage, formatDateTime } from "../system/SettingsUi"

const KINDS = [
  ["", "All files"],
  ["image", "Images"],
  ["video", "Videos"],
  ["pdf", "PDFs"],
  ["file", "Other"],
]

const size = (bytes) => {
  const n = Number(bytes) || 0
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

const absoluteUrl = (url) => {
  if (!url) return ""
  try {
    return new URL(url, window.location.origin).toString()
  } catch {
    return url
  }
}

/** Files in upload storage: find, copy a link, delete what nothing uses. */
export default function Gallery() {
  const [filters, setFilters] = useState({ folder: "", kind: "", search: "" })
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState("")

  const load = async () => {
    try {
      setLoading(true)
      const params = Object.fromEntries(Object.entries(filters).filter(([, v]) => v))
      const res = await adminSystemExtrasAPI.getGalleryFiles({ ...params, page, limit: 48 })
      setData(res?.data?.data || null)
    } catch (err) {
      toast.error(errorMessage(err, "Failed to load files"))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [filters, page])

  const setFilter = (key, value) => {
    setFilters((f) => ({ ...f, [key]: value }))
    setPage(1)
  }

  const copy = async (file) => {
    try {
      await navigator.clipboard.writeText(absoluteUrl(file.url))
      toast.success("Link copied")
    } catch {
      toast.error("Could not copy the link")
    }
  }

  const remove = async (file) => {
    if (!window.confirm(`Delete ${file.name}? It is checked first: a file still in use is not deleted.`)) return
    try {
      setDeleting(file.path)
      await adminSystemExtrasAPI.deleteGalleryFile(file.path)
      toast.success("File deleted")
      load()
    } catch (err) {
      toast.error(errorMessage(err, "Failed to delete"))
    } finally {
      setDeleting("")
    }
  }

  const files = data?.files || []
  const pages = data?.pagination?.pages || 1

  return (
    <PageFrame
      icon={Images}
      title="Gallery"
      description="Every file uploaded to the system, newest first. Deleting is only allowed when nothing in the system still uses the file."
    >
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Folder">
            <select className={inputClass} value={filters.folder} onChange={(e) => setFilter("folder", e.target.value)}>
              <option value="">All folders</option>
              {(data?.folders || []).map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </Field>
          <Field label="Type">
            <select className={inputClass} value={filters.kind} onChange={(e) => setFilter("kind", e.target.value)}>
              {KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          <form onSubmit={(e) => { e.preventDefault(); setFilter("search", search.trim()) }}>
            <Field label="Search">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input className={`${inputClass} pl-9`} placeholder="File name or folder" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
            </Field>
          </form>
          {data && <p className="ml-auto text-sm text-slate-500">{data.pagination.total} file(s){data.truncated ? " — showing the first 20,000 found" : ""}</p>}
        </div>
      </Card>

      <Card>
        {loading ? (
          <Loading />
        ) : !files.length ? (
          <p className="py-12 text-center text-sm text-slate-500">No files found.</p>
        ) : (
          <div className="grid gap-4 grid-cols-2 md:grid-cols-4 xl:grid-cols-6">
            {files.map((file) => (
              <div key={file.path} className="rounded-lg border border-slate-200 overflow-hidden flex flex-col">
                <a href={file.url} target="_blank" rel="noreferrer" className="block aspect-square bg-slate-50">
                  {file.kind === "image" ? (
                    <img src={file.url} alt={file.name} loading="lazy" className="h-full w-full object-cover" />
                  ) : (
                    <div className="h-full w-full flex items-center justify-center text-slate-400">
                      {file.kind === "video" ? <Film className="w-10 h-10" /> : <FileText className="w-10 h-10" />}
                    </div>
                  )}
                </a>
                <div className="p-2 space-y-1 flex-1 flex flex-col">
                  <p className="text-[11px] font-medium text-slate-800 truncate" title={file.path}>{file.name}</p>
                  <p className="text-[10px] text-slate-500 truncate" title={file.folder}>{file.folder || "/"}</p>
                  <p className="text-[10px] text-slate-400">{size(file.size)} · {formatDateTime(file.modifiedAt)}</p>
                  <div className="mt-auto flex gap-1.5 pt-1">
                    <button type="button" onClick={() => copy(file)} className="inline-flex flex-1 items-center justify-center gap-1 rounded border border-slate-300 px-2 py-1 text-[11px]">
                      <Copy className="w-3 h-3" /> Copy link
                    </button>
                    <button type="button" onClick={() => remove(file)} disabled={deleting === file.path} aria-label="Delete" className="rounded border border-slate-300 px-2 py-1 text-slate-500 hover:text-red-600 disabled:opacity-50">
                      {deleting === file.path ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        {pages > 1 && (
          <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-200">
            <p className="text-sm text-slate-600">Page {page} of {pages}</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="px-4 py-2 text-sm rounded-lg border border-slate-300 disabled:opacity-50">Previous</button>
              <button type="button" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} className="px-4 py-2 text-sm rounded-lg border border-slate-300 disabled:opacity-50">Next</button>
            </div>
          </div>
        )}
      </Card>
    </PageFrame>
  )
}
