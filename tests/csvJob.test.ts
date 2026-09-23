// Batch G (2026-09-21): designer-side job export. The generator already
// understands batchData (one print invocation per row — the standard IPL
// variable-data pattern), but nothing produced it from real tabular data.
// csvJob.ts closes that gap: parseCsv (RFC-4180 subset) -> autoMapFields
// (headers matched to field names) -> buildBatchData, which the Data tab
// feeds to generateIPL for a multi-label .ipl job.
import { describe, it, expect } from 'vitest';
import { parseCsv, autoMapFields, buildBatchData, exportableVariableFields, decodeCsvText, MAX_CSV_FILE_BYTES, planCsvJob, rowBatchData } from '../services/csvJob';
import { generateIPL } from '../services/iplGenerator';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import type { Design, Field, TextField } from '../types';

describe('decodeCsvText (Excel code-page reality)', () => {
    it('decodes valid UTF-8 including multibyte text', () => {
        const bytes = new TextEncoder().encode('SKU,Desc\nA1,karty-dużego\n');
        expect(decodeCsvText(bytes)).toBe('SKU,Desc\nA1,karty-dużego\n');
    });

    it('a UTF-8 BOM never survives into the text (decoder or parseCsv strips it)', () => {
        const withBom = new Uint8Array([0xEF, 0xBB, 0xBF, ...new TextEncoder().encode('SKU\nA1\n')]);
        const text = decodeCsvText(withBom);
        // Browsers' UTF-8 TextDecoder removes the BOM by default; parseCsv
        // also strips U+FEFF defensively for pasted text. Either way the
        // first header must be clean:
        expect(parseCsv(text).headers).toEqual(['SKU']);
    });

    it('falls back to a lossless single-byte decode when not valid UTF-8', () => {
        // 0xBF alone is illegal UTF-8; windows-1252 (browsers) AND latin1
        // (happy-dom's fallback) both map it to '¿', so this assertion is
        // environment-stable. The contract: never throw, never U+FFFD,
        // one char per byte — headers survive Excel's ANSI exports.
        const out = decodeCsvText(new Uint8Array([0x53, 0x4B, 0x55, 0xBF]));
        expect(out).toBe('SKU¿');
        const smart = decodeCsvText(new Uint8Array([0x93, 0x41, 0x94]));
        expect(smart).toHaveLength(3);
        expect(smart[1]).toBe('A');
        expect(smart).not.toContain('�');
    });

    it('empty input decodes to empty string; cap constant is sane', () => {
        expect(decodeCsvText(new Uint8Array(0))).toBe('');
        expect(MAX_CSV_FILE_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
        expect(MAX_CSV_FILE_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024);
    });

    it('detects UTF-16 BOMs (PowerShell Export-Csv / Excel Unicode Text)', () => {
        // 'SKU\n' in UTF-16LE with FF FE BOM — without the branch this
        // decodes through cp1252 as NUL-interleaved garbage whose headers
        // never match any field.
        const le = new Uint8Array([0xFF, 0xFE, 0x53, 0x00, 0x4B, 0x00, 0x55, 0x00, 0x0A, 0x00]);
        expect(parseCsv(decodeCsvText(le)).headers).toEqual(['SKU']);
        const be = new Uint8Array([0xFE, 0xFF, 0x00, 0x53, 0x00, 0x4B, 0x00, 0x55, 0x00, 0x0A]);
        expect(parseCsv(decodeCsvText(be)).headers).toEqual(['SKU']);
    });
});

const design = (fields: Field[]): Design => ({
    name: 'T',
    labelSettings: { width: 80, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'thermal-transfer', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields,
    dataSources: [
        { id: 'ds1', name: 'SKU', type: 'variable', sampleData: 'DEF' },
        { id: 'ds2', name: 'Qty', type: 'counter', start: 1, step: 1, padding: 3 },
    ],
    nextId: 4,
    guides: { horizontal: [], vertical: [] },
});

const vf = (id: number, name: string, extra: Partial<Field> = {}): Field => ({
    id, type: 'text', name, x: 5, y: 5, rotation: 0,
    dataSource: { type: 'variable', defaultData: 'X' }, font: '25', fontSize: 12, h_mag: 1, w_mag: 1,
    ...extra,
} as Field);

describe('parseCsv', () => {
    it('parses a plain header + rows table', () => {
        const t = parseCsv('SKU,Desc,Qty\nA1,Widget,10\nB2,Gadget,20\n');
        expect(t.headers).toEqual(['SKU', 'Desc', 'Qty']);
        expect(t.rows).toEqual([['A1', 'Widget', '10'], ['B2', 'Gadget', '20']]);
    });

    it('handles quoted fields with commas, escaped quotes and newlines', () => {
        const t = parseCsv('Name,Note\n"Smith, John","He said ""hi""\nsecond line"\n');
        expect(t.rows).toEqual([['Smith, John', 'He said "hi"\nsecond line']]);
    });

    it('accepts CRLF and trims header whitespace; empty input yields nothing', () => {
        const t = parseCsv('SKU , Desc \r\nA1,Widget\r\n');
        expect(t.headers).toEqual(['SKU', 'Desc']);
        expect(t.rows).toEqual([['A1', 'Widget']]);
        expect(parseCsv('   ')).toEqual({ headers: [], rows: [] });
    });

    it('ragged rows keep their length (mapping clamps by index)', () => {
        const t = parseCsv('A,B,C\n1,2\n3,4,5,6\n');
        expect(t.rows[0]).toEqual(['1', '2']);
        expect(t.rows[1]).toEqual(['3', '4', '5', '6']);
    });

    it('strips a UTF-8 BOM (Excel) before parsing', () => {
        const t = parseCsv('﻿"SKU, ID",Desc\n1,2\n');
        expect(t.headers).toEqual(['SKU, ID', 'Desc']); // quoted, comma intact
        const plain = parseCsv('﻿SKU,Desc\nA1,W\n');
        expect(plain.headers).toEqual(['SKU', 'Desc']); // mapping survives BOM
    });

    it('treats lone-CR line endings as row breaks (classic Mac)', () => {
        const t = parseCsv('A,B\r1,2\r3,4\r');
        expect(t.headers).toEqual(['A', 'B']);
        expect(t.rows).toEqual([['1', '2'], ['3', '4']]);
    });

    it('normalizes CRLF inside quoted fields to LF (no stray \\r in data)', () => {
        const t = parseCsv('Note\r\n"line1\r\nline2"\r\n');
        expect(t.rows).toEqual([['line1\nline2']]);
    });
});

describe('exportableVariableFields + autoMapFields', () => {
    it('lists variable and linked fields only (fixed/date/time cannot take row data)', () => {
        const d = design([
            vf(1, 'SKU'),
            vf(2, 'Fixed', { dataSource: { type: 'fixed', data: 'NO' } }),
            { ...vf(3, 'Linked'), dataSource: { type: 'linked', sourceId: 'ds1' } } as TextField,
        ]);
        expect(exportableVariableFields(d).map(f => f.id)).toEqual([1, 3]);
    });

    it('matches headers to field names case-insensitively and trims', () => {
        // field 1 name 'sku' -> col 0; field 3 name 'Lot' -> ' LOT ' col 2
        // (its own name matches before its linked source name 'SKU').
        const d = design([vf(1, 'sku'), { ...vf(3, 'Lot'), dataSource: { type: 'linked', sourceId: 'ds1' } } as TextField]);
        const m = autoMapFields(d, exportableVariableFields(d), ['SKU', 'desc', ' LOT ']);
        expect(m).toEqual({ 1: 0, 3: 2 });
    });

    it('a linked field with no name-match falls back to its source name', () => {
        // field 'Kode' has no 'Kode' column but links to source 'SKU'.
        const d = design([{ ...vf(1, 'Kode'), dataSource: { type: 'linked', sourceId: 'ds1' } } as TextField]);
        expect(autoMapFields(d, exportableVariableFields(d), ['SKU', 'other'])).toEqual({ 1: 0 });
    });

    it('first matching column wins when headers repeat; no match = unmapped', () => {
        const d = design([vf(1, 'SKU')]);
        expect(autoMapFields(d, exportableVariableFields(d), ['x', 'SKU', 'SKU'])).toEqual({ 1: 1 });
        expect(autoMapFields(d, exportableVariableFields(d), ['other'])).toEqual({});
    });

    it('an unnamed field never matches an empty header cell', () => {
        const d = design([vf(1, '')]);
        expect(autoMapFields(d, exportableVariableFields(d), ['SKU', '', 'Desc'])).toEqual({});
    });
});

describe('buildBatchData + generateIPL job end-to-end', () => {
    it('produces one print block per CSV row with mapped <ESC>F data', async () => {
        const d = design([vf(1, 'SKU'), vf(2, 'Desc')]);
        const t = parseCsv('SKU,Desc\nA1,Widget\nB2,Gadget\n');
        const batch = buildBatchData(d, t)!;
        expect(batch.mappings).toEqual({ 1: 0, 2: 1 });
        const ipl = await generateIPL(d, batch);
        const blocks = ipl.split('\n').filter(l => l.includes('<CAN>'));
        expect(blocks).toHaveLength(2);
        expect(blocks[0]).toContain('<ESC>F1<NUL>A1');
        expect(blocks[0]).toContain('<ESC>F2<NUL>Widget');
        expect(blocks[1]).toContain('<ESC>F1<NUL>B2');
        expect(blocks[1]).toContain('<ESC>F2<NUL>Gadget');
        // Field definitions themselves appear exactly once (format block).
        expect(ipl.split('\n').filter(l => l.startsWith('<STX>H1;')).length).toBe(1);
    });

    it('unmapped columns and fields fall back: field without column keeps its default', async () => {
        const d = design([vf(1, 'SKU'), vf(2, 'Desc', { dataSource: { type: 'variable', defaultData: 'DEFAULT' } })]);
        const t = parseCsv('SKU,Extra\nA1,ignored\n');
        const batch = buildBatchData(d, t)!;
        expect(batch.mappings).toEqual({ 1: 0 }); // Desc has no column
        const ipl = await generateIPL(d, batch);
        expect(ipl).toContain('<ESC>F2<NUL>DEFAULT');
        expect(ipl).not.toContain('ignored');
    });

    it('CSV with no matching header yields null (caller must not emit a job)', () => {
        const d = design([vf(1, 'SKU')]);
        expect(buildBatchData(d, parseCsv('A,B\n1,2\n'))).toBeNull();
        expect(buildBatchData(d, { headers: [], rows: [] })).toBeNull();
    });

    it('linked fields map by their data-source name too (header "SKU" hits a field linked to source SKU)', async () => {
        const d = design([
            { ...vf(1, 'Kode'), dataSource: { type: 'linked', sourceId: 'ds1' } } as TextField, // ds1 name: 'SKU'
        ]);
        const t = parseCsv('SKU\nA1\n');
        const batch = buildBatchData(d, t)!;
        expect(batch.mappings).toEqual({ 1: 0 });
        const ipl = await generateIPL(d, batch);
        expect(ipl).toContain('<ESC>F1<NUL>A1');
    });

    it('review HIGH: unmapped LINKED field falls back to its source value, not empty', async () => {
        // 'Lot' links to ds1 (Variable 'SKU', sampleData 'DEF'); the CSV maps
        // only field 1, so Lot must print the source's sample (mirroring the
        // non-batch path) — the UI literally promises "(default)".
        const d = design([
            vf(1, 'Code'),
            { ...vf(2, 'Lot'), dataSource: { type: 'linked', sourceId: 'ds1' } } as TextField,
        ]);
        const t = parseCsv('Code\nA1\n');
        const ipl = await generateIPL(d, buildBatchData(d, t)!);
        expect(ipl).toContain('<ESC>F1<NUL>A1');
        expect(ipl).toContain('<ESC>F2<NUL>DEF');
    });

    it('review MEDIUM: ragged row (fewer cells than mapped column) falls back to default', async () => {
        const d = design([vf(1, 'A'), vf(2, 'B', { dataSource: { type: 'variable', defaultData: 'FALLBACK' } })]);
        const t = parseCsv('A,B\n1\n'); // row missing the B cell
        const ipl = await generateIPL(d, buildBatchData(d, t)!);
        expect(ipl).toContain('<ESC>F1<NUL>1');
        expect(ipl).toContain('<ESC>F2<NUL>FALLBACK');
    });

    it('review MEDIUM: framing tokens and raw control bytes cannot inject printer commands', async () => {
        const d = design([vf(1, 'SKU')]);
        const t = parseCsv('SKU\nA1<ETX><STX>evil<ESC>C\n');
        const ipl = await generateIPL(d, buildBatchData(d, t)!);
        const block = ipl.split('\n').find(l => l.includes('<CAN>'))!;
        // Exactly one <ETX> per print block (its own terminator), no re-opened frame.
        expect((block.match(/<ETX>/g) || []).length).toBe(1);
        expect(block).not.toContain('<STX>evil');
        // Raw control bytes (0x03 ETX smuggled in a quoted cell) are stripped.
        const raw = 'A' + String.fromCharCode(3) + 'B';
        const t2 = parseCsv('SKU\n"' + raw + '"\n');
        const ipl2 = await generateIPL(d, buildBatchData(d, t2)!);
        expect(ipl2).not.toContain(String.fromCharCode(3));
        expect(ipl2).toContain('<ESC>F1<NUL>AB');
    });
});

describe('rowBatchData — single-row preview pipeline (Batch I)', () => {
    it('wraps exactly one row, clamped to the plan bounds', () => {
        const d = design([vf(1, 'SKU')]);
        const plan = planCsvJob(d, parseCsv('SKU\nA1\nB2\nC3\n'))!;
        expect(rowBatchData(plan, 1).rows).toEqual([['B2']]);
        expect(rowBatchData(plan, -5).rows).toEqual([['A1']]);   // clamps low
        expect(rowBatchData(plan, 99).rows).toEqual([['C3']]);   // clamps high
        expect(rowBatchData(plan, 2).mappings).toEqual(plan.batch.mappings);
    });

    it('generateIPL(row) -> parseViewerIPL attaches the row data end-to-end', async () => {
        const d = design([
            vf(1, 'SKU'),
            // Lot links to ds2 ('Qty', counter 001) — no header matches its
            // field or source name, so it must fall back to the source value
            // in the PREVIEW pipeline exactly like the generator does.
            { ...vf(2, 'Lot'), dataSource: { type: 'linked', sourceId: 'ds2' } } as TextField,
        ]);
        const plan = planCsvJob(d, parseCsv('SKU\nA1\nB2\n'))!;
        expect(plan.batch.mappings).toEqual({ 1: 0 }); // Lot unmapped
        const ipl = await generateIPL(d, rowBatchData(plan, 1));
        const label = parseViewerIPL(ipl);
        const texts = label.elements.filter(e => e.kind === 'text') as { source: { type: string; data?: string } }[];
        expect(texts.some(t => t.source.data === 'B2')).toBe(true);
        expect(texts.some(t => t.source.data === '001')).toBe(true);
        expect(label.issues.filter(i => i.level === 'error')).toHaveLength(0);
    });
});
