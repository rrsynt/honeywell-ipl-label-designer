// DPL (Datamax Programming Language): the parser, the generator, and the two
// things that make DPL different from the other four languages here.
//
// EVERY table is pinned to the **Datamax Class Series Programmer's Manual**
// (88-2316-01 Rev H), with the section named inline, and cross-checked against
// the **Honeywell DPL Command Reference for Fiji Platform Printers**. Both are
// in docs/manuals/.
//
// The secondary source that had been collected for DPL
// (docs/manuals/DPL_Reference_Sources/) was deliberately NOT used for any
// table: it disagrees with both manuals about which letter means which bar
// code and about the font cell sizes. Two tests below pin that difference by
// asserting the MANUAL's values, so a future change "correcting" them back to
// the secondary source fails loudly instead of printing the wrong symbology.

import { describe, it, expect } from 'vitest';
import './golden/setup';
import { parseDPL, tokenizeDpl } from '../services/dpl/dplParser';
import { generateDPL } from '../services/dpl/dplGenerator';
import { DPL_FONTS, dplMultiplier, dplMultiplierValue, nearestSmoothPoint } from '../services/dpl/dplFonts';
import { dplBarcodeFor, DPL_BARCODES } from '../services/dpl/dplBarcodes';
import { detectSourceLanguage } from '../components/IPLViewerModal';
import { estimateElementSize } from '../services/ipl/renderer';
import type { Design } from '../types';

/** 4x2in media at 203 dpi — the size the manual's own examples assume. */
const PAGE = 406;

