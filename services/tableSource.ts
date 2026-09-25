// Fase 2: tabular data sources. A table (pasted CSV, an imported .xlsx
// sheet, or rows typed in the Data tab) becomes the SAME BatchData the CSV
// job exporter already feeds to generateIPL — so preview, .ipl export and
// Send Job all work for every source without a second code path.
//
// A query (filter + sort + record range) is applied BEFORE the batch is
// built, and it lives on the data source, not in component state: saving the
// design must save "print rows 10-50 where Status = OK" along with it.
//
// Everything here is pure. File decoding stays in csvJob (decodeCsvText) and
// the xlsx parser is injected by the caller, so this module never imports it.

import type { BatchData } from './iplGenerator';
import type { CsvTable, JobPlan } from './csvJob';
import { autoMapFields, exportableVariableFields, MAX_JOB_ROWS } from './csvJob';
import type { BarcodeField, DataQuery, DataSource, Design, Field, FieldDataSource, TextField } from '../types';

export interface DataTable {
    columns: string[];
    /** One entry per row, keyed by column name. Missing cells are ''. */
    rows: Record<string, string>[];
}

export type { DataQuery } from '../types';

/** A single comparison. `value` is matched exactly, case-sensitively, after
 *  both sides are trimmed — "contains" would need a language, and exact is
 *  what label jobs actually filter on (status codes, plant ids). */
type FilterClause = DataQuery['filters'][number];

export const EMPTY_QUERY: DataQuery = { filters: [], combine: 'and' };

const cell = (row: Record<string, string>, column: string): string => (row[column] ?? '').trim();

const clauseMatches = (row: Record<string, string>, clause: FilterClause): boolean => {
    const v = cell(row, clause.column);
    switch (clause.op) {
        case 'eq': return v === clause.value.trim();
        case 'neq': return v !== clause.value.trim();
        case 'empty': return v === '';
        case 'notEmpty': return v !== '';
    }
};

/**
 * Filter, then sort, then slice to the record range. Sorting is numeric when
 * BOTH values parse as finite numbers (so "10" follows "2", not "1"), and a
 * plain string compare otherwise. Invalid range bounds are ignored rather
 * than throwing — a half-typed "from" box must not blank the preview.
 */
export const applyQuery = (table: DataTable, query: DataQuery): DataTable => {
    let rows = table.rows;
    if (query.filters.length > 0) {
        const all = query.combine === 'and';
        rows = rows.filter(row => {
            const results = query.filters.map(c => clauseMatches(row, c));
            return all ? results.every(Boolean) : results.some(Boolean);
        });
    }
    if (query.sortColumn && table.columns.includes(query.sortColumn)) {
        const col = query.sortColumn;
        const dir = query.sortDir === 'desc' ? -1 : 1;
        rows = [...rows].sort((a, b) => {
            const av = cell(a, col);
            const bv = cell(b, col);
            const an = Number(av);
            const bn = Number(bv);
            if (av !== '' && bv !== '' && Number.isFinite(an) && Number.isFinite(bn) && an !== bn) {
                return an < bn ? -dir : dir;
            }
            return av < bv ? -dir : av > bv ? dir : 0;
        });
    }
    const from = query.fromRow !== undefined && query.fromRow >= 1 ? Math.floor(query.fromRow) : 1;
    const to = query.toRow !== undefined && query.toRow >= 1 ? Math.floor(query.toRow) : rows.length;
    if (from > 1 || to < rows.length) rows = rows.slice(from - 1, Math.max(from - 1, to));
    return { columns: table.columns, rows };
};

/** CSV/xlsx parsers yield arrays of arrays; the table model is keyed rows. */
export const tableFromRows = (headers: string[], rows: string[][]): DataTable => ({
    columns: headers,
    rows: rows.map(r => {
        const rec: Record<string, string> = {};
        headers.forEach((h, i) => { rec[h] = r[i] ?? ''; });
        return rec;
    }),
});

export const tableToCsvTable = (table: DataTable): CsvTable => ({
    headers: table.columns,
    rows: table.rows.map(r => table.columns.map(c => r[c] ?? '')),
});

/**
 * The job a table prints: same shape planCsvJob returns, so the existing
 * exporter, sender and row preview consume it unchanged. `query` is applied
 * first, so mappings are computed against the columns the query sees.
 * Returns null when no column maps to a field or the query matched no rows.
 */
