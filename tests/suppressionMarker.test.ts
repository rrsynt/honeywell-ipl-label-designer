// Fase 6: the sheet preview marks which fields a record dropped.
//
// The marker is only useful if it agrees with the printer. So this file does
// not check "the function returns the right ids" in isolation — it renders the
// SAME row through generateIPL and asserts that the marked fields are exactly
// the ones whose print-block data came out empty. A preview that disagrees
// with the stream is worse than no preview: it would send someone hunting for
// a printer fault that is really a suppression rule.

import { describe, it, expect } from 'vitest';
import { generateIPL, suppressedFieldIdsForRow, rowCellFor } from '../services/iplGenerator';
import type { BatchData } from '../services/iplGenerator';
import { planDesignTableJob } from '../services/tableSource';
import type { Design, TextField } from '../types';

const design = (fields: Partial<TextField>[], rows: Record<string, string>[]): Design => ({
    name: 'Suppression',
    labelSettings: { width: 100, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields: fields.map((over, i) => ({
        id: i + 1, type: 'text', name: `F${i + 1}`, x: 5 + i * 5, y: 5, rotation: 0,
        dataSource: { type: 'linked', sourceId: 's1' },
        font: '25', fontSize: 12, h_mag: 1, w_mag: 1,
        ...over,
    })) as Design['fields'],
    dataSources: [{
        id: 's1', name: 'Orders', type: 'table',
        columns: ['MARKET', 'SKU'], rows,
        query: { filters: [], combine: 'and' },
    }],
    nextId: 9,
    guides: { horizontal: [], vertical: [] },
} as Design);

/** The print-block data the stream carries for field id `id`, or null when the
 *  stream has no `<ESC>F<id>` entry at all. */
const dataForField = (stream: string, id: number): string | null => {
    const m = new RegExp(`<ESC>F${id}<NUL>([\\s\\S]*?)(?=<ESC>F|<RS>|<ETB>)`).exec(stream);
    return m ? m[1] : null;
};

describe('rowCellFor', () => {
    it('reads the mapped column, and undefined for an unmapped or ragged row', () => {
        const batch: BatchData = { headers: ['A', 'B'], mappings: { 1: 0 }, rows: [['x', 'y']] };
        expect(rowCellFor(batch, 1, batch.rows[0])).toBe('x');
        expect(rowCellFor(batch, 2, batch.rows[0])).toBeUndefined(); // unmapped
        expect(rowCellFor(batch, 1, [])).toBeUndefined();            // ragged
        // An explicit mapping past the row's length is the same as unmapped.
        expect(rowCellFor({ headers: ['A'], mappings: { 1: 5 }, rows: [['x']] }, 1, ['x'])).toBeUndefined();
    });
});

describe('suppressedFieldIdsForRow', () => {
    it('marks a field whose own rule matches the row', async () => {
        const d = design([
            { name: 'SKU' },
            // Suppressed on export labels only.
            { name: 'Price', dataSource: { type: 'linked', sourceId: 's1', column: 'MARKET' }, suppress: 'IF(value, "EQ", "EXPORT", "yes", "")' },
        ], [
            { MARKET: 'HOME', SKU: 'A1' },
            { MARKET: 'EXPORT', SKU: 'A2' },
        ]);
        const plan = planDesignTableJob(d).plan!;
        expect(suppressedFieldIdsForRow(d, [d.fields[0] as TextField, d.fields[1] as TextField], plan.batch.rows[0], plan.batch)).toEqual([]);
        expect(suppressedFieldIdsForRow(d, [d.fields[0] as TextField, d.fields[1] as TextField], plan.batch.rows[1], plan.batch)).toEqual([2]);
    });

    it('marks every member of a hidden group', async () => {
        // A group's condition is judged against its reference member — the
        // lowest id — so THAT member is the one that has to read a column.
        const d = design([
            { name: 'SKU' },
            { name: 'ExportCode', groupId: 5, dataSource: { type: 'linked', sourceId: 's1', column: 'MARKET' } },
            { name: 'ExportNote', groupId: 5 },
        ], [{ MARKET: 'EXPORT', SKU: 'A1' }]);
        d.groupSuppress = { 5: 'IF(value, "EQ", "EXPORT", "yes", "")' };
        const plan = planDesignTableJob(d).plan!;
        const fields = d.fields as TextField[];
        expect(suppressedFieldIdsForRow(d, fields, plan.batch.rows[0], plan.batch)).toEqual([2, 3]);
    });

    it('marks nothing when no rule parses — a typo must not drop a field', async () => {
        const d = design([{ name: 'SKU', suppress: 'UPPERCASE(value)' }], [{ SKU: 'A1' }]);
        const plan = planDesignTableJob(d).plan!;
        expect(suppressedFieldIdsForRow(d, d.fields as TextField[], plan.batch.rows[0], plan.batch)).toEqual([]);
    });
});

describe('THE CONTRACT: the marker equals what the stream did', () => {
    it('every marked field has empty print data, and every field with data is unmarked', async () => {
        const d = design([
            { name: 'SKU' },
            { name: 'Price', dataSource: { type: 'linked', sourceId: 's1', column: 'MARKET' }, suppress: 'IF(value, "EQ", "EXPORT", "yes", "")' },
            { name: 'Note', suppress: 'IF(value, "EMPTY", "", "yes", "")' },
        ], [
            { MARKET: 'HOME', SKU: 'A1' },
            { MARKET: 'EXPORT', SKU: 'A2' },
        ]);
        const plan = planDesignTableJob(d).plan!;
        const fields = d.fields as TextField[];

        for (let row = 0; row < plan.batch.rows.length; row++) {
            // One row at a time through the REAL generator, exactly as the
            // print job would send it.
            const stream = await generateIPL(d, { ...plan.batch, rows: [plan.batch.rows[row]] });
            const marked = new Set(suppressedFieldIdsForRow(d, fields, plan.batch.rows[row], plan.batch));

            for (const field of fields) {
                const data = dataForField(stream, field.id);
                expect(data, `field ${field.id} missing from the stream`).not.toBeNull();
                const isEmpty = data === '';
                expect(
                    marked.has(field.id),
                    `record ${row + 1}, field ${field.id} ("${field.name}"): marker says ${marked.has(field.id) ? 'suppressed' : 'printed'} but the stream data is ${isEmpty ? 'empty' : JSON.stringify(data)}`,
                ).toBe(isEmpty);
            }
        }
    });

    it('a hidden GROUP is marked on every member, matching the stream', async () => {
        // Both members read a real column, so "empty data" can only mean
        // suppression here. A field that is merely unmapped also prints
        // nothing, and a marker test that confuses the two proves nothing.
        const d = design([
            { name: 'SKU' },
            { name: 'ExportCode', groupId: 5, dataSource: { type: 'linked', sourceId: 's1', column: 'MARKET' } },
            { name: 'ExportNote', groupId: 5, dataSource: { type: 'linked', sourceId: 's1', column: 'SKU' } },
        ], [
            { MARKET: 'HOME', SKU: 'A1' },
            { MARKET: 'EXPORT', SKU: 'A2' },
        ]);
        d.groupSuppress = { 5: 'IF(value, "EQ", "EXPORT", "yes", "")' };
        const plan = planDesignTableJob(d).plan!;
        const fields = d.fields as TextField[];

        for (let row = 0; row < plan.batch.rows.length; row++) {
            const stream = await generateIPL(d, { ...plan.batch, rows: [plan.batch.rows[row]] });
            const marked = new Set(suppressedFieldIdsForRow(d, fields, plan.batch.rows[row], plan.batch));
            for (const field of fields) {
                expect(marked.has(field.id), `record ${row + 1}, field ${field.id}`).toBe(dataForField(stream, field.id) === '');
            }
        }
    });

    it('the marker follows the ROW, not the field — the same field flips between records', async () => {
        const d = design([
            { name: 'SKU' },
            { name: 'Price', dataSource: { type: 'linked', sourceId: 's1', column: 'MARKET' }, suppress: 'IF(value, "EQ", "EXPORT", "yes", "")' },
        ], [
            { MARKET: 'HOME', SKU: 'A1' },
            { MARKET: 'EXPORT', SKU: 'A2' },
            { MARKET: 'HOME', SKU: 'A3' },
        ]);
        const plan = planDesignTableJob(d).plan!;
        const fields = d.fields as TextField[];
        const markedPerRow = plan.batch.rows.map(row => suppressedFieldIdsForRow(d, fields, row, plan.batch).length);
        expect(markedPerRow).toEqual([0, 1, 0]);
    });
});
