// Unit tests for the pure dataSources helpers behind the Data tab UI.
import { describe, it, expect } from 'vitest';
import { newVariable, newCounter, upsert, remove, linkedFieldIds, parseClampedInt, nextSourceName, unlinkFields } from '../services/dataSources';
import type { DataSource, Field } from '../types';

describe('dataSources helpers', () => {
    it('creates variable and counter sources with defaults and unique ids', () => {
        const v1 = newVariable('Lot');
        const v2 = newVariable('Lot');
        expect(v1).toMatchObject({ type: 'variable', name: 'Lot', sampleData: '' });
        expect(v1.id).not.toBe(v2.id);
        const c = newCounter('Serial');
        expect(c).toMatchObject({ type: 'counter', name: 'Serial', start: 1, step: 1, padding: 4 });
    });

    it('upsert appends new and replaces same-id, immutably', () => {
        const a = newVariable('A');
        const list: DataSource[] = [];
        const withA = upsert(list, a);
        expect(list).toHaveLength(0); // input untouched
        const renamed = upsert(withA, { ...a, name: 'A2' });
        expect(renamed).toHaveLength(1);
        expect(renamed[0].name).toBe('A2');
    });

    it('remove drops only the target id', () => {
        const a = newVariable('A');
        const b = newCounter('B');
        expect(remove([a, b], a.id)).toEqual([b]);
    });

    it('linkedFieldIds finds linked text/barcode fields and ignores others', () => {
        const a = newVariable('A');
        const fields = [
            { id: 1, type: 'text', dataSource: { type: 'linked', sourceId: a.id } },
            { id: 2, type: 'barcode', dataSource: { type: 'linked', sourceId: 'other' } },
            { id: 3, type: 'text', dataSource: { type: 'fixed', data: 'x' } },
            { id: 4, type: 'line' },
        ] as unknown as Field[];
        expect(linkedFieldIds(fields, a.id)).toEqual([1]);
        expect(linkedFieldIds(fields, 'other')).toEqual([2]);
        expect(linkedFieldIds(fields, 'missing')).toEqual([]);
    });

    it('parseClampedInt accepts 0 and clamps; only empty/NaN keep the fallback', () => {
        // The old `Number(x) || fallback` idiom rejected the legitimate 0.
        expect(parseClampedInt('0', 1, 0, 99)).toBe(0);
        expect(parseClampedInt(' 5 ', 1, 0, 99)).toBe(5);
        expect(parseClampedInt('100', 1, 0, 99)).toBe(99);
        expect(parseClampedInt('-5', 1, 0, 99)).toBe(0);
        expect(parseClampedInt('', 7, 0, 99)).toBe(7);
        expect(parseClampedInt('abc', 7, 0, 99)).toBe(7);
        expect(parseClampedInt('2.6', 0, 0, 99)).toBe(3);
    });

    it('nextSourceName skips taken names (no duplicates after deletes)', () => {
        const list = [newVariable('Variable 1'), newVariable('Variable 3')];
        expect(nextSourceName('Variable', list)).toBe('Variable 2');
        expect(nextSourceName('Variable', [])).toBe('Variable 1');
        // rapid double-add within one render sees the same list, but the
        // second click's name still won't collide once the first is in it:
        expect(nextSourceName('Variable', upsert(list, list[0]))).toBe('Variable 2');
    });

    it('unlinkFields reverts only the matching linked fields', () => {
        const a = newVariable('A');
        const fields = [
            { id: 1, type: 'text', dataSource: { type: 'linked', sourceId: a.id } },
            { id: 2, type: 'text', dataSource: { type: 'linked', sourceId: 'other' } },
            { id: 3, type: 'text', dataSource: { type: 'fixed', data: 'x' } },
        ] as unknown as Field[];
        const out = unlinkFields(fields, a.id);
        const ds = (i: number) => (out[i] as { dataSource: unknown }).dataSource;
        expect(ds(0)).toEqual({ type: 'variable', defaultData: '' });
        expect(ds(1)).toEqual({ type: 'linked', sourceId: 'other' });
        expect(out[2]).toBe(fields[2]); // untouched rows keep identity
    });
});
