// Batch G (2026-09-21): designer-side job export — turn a CSV table into
// one multi-label .ipl file. The generator already accepts BatchData (one
// print invocation per row, the standard IPL variable-data pattern); this
// module produces it from pasted/opened CSV text:
//   parseCsv (RFC-4180 subset) -> exportableVariableFields -> autoMapFields
//   (headers matched case-insensitively against field names, and against
//   the linked data-source name for 'linked' fields) -> buildBatchData.
// Pure functions, no DOM — the Data tab wires them to a textarea + download.

import type { Design, Field, BarcodeField, TextField } from '../types';
import type { BatchData } from './iplGenerator';

export interface CsvTable {
    headers: string[];
    rows: string[][];
}

/** Hard ceiling on job rows; beyond it the .ipl file is megabytes and the
 *  printer queue is not the place to find out. */
export const MAX_JOB_ROWS = 5000;

/** Cap on imported CSV files (Batch H) — a spreadsheet table this big is
 *  almost certainly the wrong tool; refuse rather than freeze the tab. */
export const MAX_CSV_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Decode CSV file bytes to text. Excel's "CSV (MS-DOS)" / legacy "ANSI"
 * exports are windows-1252, NOT UTF-8 — decoding them as UTF-8 mangles
 * every accented header ('ż' -> 'ż¿') and silently breaks auto-mapping.
 * PowerShell 5.1's Export-Csv and Excel's "Unicode Text" are UTF-16 with a
 * FF FE / FE FF BOM — without an explicit branch they would fall into the
 * single-byte path and yield NUL-interleaved text whose headers never
 * match. Strategy: UTF-16 by BOM first, then STRICT UTF-8 (real UTF-8
 * files, including BOM'd ones, decode exactly), else windows-1252, which
 * decodes every byte without throwing.
 */
export const decodeCsvText = (bytes: Uint8Array): string => {
    if (bytes.length >= 2) {
        if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes);
        if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes);
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        try {
            return new TextDecoder('windows-1252').decode(bytes);
        } catch {
            // windows-1252 is an encoding spec requirement in browsers; if
            // it is somehow missing, latin1 is the closest lossless fallback.
            return new TextDecoder('latin1').decode(bytes);
        }
    }
};

/**
 * RFC-4180 subset: comma-separated, double-quoted fields ("" escapes a
 * quote; quoted fields may contain commas and newlines), LF or CRLF line
 * endings, optional trailing newline. Header cells are trimmed. A line
 * consisting only of whitespace after the header is skipped.
 */
export const parseCsv = (text: string): CsvTable => {
    // Excel's UTF-8 CSVs start with a BOM; left in place it corrupts the
    // first header ('﻿SKU' never matches field 'SKU', and it also
    // blocks a leading quoted field from opening quotes mode).
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    // Normalize CRLF and lone-CR (classic Mac / serial captures) to LF
    // before the state machine, so \r can never merge rows or leak into
    // quoted-field values.
    text = text.replace(/\r\n?/g, '\n');
    if (text.trim() === '') return { headers: [], rows: [] };
    const rows: string[][] = [];
    let field = '';
    let row: string[] = [];
    let inQuotes = false;
    let i = 0;
    const pushField = () => { row.push(field); field = ''; };
    const pushRow = () => { pushField(); rows.push(row); row = []; };
    while (i < text.length) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
                inQuotes = false; i++; continue;
            }
            field += c; i++; continue;
        }
        if (c === '"' && field === '') { inQuotes = true; i++; continue; }
        if (c === ',') { pushField(); i++; continue; }
        if (c === '\r') { i++; continue; } // handled by \n (or lone \r below)
        if (c === '\n') { pushRow(); i++; continue; }
        field += c; i++;
    }
    if (field !== '' || row.length > 0) pushRow();
    if (rows.length === 0) return { headers: [], rows: [] };
    const headers = rows[0].map(h => h.trim());
    // Drop a trailing empty row produced by a final newline.
    const body = rows.slice(1).filter(r => !(r.length === 1 && r[0].trim() === ''));
    return { headers, rows: body };
};

/** Fields that can receive per-row data: variable or linked text/barcode. */
export const exportableVariableFields = (design: Design): (TextField | BarcodeField)[] =>
    design.fields.filter((f): f is TextField | BarcodeField =>
        ('dataSource' in f) && f.visible !== false &&
        (f.dataSource.type === 'variable' || f.dataSource.type === 'linked'));

/** Candidate header names per field: its own name, plus the linked source
 *  name (a field 'Kode' fed by source 'SKU' maps from a SKU column). */
const candidateNames = (design: Design, f: TextField | BarcodeField): string[] => {
    const names = [f.name];
    const src = f.dataSource;
    if (src.type === 'linked') {
        const source = design.dataSources.find(ds => ds.id === src.sourceId);
        if (source) names.push(source.name);
    }
    return names;
};

/**
 * Map fieldId -> column index by matching headers (trimmed, case-
 * insensitive) against each field's candidate names. First matching column
 * wins; fields without a match stay unmapped (the generator falls back to
 * their default data).
 */
export const autoMapFields = (
    design: Design,
    fields: (TextField | BarcodeField)[],
    headers: string[],
): { [fieldId: number]: number } => {
    const norm = headers.map(h => h.trim().toLowerCase());
    const mappings: { [fieldId: number]: number } = {};
    for (const f of fields) {
        for (const cand of candidateNames(design, f)) {
            const candNorm = cand.trim().toLowerCase();
            if (!candNorm) continue; // an unnamed field must not match an empty header cell
            const col = norm.indexOf(candNorm);
            if (col >= 0) { mappings[f.id] = col; break; }
        }
    }
    return mappings;
};

export interface JobPlan {
    batch: BatchData;
    mapped: number;   // fields with a column
    total: number;    // exportable fields
    truncated: boolean;
}

/**
 * Build the batch payload for generateIPL. Returns null when nothing could
 * be mapped (the caller must not emit a job of pure defaults pretending to
 * be data-driven). Rows beyond MAX_JOB_ROWS are truncated, flagged.
 */
export const planCsvJob = (design: Design, table: CsvTable): JobPlan | null => {
    const fields = exportableVariableFields(design);
    const mappings = autoMapFields(design, fields, table.headers);
    const mapped = Object.keys(mappings).length;
    if (mapped === 0 || table.rows.length === 0) return null;
    const truncated = table.rows.length > MAX_JOB_ROWS;
    return {
        batch: { headers: table.headers, mappings, rows: table.rows.slice(0, MAX_JOB_ROWS) },
        mapped,
        total: fields.length,
        truncated,
    };
};

/** Convenience kept for callers that only need the BatchData. */
export const buildBatchData = (design: Design, table: CsvTable): BatchData | null =>
    planCsvJob(design, table)?.batch ?? null;

/**
 * Batch I: one row of a planned job as its own BatchData — generateIPL of
 * this yields the exact .ipl the printer would receive for that label,
 * which parseViewerIPL + renderLabel then preview faithfully (print-block
 * data attaches during parse, so the preview is the real pipeline, not a
 * re-implementation).
 */
export const rowBatchData = (plan: JobPlan, rowIndex: number): BatchData => ({
    headers: plan.batch.headers,
    mappings: plan.batch.mappings,
    rows: [plan.batch.rows[Math.max(0, Math.min(rowIndex, plan.batch.rows.length - 1))]],
});