/**
 * The job implied by the design's own table sources — no pasted CSV needed.
 * Every table is filtered by its saved query first; rows are then zipped by
 * position, so row 3 of one table prints beside row 3 of another. A table with
 * fewer rows than the longest one simply stops contributing, and those labels
 * fall back to the field's default rather than repeating stale data.
 *
 * Returns null when the design has no table, or when nothing maps: a table
 * whose columns match no field is not a job. A query that matches ZERO rows is
 * reported rather than dropped — `empty` carries the source name so the UI can
 * say "Table 1 matches no rows" instead of silently printing nothing.
 */
export interface TableJobResult {
    plan: JobPlan | null;
    /** Table sources whose query matched nothing. */
    empty: string[];
    /** Columns mapped by explicit field binding rather than by name. */
    bound: number;
}

export const planDesignTableJob = (design: Design): TableJobResult => {
    const tables = design.dataSources.filter((s): s is Extract<DataSource, { type: 'table' }> => s.type === 'table');
    if (tables.length === 0) return { plan: null, empty: [], bound: 0 };

    const filtered = tables.map(s => ({ source: s, table: applyQuery({ columns: s.columns, rows: s.rows }, s.query) }));
    const empty = filtered.filter(f => f.source.rows.length > 0 && f.table.rows.length === 0).map(f => f.source.name);
    const contributing = filtered.filter(f => f.table.rows.length > 0);
    if (contributing.length === 0) return { plan: null, empty, bound: 0 };

    const rowCount = Math.max(...contributing.map(f => f.table.rows.length));
    const headers: string[] = [];
    const offsets: { sourceId: string; columns: string[]; start: number }[] = [];
    for (const { source, table } of contributing) {
        offsets.push({ sourceId: source.id, columns: table.columns, start: headers.length });
        headers.push(...table.columns);
    }
    const rows: string[][] = [];
    for (let i = 0; i < rowCount; i++) {
        const row: string[] = [];
        for (const { table } of contributing) {
            const src = table.rows[i];
            row.push(...table.columns.map(c => src?.[c] ?? ''));
        }
        rows.push(row);
    }

    const fields = exportableVariableFields(design);
    const mappings = autoMapFields(design, fields, headers);
    // An explicit column binding outranks the name match: two tables can both
    // have a "Qty" column, and only the field knows which one it means.
    let bound = 0;
    for (const field of fields) {
        const ds = field.dataSource;
        if (ds.type !== 'linked' || !ds.column) continue;
        const slot = offsets.find(o => o.sourceId === ds.sourceId);
        if (!slot) continue;
        const idx = slot.columns.indexOf(ds.column);
        if (idx < 0) continue;
        mappings[field.id] = slot.start + idx;
        bound++;
    }
    if (Object.keys(mappings).length === 0) return { plan: null, empty, bound: 0 };

    const truncated = rows.length > MAX_JOB_ROWS;
    const plan: JobPlan = {
        batch: { headers, mappings, rows: rows.slice(0, MAX_JOB_ROWS) },
        mapped: Object.keys(mappings).length,
        total: fields.length,
        truncated,
    };
    plan.batch = applyLinkedTransforms(design, fields, plan.batch).batch;
    return { plan, empty, bound };
};

export const planTableJob = (design: Design, table: DataTable, query: DataQuery = EMPTY_QUERY): JobPlan | null => {
    const filtered = applyQuery(table, query);
    const fields = exportableVariableFields(design);
    const csv = tableToCsvTable(filtered);
    const mappings = autoMapFields(design, fields, csv.headers);
    const mapped = Object.keys(mappings).length;
    if (mapped === 0 || csv.rows.length === 0) return null;
    const truncated = csv.rows.length > MAX_JOB_ROWS;
    return {
        batch: { headers: csv.headers, mappings, rows: csv.rows.slice(0, MAX_JOB_ROWS) },
        mapped,
        total: fields.length,
        truncated,
    };
};

// --- value transforms ---------------------------------------------------------
//
// A linked field prints its source value verbatim today. A transform lets one
// column feed several fields differently: UPPER(SUBSTR(value, 1, 3)). The
// language is deliberately tiny and has no `eval` — unknown functions and
// malformed expressions return the original value unchanged, so a typo can
// never blank a label or throw during a 5000-row export.

