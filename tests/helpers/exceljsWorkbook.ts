// Test helper: build a real .xlsx in memory with ExcelJS (the import path's
// own parser), so xlsxImport tests cover the parser's behaviour, not a stub.
import ExcelJS from 'exceljs';

export class ExcelJSWorkbook {
    async build(sheets: { name: string; rows: (string | number | Date)[][] }[]): Promise<Uint8Array> {
        const wb = new ExcelJS.Workbook();
        for (const s of sheets) {
            const ws = wb.addWorksheet(s.name);
            for (const row of s.rows) ws.addRow(row);
        }
        const buffer = await wb.xlsx.writeBuffer();
        return new Uint8Array(buffer as ArrayBuffer);
    }
}
