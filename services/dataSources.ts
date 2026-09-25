// Pure helpers for the Design.dataSources list (variables + counters that
// linked fields draw their print data from). The Data tab UI and the field
// editor both go through these, so id creation and list edits stay uniform
// and unit-testable without React.

import type { CounterDataSource, DataSource, Field, TableDataSource, VariableDataSource } from '../types';
import { EMPTY_QUERY } from './tableSource';

const makeId = (prefix: string): string =>
    `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const newVariable = (name: string): VariableDataSource => ({
    id: makeId('var'), type: 'variable', name, sampleData: '',
});

export const newTable = (name: string): TableDataSource => ({
    id: makeId('tbl'), type: 'table', name, columns: [], rows: [], query: { ...EMPTY_QUERY },
});

export const newCounter = (name: string): CounterDataSource => ({
    // serial defaults ON for fresh counters: a counter that prints the same
    // start value on every label is just a constant. Designs saved before
    // Batch Q carry no serial key → falsy → legacy behavior, unchanged.
    id: makeId('cnt'), type: 'counter', name, start: 1, step: 1, padding: 4, serial: true,
});

/** Insert or replace by id (immutable). */
export const upsert = (list: DataSource[], source: DataSource): DataSource[] =>
    list.some(s => s.id === source.id)
        ? list.map(s => (s.id === source.id ? source : s))
        : [...list, source];

export const remove = (list: DataSource[], id: string): DataSource[] =>
    list.filter(s => s.id !== id);

/**
 * Ids of fields currently linked to a data source — shown before deleting so
 * the user knows which fields will fall back to empty print data (canvas
 * renders them as "[unlinked]").
 */
export const linkedFieldIds = (fields: Field[], sourceId: string): number[] =>
    fields
        .filter(f => ('dataSource' in f) && f.dataSource.type === 'linked' && f.dataSource.sourceId === sourceId)
        .map(f => f.id);

/**
 * Parse a user-typed integer with clamping. Explicit NaN/empty handling —
 * NOT `Number(x) || fallback`, which would also reject the legitimate value 0.
 */
export const parseClampedInt = (local: string, fallback: number, min: number, max: number): number => {
    const trimmed = local.trim();
    if (trimmed === '') return fallback;
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
};

/** Next unused "<prefix> N" name for a new source (no duplicates after deletes). */
export const nextSourceName = (prefix: string, list: DataSource[]): string => {
    let index = 1;
    while (list.some(s => s.name === `${prefix} ${index}`)) index++;
    return `${prefix} ${index}`;
};

/**
 * Fields linked to `sourceId` fall back to plain variable fields with empty
 * data. Deleting a source must not leave orphaned sourceIds: the linked
 * dropdown would show a selection that no longer exists in its options.
 */
export const unlinkFields = (fields: Field[], sourceId: string): Field[] =>
    fields.map(f => {
        if ('dataSource' in f && f.dataSource.type === 'linked' && f.dataSource.sourceId === sourceId) {
            return { ...f, dataSource: { type: 'variable', defaultData: '' } } as Field;
        }
        return f;
    });