const design = (fields: unknown[]): Design => ({
    name: 'DPL test',
    labelSettings: { width: 101.6, height: 50.8, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: {
        model: 'M-4208', dpi: 203, quantity: 2, mediaType: 'direct-thermal',
        mediaSenseMode: 'gap', printSpeed: 6, darkness: 10, language: 'dpl',
    },
    fields,
    dataSources: [],
    nextId: 9,
    guides: { horizontal: [], vertical: [] },
} as unknown as Design);

const textField = (over: Record<string, unknown> = {}) => ({
    id: 1, type: 'text' as const, name: 'T', x: 10, y: 10, rotation: 0 as const,
    dataSource: { type: 'fixed' as const, data: 'HELLO' },
    font: '0', fontSize: 12, h_mag: 1, w_mag: 1, ...over,
});
const barcodeField = (over: Record<string, unknown> = {}) => ({
    id: 2, type: 'barcode' as const, name: 'B', x: 10, y: 25, rotation: 0 as const,
    dataSource: { type: 'fixed' as const, data: '12345' },
    symbology: '6', humanReadable: 'below', h_mag: 40, w_mag: 2, ...over,
});

describe('DPL tokenizer', () => {
    it('reads a job as <STX>L ... E, keeping records verbatim', () => {
        // "The <STX>L command switches the printer from the System-Level
        // Processor to the Label Formatting Processor" (manual p. 109).
        const cmds = tokenizeDpl('\x02L\r141100001000100SAMPLE LABEL\rQ0001\rE\r');
        expect(cmds.map(c => c.name)).toEqual(['L', '', '', '']);
        expect(cmds[1].params).toBe('141100001000100SAMPLE LABEL');
        expect(cmds[3].params).toBe('E');
    });

    it('accepts the <STX> notation as well as the raw byte', () => {
        // Every other language here carries this hazard; a stream may spell the
        // control characters out or send them, and both must read the same.
        const raw = tokenizeDpl('\x02L\r141100001000100X\rE\r');
        const notated = tokenizeDpl('<STX>L\r141100001000100X\r E\r'.replace('\r E', '\rE'));
        expect(notated.map(c => c.name)).toEqual(raw.map(c => c.name));
        expect(notated[1].params).toBe(raw[1].params);
    });
});

describe('DPL bar code table (manual Appendix F, cross-checked against Fiji)', () => {
    it('maps the letters the MANUALS give, not the shifted secondary table', () => {
        // Class Series Table F-1, confirmed by the Fiji Command Reference:
        //   B/b UPC-A, C/c UPC-E, D/d Interleaved 2 of 5, E/e Code 128,
        //   F/f EAN-13, G/g EAN-8, H/h HIBC, I/i Codabar
        // The secondary source in DPL_Reference_Sources/ lists C as UPC-E and
        // shifts every letter from there, so a table taken from it would print
        // the wrong symbology on every bar code from C up.
        const sym = (b: string) => dplBarcodeFor(b)?.type.symbology;
        expect(sym('B'), 'B is UPC-A (the IR resolves the variant by length)').toBe('7');
        expect(sym('D'), 'D is Interleaved 2 of 5').toBe('2');
        expect(sym('E'), 'E is Code 128').toBe('6');
        expect(sym('F'), 'F is EAN-13').toBe('7');
        expect(sym('G'), 'G is EAN-8').toBe('7');
        expect(sym('H'), 'H is HIBC').toBe('8');
        expect(sym('I'), 'I is Codabar').toBe('4');
        expect(sym('A'), 'A is Code 39').toBe('0');
    });

    it('reads case as the human-readable flag, and knows which codes have none', () => {
        // "Values A through T (uppercase) will print bar codes with
        // human-readable interpretations. Values a through z (lowercase) will
        // print bar codes only" (manual p. 133).
        expect(dplBarcodeFor('A')?.hri).toBe(1);
        expect(dplBarcodeFor('a')?.hri).toBe(0);
        // "Other bar codes without a human-readable counterpart include u
        // (MaxiCode) and z (PDF417)" — and Postnet, whose uppercase P the
        // manual calls invalid outright.
        expect(dplBarcodeFor('P')?.hri, 'Postnet cannot print text').toBe(0);
        expect(dplBarcodeFor('U')?.hri, 'MaxiCode cannot print text').toBe(0);
        expect(dplBarcodeFor('Z')?.hri, 'PDF417 cannot print text').toBe(0);
    });

    it('reads the two-character Wxx ids, which shift the whole header', () => {
        // "Value W requires two additional characters to specify the Bar
        // Code/Font ID" (manual p. 133). Consuming one letter would leave the
        // second as the width multiplier and shift every later field.
        const qr = dplBarcodeFor('W1D');
        expect(qr?.type.symbology).toBe('18');
        expect(qr?.consumed, 'Wxx takes THREE characters').toBe(3);
        expect(dplBarcodeFor('W1d')?.hri, 'the lowercase form prints no text').toBe(0);
        expect(dplBarcodeFor('W1C')?.type.symbology).toBe('17');
        expect(dplBarcodeFor('W1F')?.type.symbology).toBe('23');
    });
});

describe('DPL font table (manual Appendix C)', () => {
    it('carries the MANUAL cells, not the secondary source\'s', () => {
        // Appendix C Table C-2 @ 203 dpi: Font 0 is 10 high x 7 wide with a
        // 1-dot spacing. The secondary source in DPL_Reference_Sources/ lists
        // it as 7 high x 5 wide — a different measurement, and a table built
        // from it sizes every text field wrong.
        expect(DPL_FONTS['0']).toMatchObject({ height: 10, width: 7, spacing: 1 });
        expect(DPL_FONTS['4']).toMatchObject({ height: 53, width: 27, spacing: 4 });
        expect(DPL_FONTS['6']).toMatchObject({ height: 95, width: 47, spacing: 6 });
    });

    it('maps the multiplier alphabet 1-61 (manual p. 134)', () => {
        // "Values 1-9, A-Z, and a-z represent multiplication factors from 1 - 61"
        expect(dplMultiplier(1)).toBe('1');
        expect(dplMultiplier(9)).toBe('9');
        expect(dplMultiplier(10)).toBe('A');
        expect(dplMultiplier(35)).toBe('Z');
        expect(dplMultiplier(36)).toBe('a');
        expect(dplMultiplier(61)).toBe('z');
        // and the inverse agrees with it
        for (const n of [1, 9, 10, 35, 36, 61]) {
            expect(dplMultiplierValue(dplMultiplier(n)), `round trip ${n}`).toBe(n);
        }
    });

    it('snaps a smooth-font size to a documented one', () => {
        // Table C-6 sizes, given in POINTS — "specify the font size in points"
        // for portability between printers of different dpi (manual p. 135).
        expect(nearestSmoothPoint(12)).toBe(12);
        expect(nearestSmoothPoint(13)).toBe(12);
        expect(nearestSmoothPoint(16)).toBe(14);
        expect(nearestSmoothPoint(70)).toBe(72);
    });
});

describe('DPL record parsing (manual Table 8-3)', () => {
    it('splits the fixed fields at the documented offsets', () => {
        // The manual's own worked example, p. 132:
        //   121100000050005HOME POSITION  ->  a=1 b=2 c=1 d=1 eee=000 ffff=0005 gggg=0005
        const el = parseDPL('\x02L\r121100000050005HOME POSITION\rQ0001\rE\r', PAGE).elements[0] as any;
        expect(el.kind).toBe('text');
        expect((el.source as { data: string }).data).toBe('HOME POSITION');
        // ffff is the ROW, measured UP from the bottom-left home position.
        expect(el.ox, 'gggg 0005 is the column, 0.05in from the left').toBeCloseTo(10, 0);
    });

    it('uses eee as the bar code height only for bar code records', () => {
        // Table 8-5: for fonts 0-8 the height field is "not used"; for a bar
        // code it is the symbol height. Reading it for a text record would
        // invent a height the printer ignores.
        const text = parseDPL('\x02L\r141100001000100HI\rQ0001\rE\r', PAGE).elements[0] as any;
        expect(text.kind).toBe('text');
        expect(text.heightDots, 'a text element sizes itself from its font').toBeUndefined();

        const bc = parseDPL('\x02L\r1E2201000100010BC\rQ0001\rE\r', PAGE).elements[0] as any;
        expect(bc.kind).toBe('barcode');
        expect(bc.heightDots, 'eee 010 = 0.10in = 20 dots').toBeCloseTo(20, 0);
    });

    it('flips rows, because DPL home is the LOWER-left corner', () => {
        // "The lower left corner of a label is considered the home position.
        // The row position field is a vertical coordinate that determines how
        // far ABOVE the home position the data is to be printed."
        // Record = a b c d eee ffff gggg data, so the row is characters 7-10.
        // Rows are in hundredths of an inch ("Field data is interpreted in
        // hundredths of an inch", p. 135): 0020 is 0.20in = 41 dots up from the
        // bottom, 0150 is 1.50in = 305 dots up. Both fit a 406-dot page.
        const atRow = (row: string) =>
            parseDPL(`\x02L\r1411000${row}0100LOW\rQ0001\rE\r`, PAGE).elements[0] as any;
        const low = atRow('0020');
        const high = atRow('0150');
        // A row nearer the label's bottom must land at a LARGER y in the IR,
        // which measures down from the top.
        expect(low.oy).toBeGreaterThan(high.oy);

        // and the arithmetic is exact: page - row - object height
        const sz = estimateElementSize(low, 203);
        expect(low.oy).toBeCloseTo(PAGE - 41 - sz.crossDots, 0);
    });

    it('does not treat <STX>M as the label length', () => {
        // "M ... instructs the printer to move media this distance in search of
        // the top-of-form ... a good practice to set this command to 2.5 to 3
        // times the actual label length" (manual p. 22). Using it as the page
        // height would draw every label two to three times too tall.
        const lab = parseDPL('\x02M0500\r\x02L\r141100001000100HI\rQ0001\rE\r', PAGE);
        expect(lab.heightDots, 'the caller stock size still wins').toBe(PAGE);
        expect(lab.issues.map(i => i.code), 'and the substitution is named').toContain('dpl-max-travel');
    });

    it('draws a graphics record (b = X) from its data field', () => {
        // "BOX***: Bhhhvvvbbbsss" and "LINE*: Lhhhvvv" (manual p. 139).
        const box = parseDPL('\x02L\r1X1100003050240B065035002002\rQ0001\rE\r', PAGE).elements[0] as any;
        expect(box.kind).toBe('box');
        // 065 = 0.65in = 132 dots wide, 035 = 0.35in = 71 high
        expect(box.widthDots).toBeCloseTo(132, -1);
        expect(box.heightDots).toBeCloseTo(71, -1);
        expect(box.thicknessDots, 'the 002 thickness, magnified by dot size').toBeGreaterThan(0);

        const line = parseDPL('\x02L\r1X1100003050240L065035\rQ0001\rE\r', PAGE).elements[0] as any;
        expect(line.kind).toBe('line');
    });

    it('applies Inverse Mode as a real inversion', () => {
        // "A5 ... This mode allows inverse (white on black) printing" (p. 110).
        const lab = parseDPL('\x02L\rA5\r141100001000100HI\rQ0001\rE\r', PAGE);
        const rev = lab.elements.find(e => e.kind === 'reverse') as any;
        expect(rev, 'A5 must produce an inversion, not just a message').toBeDefined();
        expect(rev.widthDots).toBeGreaterThan(0);
        expect(lab.issues.map(i => i.code)).toContain('dpl-inverse-mode');
    });
});

describe('DPL generator', () => {
    it('emits <STX>L ... E with positional records', () => {
        const { dpl, warnings } = generateDPL(design([textField()]));
        expect(dpl.startsWith('\x02L\r'), 'opens label formatting').toBe(true);
        expect(dpl.trimEnd().endsWith('E'), 'and prints').toBe(true);
        expect(warnings).toEqual([]);
        // a=1 (0 degrees) b=2 (font) c/d multipliers eee=000 ffff gggg data
        const record = dpl.split('\r').find(l => /^\d/.test(l))!;
        expect(record[0]).toBe('1');
        expect(record[1]).toBe('2');
        expect(record.slice(15)).toBe('HELLO');
    });

    it('flips the row, since the designer measures down and DPL up', () => {
        // A field at the TOP of the design must get a LARGE row.
        const top = generateDPL(design([textField({ y: 0 })]));
        const bottom = generateDPL(design([textField({ y: 48 })]));
        const rowOf = (s: string) => Number(s.split('\r').find(l => /^\d/.test(l))!.slice(7, 11));
        expect(rowOf(top.dpl), 'y=0 is the top, so the row is near the label length').toBeGreaterThan(rowOf(bottom.dpl));
    });

    it('uses the uppercase letter for a human-readable bar code and lower for none', () => {
        const shown = generateDPL(design([barcodeField({ humanReadable: 'below' })]));
        const hidden = generateDPL(design([barcodeField({ humanReadable: 'none' })]));
        const bOf = (s: string) => s.split('\r').find(l => /^\d/.test(l))![1];
        expect(bOf(shown.dpl)).toBe('E');   // Code 128 with text
        expect(bOf(hidden.dpl)).toBe('e');  // Code 128 without
    });

    it('says so when a symbology has no DPL equivalent', () => {
        const { dpl, warnings } = generateDPL(design([barcodeField({ symbology: '8' })]));
        expect(warnings.join(' ')).toMatch(/no DPL equivalent/);
        expect(dpl).not.toContain('HIBC');
    });

    it('ROUND TRIP: what it emits, the parser reads back', () => {
        const d = design([
            textField({ dataSource: { type: 'fixed', data: 'ROUND TRIP' } }),
            barcodeField({ dataSource: { type: 'fixed', data: '98765' } }),
        ]);
        const { dpl } = generateDPL(d);
        const back = parseDPL(dpl, PAGE);
        expect(back.elements).toHaveLength(2);
        expect((back.elements[0] as any).kind).toBe('text');
        expect((back.elements[0] as any).source.data).toBe('ROUND TRIP');
        expect((back.elements[1] as any).kind).toBe('barcode');
        expect((back.elements[1] as any).symbology, 'Code 128 survives the round trip').toBe('6');
        expect((back.elements[1] as any).source.data).toBe('98765');
        expect(back.issues, 'and nothing is complained about').toEqual([]);
    });
});

describe('DPL language detection', () => {
    it('recognises <STX>L, in both spellings, and leaves the others alone', () => {
        // The marker is unambiguous: no other language here uses <STX>L as its
        // label-formatting entry.
        expect(detectSourceLanguage('\x02L\r141100001000100HI\rE')).toBe('dpl');
        expect(detectSourceLanguage('<STX>L\n141100001000100HI')).toBe('dpl');
        // and the other languages are not captured by it
        expect(detectSourceLanguage('^XA^FO10,10^FDX^FS^XZ')).toBe('zpl');
        expect(detectSourceLanguage('N\nq400\nQ200,24\nA10,10,0,2,1,1,N,"X"\nP1')).toBe('epl');
        expect(detectSourceLanguage('<STX><ESC>C<SI>W800<ETX>')).toBe('ipl');
    });
});

describe('DPL tables are complete against the manual', () => {
    it('every letter the manual lists is present', () => {
        // Appendix F Table F-1 lists these single-letter ids; a gap would make
        // a valid stream report "not part of the supported subset" for a code
        // the language actually has.
        for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVZ') {
            expect(DPL_BARCODES[letter], `letter ${letter}`).toBeDefined();
        }
    });
});
