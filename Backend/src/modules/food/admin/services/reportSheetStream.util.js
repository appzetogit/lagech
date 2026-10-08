/**
 * Writing a report straight to the HTTP response as CSV or Excel, a batch at a
 * time, so an export of the whole filtered set never has to sit in memory.
 *
 * `columns` is [{ key, label }]; `batches` is an async iterable of row arrays.
 * A value of null/undefined is written as an empty cell — the reports use it
 * for "does not apply" (e.g. income on a cancelled order), which is different
 * from 0.
 */

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const csvCell = (value) => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const csvLine = (values) => `${values.map(csvCell).join(',')}\r\n`;

export const normaliseSheetFormat = (format) =>
    (String(format || '').toLowerCase() === 'xlsx' || String(format || '').toLowerCase() === 'excel' ? 'xlsx' : 'csv');

/** Waits for the socket to drain when the client reads slower than we write. */
const write = (res, chunk) =>
    new Promise((resolve) => {
        if (res.write(chunk)) resolve();
        else res.once('drain', resolve);
    });

export async function streamSheet(res, { format, filename, sheetName = 'Report', columns, batches }) {
    const kind = normaliseSheetFormat(format);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}.${kind}"`,
    );

    if (kind === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.status(200);
        // BOM so Excel opens the ₹ and names as UTF-8.
        await write(res, `﻿${csvLine(columns.map((c) => c.label))}`);
        for await (const rows of batches) {
            if (!rows.length) continue;
            await write(res, rows.map((row) => csvLine(columns.map((c) => row[c.key]))).join(''));
        }
        res.end();
        return;
    }

    const { default: ExcelJS } = await import('exceljs');
    res.setHeader('Content-Type', XLSX_MIME);
    res.status(200);
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
    const sheet = workbook.addWorksheet(sheetName);
    sheet.columns = columns.map((c) => ({ header: c.label, key: c.key, width: Math.max(12, c.label.length + 2) }));
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).commit();
    for await (const rows of batches) {
        for (const row of rows) {
            const values = {};
            for (const c of columns) values[c.key] = row[c.key] ?? null;
            sheet.addRow(values).commit();
        }
    }
    sheet.commit();
    await workbook.commit();
}
