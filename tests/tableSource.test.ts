import { describe, it, expect } from 'vitest';
import {
    applyQuery, tableFromRows, planTableJob, planDesignTableJob, applyTransform,
    transformBatchColumn, applyLinkedTransforms, resolveLinkedPreview, EMPTY_QUERY,
    isSuppressed, fieldIsSuppressed, groupIsSuppressed,
} from '../services/tableSource';
import type { DataTable } from '../services/tableSource';
import type { DataQuery } from '../types';
import { buildBatchData, planCsvJob, rowBatchData } from '../services/csvJob';
import { generateIPL, suppressionWarnings } from '../services/iplGenerator';
import { sheetToTable } from '../services/xlsxImport';
import type { Design, Field } from '../types';

const table = (): DataTable => tableFromRows(
    ['SKU', 'Qty', 'Status'],
    [['A1', '2', 'OK'], ['B2', '10', 'HOLD'], ['C3', '3', 'OK'], ['D4', '', 'OK']],
);

const query = (over: Partial<DataQuery>): DataQuery => ({ ...EMPTY_QUERY, ...over });

const designWith = (fieldName: string): Design => ({
    name: 'T',
    labelSettings: { width: 100, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields: [{ id: 7, type: 'text', name: fieldName, x: 0, y: 0, rotation: 0, dataSource: { type: 'variable', defaultData: '' }, font: '25', fontSize: 12, h_mag: 1, w_mag: 1 }],
    dataSources: [],
    nextId: 8,
    guides: { horizontal: [], vertical: [] },
} as Design);

describe('applyQuery', () => {
    it('filters with AND and OR', () => {
        const and = applyQuery(table(), query({
            filters: [{ column: 'Status', op: 'eq', value: 'OK' }, { column: 'Qty', op: 'neq', value: '2' }],
        }));
        expect(and.rows.map(r => r.SKU)).toEqual(['C3', 'D4']);

        const or = applyQuery(table(), query({
            combine: 'or',
            filters: [{ column: 'SKU', op: 'eq', value: 'A1' }, { column: 'Status', op: 'eq', value: 'HOLD' }],
        }));
        expect(or.rows.map(r => r.SKU)).toEqual(['A1', 'B2']);
    });

    it('matches empty and non-empty cells', () => {
        const q = applyQuery(table(), query({ filters: [{ column: 'Qty', op: 'empty', value: '' }] }));
        expect(q.rows.map(r => r.SKU)).toEqual(['D4']);
        const q2 = applyQuery(table(), query({ filters: [{ column: 'Qty', op: 'notEmpty', value: '' }] }));
        expect(q2.rows).toHaveLength(3);
    });

    it('trims both sides and is case-sensitive', () => {
        const t = tableFromRows(['S'], [[' OK '], ['ok']]);
        expect(applyQuery(t, query({ filters: [{ column: 'S', op: 'eq', value: 'OK' }] })).rows).toHaveLength(1);
        expect(applyQuery(t, query({ filters: [{ column: 'S', op: 'eq', value: 'ok' }] })).rows).toHaveLength(1);
    });

    it('sorts numbers numerically and text lexicographically', () => {
        const byQty = applyQuery(table(), query({ sortColumn: 'Qty', sortDir: 'asc' }));
        expect(byQty.rows.map(r => r.SKU)).toEqual(['D4', 'A1', 'C3', 'B2']); // '' < 2 < 3 < 10
        const bySkuDesc = applyQuery(table(), query({ sortColumn: 'SKU', sortDir: 'desc' }));
        expect(bySkuDesc.rows.map(r => r.SKU)).toEqual(['D4', 'C3', 'B2', 'A1']);
    });

    it('sorts only by a column that exists', () => {
        const same = applyQuery(table(), query({ sortColumn: 'nope' }));
        expect(same.rows.map(r => r.SKU)).toEqual(['A1', 'B2', 'C3', 'D4']);
    });

    it('slices a 1-based inclusive record range', () => {
        const mid = applyQuery(table(), query({ fromRow: 2, toRow: 3 }));
        expect(mid.rows.map(r => r.SKU)).toEqual(['B2', 'C3']);
    });

    it('ignores a nonsense range instead of throwing', () => {
        const all = applyQuery(table(), query({ fromRow: 0, toRow: -5 }));
        expect(all.rows).toHaveLength(4);
        const none = applyQuery(table(), query({ fromRow: 100 }));
        expect(none.rows).toHaveLength(0);
    });

    it('applies filter, then sort, then range — in that order', () => {
        const out = applyQuery(table(), query({
            filters: [{ column: 'Status', op: 'eq', value: 'OK' }],
            sortColumn: 'SKU', sortDir: 'desc',
            fromRow: 1, toRow: 2,
        }));
        expect(out.rows.map(r => r.SKU)).toEqual(['D4', 'C3']);
    });
});

describe('planTableJob', () => {
    it('produces the same batch as the CSV path for identical data', () => {
        const t = table();
        const fromTable = planTableJob(designWith('SKU'), t);
        const fromCsv = buildBatchData(designWith('SKU'), { headers: t.columns, rows: t.rows.map(r => t.columns.map(c => r[c])) });
        expect(fromTable?.batch).toEqual(fromCsv);
    });

    it('a filter cuts the number of labels', () => {
        const plan = planTableJob(designWith('SKU'), table(), query({ filters: [{ column: 'Status', op: 'eq', value: 'HOLD' }] }));
        expect(plan?.batch.rows).toEqual([['B2', '10', 'HOLD']]);
    });

    it('returns null when the query matches nothing', () => {
        const plan = planTableJob(designWith('SKU'), table(), query({ filters: [{ column: 'Status', op: 'eq', value: 'GONE' }] }));
        expect(plan).toBeNull();
    });

    it('returns null when no column maps to a field', () => {
        expect(planTableJob(designWith('NotAColumn'), table())).toBeNull();
    });
});

describe('applyTransform', () => {
    it('uppercases, lowercases and trims', () => {
        expect(applyTransform('UPPER(value)', 'ab').result).toBe('AB');
        expect(applyTransform('LOWER(value)', 'AB').result).toBe('ab');
        expect(applyTransform('TRIM(value)', '  x  ').result).toBe('x');
    });

    it('SUBSTR is 1-based and clamps', () => {
        expect(applyTransform('SUBSTR(value, 2, 3)', 'ABCDEF').result).toBe('BCD');
        expect(applyTransform('SUBSTR(value, 1)', 'ABC').result).toBe('ABC');
        expect(applyTransform('SUBSTR(value, 0, 2)', 'ABC').result).toBe('AB');
    });

    it('pads on the left like a counter', () => {
        expect(applyTransform('PAD(value, 4, "0")', '7').result).toBe('0007');
        expect(applyTransform('PAD(value, 4, "0")', '12345').result).toBe('12345');
    });

    it('replaces literal text', () => {
        expect(applyTransform('REPLACE(value, "-", "")', 'A-1-2').result).toBe('A12');
    });

    it('nests calls', () => {
        expect(applyTransform('UPPER(SUBSTR(value, 1, 4))', 'widget').result).toBe('WIDG');
    });

    it('a bad expression returns the value unchanged AND a warning', () => {
        const unknown = applyTransform('REVERSE(value)', 'abc');
        expect(unknown.result).toBe('abc');
        expect(unknown.warning).not.toBeNull();
        const garbage = applyTransform('not a call', 'abc');
        expect(garbage.result).toBe('abc');
        expect(garbage.warning).not.toBeNull();
    });

    it('an empty expression is a no-op without warning', () => {
        expect(applyTransform('  ', 'abc')).toEqual({ result: 'abc', warning: null });
        expect(applyTransform('value', 'abc').warning).toBeNull();
    });

    it('CONCAT joins arguments, quoted literals included', () => {
        expect(applyTransform('CONCAT(value, "-", "X")', 'AB').result).toBe('AB-X');
        // A comma inside quotes is data, not an argument boundary.
        expect(applyTransform('CONCAT("a,b", value)', 'c').result).toBe('a,bc');
    });

    it('IF picks a branch and compares case-insensitively', () => {
        expect(applyTransform('IF(value, "EQ", "export", "YES", "NO")', 'EXPORT').result).toBe('YES');
        expect(applyTransform('IF(value, "NEQ", "X", "YES", "")', 'X').result).toBe('');
        expect(applyTransform('IF(value, "EMPTY", "", "BLANK", "FULL")', '  ').result).toBe('BLANK');
        expect(applyTransform('IF(value, "NOTEMPTY", "", "FULL", "")', '').result).toBe('');
    });

    it('an IF with an unknown comparison warns and changes nothing', () => {
        const bad = applyTransform('IF(value, "GT", "5", "big", "small")', '9');
        expect(bad.result).toBe('9');
        expect(bad.warning).not.toBeNull();
        // The same failure buried inside another call still warns.
        const nested = applyTransform('CONCAT(IF(value, "GT", "5", "big", "small"), "!")', '9');
        expect(nested.warning).not.toBeNull();
    });
});

describe('LOOKUP (Fase 4)', () => {
    // A price list stored in the design. The field prints an SKU; the expression
    // turns that SKU into its price. `query` keeps the HOLD row out, so a lookup
    // must never be able to see it.
    const designWithPriceList = (): Design => ({
        ...designWith('SKU'),
        dataSources: [{
            id: 'prices', type: 'table', name: 'Prices',
            columns: ['SKU', 'Price'],
            rows: [{ SKU: 'A1', Price: '1.50' }, { SKU: 'B2', Price: '2.00' }, { SKU: 'C3', Price: '9.99' }],
            query: { ...EMPTY_QUERY, filters: [{ column: 'SKU', op: 'neq', value: 'C3' }] },
        }],
    });

    it('returns the column of the row whose key matches the cell', () => {
        const found = applyTransform('LOOKUP("Prices", "SKU", value, "Price")', 'B2', designWithPriceList());
        expect(found).toEqual({ result: '2.00', warning: null });
    });

    it('matches the key trimmed and case-insensitively, like every other comparison', () => {
        const found = applyTransform('LOOKUP("Prices", "SKU", value, "Price")', '  a1 ', designWithPriceList());
        expect(found.result).toBe('1.50');
        expect(found.warning).toBeNull();
    });

    it('returns the first matching row when the key repeats', () => {
        const design = designWithPriceList();
        const table = design.dataSources[0];
        if (table.type !== 'table') throw new Error('fixture');
        table.rows = [{ SKU: 'A1', Price: 'FIRST' }, { SKU: 'A1', Price: 'SECOND' }];
        table.query = { ...EMPTY_QUERY };
        expect(applyTransform('LOOKUP("Prices", "SKU", value, "Price")', 'A1', design).result).toBe('FIRST');
    });

    it('a key the table does not have returns nothing and warns, naming the key', () => {
        const missed = applyTransform('LOOKUP("Prices", "SKU", value, "Price")', 'Z9', designWithPriceList());
        expect(missed.result).toBe('');
        expect(missed.warning?.message).toMatch(/Z9/);
    });

    it('a row the query filtered out is invisible to the lookup', () => {
        // C3 exists in the stored rows but the query excludes it.
        const hidden = applyTransform('LOOKUP("Prices", "SKU", value, "Price")', 'C3', designWithPriceList());
        expect(hidden.result).toBe('');
        expect(hidden.warning).not.toBeNull();
    });

    it('names the table, the key column and the result column when they do not exist', () => {
        const design = designWithPriceList();
        expect(applyTransform('LOOKUP("Nope", "SKU", value, "Price")', 'A1', design).warning?.message).toMatch(/Nope/);
        expect(applyTransform('LOOKUP("Prices", "Nope", value, "Price")', 'A1', design).warning?.message).toMatch(/Nope/);
        expect(applyTransform('LOOKUP("Prices", "SKU", value, "Nope")', 'A1', design).warning?.message).toMatch(/Nope/);
    });

    it('without a design there is nothing to look up, so it warns and changes nothing', () => {
        const bare = applyTransform('LOOKUP("Prices", "SKU", value, "Price")', 'A1');
        expect(bare.result).toBe('A1');
        expect(bare.warning).not.toBeNull();
    });

    it('nests, so the looked-up text can still be transformed', () => {
        expect(applyTransform('UPPER(LOOKUP("Prices", "SKU", value, "Price"))', 'b2', designWithPriceList()).result).toBe('2.00');
    });

    it('a job prints the looked-up column, not the raw key', () => {
        const design = designWithPriceList();
        const table = design.dataSources[0];
        if (table.type !== 'table') throw new Error('fixture');
        table.query = { ...EMPTY_QUERY };
        design.fields = design.fields.map(f => ({
            ...f,
            dataSource: { type: 'linked' as const, sourceId: 'prices', column: 'SKU', transform: 'LOOKUP("Prices", "SKU", value, "Price")' },
        }));
        const plan = planDesignTableJob(design).plan;
        expect(plan).not.toBeNull();
        // The SKU column is what the field maps to, and the transform rewrites it.
        expect(plan!.batch.rows.map(r => r[plan!.batch.mappings[7]])).toEqual(['1.50', '2.00', '9.99']);
    });
});

describe('planDesignTableJob', () => {
    const newTableSource = () => ({
        id: 'tbl-1', type: 'table' as const, name: 'Stock',
        columns: ['SKU', 'Qty'], rows: [{ SKU: 'A1', Qty: '2' }, { SKU: 'b2', Qty: '10' }],
        query: { ...EMPTY_QUERY },
    });

    const designWithTable = (fieldName: string, column?: string, transform?: string): Design => {
        const base = designWith(fieldName);
        const table = newTableSource();
        return {
            ...base,
            dataSources: [table],
            fields: base.fields.map(f => f.name === fieldName
                ? { ...f, dataSource: { type: 'linked' as const, sourceId: table.id, column, transform } }
                : f),
        };
    };

    it('prints the same rows as the CSV path for identical data', () => {
        const design = designWithTable('SKU');
        const fromDesign = planDesignTableJob(design).plan;
        const t = tableFromRows(['SKU', 'Qty'], [['A1', '2'], ['b2', '10']]);
        const fromCsv = planTableJob(design, t);
        expect(fromDesign?.batch.rows).toEqual(fromCsv?.batch.rows);
    });

    it('an explicit column binding beats the name match', () => {
        // The field is named "Code" but bound to the Qty column.
        const design = designWithTable('Code', 'Qty');
        const plan = planDesignTableJob(design).plan;
        expect(plan?.batch.rows.map(r => r[plan.batch.mappings[7]])).toEqual(['2', '10']);
    });

    it('applies a linked transform to the printed column', () => {
        const design = designWithTable('SKU', undefined, 'UPPER(value)');
        const plan = planDesignTableJob(design).plan;
        expect(plan?.batch.rows.map(r => r[0])).toEqual(['A1', 'B2']);
    });

    it('names a table whose query matches nothing instead of dropping it silently', () => {
        const design = designWithTable('SKU');
        const table = design.dataSources[0];
        if (table.type !== 'table') throw new Error('fixture');
        table.query = { ...EMPTY_QUERY, filters: [{ column: 'SKU', op: 'eq', value: 'GONE' }] };
        const result = planDesignTableJob(design);
        expect(result.plan).toBeNull();
        expect(result.empty).toEqual(['Stock']);
    });

    it('returns no plan when the design has no table', () => {
        expect(planDesignTableJob(designWith('SKU')).plan).toBeNull();
    });

    it('CSV, a spreadsheet sheet and the stored table emit identical print blocks', async () => {
        const design = designWithTable('SKU');
        const rows = [['A1', '2'], ['b2', '10']];

        const fromTable = planDesignTableJob(design).plan;
        const fromCsv = planCsvJob(design, { headers: ['SKU', 'Qty'], rows });
        const fromSheet = planTableJob(design, sheetToTable(
            [{ name: 'Sheet1', rows: [['SKU', 'Qty'], ...rows] }],
            { sheet: 'Sheet1', headerRow: 1 },
        )!);

        const [a, b, c] = await Promise.all([
            generateIPL(design, fromTable!.batch),
            generateIPL(design, fromCsv!.batch),
            generateIPL(design, fromSheet!.batch),
        ]);
        expect(a).toBe(b);
        expect(b).toBe(c);
        // The data actually landed in the stream, not just the format wrapper.
        expect(a).toContain('A1');
        expect(a).toContain('b2');
    });
});

describe('applyLinkedTransforms', () => {
    const batch = { headers: ['SKU'], mappings: { 1: 0, 2: 0 }, rows: [['ab'], ['cd']] };

    const field = (id: number, transform?: string) => ({
        id, type: 'text' as const, name: `F${id}`, x: 0, y: 0, rotation: 0 as const,
        dataSource: { type: 'linked' as const, sourceId: 's', transform },
        font: '25', fontSize: 12, h_mag: 1, w_mag: 1,
    });

    it('transforms the mapped column', () => {
        const out = applyLinkedTransforms(designWith('SKU'), [field(1, 'UPPER(value)')], batch);
        expect(out.batch.rows).toEqual([['AB'], ['CD']]);
        expect(out.warnings).toEqual([]);
        expect(batch.rows[0][0]).toBe('ab');
    });

    it('reverts to raw and warns when two fields transform one column differently', () => {
        const out = applyLinkedTransforms(designWith('SKU'), [field(1, 'UPPER(value)'), field(2, 'LOWER(value)')], batch);
        expect(out.batch.rows).toEqual(batch.rows);
        expect(out.warnings[0]).toMatch(/share column/);
    });

    it('warns but still prints when the expression is bad', () => {
        const out = applyLinkedTransforms(designWith('SKU'), [field(1, 'NOPE(value)')], batch);
        expect(out.batch.rows).toEqual(batch.rows);
        expect(out.warnings[0]).toMatch(/Unknown function/);
    });
});

describe('resolveLinkedPreview', () => {
    it('reads the first row of the bound column', () => {
        const source = { id: 't', type: 'table' as const, name: 'T', columns: ['SKU'], rows: [{ SKU: 'A1' }, { SKU: 'B2' }], query: { ...EMPTY_QUERY } };
        expect(resolveLinkedPreview(source, { type: 'linked', sourceId: 't', column: 'SKU' }, 'Code')).toBe('A1');
    });

    it('falls back to the field name when no column is bound', () => {
        const source = { id: 't', type: 'table' as const, name: 'T', columns: ['SKU'], rows: [{ SKU: 'A1' }], query: { ...EMPTY_QUERY } };
        expect(resolveLinkedPreview(source, { type: 'linked', sourceId: 't' }, 'SKU')).toBe('A1');
    });

    it('returns null when neither the binding nor the field name matches a column', () => {
        const source = { id: 't', type: 'table' as const, name: 'T', columns: ['SKU'], rows: [{ SKU: 'A1' }], query: { ...EMPTY_QUERY } };
        expect(resolveLinkedPreview(source, { type: 'linked', sourceId: 't' }, 'Code')).toBeNull();
    });

    it('returns null for a missing source', () => {
        expect(resolveLinkedPreview(undefined, { type: 'linked', sourceId: 'gone' }, 'SKU')).toBeNull();
    });

    it('the single-label export prints the first matching row, transformed', async () => {
        const design = designWith('Code');
        design.dataSources = [{
            id: 't', type: 'table', name: 'T', columns: ['SKU'],
            rows: [{ SKU: 'hold' }, { SKU: 'ok' }],
            query: { ...EMPTY_QUERY, filters: [{ column: 'SKU', op: 'eq', value: 'ok' }] },
        }];
        design.fields = design.fields.map(f => ({ ...f, dataSource: { type: 'linked' as const, sourceId: 't', column: 'SKU', transform: 'UPPER(value)' } }));
        const ipl = await generateIPL(design);
        expect(ipl).toContain('OK');
        expect(ipl).not.toContain('hold');
    });

    it('a record past the end of the table warns and is clamped, not thrown', () => {
        const design = designWith('SKU');
        const plan = planTableJob(design, table());
        // One row past the last. rowBatchData clamps to the final row rather
        // than indexing off the end — the preview must show a label, not crash.
        const row = rowBatchData(plan!, plan!.batch.rows.length + 5);
        expect(row.rows).toHaveLength(1);
        expect(row.rows[0]).toEqual(plan!.batch.rows[plan!.batch.rows.length - 1]);
    });

    it('honours the query, so a filtered-out first row is not what previews', () => {
        const source = {
            id: 't', type: 'table' as const, name: 'T', columns: ['SKU', 'Status'],
            rows: [{ SKU: 'A1', Status: 'HOLD' }, { SKU: 'B2', Status: 'OK' }],
            query: { ...EMPTY_QUERY, filters: [{ column: 'Status', op: 'eq' as const, value: 'OK' }] },
        };
        expect(resolveLinkedPreview(source, { type: 'linked', sourceId: 't', column: 'SKU' }, 'SKU')).toBe('B2');
    });
});

describe('suppression (Fase 4)', () => {
    const suppressWhen = (value: string) => `IF(value, "EQ", "${value}", "yes", "")`;

    it('suppresses only on a non-empty, warning-free result', () => {
        expect(isSuppressed(suppressWhen('EXPORT'), 'export').suppress).toBe(true);
        expect(isSuppressed(suppressWhen('EXPORT'), 'HOME').suppress).toBe(false);
        expect(isSuppressed('IF(value, "EMPTY", "", "yes", "")', '   ').suppress).toBe(true);
        expect(isSuppressed('IF(value, "EMPTY", "", "yes", "")', 'x').suppress).toBe(false);
        // No condition means always print.
        expect(isSuppressed(undefined, 'anything').suppress).toBe(false);
        expect(isSuppressed('   ', 'anything').suppress).toBe(false);
    });

    it('a condition that does not parse suppresses nothing and warns', () => {
        const broken = isSuppressed('IF(value, "GT", "5", "yes", "")', '9');
        expect(broken.suppress).toBe(false);
        expect(broken.warning).not.toBeNull();
        const garbage = isSuppressed('not a condition', 'x');
        expect(garbage.suppress).toBe(false);
        expect(garbage.warning).not.toBeNull();
    });

    it('removes the field from the matching row of the stream but keeps it defined', async () => {
        const design = designWith('Dest');
        design.fields = design.fields.map(f => ({ ...f, suppress: suppressWhen('EXPORT') }));
        const batch = {
            headers: ['Dest'], mappings: { 7: 0 },
            rows: [['EXPORT'], ['HOME']],
        };
        const ipl = await generateIPL(design, batch);

        // One print block per row. The matching row carries an EMPTY payload for
        // the field; the other row carries its data. Both blocks still name the
        // field, and the format definition is still there — suppression blanks a
        // label, it does not delete the field.
        const blocks = ipl.match(/<ESC>E\d<CAN>.*?<ETX>/g) ?? [];
        expect(blocks).toHaveLength(2);
        expect(blocks[0]).toContain('<ESC>F7<NUL><RS>');
        expect(blocks[0]).not.toContain('EXPORT');
        expect(blocks[1]).toContain('<ESC>F7<NUL>HOME');
        expect(ipl).toContain('<STX>H7;');
    });

    it('a broken condition leaves every row intact and is reported', async () => {
        const design = designWith('Dest');
        design.fields = design.fields.map(f => ({ ...f, suppress: 'IF(value, "GT", "5", "yes", "")' }));
        const ipl = await generateIPL(design, { headers: ['Dest'], mappings: { 7: 0 }, rows: [['9'], ['1']] });
        const blocks = ipl.match(/<ESC>E\d<CAN>.*?<ETX>/g) ?? [];
        expect(blocks[0]).toContain('<ESC>F7<NUL>9');
        expect(blocks[1]).toContain('<ESC>F7<NUL>1');
        expect(suppressionWarnings(design).length).toBeGreaterThan(0);
    });

    it('a linked field is judged on the cell it prints, in the stream and on screen', async () => {
        const design = designWith('Code');
        design.dataSources = [{
            id: 't', type: 'table', name: 'T', columns: ['SKU'],
            rows: [{ SKU: 'EXPORT' }], query: { ...EMPTY_QUERY },
        }];
        design.fields = design.fields.map(f => ({
            ...f, suppress: suppressWhen('EXPORT'),
            dataSource: { type: 'linked' as const, sourceId: 't', column: 'SKU' },
        }));

        // No batch: the single-label stream falls back to the source's preview
        // value, which is the cell the condition must see.
        const ipl = await generateIPL(design);
        expect(ipl).toContain('<ESC>F7<NUL><ETB>');
        expect(ipl).not.toContain('EXPORT');

        // The same field, judged the same way, is what the canvas hides.
        expect(fieldIsSuppressed(design.fields[0], design)).toBe(true);

        // Change the cell and both agree it prints again.
        const table = design.dataSources[0];
        if (table.type === 'table') table.rows = [{ SKU: 'HOME' }];
        const printed = await generateIPL(design);
        expect(printed).toContain('<ESC>F7<NUL>HOME');
        expect(fieldIsSuppressed(design.fields[0], design)).toBe(false);
    });

    it('a group condition hides every member, and a static member leaves the format', async () => {
        const design = designWith('Dest');
        const box: Field = { id: 8, type: 'line', name: 'Rule', x: 0, y: 10, rotation: 0, length: 40, thickness: 0.5 } as Field;
        design.fields = [...design.fields.map(f => ({ ...f, groupId: 3, dataSource: { type: 'fixed' as const, data: 'EXPORT' } })), { ...box, groupId: 3 }];
        design.nextId = 9;
        design.groupSuppress = { 3: suppressWhen('EXPORT') };
        const batch = { headers: ['Dest'], mappings: { 7: 0 }, rows: [['EXPORT'], ['HOME']] };
        const ipl = await generateIPL(design, batch);

        // The matching row prints the base format, which has neither member.
        // The other row prints the group's format, which has the line.
        const blocks = ipl.match(/<ESC>E\d<CAN>.*?<ETX>/g) ?? [];
        expect(blocks[0]).toContain('<ESC>E1<CAN>');
        expect(blocks[0]).not.toContain('<ESC>F7');
        expect(blocks[1]).toContain('<ESC>E2<CAN>');
        // Fixed text is baked into the format, so the group's format carries the
        // data and the base format does not.
        expect(ipl.match(/<STX>H7;[^<]*EXPORT/g)).toHaveLength(1);
        // The line exists in exactly one format — the group's.
        expect(ipl.match(/<STX>L8;/g)).toHaveLength(1);

        // And the canvas agrees: the group is hidden for the preview value.
        expect(groupIsSuppressed(3, design)).toBe(true);
    });

    it('two conditional groups both showing names the one that is dropped', () => {
        const design = designWith('A');
        const line = (id: number, groupId: number): Field =>
            ({ id, type: 'line', name: `R${id}`, x: 0, y: 0, rotation: 0, length: 10, thickness: 0.3, groupId } as Field);
        design.fields = [...design.fields.map(f => ({ ...f, groupId: 1 })), line(8, 1), line(9, 2)];
        design.groupSuppress = { 1: suppressWhen('NEVER'), 2: suppressWhen('NEVER') };
        const warnings = suppressionWarnings(design);
        expect(warnings.some(w => w.includes('Group 2 overlaps'))).toBe(true);
    });

    it('a well-formed condition reports no warning', () => {
        const design = designWith('Dest');
        design.fields = design.fields.map(f => ({ ...f, suppress: suppressWhen('EXPORT') }));
        expect(suppressionWarnings(design)).toEqual([]);
    });
});

describe('transformBatchColumn', () => {
    it('transforms only the named column', () => {
        const batch = { headers: ['SKU', 'Qty'], mappings: { 1: 0 }, rows: [['a1', '2'], ['b2', '3']] };
        const out = transformBatchColumn(batch, 'SKU', 'UPPER(value)');
        expect(out.rows).toEqual([['A1', '2'], ['B2', '3']]);
        expect(batch.rows[0][0]).toBe('a1'); // input untouched
    });

    it('leaves the batch alone for an unknown column', () => {
        const batch = { headers: ['SKU'], mappings: {}, rows: [['a']] };
        expect(transformBatchColumn(batch, 'nope', 'UPPER(value)')).toBe(batch);
    });
});
