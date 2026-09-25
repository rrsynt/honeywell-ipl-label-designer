import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { readWorkbook, sheetToTable } from '../services/xlsxImport';

/** Build a real xlsx in memory so the test covers SheetJS's behaviour, not a stub. */
const workbookBytes = (sheets: { name: string; rows: (string | number)[][] }[]): Uint8Array => {
    const wb = XLSX.utils.book_new();
    for (const s of sheets) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows), s.name);
    }
    const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    return new Uint8Array(out);
};

describe('xlsx import', () => {
    const bytes = workbookBytes([
        { name: 'Items', rows: [['Report title'], ['SKU', 'Qty', ''], ['A1', 2, ''], ['B2', 10, '']] },
        { name: 'Empty', rows: [] },
    ]);

    it('lists the sheets', async () => {
        expect((await readWorkbook(bytes)).map(s => s.name)).toEqual(['Items', 'Empty']);
    });

    it('uses the chosen header row and drops blank columns', async () => {
        const sheets = await readWorkbook(bytes);
        const table = sheetToTable(sheets, { sheet: 'Items', headerRow: 2 });
        expect(table?.columns).toEqual(['SKU', 'Qty']);
        expect(table?.rows).toEqual([{ SKU: 'A1', Qty: '2' }, { SKU: 'B2', Qty: '10' }]);
    });

    it('keeps numbers as text so leading zeros survive', async () => {
        const b = workbookBytes([{ name: 'S', rows: [['Code'], ['007']] }]);
        const table = sheetToTable(await readWorkbook(b), { sheet: 'S', headerRow: 1 });
        expect(table?.rows[0].Code).toBe('007');
    });

    it('suffixes duplicate header names', async () => {
        const b = workbookBytes([{ name: 'S', rows: [['Qty', 'Qty'], ['1', '2']] }]);
        const table = sheetToTable(await readWorkbook(b), { sheet: 'S', headerRow: 1 });
        expect(table?.columns).toEqual(['Qty', 'Qty (2)']);
        expect(table?.rows[0]).toEqual({ 'Qty': '1', 'Qty (2)': '2' });
    });

    it('skips fully blank data rows', async () => {
        const b = workbookBytes([{ name: 'S', rows: [['A'], ['x'], ['', ''], ['y']] }]);
        const table = sheetToTable(await readWorkbook(b), { sheet: 'S', headerRow: 1 });
        expect(table?.rows.map(r => r.A)).toEqual(['x', 'y']);
    });

    it('returns null for a missing sheet, a header row past the end, or an empty header', async () => {
        const sheets = await readWorkbook(bytes);
        expect(sheetToTable(sheets, { sheet: 'Nope', headerRow: 1 })).toBeNull();
        expect(sheetToTable(sheets, { sheet: 'Items', headerRow: 50 })).toBeNull();
        expect(sheetToTable(sheets, { sheet: 'Items', headerRow: 0 })).toBeNull();
        expect(sheetToTable(sheets, { sheet: 'Empty', headerRow: 1 })).toBeNull();
    });
});