export interface TransformWarning {
    /** Human-readable; the caller surfaces it, nothing here throws. */
    message: string;
}

// FROZEN at the end of Fase 4. Adding a function is a decision of its own, not a
// drive-by — every one of these is a promise that preview, export and the IPL
// stream all agree on, and LOOKUP is the last of them.
const FN_NAMES = ['UPPER', 'LOWER', 'TRIM', 'SUBSTR', 'PAD', 'REPLACE', 'IF', 'CONCAT', 'LOOKUP'] as const;

interface Call { name: string; args: string[]; }

/**
 * What a LOOKUP can see: the design's tables, each already cut down by its own
 * saved query. Built once per expression and shared with every nested call, so a
 * LOOKUP inside a LOOKUP reads the same rows. `null` means there is no design in
 * reach — a transform typed where no label exists — and a LOOKUP there warns
 * rather than inventing an empty table.
 */
type LookupTables = Map<string, DataTable> | null;

const lookupTablesFor = (design: Pick<Design, 'dataSources'> | undefined): LookupTables => {
    if (!design) return null;
    const tables: LookupTables = new Map();
    for (const source of design.dataSources) {
        if (source.type !== 'table') continue;
        // The query is part of the table's definition ("print rows where Status
        // = OK"), so a lookup must not be able to reach behind it. A filtered-out
        // row is a row the design has said does not exist.
        tables.set(source.name.trim().toLowerCase(), applyQuery({ columns: source.columns, rows: source.rows }, source.query));
    }
    return tables;
};

/**
 * Parse one function call, optionally wrapping another: UPPER(SUBSTR(v,1,3)).
 * Returns null when the text isn't a call at all (the caller then treats the
 * whole string as a literal template is NOT supported — one value in, one
 * value out).
 */
const parseCall = (text: string): Call | null => {
    const m = /^([A-Za-z]+)\((.*)\)$/s.exec(text.trim());
    if (!m) return null;
    const name = m[1].toUpperCase();
    const args: string[] = [];
    let depth = 0;
    let quoted = false;
    let cur = '';
    for (const ch of m[2]) {
        // A comma inside "quotes" belongs to the string, not to the argument
        // list — otherwise CONCAT("a,b", value) splits into three arguments.
        if (ch === '"') quoted = !quoted;
        if (!quoted) {
            if (ch === '(') depth++;
            if (ch === ')' && depth > 0) depth--;
            if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
        }
        cur += ch;
    }
    if (cur.trim() !== '' || args.length > 0) args.push(cur.trim());
    return { name, args };
};

const unquote = (arg: string): string =>
    arg.length >= 2 && arg.startsWith('"') && arg.endsWith('"') ? arg.slice(1, -1) : arg;

/** `value` (any case) is the cell. Anything else unquoted is a literal, so a
 *  typo reads back as itself in the output instead of vanishing. */
const literal = (arg: string, value: string): string =>
    arg.trim().toLowerCase() === 'value' ? value : unquote(arg);

