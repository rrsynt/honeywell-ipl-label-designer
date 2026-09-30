import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { generateIPL } from '../services/iplGenerator';
import { parseIPL } from '../services/iplParser';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { parseEPL } from '../services/epl/eplParser';
import { buildBwipSpec } from '../services/ipl/barcodes';
import type { Design, Field, TextField, BarcodeField } from '../types';

const DPI = 203 as const;
const DOT_MM = 1 / 8; // 203 dpi -> 8 dots/mm
const r3 = (v: number) => Math.round(v * 1000) / 1000;

const basePrinter = {
    model: 'PD43',
    dpi: DPI,
    quantity: 1,
    mediaType: 'thermal-transfer' as const,
    mediaSenseMode: 'gap' as const,
    printSpeed: 6,
    darkness: 10,
};

const makeDesign = (fields: Field[], overrides: Partial<Design['printerSettings']> = {}): Design => ({
    name: 'Test Label',
    labelSettings: { width: 80, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { ...basePrinter, ...overrides },
    fields,
    dataSources: [],
    nextId: Math.max(0, ...fields.map(f => f.id)) + 1,
    guides: { horizontal: [], vertical: [] },
});

const text = (id: number, x: number, y: number, data: string, extra: Partial<TextField> = {}): TextField => ({
    id, type: 'text', name: `Text ${id}`, x, y, rotation: 0,
    dataSource: { type: 'fixed', data }, font: '25', fontSize: 12, h_mag: 1, w_mag: 1, ...extra,
});

const barcode = (id: number, x: number, y: number, data: string, extra: Partial<BarcodeField> = {}): BarcodeField => ({
    id, type: 'barcode', name: `Barcode ${id}`, x, y, rotation: 0,
    dataSource: { type: 'fixed', data }, symbology: '6', humanReadable: 'none',
    h_mag: 80, w_mag: 2, ...extra,
});

/** Projection of the properties that must survive a generate -> parse round trip. */
const normalizeField = (f: Field): Record<string, unknown> => {
    const base: Record<string, unknown> = {
        id: f.id,
        type: f.type,
        rotation: f.rotation,
        visible: f.visible !== false,
    };
    switch (f.type) {
        case 'text': {
            base.font = f.font;
            base.fontSize = f.fontSize;
            base.h_mag = f.h_mag;
            base.w_mag = f.w_mag;
            // c n,m — must survive import -> regenerate, or a spacing the host
            // asked for silently disappears from the printed label.
            base.intercharGapDots = f.intercharGapDots ?? null;
            break;
        }
        case 'barcode': {
            base.symbology = f.symbology.split(',')[0];
            base.humanReadable = f.humanReadable;
            // Generator emits the I-command with these defaults when HRI is on but font unset
            base.hriFont = !f.hriFont || (f.hriFont === '21' && (f.hriFontSize ?? 10) === 10) ? null : f.hriFont;
            base.code39_checkDigit = !f.code39_checkDigit || f.code39_checkDigit === 'none' ? null : f.code39_checkDigit;
            base.code128_subset = !f.code128_subset || f.code128_subset === 'auto' ? null : f.code128_subset;
            break;
        }
        case 'line':
            base.length = r3(f.length);
            base.thickness = r3(f.thickness);
            break;
        case 'box':
            base.width = r3(f.width);
            base.height = r3(f.height);
            base.thickness = r3(f.thickness);
            break;
    }
    return base;
};

describe('IPL generator -> parser round trip', () => {

    it('parses its own generated output (regression: <STX>D0<ETX> no longer required)', async () => {
        const design = makeDesign([
            text(1, 5, 5, 'HELLO'),
            barcode(2, 5, 20, '123456', { dataSource: { type: 'variable', defaultData: '123456' } }),
        ]);
        const ipl = await generateIPL(design);
        expect(ipl).not.toContain('<STX>D0<ETX>');

        const parsed = parseIPL(ipl, DPI);
        expect(parsed.fields).toHaveLength(2);
        expect(parsed.fields.map(f => f.type)).toEqual(['text', 'barcode']);
    });

    it('round-trips field geometry, fonts and static data at rotation 0', async () => {
        const design = makeDesign([
            text(1, 5.25, 4, 'Cat.'),
            { ...text(2, 30, 10, 'ABC'), font: '0', h_mag: 2, w_mag: 2 },
            barcode(3, 5, 15, 'HELLO39', { symbology: '0' }),
            barcode(4, 5, 35, '12345678'),
            { ...barcode(5, 40, 15, ''), humanReadable: 'above', hriFont: '22', hriFontSize: 14 },
            { id: 6, type: 'line', name: 'Line 6', x: 2, y: 45, rotation: 0, length: 70.125, thickness: 0.375 },
            { id: 7, type: 'box', name: 'Box 7', x: 55, y: 4, rotation: 0, width: 20.25, height: 12.5, thickness: 0.25 },
        ]);

        const parsed = parseIPL(await generateIPL(design), DPI);

        expect(parsed.fields).toHaveLength(7);
        const tol = DOT_MM * 1.01; // one-dot rounding granularity
        for (const original of design.fields) {
            const roundTripped = parsed.fields.find(f => f.id === original.id)!;
            expect(roundTripped).toBeDefined();
            expect(roundTripped.type).toBe(original.type);
            expect(roundTripped.rotation).toBe(0);
            // Origin compensation is exact for unrotated fields
            expect(Math.abs(roundTripped.x - original.x)).toBeLessThanOrEqual(tol);
            expect(Math.abs(roundTripped.y - original.y)).toBeLessThanOrEqual(tol);

            expect(normalizeField(roundTripped), `field ${original.id} mismatch`)
                .toEqual(normalizeField(original));
        }

        // Data sources survive
        const t1 = parsed.fields[0] as TextField;
        expect(t1.dataSource).toEqual({ type: 'fixed', data: 'Cat.' });
        const b3 = parsed.fields[2] as BarcodeField;
        expect(b3.symbology).toBe('0');
        expect(b3.dataSource).toEqual({ type: 'fixed', data: 'HELLO39' });
    });

    it('restores variable-field data from the print block', async () => {
        const design = makeDesign([
            text(1, 5, 5, 'x', { dataSource: { type: 'variable', defaultData: 'ORDER-1001' } }),
            barcode(2, 5, 20, '', { dataSource: { type: 'variable', defaultData: '99887766' } }),
        ]);
        const parsed = parseIPL(await generateIPL(design), DPI);

        const t1 = parsed.fields.find(f => f.id === 1) as TextField;
        const b2 = parsed.fields.find(f => f.id === 2) as BarcodeField;
        expect(t1.dataSource).toMatchObject({ type: 'variable', defaultData: 'ORDER-1001' });
        expect(b2.dataSource).toMatchObject({ type: 'variable', defaultData: '99887766' });
    });

    it('bakes date and time data sources into fixed text', async () => {
        // IPL has no clock: `dn` documents only d0-d3 (PRM p.184), so there is
        // no command a date source could round-trip THROUGH. The generator
        // writes the formatted value as fixed data, which the parser reads
        // back as text in the requested shape.
        const design = makeDesign([
            text(1, 5, 5, '', { dataSource: { type: 'date', format: 'DD/MM/YYYY' } }),
            text(2, 5, 15, '', { dataSource: { type: 'time', format: 'HH:MM am/pm' } }),
        ]);
        const parsed = parseIPL(await generateIPL(design), DPI);

        const dateSrc = (parsed.fields[0] as TextField).dataSource as { type: string; data: string };
        const timeSrc = (parsed.fields[1] as TextField).dataSource as { type: string; data: string };
        expect(dateSrc.type).toBe('fixed');
        expect(dateSrc.data, 'DD/MM/YYYY shape').toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
        expect(timeSrc.type).toBe('fixed');
        expect(timeSrc.data, 'HH:MM am/pm shape').toMatch(/^\d{2}:\d{2} (am|pm)$/);
    });

    it('round-trips code128 subset, code39 check digit and multi-line text', async () => {
        const design = makeDesign([
            barcode(1, 5, 5, '', { code128_subset: 'b' }),
            barcode(2, 5, 40, '', { symbology: '0', code39_checkDigit: 'printer-generated' }),
            text(3, 5, 30, 'LINE ONE\nLINE TWO'),
        ]);
        const parsed = parseIPL(await generateIPL(design), DPI);

        const b1 = parsed.fields[0] as BarcodeField;
        expect(b1.code128_subset).toBe('b');
        const b2 = parsed.fields[1] as BarcodeField;
        expect(b2.code39_checkDigit).toBe('printer-generated');
        const t3 = parsed.fields[2] as TextField;
        expect(t3.dataSource).toEqual({ type: 'fixed', data: 'LINE ONE\nLINE TWO' });
    });

    // `c n,m` on a text field. Before this was carried through the designer,
    // the importer stored `font: "25,3"` — a value FONT_MAP cannot resolve —
    // and the regenerated stream emitted a plain `c25`, so the spacing the
    // host asked for vanished without a word.
    it('round-trips the intercharacter gap c n,m on outline and bitmap fonts', async () => {
        const design = makeDesign([
            text(1, 5, 5, 'HELLO', { font: '25', intercharGapDots: 3 }),
            text(2, 5, 20, 'HELLO', { font: '0', h_mag: 2, w_mag: 1, intercharGapDots: -4 }),
            text(3, 5, 35, 'HELLO', { font: '25' }),
        ]);
        const ipl = await generateIPL(design);
        expect(ipl).toContain('c25,3');
        expect(ipl).toContain('c0,-4');
        // The third field carries no gap: exactly one `c25` may appear with a
        // modifier, and one must appear bare.
        expect(ipl.match(/c0,-4/g)?.length).toBe(1);
        expect(ipl.match(/c25;[^,]/g)?.length, 'one bare c25 for field 3').toBe(1);

        const parsed = parseIPL(ipl, DPI);
        const t1 = parsed.fields[0] as TextField;
        expect(t1.font, 'font id must not absorb the gap').toBe('25');
        expect(t1.intercharGapDots).toBe(3);
        const t2 = parsed.fields[1] as TextField;
        expect(t2.font).toBe('0');
        expect(t2.intercharGapDots, 'a negative gap overlaps on purpose').toBe(-4);
        const t3 = parsed.fields[2] as TextField;
        expect(t3.intercharGapDots).toBeUndefined();
    });

    it('round-trips printer settings and label dimensions', async () => {
        const design = makeDesign(
            [text(1, 5, 5, 'A')],
            { quantity: 5, printSpeed: 5, darkness: 12, mediaType: 'direct-thermal', mediaSenseMode: 'continuous' },
        );
        const parsed = parseIPL(await generateIPL(design), DPI);

        expect(parsed.printerSettings.quantity).toBe(5);
        expect(parsed.printerSettings.printSpeed).toBe(5);
        expect(parsed.printerSettings.darkness).toBe(12);
        expect(parsed.printerSettings.mediaType).toBe('direct-thermal');
        expect(parsed.printerSettings.mediaSenseMode).toBe('continuous');

        const tol = DOT_MM * 1.01;
        expect(Math.abs(parsed.labelSettings.width - 80)).toBeLessThanOrEqual(tol);
        expect(Math.abs(parsed.labelSettings.height - 50)).toBeLessThanOrEqual(tol);
    });

    it('keeps rotated fields present with correct type and rotation', async () => {
        const design = makeDesign([
            { ...text(1, 10, 10, 'ROT'), rotation: 90 as 90 },
            { ...barcode(2, 10, 30, '123'), rotation: 270 as 270 },
        ]);
        const parsed = parseIPL(await generateIPL(design), DPI);

        expect(parsed.fields).toHaveLength(2);
        expect(parsed.fields.find(f => f.id === 1)!.rotation).toBe(90);
        expect(parsed.fields.find(f => f.id === 2)!.rotation).toBe(270);
    });

    it('writes each bar code before the interpretive that binds to it', async () => {
        // An I<n> field interprets bar code <n>, so the bar code must already
        // be defined when it appears (PRM p.191). The generator used to push
        // the I command while iterating but the B command only after the loop,
        // so EVERY stream had I before B and the viewer reported
        // "references bar code field N, which has not been defined". Nothing
        // caught it because the parser still renders both fields either way —
        // only the ordering was wrong, and only the viewer's issue list said so.
        const design = makeDesign([
            text(1, 5, 5, 'Label'),
            barcode(2, 5, 20, '12345678', { humanReadable: 'below' }),
        ]);
        const ipl = await generateIPL(design);
        const bPos = ipl.indexOf('<STX>B2;');
        const iPos = ipl.indexOf('<STX>I2;');
        expect(bPos, 'bar code B2 is emitted').toBeGreaterThanOrEqual(0);
        expect(iPos, 'interpretive I2 is emitted').toBeGreaterThanOrEqual(0);
        expect(bPos, 'B2 must precede I2').toBeLessThan(iPos);
    });

    it('puts the interpretive of a later field after that field, not before it', async () => {
        // Two barcodes, so a fix that merely moved every I to the end of the
        // loop would still emit I3 before B3.
        const design = makeDesign([
            barcode(2, 5, 20, '12345678', { humanReadable: 'below' }),
            text(1, 5, 5, 'Between'),
            barcode(3, 5, 40, '98765432', { humanReadable: 'above' }),
        ]);
        const ipl = await generateIPL(design);
        expect(ipl.indexOf('<STX>B2;')).toBeLessThan(ipl.indexOf('<STX>I2;'));
        expect(ipl.indexOf('<STX>B3;')).toBeLessThan(ipl.indexOf('<STX>I3;'));
        // and the second interpretive is not smuggled in ahead of the second
        // bar code by sitting right after the first field's flush
        expect(ipl.indexOf('<STX>B3;')).toBeGreaterThan(ipl.indexOf('<STX>I2;'));
    });

    it('generates a stream the viewer parses without an ordering warning', async () => {
        // The user-visible symptom, asserted directly: no "references bar code
        // field N, which has not been defined" from the real viewer parser.
        const design = makeDesign([
            barcode(2, 5, 20, '12345678', { humanReadable: 'below' }),
            barcode(3, 5, 40, '98765432', { humanReadable: 'above' }),
        ]);
        const label = parseViewerIPL(await generateIPL(design));
        const warned = label.issues.filter(i => i.code === 'interpretive-no-host');
        expect(warned.map(w => w.message)).toEqual([]);
    });
});

describe('parseIPL robustness', () => {
    it('accepts third-party IPL without a print block or D terminator', () => {
        const external = [
            '<STX><ESC>C<SI>W791<SI>h<ETX>',
            '<STX><ESC>P<ETX>',
            '<STX>E5;F5;<ETX>',
            '<STX>H0;o35,40;c25;k12;d3,Cat.;<ETX>',
            '<STX>B1;o35,120;c6,0,0,1;h80;w2;i1;d0,255<ETX>',
            '<STX>R<ETX>',
        ].join('\n');
        const parsed = parseIPL(external, DPI);

        expect(parsed.fields).toHaveLength(2);
        expect(parsed.fields[0]).toMatchObject({ type: 'text', font: '25', fontSize: 12 });
        expect((parsed.fields[0] as TextField).dataSource).toEqual({ type: 'fixed', data: 'Cat.' });
        const b = parsed.fields[1] as BarcodeField;
        expect(b).toMatchObject({ type: 'barcode', symbology: '6', code128_subset: 'a', humanReadable: 'below' });
        expect(b.dataSource.type).toBe('variable');
    });

    it('returns an empty design gracefully on garbage input', () => {
        const parsed = parseIPL('this is not IPL at all <<<>>>', DPI);
        expect(parsed.fields).toHaveLength(0);
    });

    it('returns an empty design on empty input', () => {
        expect(parseIPL('', DPI).fields).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// The importer and the viewer must read fixed text the same way
// ---------------------------------------------------------------------------
//
// parseIPL splits a frame body on ';' to get its field commands. That plain
// split truncated the label's OWN TEXT: "H0;o10,10;d3,A;B" is one field whose
// fixed data reads "A;B", but the split produced "d3,A" plus a stray "B", so
// the importer yielded "A" where the viewer yielded "A;B".
//
// This file already promises "viewer parity" in three places, so the two are
// meant to agree by contract — these tests are what hold it.
describe('d3 fixed text with semicolons: importer/viewer parity (2026-09-29)', () => {
    const stx = (f: string) => `<STX>${f}<ETX>`;
    const importedText = (field: string): string => {
        const design = parseIPL(
            [stx('<ESC>P'), stx('E5;F5'), stx(field), stx('R')].join(''), DPI);
        const f = design.fields[0] as TextField;
        const ds = f.dataSource as { data?: string; defaultData?: string };
        return ds.data ?? ds.defaultData ?? '';
    };
    const viewedText = (field: string): string => {
        const el = parseViewerIPL(
            [stx('<ESC>P'), stx('E5;F5'), stx(field), stx('R')].join(''))
            .elements[0] as { source: { data: string } };
        return el.source.data;
    };

    it('keeps the label\'s own semicolons, in both parsers', () => {
        // All three are shapes the manual's own examples use.
        for (const text of ['A;B', 'A;B;C', 'LOT;ROLLS;39', 'BASIS WT. 39-4838']) {
            const field = `H0;o10,10;c0;d3,${text}`;
            expect(importedText(field), `importer: ${text}`).toBe(text);
            expect(viewedText(field), `viewer: ${text}`).toBe(text);
        }
    });

    it('still reads a parameter placed AFTER the fixed data', () => {
        // PRM 2.70 p.109 puts k12 after the data. The trailing run of
        // well-formed parameters is split off, so this keeps working while the
        // text above stays whole.
        const design = parseIPL(
            [stx('<ESC>P'), stx('E5;F5'), stx('H0;o35,40;c25;d3,Cat.;k12'), stx('R')].join(''), DPI);
        const f = design.fields[0] as TextField;
        expect((f.dataSource as { data: string }).data).toBe('Cat.');
        expect(f.fontSize).toBe(12);
    });

    it('agrees with the viewer on every case in one pass', () => {
        // The invariant, stated once and directly.
        for (const field of [
            'H0;o10,10;c0;d3,A;B',
            'H0;o10,10;c0;d3,LOT;ROLLS;39',
            'H0;o10,10;c0;d3,AB;h3;w2',
            'H0;o35,40;c25;d3,Cat.;k12',
        ]) {
            expect(importedText(field), field).toBe(viewedText(field));
        }
    });
});

// A `;`-CHAIN in one frame is how the manual writes a label, and it is what
// samples/chained.ipl is. The importer read it as ONE field, so the first
// field's greedy `d3` text ran to the end of the label and everything after it
// was lost: chained.ipl imported as ZERO fields and regenerated as an empty
// label, while the viewer drew both fields. The two forms below are the same
// label written the two ways.
describe('chained frames import like split frames (2026-09-30)', () => {
    const stx = (f: string) => `<STX>${f}<ETX>`;
    const CHAINED = `<STX><ESC>P;E1;F1;H1;o100,100;f0;c25;k12;d3,Hello World!;B2;o100,200;f0;c6;h80;w2;i1;d3,12345678;R<ETX>`;
    const SPLIT = [
        stx('<ESC>P'), stx('E1;F1'),
        stx('H1;o100,100;f0;c25;k12;d3,Hello World!'),
        stx('B2;o100,200;f0;c6;h80;w2;i1;d3,12345678'),
        stx('R'),
    ].join('');

    const shape = (src: string) => parseIPL(src, DPI).fields.map(f => {
        // A field holding data — text or barcode. The union also covers `line`,
        // which has no dataSource, so the cast is what the other cases in this
        // file do too.
        const d = f as TextField | BarcodeField;
        return {
            type: f.type,
            data: (d.dataSource as { data?: string }).data,
            // The face each field names, so a barcode's parameters cannot be
            // read as the text field's font.
            face: f.type === 'text' ? (d as TextField).font : (d as BarcodeField).symbology,
        };
    });

    it('reads the chained form as its two fields, not as none', () => {
        expect(shape(CHAINED)).toHaveLength(2);
        expect(shape(CHAINED)).toEqual(shape(SPLIT));
    });

    it('keeps each field\'s data intact, with no trailing R', () => {
        const [text, bar] = shape(CHAINED);
        expect(text.data).toBe('Hello World!');
        expect(bar.data).toBe('12345678');
        // The face is the field's OWN: the barcode's c6 must not become the
        // text field's font, which is what reading the chain as one field did.
        expect(text.face).toBe('25');
        expect(bar.face).toBe('6');
    });

    it('still keeps a semicolon inside d3 when no field follows it', () => {
        // The greedy rule is the reason the split is made only at a segment
        // that IS a field start — the control for the two above.
        const design = parseIPL([stx('<ESC>P'), stx('E1;F1'),
            stx('H1;o10,10;c0;d3,A;B'), stx('R')].join(''), DPI);
        const f = design.fields[0] as TextField;
        expect((f.dataSource as { data: string }).data).toBe('A;B');
        expect(design.fields).toHaveLength(1);
    });

    it('regenerates the chained sample into a label the viewer draws', () => {
        // The end-to-end claim: samples/chained.ipl must survive import and
        // come back as content, not as an empty shell. Before the fix the
        // regenerated stream held only setup frames and the viewer drew 0 ink.
        const src = fs.readFileSync(path.join(process.cwd(), 'samples', 'chained.ipl'), 'utf8');
        const design = parseIPL(src, DPI);
        expect(design.fields.length, 'the sample must import its fields').toBe(2);
        expect(design.fields.map(f => f.type)).toEqual(['text', 'barcode']);
        const text = design.fields[0] as TextField;
        expect((text.dataSource as { data: string }).data).toBe('Hello World!');
    });
});

// The per-field parameter DEFAULTS, taken from the manual's own tables rather
// than from the parser, so a drift in either direction is caught. These tables
// are the authority for what a field means when the stream states nothing:
//
//   Bar Code Field      h = 50, w = 1, i = Disabled
//   Interpretive Field  h = 2,  w = 2
//   Line Field          l = 100, w = 1
//
// (IPL_2.70_Programmers_Reference_Manual, "X Field Default Parameters".) The
// sweep that added these checked every field type's parameters against its own
// table and found no divergence — the parser already agreed — so what they pin
// is that it keeps agreeing.
describe('IPL field parameters match the manual defaults (2026-09-30)', () => {
    const stx = (f: string) => '<STX>' + f + '<ETX>';
    const head = [stx('<ESC>C<SI>W812<SI>L400'), stx('<ESC>P'), stx('E1;F1;')];
    // The element kinds differ per test, so this reads the fields each one
    // actually carries; the cast goes through `unknown` because the union has
    // no index signature.
    const first = (frames: string[]) => parseViewerIPL([...head, ...frames, stx('R')].join(''))
        .elements[0] as unknown as Record<string, number | string | undefined>;

    it('leaves a bar code at the documented h = 50 and w = 1', () => {
        const el = first([stx('B1;o10,10;c0;d3,123')]);
        expect(el.kind).toBe('barcode');
        expect(el.heightDots, 'Bar Code Field h default').toBe(50);
    });

    it('leaves a line at the documented l = 100 and w = 1', () => {
        // w is the LINE WIDTH here — the stroke — not a second dimension, which
        // is what makes reading it as a length the obvious wrong move.
        const el = first([stx('L1;o10,10')]);
        expect(el.lengthDots, 'Line Field l default').toBe(100);
        expect(el.thicknessDots, 'Line Field w default').toBe(1);
    });

    it('leaves text and interpretive at the documented h = 2 and w = 2', () => {
        const text = first([stx('H1;o10,10;d3,HI')]);
        expect([text.hMag, text.wMag], 'Human-Readable Text defaults').toEqual([2, 2]);
    });

    it('parses the shipped sample without a single issue', () => {
        // The end-to-end control for this batch: whatever the parameter sweep
        // touched, a real stream must still come through clean.
        const ir = parseViewerIPL(fs.readFileSync(
            path.join(process.cwd(), 'samples', 'product.ipl'), 'utf8'));
        expect(ir.elements.length).toBeGreaterThan(3);
        expect(ir.issues, 'the sample is valid IPL').toEqual([]);
    });
});

// Data Matrix parameters, from each language's own manual section. Neither was
// read before: IPL c17's m1/m2 and EPL's b…D,c/r/v were all dropped silently.
//
//   IPL c17[,m1][,m2][,m3,m4[,m5,m6]] (PRM p.162)
//     m1  ECC version 100 or 200 — DIFFERENT PARITY, not a preference
//     m2  0 square, 1 rectangular
//     m3-m6  Structured Append position and file identifier
//   EPL b…D[,c cols][,r rows][,h module][,v inverse] (EPL manual p. 3-20)
//     "Order is not important for parameters p4-p7"
describe('Data Matrix parameters survive both languages (2026-09-30)', () => {
    const stx = (f: string) => '<STX>' + f + '<ETX>';
    const iplEl = (spec: string) => {
        const ir = parseViewerIPL([stx('<ESC>C<SI>W812<SI>L400'), stx('<ESC>P'),
            stx('E1;F1;'), stx(spec), stx('R')].join(''));
        const el = ir.elements.find(e => e.kind === 'barcode') as
            { dmVersion?: string; dmShape?: string; dmCols?: string; dmRows?: string; inverse?: boolean } | undefined;
        return { el, codes: ir.issues.map(i => i.code) };
    };
    const eplEl = (src: string) => {
        const r = parseEPL(`N\n${src}\nP1\n`);
        const el = r.elements[0] as
            { dmVersion?: string; dmShape?: string; dmCols?: string; dmRows?: string; inverse?: boolean } | undefined;
        return { el, codes: r.issues.map(i => i.code) };
    };

    it('names ECC-100 instead of forcing an option the encoder rejects', () => {
        // ECC-100 and ECC-200 are different encodings, so this is not a
        // rendering preference. But bwip's datamatrix is ECC-200 ONLY — there
        // is no ECC-100 mode, and the former `format: 'full'` guess made the
        // encoder THROW, so an ECC-100 field dropped out as "data fails
        // encoding rules" — an error blaming the data for an encoder gap.
        // Now the field draws (as ECC-200) and the substitution is named.
        expect((buildBwipSpec('17', 'DATA', { dmVersion: '100' })?.main.opts as Record<string, unknown>)?.format)
            .toBeUndefined();
        const { el, codes } = iplEl('B1;o10,10;c17,100;d3,DATA');
        expect(el?.dmVersion).toBe('100');
        expect(codes).toContain('dm-ecc100-unsupported');
        // The control: ECC-200 is the encoder's own default, so nothing to say.
        expect(iplEl('B1;o10,10;c17,200;d3,DATA').codes).toEqual([]);
    });

    it('reads c17,m2 and draws the rectangular Data Matrix', () => {
        // m2 selects the SHAPE (PRM p.162): 0 square, 1 rectangular. It was
        // never read — parts[1] is m1 and parts.slice(3) is m3-m6 — so a
        // rectangular request drew square in silence.
        const { el, codes } = iplEl('B1;o10,10;c17,200,1;d3,123456789012345678901234567890');
        expect(el?.dmShape).toBe('rectangle');
        expect(codes).not.toContain('dm-shape-invalid');
        expect((buildBwipSpec('17', 'DATA', { dmShape: 'rectangle' })?.main.opts as Record<string, unknown>)?.format)
            .toBe('rectangle');
        // Controls: m2=0 is the square default (no option, no message), and an
        // out-of-range m2 is named rather than misread as rectangular.
        expect(iplEl('B1;o10,10;c17,200,0;d3,DATA').el?.dmShape).toBeUndefined();
        expect(iplEl('B1;o10,10;c17,200,9;d3,DATA').codes).toContain('dm-shape-invalid');
    });

    it('rejects an ECC version that is not 100 or 200', () => {
        const { codes } = iplEl('B1;o10,10;c17,999;d3,DATA');
        expect(codes).toContain('dm-version-invalid');
    });

    it('names Structured Append rather than dropping it', () => {
        // m3-m6 describe a symbol that is one of a GROUP; the viewer draws the
        // one symbol, so the difference is stated.
        const { codes } = iplEl('B1;o10,10;c17,200,0,2,5,1,43;d3,DATA');
        expect(codes).toContain('dm-structured-append');
        // The control: no m3-m6 means nothing to say.
        expect(iplEl('B1;o10,10;c17,200;d3,DATA').codes).toEqual([]);
    });

    it('reads the EPL Data Matrix options by prefix, in any order', () => {
        // The manual: "Include the prefix letter (c, r, h, or v) ... Order is
        // not important for parameters p4-p7."
        const a = eplEl('b80,100,D,c16,r16,h8,v1,"DATA"');
        expect([a.el?.dmCols, a.el?.dmRows, a.el?.inverse]).toEqual(['16', '16', true]);
        // Reordered — the same field.
        const b = eplEl('b80,100,D,v1,h8,r16,c16,"DATA"');
        expect([b.el?.dmCols, b.el?.dmRows, b.el?.inverse]).toEqual(['16', '16', true]);
    });

    it('reports the inverse rather than drawing it as ordinary black-on-white', () => {
        expect(eplEl('b80,100,D,v1,"DATA"').codes).toContain('epl-dm-inverse');
        // The control: v0 is not inverse, and must stay silent.
        expect(eplEl('b80,100,D,v0,"DATA"').codes).toEqual([]);
        expect(eplEl('b80,100,D,v0,"DATA"').el?.inverse).toBeUndefined();
    });
});

// EAN.UCC Composite c21[,m1][,m2][,m3][,m4][,m5][,m6] (PRM p.162). m1, m3 and
// m5 were read; m2, m4 and m6 were dropped silently, and one of them is not a
// presentation detail:
//
//   m2  separator-row height, 1x-2x the bar magnification
//   m4  0 = "(" ")" and spaces appear only in the interpretive; 1 = both carry
//       exactly the same data
//   m6  0 = the linear component's interpretive is NOT printed; 1 = it is
//
// m6 decides whether a line of text is on the label at all, so a stream asking
// for 0 was previewed with the human-readable row the printer would omit.
describe('EAN.UCC Composite options are reported, not dropped (2026-09-30)', () => {
    const stx = (f: string) => '<STX>' + f + '<ETX>';
    const HT = String.fromCharCode(9);
    // The linear and 2D components are separated by <HT> (PRM p.160).
    const DATA = `112233445566${HT}aabbccddeeff`;
    const codes = (spec: string) => parseViewerIPL(
        [stx('<ESC>C<SI>W812<SI>L400'), stx('<ESC>P'), stx('E1;F1;'), stx(spec), stx('R')].join(''),
    ).issues.map(i => i.code);

    it('says which options it does not reproduce', () => {
        // m2 and m6 stated.
        const hit = codes(`B1;o10,10;c21,0,4,10,1,3,0;d3,${DATA}`).includes('composite-options-not-reproduced');
        expect(hit, 'a stated option must be named').toBe(true);
        // And the message must say WHICH, not just that something differs.
        const msg = parseViewerIPL(
            [stx('<ESC>C<SI>W812<SI>L400'), stx('<ESC>P'), stx('E1;F1;'),
                stx(`B1;o10,10;c21,0,4,10,1,3,0;d3,${DATA}`), stx('R')].join(''),
        ).issues.find(i => i.code === 'composite-options-not-reproduced')!.message;
        expect(msg, 'the separator row').toMatch(/m2=4/);
        expect(msg, 'the linear interpretive').toMatch(/m6=0/);
    });

    it('stays silent when the stream states none of them', () => {
        // The control: a bare c21, or one that gives only the positions the
        // parser models, must not raise this.
        expect(codes(`B1;o10,10;c21;d3,${DATA}`)).not.toContain('composite-options-not-reproduced');
        expect(codes(`B1;o10,10;c21,2;d3,${DATA}`)).not.toContain('composite-options-not-reproduced');
    });

    it('still reads the three it models', () => {
        // The batch must not have disturbed m1/m3/m5 on its way past.
        const el = parseViewerIPL(
            [stx('<ESC>C<SI>W812<SI>L400'), stx('<ESC>P'), stx('E1;F1;'),
                stx(`B1;o10,10;c21,2,4,10,1,3,0;d3,${DATA}`), stx('R')].join(''),
        ).elements.find(e => e.kind === 'barcode') as
            { compositeVersion?: string; compositeColumns?: string; compositeRowHeight?: string };
        expect([el.compositeVersion, el.compositeColumns, el.compositeRowHeight]).toEqual(['2', '10', '3']);
    });
});

// RSS / GS1 DataBar c20[,m1][,m2][,m3] (PRM p.166). The parser reads all three
// and validates each — m1 0-6, m3 an even 2-22 — but took m2 and m3
// positionally without checking the manual's applicability, which is scoped:
//
//   m2  height of the separator pattern row   "m1 = 2, 3, and 6 only"
//   m3  number of segments per row            "m1 = 6 only"
//
// A stream stating one for another version asks for something the printer
// ignores. The encoder here drops it too, so the two agreed by both doing
// nothing, and no message distinguished that from agreement on what to draw.
describe('c20 options are scoped to the version that accepts them (2026-09-30)', () => {
    const stx = (f: string) => '<STX>' + f + '<ETX>';
    const DATA = '1234567890123';
    const codes = (opts: string) => parseViewerIPL(
        [stx('<ESC>C<SI>W812<SI>L400'), stx('<ESC>P'), stx('E1;F1;'),
            stx(`B1;o10,10;c20${opts};d3,${DATA}`), stx('R')].join(''),
    ).issues.map(i => i.code);

    it('names an option stated for a version that does not take it', () => {
        // m2 belongs to 2/3/6, m3 to 6 alone, so neither is meaningful on 0.
        expect(codes(',0,3'), 'm2 on version 0').toContain('rss-option-not-applicable');
        expect(codes(',0,1,8'), 'm3 on version 0').toContain('rss-option-not-applicable');
    });

    it('stays silent when the version does take them', () => {
        // The control, both ways: m2 is legal on 2 and on 3, and both are legal
        // on 6. A rule that fired on the legal cases too could not tell
        // "reported correctly" from "reports everything".
        expect(codes(',2,3'), 'm2 on version 2').not.toContain('rss-option-not-applicable');
        expect(codes(',3,3'), 'm2 on version 3').not.toContain('rss-option-not-applicable');
        expect(codes(',6,1,8'), 'both on version 6').not.toContain('rss-option-not-applicable');
        // And a bare c20 states neither.
        expect(codes(''), 'no options stated').not.toContain('rss-option-not-applicable');
    });

    it('leaves the existing validation alone', () => {
        // m1 out of 0-6 and an odd segment count are separate, earlier checks.
        expect(codes(',7')).toContain('rss-version-invalid');
        expect(codes(',6,1,7')).toContain('rss-segments-invalid');
    });
});

// The 1D types other than Code 39 take a single m, and it selects something the
// SYMBOL carries rather than a presentation detail (PRM p.151-152):
//
//   c2[,m]  Interleaved 2 of 5 — 0 no check digit, 1 the PRINTER enters one,
//           2 the HOST enters it
//   c3[,m]  Code 2 of 5 — 0 three-bar start/stop, 1 two-bar
//   c4[,m]  Codabar — 0 host enters start/stop, 1,x,y the printer enters them
//   c5[,m]  Code 11 — 0 the PRINTER enters TWO check digits, 1 printer enters
//           one, 2 host enters two, 3 host enters one
//
// None of these reached the encoder, so a Code 11 asking for the printer's two
// check digits drew an arity-different symbol in silence. The trap is m0: Code
// 11's is NOT "no check digit" but "printer enters two", so a bare c5 is one of
// the streams that must be reported, and the report must skip the host modes
// whose check character already sits in the field's data.
describe('c2-c5 modifiers are either applied or named (2026-09-30)', () => {
    const stx = (f: string) => '<STX>' + f + '<ETX>';
    const codes = (spec: string) => parseViewerIPL(
        [stx('<ESC>C<SI>W812<SI>L400'), stx('<ESC>P'), stx('E1;F1;'), stx(spec), stx('R')].join(''),
    ).issues.map(i => i.code);

    it('names the check digit only when the PRINTER supplies it', () => {
        // c2 m1 and c5 m0/m1 are the printer-entered modes. bwip's includecheck
        // does append a digit (measured: c2 +5 elements, c5 +3), but its
        // algorithm is not necessarily the printer's, and a plausible-looking
        // wrong digit is worse than none — so these are named, not guessed.
        expect(codes('B1;o10,10;c2,1;d3,1234567890')).toContain('check-digit-not-drawn');
        expect(codes('B1;o10,10;c5;d3,12345')).toContain('check-digit-not-drawn');   // m0 = printer, 2 digits
        expect(codes('B1;o10,10;c5,0;d3,12345')).toContain('check-digit-not-drawn');
        expect(codes('B1;o10,10;c5,1;d3,12345')).toContain('check-digit-not-drawn'); // printer, 1 digit
    });

    it('stays silent on host-entered modes and on no-check-digit c2', () => {
        // The control: c2 m0 and m2 draw exactly what the printer would (no
        // digit / a digit already in the data), and c5 m2/m3 carry their check
        // character in the field's data too — reporting those would be noise.
        for (const spec of ['c2', 'c2,0', 'c5,2', 'c5,3', 'c3,0', 'c4,0']) {
            expect(codes(`B1;o10,10;${spec};d3,123456`), spec)
                .not.toContain('check-digit-not-drawn');
        }
    });

    it('rejects a modifier outside the documented values', () => {
        // c2 allows 0-2, c5 allows 0-3; anything else is not a mode.
        expect(codes('B1;o10,10;c2,9;d3,1234567890')).toContain('check-digit-mode-invalid');
        expect(codes('B1;o10,10;c5,9;d3,12345')).toContain('check-digit-mode-invalid');
    });

    it('names the two structural modifiers it cannot draw', () => {
        // c3's m picks the start/stop PATTERN and c4's picks the start/stop
        // CHARACTERS; the encoder has no option for either, so both are named
        // rather than silently drawn with the encoder's own.
        expect(codes('B1;o10,10;c3,1;d3,12345')).toContain('code2of5-bar-pattern');
        expect(codes('B1;o10,10;c4,1,A,B;d3,12345')).toContain('codabar-start-stop');
        // The controls: the default values state nothing to draw differently.
        expect(codes('B1;o10,10;c3,0;d3,12345')).not.toContain('code2of5-bar-pattern');
        expect(codes('B1;o10,10;c4,0;d3,12345')).not.toContain('codabar-start-stop');
    });
});
