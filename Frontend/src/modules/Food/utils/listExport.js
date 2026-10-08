/**
 * Export for admin lists: the old panel's "Export -> Excel / .Csv".
 *
 * One helper for every list, so the files look alike and quote alike:
 *
 *   exportRows("csv" | "excel", { filename, columns, rows })
 *
 * `columns` is [{ label, value(row, index) }] (or { label, key }). Excel is a
 * real .xlsx (Office Open XML in a zip, written here: the frontend has no
 * spreadsheet library and one sheet of text and numbers needs none), so Excel
 * opens it without the "format and extension don't match" warning the old
 * HTML-table .xls files gave.
 *
 * `fetchAllPages` walks a paged API with the list's own filters so an export
 * holds every matching row, not just the page on screen.
 */

const cellValue = (column, row, index) => {
  const raw = typeof column.value === "function" ? column.value(row, index) : row?.[column.key]
  if (raw === null || raw === undefined) return ""
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? "" : raw.toLocaleString("en-IN")
  if (typeof raw === "boolean") return raw ? "Yes" : "No"
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : ""
  if (typeof raw === "object") return raw.name || raw.label || raw.title || ""
  return String(raw)
}

/** Header row plus one row per record, as plain values. */
export function buildMatrix(columns, rows) {
  const header = columns.map((c) => c.label)
  const body = (rows || []).map((row, index) => columns.map((c) => cellValue(c, row, index)))
  return [header, ...body]
}

const csvCell = (value) => {
  let text = typeof value === "number" ? String(value) : String(value ?? "")
  // A cell starting with = + - @ is run as a formula by Excel; a leading
  // apostrophe keeps it text. Plain numbers and phone numbers are left alone.
  if (/^[=+\-@\t\r]/.test(text) && !/^[+-]?\d[\d.\s]*$/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Matrix -> CSV text with a BOM, so Excel reads UTF-8 (₹, names) correctly. */
export function toCsvText(columns, rows) {
  const lines = buildMatrix(columns, rows).map((line) => line.map(csvCell).join(","))
  return `﻿${lines.join("\r\n")}\r\n`
}

// ─── minimal .xlsx writer ────────────────────────────────────────────────────

const xmlEscape = (text) =>
  String(text)
    // Characters XML 1.0 does not allow at all.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

const columnName = (index) => {
  let n = index + 1
  let name = ""
  while (n > 0) {
    const rem = (n - 1) % 26
    name = String.fromCharCode(65 + rem) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

function sheetXml(matrix) {
  const widths = (matrix[0] || []).map((_, col) =>
    Math.min(60, Math.max(10, ...matrix.slice(0, 200).map((line) => String(line[col] ?? "").length + 2))),
  )
  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : ""
  const rowsXml = matrix
    .map((line, r) => {
      const style = r === 0 ? ' s="1"' : ""
      const cells = line
        .map((value, c) => {
          const ref = `${columnName(c)}${r + 1}`
          if (typeof value === "number") return `<c r="${ref}"${style}><v>${value}</v></c>`
          if (value === "") return ""
          return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`
        })
        .join("")
      return `<row r="${r + 1}">${cells}</row>`
    })
    .join("")
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `${cols}<sheetData>${rowsXml}</sheetData></worksheet>`
  )
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

const crc32 = (bytes) => {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Files -> a zip (stored, not deflated: small enough, and needs no library). */
function zip(files) {
  const encoder = new TextEncoder()
  const chunks = []
  const central = []
  let offset = 0
  for (const { name, content } of files) {
    const nameBytes = encoder.encode(name)
    const data = encoder.encode(content)
    const crc = crc32(data)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(6, 0x0800, true) // UTF-8 names
    local.setUint16(8, 0, true) // stored
    local.setUint16(10, 0, true)
    local.setUint16(12, 0x21, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true)
    local.setUint32(22, data.length, true)
    local.setUint16(26, nameBytes.length, true)
    local.setUint16(28, 0, true)
    chunks.push(new Uint8Array(local.buffer), nameBytes, data)

    const entry = new DataView(new ArrayBuffer(46))
    entry.setUint32(0, 0x02014b50, true)
    entry.setUint16(4, 20, true)
    entry.setUint16(6, 20, true)
    entry.setUint16(8, 0x0800, true)
    entry.setUint16(10, 0, true)
    entry.setUint16(12, 0, true)
    entry.setUint16(14, 0x21, true)
    entry.setUint32(16, crc, true)
    entry.setUint32(20, data.length, true)
    entry.setUint32(24, data.length, true)
    entry.setUint16(28, nameBytes.length, true)
    entry.setUint32(42, offset, true)
    central.push(new Uint8Array(entry.buffer), nameBytes)
    offset += 30 + nameBytes.length + data.length
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, files.length, true)
  end.setUint16(10, files.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, offset, true)
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  })
}

/** Columns + rows -> an .xlsx Blob with a bold, frozen header row. */
export function toXlsxBlob(columns, rows, sheetName = "Sheet1") {
  const name = xmlEscape(String(sheetName).replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet1")
  return zip([
    {
      name: "[Content_Types].xml",
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        "</Types>",
    },
    {
      name: "_rels/.rels",
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        "</Relationships>",
    },
    {
      name: "xl/workbook.xml",
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        "</Relationships>",
    },
    {
      name: "xl/styles.xml",
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        "</styleSheet>",
    },
    { name: "xl/worksheets/sheet1.xml", content: sheetXml(buildMatrix(columns, rows)) },
  ])
}

// ─── downloading ─────────────────────────────────────────────────────────────

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.style.display = "none"
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/** "csv" or "excel" -> a dated download of the given rows. */
export function exportRows(format, { filename, columns, rows, sheetName }) {
  const base = `${String(filename || "export").replace(/[^\w.-]+/g, "_")}_${today()}`
  if (format === "csv") {
    downloadBlob(new Blob([toCsvText(columns, rows)], { type: "text/csv;charset=utf-8" }), `${base}.csv`)
  } else {
    downloadBlob(toXlsxBlob(columns, rows, sheetName || filename), `${base}.xlsx`)
  }
}

/**
 * Every row of a paged list. `fetchPage({ page, limit })` returns the axios
 * response; `pick(response)` gives { rows, total?, pages? }. Stops at the last
 * page, a short page, or `maxRows`.
 */
export async function fetchAllPages(fetchPage, pick, { pageSize = 200, maxRows = 50000 } = {}) {
  const all = []
  for (let page = 1; all.length < maxRows; page += 1) {
    const { rows = [], total, pages } = pick(await fetchPage({ page, limit: pageSize })) || {}
    all.push(...rows)
    if (!rows.length || rows.length < pageSize) break
    if (Number.isFinite(Number(pages)) && page >= Number(pages)) break
    if (Number.isFinite(Number(total)) && all.length >= Number(total)) break
  }
  return all.slice(0, maxRows)
}

/** Dates as the old panel printed them: 06 Oct 2026, 02:15 pm. */
export const exportDate = (value, withTime = true) => {
  if (!value) return ""
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  })
}

/** A money amount as a plain number with two decimals (sums in Excel). */
export const exportMoney = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : ""
}
