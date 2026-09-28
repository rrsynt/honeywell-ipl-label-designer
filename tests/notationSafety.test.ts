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
import { resolveLabelAtBatch } from '../services/ipl/odometer';
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

// ---------------------------------------------------------------------------
// Batch (2026-09-29): control characters inside a PRINT BLOCK
// ---------------------------------------------------------------------------
//
// The d3 masking above protects whole-stream scans, but a print block is
// deliberately NOT masked (its data is <ESC>F-delimited, so the d3 rule does
// not apply). Its field data was cleaned of only <ESC>/<US>/<RS>, so every
// other control character — <EM> Abort Print Job, <DEL> Clear Data, <CR> Next
// Data Entry Field, and 20 more — was captured as LITERAL TEXT and painted
// onto the label, with no warning at all: a field reading "AAAA<EM><DEL>".
//
// The names and semantics below come from PRM 2.70's "Print Commands (t = 0)"
// table (p.250), which is also what caught the first cut of the fix MISSING
// <CR> and <SI> from a hand-written list — <CR> being the very character the
// sweep exists to catch.
describe('control characters in a print block are not printed as text', () => {
    const stx = (f: string) => `<STX>${f}<ETX>`;
    const blockWith = (...blockFrames: string[]): string => [
        stx('<ESC>P'), stx('E1;F1;'), stx('H1;o20,20;c25;k14'), stx('R'),
        stx('<ESC>E1<CAN>') + '<ESC>F1<NUL>' + blockFrames.join('') + '<US>1<RS>1<ETB>',
    ].join('');

    /** The text actually rendered for the first field. */
    const rendered = (block: string): string => {
        const el = parseViewerIPL(block).elements.find(e => e.kind === 'text');
        return el ? (el.source as { data: string }).data : '';
    };

    it('never leaks a control command into the painted text', () => {
        // Every name in PRM 2.70's Print Commands (t = 0) table, minus three
        // groups: the separators that deliberately survive (next test), and
        // <ETB>/<RS>/<FF>, which TERMINATE the print block rather than sit in
        // its data — "<FF>" ends the block, so the following "BB" is never part
        // of this field. That is protocol, not a leak.
        const names = ['NUL', 'SOH', 'STX', 'ETX', 'EOT', 'ENQ', 'ACK', 'BEL', 'BS', 'HT',
            'LF', 'VT', 'CR', 'SO', 'SI', 'DLE', 'DC1', 'DC2', 'DC3', 'DC4',
            'NAK', 'SYN', 'CAN', 'EM', 'DEL'];
        for (const n of names) {
            const text = rendered(blockWith(`AA<${n}>BB`));
            expect(text, `<${n}> must not print`).toBe('AABB');
        }
    });

    it('treats <ETB>/<RS>/<FF> as block terminators, not field text', () => {
        // They end the block, so everything after them belongs to the next
        // frame — the field keeps only what preceded them.
        for (const term of ['ETB', 'RS', 'FF']) {
            expect(rendered(blockWith(`AA<${term}>BB`)), `<${term}> ends the block`).toBe('AA');
        }
    });

    it('strips the RAW byte form too, not just the placeholder', () => {
        // A raw printer capture carries control BYTES: <EM> is 0x19, <DEL> is
        // 0x7f, <CR> is 0x0d.
        expect(rendered(blockWith('AA\x19BB'))).toBe('AABB');
        expect(rendered(blockWith('AA\x7fBB'))).toBe('AABB');
        expect(rendered(blockWith('AA\x0dBB'))).toBe('AABB');
    });

    it('keeps <FS> and <GS>: they are the odometer markers, not text', () => {
        // Stripping these would delete the serial counters this project built.
        const block = parseViewerIPL(blockWith('<FS>0001<FS><ESC>I5'));
        const at = (b: number) =>
            (resolveLabelAtBatch(block, b, 203).elements[0] as { source: { data: string } }).source.data;
        expect(at(0)).toBe('0001');
        expect(at(1)).toBe('0006');
    });

    it('keeps a multi-line text field: <SUB><CR> is the newline convention', () => {
        // The generator emits <SUB><CR> for a text-field \n. The sweep must not
        // eat the newline it is supposed to create — an earlier cut of this fix
        // did exactly that, silently collapsing "AA\nBB" to "AABB".
        expect(rendered(blockWith('AA<SUB><CR>BB'))).toBe('AA\nBB');
        // and the raw-byte spelling of the same pair
        expect(rendered(blockWith('AA\x1a\rBB'))).toBe('AA\nBB');
    });

    it('consumes <SUB> together with what it escapes (Data Shift, PRM p.99)', () => {
        // <SUB><GS> is a LITERAL GS that prints as a character, not a live
        // alphanumeric field separator. Dropping only the <SUB> would leave a
        // <GS> standing and turn data into an odometer region the printer never
        // asked for.
        const block = parseViewerIPL(blockWith('A<SUB><GS>B'));
        const at = (b: number) =>
            (resolveLabelAtBatch(block, b, 203).elements[0] as { source: { data: string } }).source.data;
        expect(at(0)).toBe('AB');
        expect(at(1), 'must NOT advance — it is data, not a region').toBe('AB');
    });

    /** The output-changing control commands reported for a stream. */
    const reported = (block: string): (string | undefined)[] =>
        parseViewerIPL(block).issues.filter(i => i.code === 'block-control-command').map(i => i.command);

    it('reports the four that change what prints, and stays quiet for the rest', () => {
        // <EM> aborts the job, <DEL> clears the field, <CR> moves the field
        // pointer, <DLE> resets the printer and "erases all data and commands
        // in the input buffer" (p.92) — in each case the printer's output
        // differs from the preview, so silence would be the failure mode this
        // project exists to prevent.
        expect(reported(blockWith('AA<EM>BB'))).toEqual(['<EM>']);
        expect(reported(blockWith('AA<DEL>BB'))).toEqual(['<DEL>']);
        expect(reported(blockWith('AA<CR>BB'))).toEqual(['<CR>']);
        expect(reported(blockWith('AA<DLE>BB'))).toEqual(['<DLE>']);
        // Status/comms commands cannot change the label: no report.
        //
        // <BS> (Warm Boot) is here, not above, and the manual is explicit about
        // why: it "does not take effect immediately. The printer executes all
        // previous commands before the warm boot takes effect" (p.118) — the
        // label still prints. The immediate commands cannot be lumped together;
        // three of the four change the output and one does not.
        for (const quiet of ['<BEL>', '<ENQ>', '<BS>', '<DC1>', '<NUL>', '<CAN>']) {
            expect(reported(blockWith(`AA${quiet}BB`)), `${quiet} should not report`).toEqual([]);
        }
    });

    it('reports <DLE> as a Reset even when doubled, per the manual\'s own example', () => {
        // PRM p.92: "<STX><DLE><DLE><ETX> ... the first DLE is a transparency
        // character. It instructs the printer to use the <DLE> as a reset
        // command." So the pair still resets — unlike <SUB><CR>, where the pair
        // means literal DATA.
        expect(reported(blockWith('AA<DLE><DLE>BB'))).toEqual(['<DLE>']);
        expect(reported(blockWith('AA\x10\x10BB'))).toEqual(['<DLE>']);
    });

    it('does not report a <DLE> that is only escaping a character into data', () => {
        // PRM p.100: "Use <DLE> to send these command characters as data:
        // <DC1> <DC3> <STX> <ETX>." A DLE before one of those four is an escape,
        // so a stream merely PRINTING a literal STX must not look like a reset.
        for (const esc of ['<STX>', '<ETX>', '<DC1>', '<DC3>']) {
            expect(reported(blockWith(`AA<DLE>${esc}BB`)), `<DLE>${esc} is data`).toEqual([]);
        }
        // and <SUB> escapes a DLE into data the same way (p.99-100)
        expect(reported(blockWith('AA<SUB><DLE>BB'))).toEqual([]);
    });

    it('does not mistake the <SUB><CR> newline for the <CR> field command', () => {
        // The generator emits <SUB><CR> for a text-field newline. A naive
        // /<CR>/ match sees the substring and reports "Next Data Entry Field"
        // on EVERY multi-line label — a false positive that would train users
        // to ignore the list, which is worse than no warning.
        expect(reported(blockWith('AA<SUB><CR>BB'))).toEqual([]);
        expect(reported(blockWith('AA\x1a\rBB'))).toEqual([]);
        // The real command, not escaped, still reports.
        expect(reported(blockWith('AA<CR>BB'))).toEqual(['<CR>']);
    });

    it('does not report a control char that is only in STORED field data', () => {
        // The report is about print-block data. A field whose stored d3 text
        // merely spells a control sequence is the label's own text (that case
        // is maskFieldPayloads' business, above).
        const code = [stx('<ESC>P'), stx('E1;F1;'), stx('H1;o20,20;c25;k14;d3,LITERAL<EM>HERE'), stx('R')].join('');
        const label = parseViewerIPL(code);
        expect(label.issues.filter(i => i.code === 'block-control-command')).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// An ESCAPED terminator is data, not the end of the block
// ---------------------------------------------------------------------------
//
// PRM 2.70 pp.99-100 teaches Data Shift with an example that prints control
// codes as data, and it contains "<SUB><ETB> ... <SUB><RS> <SUB><US>" — an
// escaped BLOCK TERMINATOR. The block regexes looked for <ETB>/<RS>/<FF>
// without knowing about the escape, so the block ended mid-field and the rest
// of the data was discarded: "AB<SUB><FF>CD" captured as "AB".
//
// The same trap sits one level down: an escape pair must be consumed BEFORE
// any other strip runs. "<SUB><RS>" with the <RS> strip first loses the RS and
// leaves a bare <SUB> that then eats the NEXT real character — the C in
// "AB<SUB><RS>CD".
describe('a Data Shift-escaped terminator does not end the print block', () => {
    const stx = (f: string) => `<STX>${f}<ETX>`;
    const blockWith = (data: string): string => [
        stx('<ESC>P'), stx('E1;F1;'), stx('H1;o20,20;c25;k14'), stx('R'),
        stx('<ESC>E1<CAN>') + '<ESC>F1<NUL>' + data + '<US>1<RS>1<ETB>',
    ].join('');

    const rendered = (data: string): string => {
        const el = parseViewerIPL(blockWith(data)).elements.find(e => e.kind === 'text');
        return el ? (el.source as { data: string }).data : '';
    };

    it('keeps the data that follows an escaped terminator', () => {
        // Each of these would previously truncate to "AB".
        expect(rendered('AB<SUB><FF>CD')).toBe('ABCD');
        expect(rendered('AB<SUB><ETB>CD')).toBe('ABCD');
        expect(rendered('AB\x1a\x0cCD')).toBe('ABCD');
        expect(rendered('AB\x1a\x17CD')).toBe('ABCD');
    });

    it('does not let an escaped separator eat the next real character', () => {
        // The escape pair is consumed first, so the C survives. Stripping the
        // <RS> before the pair left a bare <SUB> that consumed it: "ABD".
        expect(rendered('AB<SUB><RS>CD')).toBe('ABCD');
        expect(rendered('AB<SUB><US>CD')).toBe('ABCD');
        expect(rendered('AB<SUB><GS>CD')).toBe('ABCD');
    });

    it('still ends the block at an UNESCAPED terminator', () => {
        // The guard must not disable the terminator itself.
        expect(rendered('AB<ETB>')).toBe('AB');
        expect(rendered('AB<FF>')).toBe('AB');
    });

    it('still advances \\x1c regions — escaping must not disarm the odometer', () => {
        const label = parseViewerIPL(blockWith('<FS>0001<FS><ESC>I5'));
        const at = (b: number) =>
            (resolveLabelAtBatch(label, b, 203).elements[0] as { source: { data: string } }).source.data;
        expect(at(0)).toBe('0001');
        expect(at(1)).toBe('0006');
    });
});