const evalCall = (call: Call, value: string, tables: LookupTables): { result: string; ok: boolean; warning: TransformWarning | null } => {
    // The first warning any nested call raised. A LOOKUP that misses its row must
    // still be reported when it sits inside CONCAT or UPPER, not swallowed by the
    // function wrapped around it.
    let nested: TransformWarning | null = null;
    const argValue = (arg: string): string => {
        const inner = parseCall(arg);
        if (!inner) return literal(arg, value);
        const out = evalCall(inner, value, tables);
        if (out.warning && !nested) nested = out.warning;
        return out.result;
    };
    const num = (arg: string | undefined, fallback: number): number => {
        if (arg === undefined || arg.trim() === '') return fallback;
        const n = Number(argValue(arg));
        return Number.isFinite(n) ? Math.trunc(n) : fallback;
    };
    const ok = (result: string): { result: string; ok: boolean; warning: TransformWarning | null } => ({ result, ok: true, warning: nested });
    switch (call.name) {
        case 'UPPER': return ok(argValue(call.args[0] ?? '').toUpperCase());
        case 'LOWER': return ok(argValue(call.args[0] ?? '').toLowerCase());
        case 'TRIM': return ok(argValue(call.args[0] ?? '').trim());
        case 'SUBSTR': {
            // 1-based start, matching how label specs describe positions.
            const start = Math.max(1, num(call.args[1], 1));
            const len = call.args[2] !== undefined ? Math.max(0, num(call.args[2], 0)) : undefined;
            const s = argValue(call.args[0] ?? '');
            return ok(len === undefined ? s.slice(start - 1) : s.slice(start - 1, start - 1 + len));
        }
        case 'PAD': {
            // PAD(value, width, "0") — pad on the left, like the counter source.
            const width = Math.max(0, Math.min(64, num(call.args[1], 0)));
            const ch = argValue(call.args[2] ?? '"0"') || '0';
            return ok(argValue(call.args[0] ?? '').padStart(width, ch.slice(0, 1)));
        }
        case 'REPLACE':
            return ok(argValue(call.args[0] ?? '').split(argValue(call.args[1] ?? '')).join(argValue(call.args[2] ?? '')));
        case 'CONCAT':
            // Every argument, in order. An empty call concatenates nothing.
            return ok(call.args.map(argValue).join(''));
        case 'LOOKUP': {
            // LOOKUP("Prices", "SKU", value, "Price") — the row of the named table
            // whose key column equals the cell, and the text of its result column.
            // The key is trimmed and compared case-insensitively, like IF, because
            // a label's "a1" and a table's "A1" are the same product.
            const tableName = unquote(call.args[0] ?? '').trim();
            const keyColumn = unquote(call.args[1] ?? '').trim();
            const keyRaw = argValue(call.args[2] ?? '').trim();
            const key = keyRaw.toLowerCase();
            const resultColumn = unquote(call.args[3] ?? '').trim();
            const fail = (message: string): { result: string; ok: boolean; warning: TransformWarning | null } => ({ result: '', ok: true, warning: { message } });
            if (tables === null) return { result: value, ok: false, warning: { message: `LOOKUP("${tableName}", …) needs the design's tables, and none are available here.` } };
            const table = tables.get(tableName.toLowerCase());
            if (!table) return fail(`LOOKUP: no table named "${tableName}".`);
            if (!table.columns.includes(keyColumn)) return fail(`LOOKUP: table "${tableName}" has no column "${keyColumn}".`);
            if (!table.columns.includes(resultColumn)) return fail(`LOOKUP: table "${tableName}" has no column "${resultColumn}".`);
            const row = table.rows.find(r => (r[keyColumn] ?? '').trim().toLowerCase() === key);
            if (!row) return fail(`LOOKUP: no row in "${tableName}" where ${keyColumn} is "${keyRaw}".`);
            return ok(row[resultColumn] ?? '');
        }
        case 'IF': {
            // IF(value, "EQ", "X", "yes", "no"). The comparison is
            // case-insensitive text, which is what label data actually is —
            // nobody writes a numeric predicate against a cell that may hold
            // " 12". A missing else prints nothing rather than the raw value,
            // because the whole point of the else branch is to choose silence.
            const left = argValue(call.args[0] ?? '');
            const op = (call.args[1] ?? '').replace(/"/g, '').trim().toUpperCase();
            const right = argValue(call.args[2] ?? '');
            const known = ['EQ', 'NEQ', 'EMPTY', 'NOTEMPTY'].includes(op);
            if (!known) return { result: value, ok: false, warning: null };
            const pass = op === 'EQ' ? left.toLowerCase() === right.toLowerCase()
                : op === 'NEQ' ? left.toLowerCase() !== right.toLowerCase()
                : op === 'EMPTY' ? left.trim() === ''
                : left.trim() !== '';
            return ok(argValue(call.args[pass ? 3 : 4] ?? '""'));
        }
        default:
            return { result: value, ok: false, warning: null };
    }
};

/**
 * Apply a transform expression to one cell value. `value` (case-insensitive)
 * stands for the cell. Returns the input untouched — and a warning — when the
 * expression doesn't parse or names an unknown function, so callers can flag
 * it without ever failing the job.
 */
/**
 * Fase 4: whether a suppression condition says "don't print". The condition is
 * an ordinary transform expression, and it suppresses only when it evaluates to
 * a non-empty result — so `IF(value, "EQ", "X", "yes", "")` suppresses on a
 * match and `IF(value, "EMPTY", "", "yes", "")` suppresses a blank.
 *
 * A condition that doesn't parse does NOT suppress. The failure mode that has
 * to be impossible is a typo deleting a field from every label of a job; the
 * warning is how the caller tells the user the rule did nothing.
 */
export const isSuppressed = (condition: string | undefined, value: string): { suppress: boolean; warning: TransformWarning | null } => {
    if (!condition || condition.trim() === '') return { suppress: false, warning: null };
    const { result, warning } = applyTransform(condition, value);
    if (warning) return { suppress: false, warning };
    return { suppress: result.trim() !== '', warning: null };
};

/**
 * The string a suppression condition is judged against: the text the field
 * would print. Linked fields are judged on the resolved cell (so a condition
 * written against a column sees that column), fixed and variable fields on
 * their own text. Date and time change every second, so judging a condition
 * against them would make a field flicker in and out of the preview — they
 * are judged against the empty string, which only `EMPTY` can match.
 */
export const suppressionValueFor = (field: TextField | BarcodeField, design: Design): string => {
    const ds = field.dataSource;
    if (ds.type === 'fixed') return ds.data;
    if (ds.type === 'variable') return ds.defaultData;
    if (ds.type === 'linked') {
        const source = design.dataSources.find(s => s.id === ds.sourceId);
        const resolved = resolveLinkedPreview(source, ds, field.name);
        if (resolved === null) return '';
        return ds.transform ? applyTransform(ds.transform, resolved, design).result : resolved;
    }
    return '';
};

/**
 * Fase 4: whether this field prints nothing on the current record. Shapes and
 * images have no data of their own, so their condition is judged against the
 * empty string — `EMPTY` always holds for them and any other condition never
 * does, which is the honest reading of "suppress when the value is …" for a
 * field that has no value.
 */
export const fieldIsSuppressed = (field: Field, design: Design): boolean => {
    if (!field.suppress || field.suppress.trim() === '') return false;
    const value = (field.type === 'text' || field.type === 'barcode')
        ? suppressionValueFor(field, design)
        : '';
    return isSuppressed(field.suppress, value).suppress;
};

/**
 * Fase 4: a group's condition, judged against the text a chosen member would
 * print. The reference is the member with the lowest id — stable across edits,
 * and the same member for every field in the group, so the whole group appears
 * or disappears together. A group with no text or barcode member is judged
 * against the empty string, exactly like a shape's own condition.
 */
export const groupSuppressionValue = (groupId: number, design: Design): string => {
    const members = design.fields
        .filter(f => f.groupId === groupId && (f.type === 'text' || f.type === 'barcode'))
        .sort((a, b) => a.id - b.id);
    const ref = members[0];
    return ref && (ref.type === 'text' || ref.type === 'barcode') ? suppressionValueFor(ref, design) : '';
};

/** Whether a group's condition hides it. No condition, or one that doesn't
 *  parse, hides nothing — a typo must not blank a whole variant. */
export const groupIsSuppressed = (groupId: number | undefined, design: Design): boolean => {
    if (groupId === undefined) return false;
    const condition = design.groupSuppress?.[groupId];
    if (!condition || condition.trim() === '') return false;
    return isSuppressed(condition, groupSuppressionValue(groupId, design)).suppress;
};

export const applyTransform = (expr: string, value: string, design?: Pick<Design, 'dataSources'>): { result: string; warning: TransformWarning | null } => {
    const trimmed = expr.trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'value') return { result: value, warning: null };
    const call = parseCall(trimmed);
    if (!call) return { result: value, warning: { message: `"${trimmed}" is not a function call. Use e.g. UPPER(value).` } };
    if (!(FN_NAMES as readonly string[]).includes(call.name)) {
        return { result: value, warning: { message: `Unknown function ${call.name}. Available: ${FN_NAMES.join(', ')}.` } };
    }
    // IF's operator is checked here, not inside the evaluator: a bad operator
    // buried in a nested call would otherwise come back as "ok" with the raw
    // value and the warning would never surface. The check walks every call in
    // the expression, because the bad IF is often the argument, not the root.
    const badIf = (c: Call): boolean => c.name === 'IF'
        && !['EQ', 'NEQ', 'EMPTY', 'NOTEMPTY'].includes((c.args[1] ?? '').replace(/"/g, '').trim().toUpperCase());
    const calls: Call[] = [call];
    for (const arg of call.args) { const inner = parseCall(arg.trim()); if (inner) calls.push(inner); }
    if (calls.some(badIf)) {
        return { result: value, warning: { message: `IF needs a comparison: EQ, NEQ, EMPTY or NOTEMPTY.` } };
    }
    const { result, ok, warning } = evalCall(call, value, lookupTablesFor(design));
    if (!ok) return { result: value, warning: warning ?? { message: `Unknown function ${call.name}.` } };
    return { result, warning };
};

/**
 * The text a linked field prints when there is no job row to draw from: the
 * variable's sample, the counter's padded start, or the first row of a table
 * source's chosen column (so the canvas and the single-label export show real
 * data instead of a blank). Returns null when the source is gone or a table
 * link names no column — callers render that as "[unlinked]".
 *
 * The column is the one the field names, else the field's own name when that
 * matches a column. Deliberately NOT the source's name: a table named "Table 1"
 * has no such column, and guessing it would print blanks that look like data.
 */
export const resolveLinkedPreview = (
    source: DataSource | undefined,
    dataSource: Extract<FieldDataSource, { type: 'linked' }>,
    fieldName: string,
): string | null => {
    if (!source) return null;
    if (source.type === 'variable') return source.sampleData;
    if (source.type === 'counter') return source.start.toString().padStart(source.padding, '0');
    const column = dataSource.column && source.columns.includes(dataSource.column)
        ? dataSource.column
        : (source.columns.includes(fieldName) ? fieldName : undefined);
    if (!column) return null;
    return applyQuery({ columns: source.columns, rows: source.rows }, source.query).rows[0]?.[column] ?? '';
};

/**
 * Apply every linked field's transform to its mapped column of a batch, so the
 * job prints `UPPER(value)` rather than the raw cell. A column shared by two
 * fields with DIFFERENT transforms is left raw — transforming it would change
 * both, and the warning names the field that lost out. Unmapped fields are
 * skipped: their fallback value is the source's sample, which was never the
 * cell the expression describes.
 */
export const applyLinkedTransforms = (
    design: Design,
    fields: (TextField | BarcodeField)[],
    batch: BatchData,
): { batch: BatchData; warnings: string[] } => {
    let out = batch;
    const warnings: string[] = [];
    // A column claimed by an earlier field. Same expression twice is fine (the
    // second pass is a no-op); a DIFFERENT one would change both fields' data,
    // so the column is reverted to raw and the field that lost out is named.
    const claimed = new Map<number, { fieldId: number; expr: string; header: string; before: string[][] }>();
    for (const field of fields) {
        const ds = field.dataSource;
        if (ds.type !== 'linked' || !ds.transform || ds.transform.trim() === '') continue;
        const col = batch.mappings[field.id];
        if (col === undefined) continue;
        const header = batch.headers[col];
        if (header === undefined) continue;
        const expr = ds.transform.trim();
        const prior = claimed.get(col);
        if (prior) {
            if (prior.expr.toLowerCase() !== expr.toLowerCase()) {
                out = { ...out, rows: prior.before };
                warnings.push(`"${field.name}" and another field share column "${header}" with different transforms — printed raw.`);
                claimed.delete(col);
            }
            continue;
        }
        // Probe the expression itself on an empty cell, then one real row. The
        // empty probe catches a broken call; the row catches a LOOKUP whose key is
        // simply not in the table, which an empty cell can never show. One warning
        // per field — a 5000-row job must not produce 5000 identical lines.
        const probe = applyTransform(expr, '', design);
        const sample = out.rows.map(r => r[col] ?? '').find(v => v.trim() !== '') ?? '';
        const sampleWarning = sample !== '' ? applyTransform(expr, sample, design).warning : null;
        const warning = probe.warning ?? sampleWarning;
        if (warning) warnings.push(`"${field.name}": ${warning.message}`);
        claimed.set(col, { fieldId: field.id, expr, header, before: out.rows });
        out = transformBatchColumn(out, header, expr, design);
    }
    return { batch: out, warnings };
};

/** Run a transform across one column of a BatchData, in place (new object).
 *  `column` is matched against the batch headers; rows where the mapped cell
 *  is absent keep their original value. */
export const transformBatchColumn = (batch: BatchData, column: string, expr: string, design?: Design): BatchData => {
    const idx = batch.headers.indexOf(column);
    if (idx < 0 || expr.trim() === '') return batch;
    return {
        ...batch,
        rows: batch.rows.map(row => {
            if (idx >= row.length) return row;
            const next = row.slice();
            next[idx] = applyTransform(expr, row[idx] ?? '', design).result;
            return next;
        }),
    };
};
