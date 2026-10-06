import { describe, it, expect } from 'vitest';
import { ExcelJSWorkbook } from './helpers/exceljsWorkbook';
import { readWorkbook, sheetToTable, MAX_XLSX_BYTES } from '../services/xlsxImport';
import { tableFromRows } from '../services/tableSource';

/** Build a real xlsx in memory so the test covers the parser's behaviour, not a stub. */
const workbookBytes = async (sheets: { name: string; rows: (string | number | Date)[][] }[]): Promise<Uint8Array> =>
    new ExcelJSWorkbook().build(sheets);

describe('xlsx import', () => {
    it('lists the sheets', async () => {
        const bytes = await workbookBytes([
            { name: 'Items', rows: [['Report title'], ['SKU', 'Qty', ''], ['A1', 2, ''], ['B2', 10, '']] },
            { name: 'Empty', rows: [] },
        ]);
        expect((await readWorkbook(bytes)).map(s => s.name)).toEqual(['Items', 'Empty']);
    });

    it('uses the chosen header row and drops blank columns', async () => {
        const bytes = await workbookBytes([
            { name: 'Items', rows: [['Report title'], ['SKU', 'Qty', ''], ['A1', 2, ''], ['B2', 10, '']] },
        ]);
        const sheets = await readWorkbook(bytes);
        const table = sheetToTable(sheets, { sheet: 'Items', headerRow: 2 });
        expect(table?.columns).toEqual(['SKU', 'Qty']);
        expect(table?.rows).toEqual([{ SKU: 'A1', Qty: '2' }, { SKU: 'B2', Qty: '10' }]);
    });

    it('keeps numbers as text so leading zeros survive', async () => {
        const b = await workbookBytes([{ name: 'S', rows: [['Code'], ['007']] }]);
        const table = sheetToTable(await readWorkbook(b), { sheet: 'S', headerRow: 1 });
        expect(table?.rows[0].Code).toBe('007');
    });

    it('renders dates as ISO, not locale text', async () => {
        // SheetJS returned Excel's formatted text (locale-dependent); ExcelJS
        // hands back Dates, rendered here as deterministic ISO.
        const b = await workbookBytes([{ name: 'S', rows: [['D'], [new Date(2024, 4, 12)]] }]);
        const table = sheetToTable(await readWorkbook(b), { sheet: 'S', headerRow: 1 });
        expect(table?.rows[0].D).toBe('2024-05-12');
    });

    it('suffixes duplicate header names', async () => {
        const b = await workbookBytes([{ name: 'S', rows: [['Qty', 'Qty'], ['1', '2']] }]);
        const table = sheetToTable(await readWorkbook(b), { sheet: 'S', headerRow: 1 });
        expect(table?.columns).toEqual(['Qty', 'Qty (2)']);
        expect(table?.rows[0]).toEqual({ 'Qty': '1', 'Qty (2)': '2' });
    });

    it('skips fully blank data rows', async () => {
        const b = await workbookBytes([{ name: 'S', rows: [['A'], ['x'], ['', ''], ['y']] }]);
        const table = sheetToTable(await readWorkbook(b), { sheet: 'S', headerRow: 1 });
        expect(table?.rows.map(r => r.A)).toEqual(['x', 'y']);
    });

    it('returns null for a missing sheet, a header row past the end, or an empty header', async () => {
        const bytes = await workbookBytes([
            { name: 'Items', rows: [['Report title'], ['SKU', 'Qty']] },
            { name: 'Empty', rows: [] },
        ]);
        const sheets = await readWorkbook(bytes);
        expect(sheetToTable(sheets, { sheet: 'Nope', headerRow: 1 })).toBeNull();
        expect(sheetToTable(sheets, { sheet: 'Items', headerRow: 50 })).toBeNull();
        expect(sheetToTable(sheets, { sheet: 'Items', headerRow: 0 })).toBeNull();
        expect(sheetToTable(sheets, { sheet: 'Empty', headerRow: 1 })).toBeNull();
    });

    it('refuses an oversized file before parsing', async () => {
        const big = new Uint8Array(MAX_XLSX_BYTES + 1);
        await expect(readWorkbook(big)).rejects.toThrow(/over the 10 MB/);
    });
});

describe('tableFromRows defines columns (no proto-pollution)', () => {
    it('a __proto__ header becomes an own property, not a prototype rewrite', () => {
        const table = tableFromRows(['__proto__', 'A'], [['pwned', 'x']]);
        const row = table.rows[0] as Record<string, string>;
        expect(Object.prototype.hasOwnProperty.call(row, '__proto__')).toBe(true);
        expect(row['__proto__']).toBe('pwned');
        expect(({} as Record<string, string>)['__proto__']).toBe(Object.prototype);
        expect(row.A).toBe('x');
    });
});
