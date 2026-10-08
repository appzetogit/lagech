import { useState } from "react"
import { toast } from "sonner"
import { ChevronDown, Download, FileSpreadsheet, FileText, Loader2 } from "@food/components/admin/theme/icons"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@food/components/ui/dropdown-menu"
import { exportRows } from "@food/utils/listExport"

/**
 * The old panel's "Export" button: Excel or .Csv of the list with its filters.
 *
 *   <ExportMenu filename="customers" columns={COLUMNS} getRows={() => loadAll()} />
 *
 * `getRows` returns (or resolves to) every row to export -- usually all pages
 * fetched with the list's filters via fetchAllPages. A list exported by the
 * server instead passes `onExport(format)`.
 */
export default function ExportMenu({ filename, columns, getRows, onExport, sheetName, disabled = false, className = "" }) {
  const [busy, setBusy] = useState("")

  const run = async (format) => {
    if (busy) return
    setBusy(format)
    try {
      if (onExport) {
        await onExport(format)
        return
      }
      const rows = (await getRows?.()) || []
      if (!rows.length) {
        toast.info("Nothing to export")
        return
      }
      exportRows(format, { filename, columns, rows, sheetName })
    } catch (err) {
      toast.error(err?.response?.data?.message || err?.message || "Export failed")
    } finally {
      setBusy("")
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled || Boolean(busy)}
          className={`inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition-all hover:bg-slate-50 disabled:opacity-60 ${className}`}
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          <span className="font-bold text-black">Export</span>
          <ChevronDown className="w-3 h-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-50 w-48 rounded-lg border border-slate-200 bg-white shadow-lg">
        <DropdownMenuLabel>Download options</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => run("excel")} className="cursor-pointer">
          <span className="mr-3 flex h-6 w-6 items-center justify-center rounded-md bg-green-50">
            <FileSpreadsheet className="w-4 h-4 text-green-600" />
          </span>
          Excel
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => run("csv")} className="cursor-pointer">
          <span className="mr-3 flex h-6 w-6 items-center justify-center rounded-md bg-blue-50">
            <FileText className="w-4 h-4 text-blue-600" />
          </span>
          .Csv
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
