// Fase 2: .xlsx → DataTable. ExcelJS is the parser; this module only decides
// WHICH rows become the table, so the decisions are testable with a tiny
// synthetic workbook instead of a fixture file.
//
// Header row is 1-based and chosen by the user (spreadsheets often have a
// title above the real header). Blank columns are dropped — they would map to
// nothing and clutter the query UI. Cell values are strings: a label prints
// text, and keeping numbers as text preserves leading zeros ("007").
//
// History: this used SheetJS (`xlsx`), removed 2026-10-06 (audit DEP-01) —
// HIGH prototype-pollution + ReDoS advisories with no fix available. ExcelJS
// builds plain row arrays here (no object spreading of cell names), and
// tableFromRows defines (not assigns) each column, so a hostile `__proto__`
// header becomes an own property rather than a prototype rewrite.
//
// Dates differ from SheetJS on purpose: SheetJS returned Excel's formatted
// text (`raw: false`); ExcelJS hands back Date objects, which are rendered as
// ISO (`YYYY-MM-DD`, plus ` HH:mm` when the time is not midnight) —
// deterministic across machines instead of locale-formatted.

import { tableFromRows } from './tableSource';
import type { DataTable } from './tableSource';

// ExcelJS is bigger than SheetJS and only a .xlsx import needs it, so it is
// loaded on first use rather than at module load — the same reason jspdf and
// bwip-js are imported this way. The cast keeps the module's own signatures
// synchronous: readWorkbook stays the one async entry point.
type ExcelModule = typeof import('exceljs');
let excelModule: Promise<ExcelModule> | null = null;
const loadExcel = (): Promise<ExcelModule> => (excelModule ??= import('exceljs'));

/** A supplier file bigger than this is refused before parsing (not OOM'd). */
export const MAX_XLSX_BYTES = 10 * 1024 * 1024;

export interface WorkbookSheet {
    name: string;
    /** Raw grid, one array per row, trimmed. Shorter rows are padded later. */
    rows: string[][];
}

const cellText = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    // ExcelJS parses date-formatted cells into Date objects. ISO, not the
    // workbook's locale format: the same file must print the same text on
    // every station (see the header note).
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return '';
        const pad = (n: number): string => String(n).padStart(2, '0');
        const day = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
        if (value.getHours() === 0 && value.getMinutes() === 0 && value.getSeconds() === 0) return day;
        return `${day} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
    }
    // Rich text comes back as { richText: [{ text }] }; hyperlinks as
    // { text, hyperlink }. Read the text, not "[object Object]".
    if (typeof value === 'object') {
        const v = value as { richText?: { text?: unknown }[]; text?: unknown };
        if (Array.isArray(v.richText)) return v.richText.map(p => String(p.text ?? '')).join('').trim();
        if (v.text !== undefined) return String(v.text).trim();
        return '';
    }
    return String(value).trim();
};

/** Every sheet as a grid of trimmed strings. */
export const readWorkbook = async (bytes: Uint8Array): Promise<WorkbookSheet[]> => {
    if (bytes.length > MAX_XLSX_BYTES) {
        throw new Error(`Spreadsheet is ${(bytes.length / 1048576).toFixed(1)} MB — over the ${(MAX_XLSX_BYTES / 1048576).toFixed(0)} MB import limit. Split it or paste the rows as CSV instead.`);
    }
    const { Workbook } = await loadExcel();
    const wb = new Workbook();
    // ExcelJS reads dates into Date objects (cellDates behaviour); plain
    // values stay as they are — no shared-formula evaluation surprises.
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    const sheets: WorkbookSheet[] = [];
    wb.eachSheet(ws => {
        const grid: string[][] = [];
        // includeEmpty keeps row NUMBERS stable (a gap row is []), so the
        // 1-based headerRow the user picks means the row they see in Excel.
        ws.eachRow({ includeEmpty: true }, row => {
            const cells: string[] = [];
            // values[] is 1-based (index 0 is always empty) and sparse.
            const values = row.values as unknown[];
            const count = Array.isArray(values) ? values.length : 0;
            for (let i = 1; i < count; i++) cells.push(cellText(values[i]));
            // Trailing empties carry no columns; leading/inner ones do.
            while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
            grid.push(cells);
        });
        sheets.push({ name: ws.name, rows: grid });
    });
    return sheets;
};

export interface SheetSelection {
    sheet: string;
    /** 1-based. Rows above it are ignored; this row names the columns. */
    headerRow: number;
}

/**
 * Turn one sheet into a table. Returns null when the sheet or the header row
 * doesn't exist, or when the header row is empty — the caller reports that,
 * rather than this inventing "Column 1" headers that silently map to nothing.
 * Duplicate header names get a numeric suffix so two "Qty" columns stay
 * distinct and addressable by a query.
 */
export const sheetToTable = (sheets: WorkbookSheet[], sel: SheetSelection): DataTable | null => {
    const sheet = sheets.find(s => s.name === sel.sheet);
    if (!sheet) return null;
    const headerIdx = sel.headerRow - 1;
    if (headerIdx < 0 || headerIdx >= sheet.rows.length) return null;

    const used = new Map<string, number>();
    const columns: string[] = [];
    const keepIdx: number[] = [];
    sheet.rows[headerIdx].forEach((name, i) => {
        if (name === '') return; // blank column: drop it
        const seen = used.get(name) ?? 0;
        used.set(name, seen + 1);
        columns.push(seen === 0 ? name : `${name} (${seen + 1})`);
        keepIdx.push(i);
    });
    if (columns.length === 0) return null;

    const body = sheet.rows.slice(headerIdx + 1)
        .map(r => keepIdx.map(i => r[i] ?? ''))
        .filter(r => r.some(c => c !== ''));
    return tableFromRows(columns, body);
};
