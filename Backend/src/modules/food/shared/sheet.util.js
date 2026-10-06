/**
 * Reading and writing the simple one-sheet files the admin bulk import and
 * export use: CSV or Excel (.xlsx), first row headers, one record per row.
 *
 * CSV is handled here directly (RFC 4180: quoted fields, doubled quotes,
 * newlines inside quotes, a UTF-8 BOM from Excel). Excel goes through exceljs,
 * loaded only when an .xlsx actually arrives, so the CSV half stays a pure
 * module the tests can run without any dependencies.
 */

export const MAX_SHEET_ROWS = 1000;

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Header text as a lookup key: "Owner Phone*" -> "owner phone". */
export const headerKey = (value) =>
    String(value ?? '')
        .replace(/\*/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

/** Parse CSV text into an array of string arrays. */
export function parseCsv(text) {
    const src = String(text ?? '').replace(/^﻿/, '');
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < src.length; i += 1) {
        const ch = src[i];
        if (quoted) {
            if (ch === '"') {
                if (src[i + 1] === '"') {
                    field += '"';
                    i += 1;
                } else {
                    quoted = false;
                }
            } else {
                field += ch;
            }
            continue;
        }
        if (ch === '"' && field === '') quoted = true;
        else if (ch === ',') {
            row.push(field);
            field = '';
        } else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && src[i + 1] === '\n') i += 1;
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        } else field += ch;
    }
    if (field !== '' || row.length) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

const csvCell = (value) => {
    if (value === null || value === undefined) return '';
    let text = value instanceof Date ? value.toISOString() : String(value);
    // A cell starting with = + - @ is run as a formula by Excel; a leading
    // apostrophe keeps it text. Plain numbers and phone numbers ("+91 98...")
    // are left alone.
    if (/^[=+\-@\t\r]/.test(text) && !/^[+-]?\d[\d.\s]*$/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** Rows of values -> CSV text, with a BOM so Excel opens UTF-8 (₹, names) correctly. */
export function toCsv(headers, rows) {
    const lines = [headers.map(csvCell).join(',')];
    for (const row of rows) lines.push(row.map(csvCell).join(','));
    return `﻿${lines.join('\r\n')}\r\n`;
}

/**
 * Header row + data rows -> records keyed by headerKey, each with its sheet
 * row number. Wholly empty rows are dropped.
 */
export function rowsToRecords(matrix) {
    const [headerRow = [], ...body] = matrix;
    const keys = headerRow.map(headerKey);
    const records = [];
    body.forEach((cells, index) => {
        // A leading apostrophe is Excel's "keep this as text" mark, not data.
        const values = cells.map((c) => String(c ?? '').trim().replace(/^'/, ''));
        if (!values.some(Boolean)) return;
        const record = {};
        keys.forEach((key, col) => {
            if (key) record[key] = values[col] ?? '';
        });
        records.push({ row: index + 2, data: record });
    });
    return { headers: keys.filter(Boolean), records };
}

/** Which of the expected headers the file lacks. */
export const missingHeaders = (headers, required) =>
    required.filter((h) => !headers.includes(headerKey(h)));

const cellText = (value) => {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
        if (value.richText) return value.richText.map((t) => t.text).join('');
        if (value.hyperlink) return String(value.text?.richText ? value.text.richText.map((t) => t.text).join('') : value.text || value.hyperlink);
        if (value.result !== undefined) return String(value.result);
        if (value.text !== undefined) return String(value.text);
        return '';
    }
    return String(value);
};

const isXlsx = (file) =>
    /\.xlsx$/i.test(String(file?.originalname || '')) || file?.mimetype === XLSX_MIME;

/** An uploaded file (multer) -> records. CSV or XLSX, decided by name/type. */
export async function readSheet(file) {
    if (!file?.buffer?.length) return { headers: [], records: [] };
    let matrix;
    if (isXlsx(file)) {
        const { default: ExcelJS } = await import('exceljs');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(file.buffer);
        const sheet = workbook.worksheets[0];
        matrix = [];
        sheet?.eachRow({ includeEmpty: true }, (row, rowNumber) => {
            const values = Array.isArray(row.values) ? row.values.slice(1) : [];
            matrix[rowNumber - 1] = values.map(cellText);
        });
        for (let i = 0; i < matrix.length; i += 1) matrix[i] = matrix[i] || [];
    } else {
        matrix = parseCsv(file.buffer.toString('utf8'));
    }
    return rowsToRecords(matrix);
}

/**
 * Headers + rows -> { buffer, contentType, filename } in the asked format.
 * `notes` become a second sheet in Excel (ignored for CSV).
 */
export async function writeSheet({ format = 'xlsx', name, headers, rows = [], notes = [] }) {
    if (format === 'csv') {
        return {
            buffer: Buffer.from(toCsv(headers, rows), 'utf8'),
            contentType: 'text/csv; charset=utf-8',
            filename: `${name}.csv`,
        };
    }
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(name.slice(0, 31));
    sheet.columns = headers.map((header) => ({ header, width: Math.max(14, Math.min(40, header.length + 6)) }));
    sheet.getRow(1).font = { bold: true };
    rows.forEach((row) => sheet.addRow(row));
    if (notes.length) {
        const help = workbook.addWorksheet('How to fill');
        help.columns = [{ header: 'Column', width: 26 }, { header: 'What to enter', width: 90 }];
        help.getRow(1).font = { bold: true };
        notes.forEach((note) => help.addRow(note));
    }
    return {
        buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
        contentType: XLSX_MIME,
        filename: `${name}.xlsx`,
    };
}
