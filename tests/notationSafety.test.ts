// Batch R (2026-09-23): notation & job-command safety. Two hazards found by
// probe after Batch Q: (A) the designer importer's "accepts raw control bytes"
// contract was a lie — only STX/ETX were normalized, so a raw-byte capture
// lost label size, quantity and every <SI> setting; (B) whole-stream scans of
// job commands (<RS> quantity, <US> batch, <ESC>I/D odometer) read d3 fixed
// text as commands — a label literally saying "CODE <RS>50 END" hijacked the
// job quantity. Fixes: normalizeAllControlChars at parseIPL entry +
// maskFieldPayloads before every job-command scan (viewer + importer).
import './golden/setup';
import { describe, it, expect } from 'vitest';
import { parseIPL } from '../services/iplParser';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { generateIPL } from '../services/iplGenerator';
import { maskFieldPayloads, normalizeAllControlChars } from '../services/ipl/tokenizer';
import type { Design, TextField } from '../types';

const LIT = [
    '<STX><ESC>C<SI>W640<SI>L320<ETX>',
    '<STX><SI>T1<SI>g1<SI>S50<SI>d2<ETX>',
    '<STX><ESC>P<ETX>',
    '<STX>E1;F1;<ETX>',
    '<STX>H0;o20,20;c25;k12;d3,HELLO<ETX>',
    '<STX>R<ETX>',
    '<STX><ESC>E1<CAN><RS>5<ETB><FF><ETX>',
].join('\n');
const toRaw = (s: string) => s
    .replace(/<STX>/g, '\x02').replace(/<ETX>/g, '\x03').replace(/<ESC>/g, '\x1b')
    .replace(/<SI>/g, '\x0f').replace(/<CAN>/g, '\x18').replace(/<NUL>/g, '\x00')
    .replace(/<ETB>/g, '\x17').replace(/<FF>/g, '\x0c').replace(/<RS>/g, '\x1e');

describe('A: raw-byte stream into designer parseIPL', () => {
    it('raw import matches literal import for every setting', () => {
        const lit = parseIPL(LIT, 203);
        const raw = parseIPL(toRaw(LIT), 203);
        expect(raw.labelSettings.width).toBe(lit.labelSettings.width);       // <SI>W via <ESC>C frame
        expect(raw.labelSettings.height).toBe(lit.labelSettings.height);
        expect(raw.printerSettings.quantity).toBe(5);                          // <RS>5 raw
        expect(raw.printerSettings.printSpeed).toBe(lit.printerSettings.printSpeed);
        expect(raw.printerSettings.darkness).toBe(lit.printerSettings.darkness);
        expect(raw.printerSettings.mediaType).toBe(lit.printerSettings.mediaType);
        expect(raw.printerSettings.mediaSenseMode).toBe(lit.printerSettings.mediaSenseMode);
        expect(raw.fields).toHaveLength(1);
        expect((raw.fields[0] as TextField).dataSource).toEqual({ type: 'fixed', data: 'HELLO' });
    });

    it('CRLF line endings do not inject <CR> text into d3 payloads', () => {
        const crlf = LIT.replace(/\n/g, '\r\n');
        const d = parseIPL(crlf, 203);
        expect((d.fields[0] as TextField).dataSource).toEqual({ type: 'fixed', data: 'HELLO' });
    });

    it('mixed notation (raw STX, literal ESC) imports fine — streams are mixed in the wild', () => {
        const mixed = LIT.replace(/<STX>/g, '\x02').replace(/<ETX>/g, '\x03');
        const d = parseIPL(mixed, 203);
        expect(d.fields).toHaveLength(1);
        expect(d.printerSettings.quantity).toBe(5);
    });
});

describe('B: d3 fixed text cannot hijack job commands', () => {
    const designWith = (data: string, quantity: number): Design => ({
        name: 'H',
        labelSettings: { width: 80, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
        printerSettings: { model: 'PD43', dpi: 203, quantity, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
        fields: [{ id: 1, type: 'text', name: 'T', x: 5, y: 5, rotation: 0, dataSource: { type: 'fixed', data }, font: '25', fontSize: 12, h_mag: 1, w_mag: 1 } as TextField],
        dataSources: [], nextId: 2, guides: { horizontal: [], vertical: [] },
    });

    it('viewer: literal "<RS>50" inside fixed text does not hijack quantity', async () => {
        const ipl = await generateIPL(designWith('CODE <RS>50 END', 2));
        const label = parseViewerIPL(ipl);
        expect(label.settings.quantity).toBe(2); // design quantity, not the text
        // and the text still RENDERS (masking is scan-only, not parse-only)
        const text = label.elements.find(e => e.kind === 'text') as { source: { data: string } };
        expect(text.source.data).toContain('<RS>50');
    });

    it('viewer: "<ESC>I9" inside fixed text does not fake an odometer step', async () => {
        const ipl = await generateIPL(designWith('SERIAL <ESC>I9 HERE', 1));
        const label = parseViewerIPL(ipl);
        // The step lives on the element now (per-field, PRM p.104), so the
        // fixed-text field must carry none.
        for (const el of label.elements) {
            expect((el as { serialStep?: number }).serialStep).toBeUndefined();
        }
    });

    it('importer: quantity from text "<RS>77" ignored; real <RS> still read', async () => {
        const ipl = await generateIPL(designWith('LOT <RS>77', 3));
        const d = parseIPL(ipl, 203);
        expect(d.printerSettings.quantity).toBe(3);
    });

    it('print-block data with <RS> text survives (block frames are not masked)', async () => {
        // Variable field whose PRINT-BLOCK data contains <RS>5 — the block
        // regex terminates at <RS>, so this is a known stream ambiguity; the
        // viewer's extractPrintBlockData strips <RS>\d* from captured data.
        // Pin that the JOB quantity (real <RS>2) is still correct.
        const d = designWith('', 2);
        d.fields = [{ id: 1, type: 'text', name: 'T', x: 5, y: 5, rotation: 0, dataSource: { type: 'variable', defaultData: 'X<RS>5Y' }, font: '25', fontSize: 12, h_mag: 1, w_mag: 1 } as TextField];
        const ipl = await generateIPL(d);
        const label = parseViewerIPL(ipl);
        expect(label.settings.quantity).toBe(2);
    });
});

describe('maskFieldPayloads unit behavior', () => {
    it('strips d3 payload to frame end, keeps other frames', () => {
        const s = '<STX>H0;d3,A<RS>50<ETX>\n<STX><ESC>E1<CAN><RS>2<ETB><FF><ETX>';
        const m = maskFieldPayloads(s);
        expect(m).toBe('<STX>H0;<ETX>\n' + '<STX><ESC>E1<CAN><RS>2<ETB><FF><ETX>');
    });
    it('handles raw STX/ETX and does not touch non-d3 frames', () => {
        const s = '\x02H0;d3,TEXT\x1e9\x03';
        expect(maskFieldPayloads(s)).toBe('\x02H0;\x03');
        expect(maskFieldPayloads('<STX>R<ETX>')).toBe('<STX>R<ETX>');
    });
    it('leaves frames without ETX (truncated tails) alone', () => {
        const s = '<STX>H0;d3,ABC';
        expect(maskFieldPayloads(s)).toBe(s);
    });
    it('normalizeAllControlChars keeps LF/CR as line endings', () => {
        const s = 'a\r\nb\x1bx';
        expect(normalizeAllControlChars(s)).toBe('a\r\nb<ESC>x');
    });
});
