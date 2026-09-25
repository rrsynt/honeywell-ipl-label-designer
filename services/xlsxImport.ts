// Fase 2: .xlsx → DataTable. SheetJS is the parser; this module only decides
// WHICH rows become the table, so the decisions are testable with a tiny
// synthetic workbook instead of a fixture file.
//
// Header row is 1-based and chosen by the user (spreadsheets often have a
// title above the real header). Blank columns are dropped — they would map to
// nothing and clutter the query UI. Cell values are strings: a label prints
// text, and keeping numbers as text preserves leading zeros ("007").

import { tableFromRows } from './tableSource';
import type { DataTable } from './tableSource';

// SheetJS is ~430 KB of the main bundle and only a .xlsx import needs it, so it
// is loaded on first use rather than at module load — the same reason jspdf is
// imported this way. The cast keeps the module's own signatures synchronous:
// readWorkbook stays the one async entry point, and callers already await it.
type XlsxModule = typeof import('xlsx');
let xlsxModule: Promise<XlsxModule> | null = null;
const loadXlsx = (): Promise<XlsxModule> => (xlsxModule ??= import('xlsx'));

export interface WorkbookSheet {
    name: string;
    /** Raw grid, one array per row, trimmed. Shorter rows are padded later. */
    rows: string[][];
}

const cellText = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    return String(value).trim();
};

/** Every sheet as a grid of trimmed strings. Dates come through as Excel's
 *  formatted text (cellDates off), which is what should print. */
export const readWorkbook = async (bytes: Uint8Array): Promise<WorkbookSheet[]> => {
    const XLSX = await loadXlsx();
    const wb = XLSX.read(bytes, { type: 'array' });
    return wb.SheetNames.map(name => {
        const grid = XLSX.utils.sheet_to_json<(string | number | null)[]>(wb.Sheets[name], {
            header: 1, raw: false, defval: '', blankrows: false,
        });
        return { name, rows: grid.map(r => (Array.isArray(r) ? r : []).map(cellText)) };
    });
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
