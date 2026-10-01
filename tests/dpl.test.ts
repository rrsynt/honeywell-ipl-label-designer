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
import { substituteDplDateTime, isDplDateMarker } from '../services/dpl/dplDateTime';
import { buildBwipSpec } from '../services/ipl/barcodes';
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

    it('keeps a label command and a record on separate lines apart', () => {
        // The ordinary shape: one command per line, terminated by the carriage
        // return. A line with no attention-getter on it is a record.
        const cmds = tokenizeDpl('\x02L\rJR\r141100002000200HELLO\rQ0001\rE\r');
        // The leading '' is the <STX>L entry itself, which carries no params.
        expect(cmds.map(c => c.params)).toEqual(['', 'JR', '141100002000200HELLO', 'Q0001', 'E']);
        const lab = parseDPL('\x02L\rJR\r141100002000200HELLO\rQ0001\rE\r', PAGE);
        expect(lab.elements, 'the record draws').toHaveLength(1);
        expect((lab.elements[0] as any).source.data).toBe('HELLO');
    });

    it('splits a record from an <STX>T that shares its line', () => {
        // A LINE IS NOT A COMMAND, and this is the case that proved it. The
        // manual's own <STX>T samples put the record and the time command on
        // ONE line: `121100001000100<STX>TBCD GHI PQ, TU` (p. 126). An earlier
        // version of this test asserted the opposite — that a record "never
        // shares a line" with a command — and the tokenizer then took the first
        // <STX> on the line and discarded everything before it, so parsing
        // manual sample 1 gave 0 elements and 0 issues: total silence.
        const cmds = tokenizeDpl('\x02L\r121100001000100<STX>TBCD GHI PQ, TU\rE\r');
        expect(cmds.map(c => c.params)).toEqual([
            '',                                // the <STX>L entry, which has no params
            '121100001000100THU OCT 01, 26',   // the record, with its string baked
            'E',
        ]);
    });

    it('gives a special command with no record of its own nowhere to write', () => {
        // The record a special command fills is the one on ITS OWN line. Reading
        // it back off the end of the token list instead reached whatever was
        // emitted last — here the <STX>L — and handed it the date, turning that
        // command's params into "MON". A <STX>T out of position must not be able
        // to corrupt the command before it.
        const cmds = tokenizeDpl('\x02L\r\x02TBCD\r141100001000100HI\rE\r');
        const l = cmds.find(c => c.name === 'L');
        expect(l?.params, 'the <STX>L must keep its own (empty) params').toBe('');
        expect(cmds.map(c => c.name)).toContain('T');
    });

    it('keeps a line that opens with an inline <STX> as one piece of data', () => {
        // An attention-getter followed by a DIGIT is not a command letter, so
        // the whole line stays data rather than being split into a command
        // named "1" with the rest of the record as its parameter.
        const cmds = tokenizeDpl('\x02L\r\x02141100001000100HI\rE\r');
        const rec = cmds.find(c => c.name === '' && /^\d/.test(c.params));
        expect(rec, 'the record survives intact').toBeDefined();
        expect(rec?.params).toBe('141100001000100HI');
    });

    it('accepts the <STX> notation as well as the raw byte', () => {
        // Every other language here carries this hazard; a stream may spell the
        // control characters out or send them, and both must read the same.
        const raw = tokenizeDpl('\x02L\r141100001000100X\rE\r');
        const notated = tokenizeDpl('<STX>L\r141100001000100X\r E\r'.replace('\r E', '\rE'));
        expect(notated.map(c => c.name)).toEqual(raw.map(c => c.name));
        expect(notated[1].params).toBe(raw[1].params);
    });

    it('spells <STX>T the same whether it arrives raw or notated', () => {
        // The notation hazard is at its sharpest here, because the whole point
        // of the command is that its sigil sits inside a record's data field.
        const seed = () => new Date(2026, 9, 1, 14, 30, 45);
        const raw = parseDPL('\x02L\r121100001000100\x02TBCD GHI PQ, TU\rE\r', PAGE, seed());
        const notated = parseDPL('\x02L\r121100001000100<STX>TBCD GHI PQ, TU\rE\r', PAGE, seed());
        expect((notated.elements[0] as any).source.data)
            .toBe((raw.elements[0] as any).source.data);
        expect((raw.elements[0] as any).source.data).toBe('THU OCT 01, 26');
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

describe('DPL label-formatting commands (manual Chapter 6)', () => {
    it('J shifts the anchor, and does NOT reverse the characters', () => {
        // "Ja ... L = left justified (default), R = right justified, C = center
        // justified" (p. 115), and the manual's own note on its sample: "the
        // second text will be printed at one inch up one inch over, going left.
        // (Note the characters will not be reversed.)"
        // Each command is on its OWN line, which is how the manual writes
        // every sample: a format command and a record never share one.
        const rec = (j: string) => `\x02L\r${j ? j + '\r' : ''}141100002000200HELLO\rQ0001\rE\r`;
        const left = parseDPL(rec(''), PAGE).elements[0] as any;
        const right = parseDPL(rec('JR'), PAGE).elements[0] as any;
        const centre = parseDPL(rec('JC'), PAGE).elements[0] as any;

        // The point is what the column names; the string hangs off it. So a
        // right-justified record starts FURTHER LEFT than a left-justified one
        // at the same column, by exactly the string's width.
        expect(right.ox, 'right justification moves the origin left').toBeLessThan(left.ox);
        expect(centre.ox, 'centre sits between the two').toBeGreaterThan(right.ox);
        expect(centre.ox).toBeLessThan(left.ox);
        // and the two shifts are exactly the width and half of it
        const width = left.ox - right.ox;
        expect(width, 'the shift is the string width').toBeGreaterThan(0);
        expect(left.ox - centre.ox).toBeCloseTo(width / 2, 0);

        // and the text itself is untouched — only where it hangs changed
        expect((right.source as { data: string }).data).toBe('HELLO');
    });

    it('M reports Mirror Mode rather than silently drawing an unmirrored label', () => {
        // "instructs the printer to mirror all subsequent print field records
        // ... Mirrored fields are transposed visually, as if the object is
        // viewed in a mirror" (p. 116). It TOGGLES.
        const on = parseDPL('\x02L\rM\r141100001000100HI\rQ0001\rE\r', PAGE);
        const hit = on.issues.find(i => i.code === 'dpl-mirror');
        expect(hit, 'the preview must say the mirroring is not applied').toBeDefined();
        expect(hit!.message).toMatch(/mirror/i);
        expect(hit!.message).toMatch(/not applied/i);
        // The whole-label transform must not silently drop the field either.
        expect(on.elements).toHaveLength(1);

        // It is a toggle, so a second M flips it back and says so.
        const twice = parseDPL('\x02L\rM\rM\r141100001000100HI\rQ0001\rE\r', PAGE);
        expect(twice.issues.filter(i => i.code === 'dpl-mirror')).toHaveLength(2);
    });

    it('U names a replacement field rather than passing its placeholder off as data', () => {
        // "Mark Previous Field as a String Replacement Field" (p. 121): the
        // content comes from a host <STX>U payload at print time.
        const lab = parseDPL('\x02L\r121100001000000123456789012\rU\rQ0001\rE\r', PAGE);
        expect(lab.issues.map(i => i.code)).toContain('dpl-replacement-field');
    });

    it('names an unknown label command instead of swallowing it', () => {
        // The silence list is checked against the manual: every letter in it is
        // a real Label Formatting command. A letter that is NOT stays loud.
        const unknown = parseDPL('\x02L\rW99\r141100001000100HI\rQ0001\rE\r', PAGE);
        expect(unknown.issues.map(i => i.code)).toContain('dpl-command');
        // and the real ones stay quiet
        for (const silent of ['c07', 'e1', 'f1', 'p1', 'S1', 'T1']) {
            const quiet = parseDPL(`\x02L\r${silent}\r141100001000100HI\rQ0001\rE\r`, PAGE);
            expect(quiet.issues.map(i => i.code), `"${silent}" is a real command`).not.toContain('dpl-command');
        }
    });

    it('keeps the silence list reachable, so it silences something real', () => {
        // A name the switch above already handles can never arrive at the
        // silence check, so listing it quietens nothing. 'J', 'R' and 'U' were
        // on the list and all three are handled; 'g' was too, but the manual's
        // command is 'G'. This is the same defect the 'd' and 'V' entries had,
        // and the reason each entry must be shown to be reachable.
        //
        // The mirror image matters just as much: a real command that changes
        // the IMAGE must not be quieted. `y` (font symbol set) and `z` (zero
        // conversion) both do, so they report.
        for (const mustReport of ['y1', 'z']) {
            const lab = parseDPL(`\x02L\r${mustReport}\r141100001000100HI\rQ0001\rE\r`, PAGE);
            expect(lab.issues.map(i => i.code), `"${mustReport}" changes the image`).toContain('dpl-command');
        }
        // and the handled ones are handled rather than silenced
        for (const [cmd, code] of [['J2', null], ['R0010', null], ['U', 'dpl-replacement-field']] as const) {
            const lab = parseDPL(`\x02L\r${cmd}\r141100001000100HI\rQ0001\rE\r`, PAGE);
            if (code) expect(lab.issues.map(i => i.code)).toContain(code);
            expect(lab.issues.map(i => i.code), `"${cmd}" must not fall through to the silence list`)
                .not.toContain('dpl-command');
        }
    });

    it('handles metric mode inside the format, not just at system level', () => {
        // 'm' and 'n' appear in the Label Formatting chapter as well as the
        // system-level one, and every position is read in whichever unit is
        // current. A format that switches mid-stream really does move the
        // fields after it, so reading them as unknown commands would have left
        // every following position in the wrong unit.
        const inch = parseDPL('\x02L\r141100001000100HI\rQ0001\rE\r', PAGE).elements[0] as any;
        const metric = parseDPL('\x02L\rm\r141100001000100HI\rQ0001\rE\r', PAGE).elements[0] as any;
        // 100 hundredths of an inch is one inch; 100 tenths of a mm is 10 mm,
        // which is a different distance at any dpi.
        expect(metric.oy).not.toBe(inch.oy);
        expect(metric.oy).toBeGreaterThan(inch.oy);
    });

    it('does not silence a letter that is NOT a label command', () => {
        // 'd' and 'V' were in the silence list and are not Label Formatting
        // commands — the manual has 'D' (dot size) and 'V' is a system-level
        // software switch. Silencing them silenced nothing while every real
        // occurrence reported as unknown, which is the worse of the two.
        for (const notACommand of ['d1', 'V1']) {
            const lab = parseDPL(`\x02L\r${notACommand}\r141100001000100HI\rQ0001\rE\r`, PAGE);
            expect(lab.issues.map(i => i.code), `"${notACommand}"`).toContain('dpl-command');
        }
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

describe('DPL <STX>T time and date (manual Table 6-3, p. 126)', () => {
    // The manual's date: "The sample listings below assume a current printer
    // date of December 21, 1998." Every expectation here is that sample.
    const SAMPLE_DATE = () => new Date(1998, 11, 21, 13, 30, 45);
    const bake = (s: string) => substituteDplDateTime(s, SAMPLE_DATE());

    it('reproduces the manual\'s own samples character for character', () => {
        // Sample 1: "121100001000100<STX>TBCD GHI PQ, TU" -> "SUN DEC 21, 98".
        // Sample 2: "191100100100010<STX>TEF/PQ"          -> "12/21".
        // These are the strongest evidence the table can have: the manual states
        // the printed result, so a table that drifts fails against text that
        // was written before this code existed.
        // (Dec 21 1998 was a MONDAY; the manual's "SUN" is its own typo, and
        //  the weekday naming rule is pinned separately below.)
        expect(bake('BCD GHI PQ, TU')).toBe('MON DEC 21, 98');
        expect(bake('EF/PQ')).toBe('12/21');
        // The manual's own text confirms GHI is the month's first three
        // letters: "Sample 2 will print 12/21" with EF as the month number.
        expect(bake('BCD')).toBe('MON');
        expect(bake('GHI')).toBe('DEC');
        expect(bake('TU')).toBe('98');
        expect(bake('RSTU')).toBe('1998');
    });

    it('leaves every non-marker character exactly as written', () => {
        // "The string characters/markers are not printed" — but only the
        // markers. Sample 1's spaces and comma survive into the output, so the
        // string is a template, not a list of markers.
        expect(bake('PQ/PQ')).toBe('21/21');
        // A group can be entered part-way, and then it prints the part asked
        // for: Q is the day's SECOND character, so `QRST` is "1" from day 21
        // plus "199" from year 1998 — not the day and the year. Derived from
        // the group values rather than written out, because the concatenations
        // are easy to get wrong by hand and the point is the ADDRESSING.
        const day = bake('PQ');
        const year = bake('RSTU');
        expect(bake('Q')).toBe(day[1]);
        expect(bake('P')).toBe(day[0]);
        expect(bake('QRST')).toBe(day[1] + year.slice(0, 3));
        expect(bake('PQRSTU')).toBe(day + year);
        // Lowercase letters past h are not markers and pass through untouched,
        // as do digits and punctuation.
        expect(bake('lmn')).toBe('lmn');
        expect(bake('12-34')).toBe('12-34');
        expect(isDplDateMarker('G')).toBe(true);
        expect(isDplDateMarker('i')).toBe(false);

        // THE TRAP, and the reason a mixed string is dangerous: every UPPERCASE
        // letter is a marker, because Table 6-3 uses the whole alphabet A-Z.
        // So ordinary capitalised text inside an <STX>T string is NOT printed
        // as written — "DEC" comes out as the pieces of three different values.
        const D = bake('BCD')[2], E = bake('EF')[0], C = bake('BCD')[1];
        expect(bake('DEC')).toBe(D + E + C);
        expect(bake('DEC')).not.toBe('DEC');
    });

    it('addresses each value by the marker letter\'s position in its group', () => {
        // The reading that makes Table 6-3 legible: the letters of a group are
        // placeholders for the characters of its value, so G, H and I are the
        // first three of G..O because B, C and D are the first three of the
        // weekday name. Checked on a value with no padding to hide an error.
        expect(bake('Za')).toBe('30');   // minutes 30
        expect(bake('bc')).toBe('PM');   // 13:30
        expect(bake('gh')).toBe('45');   // seconds 45
        expect(bake('VW')).toBe('13');   // hour, 24-hour
        expect(bake('XY')).toBe('01');   // hour, 12-hour
        expect(bake('def')).toBe('355'); // Julian day of Dec 21 1998
    });

    it('keeps every group the same width as the value it prints', () => {
        // The invariant that a drifted table breaks first. If a letter is added
        // to a group or a value changes width, the substitution silently drops
        // or misplaces a character — so it is asserted rather than assumed.
        const groups: Array<[string, string]> = [
            ['A', bake('A')], ['BCD', bake('BCD')], ['EF', bake('EF')],
            ['GHIJKLMNO', bake('GHIJKLMNO')], ['PQ', bake('PQ')], ['RSTU', bake('RSTU')],
            ['VW', bake('VW')], ['XY', bake('XY')], ['Za', bake('Za')],
            ['bc', bake('bc')], ['def', bake('def')], ['gh', bake('gh')],
        ];
        // J..O print spaces because "DECEMBER" is shorter than its nine-letter
        // group — that is the padding showing, not a gap.
        for (const [letters, value] of groups) {
            expect(value.length, `group ${letters}`).toBe(letters.length);
        }
    });

    it('bakes the time into a record that shares its line with the string', () => {
        // The end-to-end shape, which is the one that used to vanish: this
        // parsed to 0 elements and 0 issues before the tokenizer was fixed.
        const lab = parseDPL('\x02L\r121100001000100<STX>TBCD GHI PQ, TU\rE\r', PAGE, SAMPLE_DATE());
        expect(lab.elements, 'the record must survive its own data field').toHaveLength(1);
        expect((lab.elements[0] as any).source.data).toBe('MON DEC 21, 98');
    });

    it('treats text outside the string as data, per sample 3', () => {
        // "The <STX>T may be preceded by data to be printed/encoded, and/or the
        // string may now be terminated by an <STX> command and then followed by
        // more data" (p. 126). Sample 3 prints "ABC 12/21 DEF": only EF/PQ is a
        // marker string — ABC and " DEF" are literal. Reading the trailing text
        // as markers too is how an earlier attempt produced "U10" for " DEF".
        const lab = parseDPL('\x02L\r191100100100010ABC <STX>TEF/PQ<STX> DEF\rE\r', PAGE, SAMPLE_DATE());
        expect((lab.elements[0] as any).source.data).toBe('ABC 12/21 DEF');
    });
});

describe('DPL global registers and <STX>S (manual p. 114 and p. 126)', () => {
    it('copies a stored field into a later record', () => {
        // The manual's own sample: store "Testing" with G, then recall it with
        // <STX>SA. "One label is printed with 'Testing' in two locations."
        const lab = parseDPL('\x02L\r121100000000000Testing\rG\r1A2210001000000<STX>SA\rE\r', PAGE);
        expect(lab.elements, 'both records draw').toHaveLength(2);
        expect((lab.elements[0] as any).source.data).toBe('Testing');
        expect((lab.elements[1] as any).source.data).toBe('Testing');
        expect(lab.issues.map(i => i.code)).toContain('dpl-global-recall');
    });

    it('draws nothing when the register it recalls was never filled', () => {
        // A register that no G ever wrote prints an empty field on the printer.
        // Drawing the format's own placeholder text instead would put a string
        // on the label that the printer will not print.
        const lab = parseDPL('\x02L\r1A2210001000000<STX>SB\rE\r', PAGE);
        expect(lab.elements, 'an unfilled register prints nothing').toHaveLength(0);
        expect(lab.issues.map(i => i.code)).toContain('dpl-global-recall');
    });

    it('reads a bare S as the feed-speed command, not as a recall', () => {
        // The manual warns about this collision in as many words: "Do not
        // confuse them with System-Level Commands because the same control
        // character is used" (p. 125). A bare `S` line is Set Feed Speed.
        const lab = parseDPL('\x02L\rS1\r141100001000100HI\rQ0001\rE\r', PAGE);
        expect(lab.elements, 'a bare S does not eat the record').toHaveLength(1);
        expect(lab.issues.map(i => i.code)).not.toContain('dpl-global-recall');
    });

    it('finds the record a recall fills even with a command between them', () => {
        // The record is the nearest one BEFORE the sigil, not necessarily the
        // token immediately before it. `J`, `R` and `C` are toggles commonly
        // written on a line of their own, and requiring strict adjacency made
        // the pairing fail — the recall then fell through to the system-level
        // Set Feed Speed reading, and the record drew its placeholder with no
        // recall issue and no warning at all.
        const lab = parseDPL(
            '\x02L\r121100000000000Testing\rG\r1A2210001000000\rJC\r\x02SA\rE\r', PAGE);
        expect(lab.issues.map(i => i.code), 'the recall must still be recognised').toContain('dpl-global-recall');
        const drawn = lab.elements.filter(e => (e as any).source?.data === 'Testing');
        expect(drawn, 'both fields print the stored value').toHaveLength(2);
    });
});

describe('DPL data that follows a closed time string (manual p. 126)', () => {
    it('keeps text beginning with a command letter as DATA, not as a command', () => {
        // "the string may now be terminated by an <STX> command and then
        // followed by more data terminated by a <CR>" (p. 126) — so after the
        // closing sigil there is no string left to open and what follows is
        // printed. Testing the segment's first CHARACTER instead of the state
        // sent anything beginning with a letter down the command path, and a
        // barcode is where that bites hardest: its data has no spaces, so
        // `<STX>TBCD<STX>SUFFIX` is how a date plus a literal is written.
        // Measured before the fix: barcode "THU" with an `S:"UFFIX"` command
        // and NO issue, the literal silently gone. `<STX>TCD<STX>MORE` was
        // worse — `M` is Mirror Mode, silently flipping the label.
        const seed = new Date(2026, 9, 1, 14, 30, 45);
        for (const [src, want] of [
            ['1E2210001000000\x02TBCD\x02SUFFIX', 'THUSUFFIX'],
            ['1E2210001000000\x02TBCD\x02 SUFFIX', 'THU SUFFIX'],
            // CD is the day name's 2nd and 3rd letters — THURSDAY on this
            // date — so the substitution is "HU", not "THU".
            ['121100001000100\x02TCD\x02MORE', 'HUMORE'],
        ] as const) {
            const lab = parseDPL(`\x02L\r${src}\rE\r`, PAGE, seed);
            expect((lab.elements[0] as any).source.data, src).toBe(want);
            expect(lab.issues.map(i => i.code), `${src} must not touch mirror mode`).not.toContain('dpl-mirror');
        }
    });
});

describe('DPL system-level commands are named too', () => {
    it('reports a system-level command it does not model', () => {
        // The `<STX>x` branch used to `continue` for every unrecognised letter
        // and never reach the reporting the label commands do, so DPL's whole
        // system-level surface — immediate commands, extended setup, print
        // quality and memory tests — disappeared without a word. A mistyped
        // attention-getter command reported NOTHING.
        for (const src of ['\x02L\r\x02Zabc\r141100001000100HI\rE\r',
                           '\x02L\r141100001000100ABC\x02Zxyz\rE\r']) {
            const lab = parseDPL(src, PAGE);
            expect(lab.issues.map(i => i.code), src).toContain('dpl-system-command');
        }
        // and the ones the preview DOES act on stay quiet
        const quiet = parseDPL('\x02L\rm\x02L\r141100001000100HI\rE\r', PAGE);
        expect(quiet.issues.map(i => i.code).filter(c => c === 'dpl-system-command')).toHaveLength(0);
    });
});

describe('DPL advanced format attributes (manual Table 8-16, p. 144)', () => {
    // Figure 2's stream, taken from the per-line dump of the manual page rather
    // than from a text extraction, which MERGES lines and would have hidden the
    // distinction this whole block is about. Six attribute groups around five
    // records, every one printing "New DPL World".
    const FIG2 = '\x02L\r'
        + 'D11FA+FB+\r'
        + '1911S0102600040P018P018New DPL World\r'
        + 'FU+I+1911S0102000040P018P018New DPL World\r'
        + 'FI-U+B-\r'
        + '1911S0101400040P018P018New DPL WorldFU-B+\r'
        + '1911S0100800040P018P018New DPL World\r'
        + 'FB+I+U+1911S0100200040P018P018New DPL World\r'
        + 'FB-U-I-\r'
        + 'E\r';

    it('draws every record in Figure 2 and none of the attribute text', () => {
        // Before this, a line beginning with F was read as the command alone, so
        // the record sharing its line vanished; and an attribute hanging off the
        // END of a record was read as part of the printed string.
        const lab = parseDPL(FIG2, PAGE);
        expect(lab.elements, 'five records, one per visible line').toHaveLength(5);
        for (const el of lab.elements) {
            expect((el as any).source.data, 'the attributes are not part of the label').toBe('New DPL World');
        }
    });

    it('names the attributes instead of drawing them', () => {
        // The IR's text element has no bold/italic/underline and the manual
        // limits these to scalable fonts, so they are reported, not applied —
        // the same choice Mirror Mode makes.
        const codes = parseDPL(FIG2, PAGE).issues.map(i => i.code);
        expect(codes).toContain('dpl-advanced-attributes');
    });

    it('reports an attribute that Table 8-16 does not define', () => {
        // `FA+` is written in the manual's own Figure 2 and appears in NO
        // manual's Table 8-16 — checked in all three. It is named rather than
        // accepted, because an attribute this parser guessed at would look like
        // it had done something.
        const lab = parseDPL('\x02L\rD11FA+FB+\r141100001000100HI\rE\r', PAGE);
        expect(lab.issues.map(i => i.code)).toContain('dpl-attribute-unknown');
        expect(lab.issues.find(i => i.code === 'dpl-attribute-unknown')?.message).toContain('FA+');
    });

    it('accepts the F-less spelling the manual also writes', () => {
        // Table 8-16 lists only the F-prefixed forms, but the examples use
        // `FU+I+`, `FB+I+U+` and `FB-U-I-` — one F establishing the prefix for
        // the pairs that follow it. Both spellings must be consumed, because
        // left in they become part of the record's text.
        for (const attrs of ['FB+I+U+', 'FB-U-I-', 'FI-U+B-']) {
            const lab = parseDPL(`\x02L\r${attrs}\r121100001000100HI\rE\r`, PAGE);
            expect((lab.elements[0] as any).source.data, `${attrs} must be consumed`).toBe('HI');
        }
    });
});

describe('DPL graphics: polygons and circles (Tables 8-13/8-14, p. 140-141)', () => {
    // Every example in the manual is annotated "spaces have been added for
    // readability", so each case is pinned in BOTH spellings — a parser that
    // only worked on the spaced form would shift every fixed offset the moment
    // a real stream arrived.
    const both = (record: string) => [
        `\x02L\r${record}\rE\r`,
        `\x02L\r${record.replace(/ /g, '')}\rE\r`,
    ];

    it('draws the manual\'s triangle, in both spellings', () => {
        // "1 X 11 000 0010 0010 P 001 0001 0040 0025 0010 0040" produces a
        // triangle whose figure has its apex at row 0040 and its base at
        // row 0010 — and rows count UP from the label's bottom, so the apex is
        // the SMALLER y in the IR's top-down space.
        for (const src of both('1X1100000100010P0010001 0040 0025 0010 0040')) {
            const lab = parseDPL(src, PAGE);
            const poly = lab.elements.find(e => e.kind === 'polygon') as any;
            expect(poly, src).toBeDefined();
            expect(poly.points, 'three corners').toHaveLength(3);
            const ys = poly.points.map((p: any) => p.y);
            expect(Math.max(...ys) - Math.min(...ys), 'the apex must sit above the base').toBeGreaterThan(40);
            // the apex is the single point, the base the other two
            const apex = poly.points.find((p: any) => p.y === Math.min(...ys));
            const base = poly.points.filter((p: any) => p !== apex);
            expect(base[0].y, 'both base corners share a row').toBe(base[1].y);
        }
    });

    it('draws the manual\'s circle at its centre with its radius', () => {
        // "1 X 11 000 0100 0100 C 001 0001 0025" is "a circle centered at row
        // 0100, column 0100 with a radius of 0025". Read against Table 8-14 the
        // header is eee = fill, f = centre ROW, g = centre COLUMN, and the
        // radius is the data field's last group.
        for (const src of both('1X1100001000100C0010001 0025')) {
            const lab = parseDPL(src, PAGE);
            const el = lab.elements.find(e => e.kind === 'ellipse') as any;
            expect(el, src).toBeDefined();
            // 0025 hundredths of an inch at 203 dpi is ~50.8 dots of radius.
            expect(el.widthDots).toBe(el.heightDots);
            expect(el.widthDots).toBeGreaterThan(95);
            expect(el.widthDots).toBeLessThan(106);
            // and it sits around its centre: the box straddles it
            expect(el.ox + el.widthDots / 2).toBeGreaterThan(el.ox);
        }
    });

    it('reports the fill pattern it does not draw', () => {
        // Table 8-15's patterns are tones, hachures and shadings; the IR has no
        // fill model, so the outline is drawn and the difference is NAMED
        // rather than silently flattened to a solid or an empty shape.
        const lab = parseDPL('\x02L\r1X1100901000100C0010001 0025\rE\r', PAGE);
        expect(lab.issues.map(i => i.code)).toContain('dpl-fill-pattern');
        // pattern 0 is "No Pattern", and drawing nothing extra is correct there
        const plain = parseDPL('\x02L\r1X1100001000100C0010001 0025\rE\r', PAGE);
        expect(plain.issues.map(i => i.code)).not.toContain('dpl-fill-pattern');
    });

    it('measures a polygon by its span, not by how far it hangs one way', () => {
        // A polygon's points are absolute and may lie on ANY side of the
        // record's own row. Measuring the extent only "downwards" from the
        // origin — in printer rows, which count UP — gave a negative height for
        // a shape hanging below its row, and the element was then clipped
        // completely: measured ink 0 for a record that draws perfectly well.
        // The span is used instead, and it is the same measure before and after
        // the row flip.
        const lab = parseDPL('\x02L\r1X1100000700070P0010001 0010 0025 0070 0040\rE\r', PAGE);
        const poly = lab.elements.find(e => e.kind === 'polygon') as any;
        expect(poly, 'the record draws').toBeDefined();
        const size = estimateElementSize(poly, 203);
        expect(size.crossDots, 'the height must cover points on both sides').toBeGreaterThan(100);
        expect(size.lengthDots).toBeGreaterThan(80);
    });

    it('draws two points as a line and refuses one', () => {
        // "If only two points are specified, a single line will be drawn."
        const lab = parseDPL('\x02L\r1X1100000100010P0010001 0040 0040\rE\r', PAGE);
        const poly = lab.elements.find(e => e.kind === 'polygon') as any;
        expect(poly.points, 'a line is a two-point polygon').toHaveLength(2);
        // and a record that lists no usable point says so
        const one = parseDPL('\x02L\r1X1100000100010P0010001\rE\r', PAGE);
        expect(one.elements.find(e => e.kind === 'polygon')).toBeUndefined();
        expect(one.issues.map(i => i.code)).toContain('dpl-polygon-points');
    });
});

describe('DPL bar code fields (Table 8-3 and Appendix G)', () => {
    // header: a b c d eee ffff gggg — '1A' '3' '1' '000' '0015' '0100'
    const at = (rec: string) => parseDPL(`\x02L\r${rec}\rE\r`, PAGE)
        .elements.find(e => e.kind === 'barcode') as any;

    it('reads c and d as wide:narrow WIDTHS in dots', () => {
        // "For ratio-based bar codes field c is the wide bar width in dots (the
        // numerator); field d is the narrow bar width in dots (the
        // denominator)". The ratio is the quotient — the parser used to compare
        // c against a dot count, so EVERY symbol fell through to the same
        // default and every bar code drew at one width.
        expect(at('1A31000001501000123456789').ratio, 'c=3 d=1 is 3:1').toBe(1);
        expect(at('1A21000001501000123456789').ratio, 'c=2 d=1 is 2:1').toBe(2);
        expect(at('1A42000001501000123456789').ratio, 'c=4 d=2 is still 2:1').toBe(2);
        // and d is carried through as the module in dots
        expect(at('1A42000001501000123456789').moduleDots).toBe(2);
        expect(at('1A31000001501000123456789').moduleDots).toBe(1);
    });

    it('treats height field 000 as the documented default, not zero dots', () => {
        // "all bar codes depicted here were produced using the ratio/module
        // values of 00 and height fields of 000 to cause the printer to produce
        // symbols using DEFAULT bar widths and height fields" (p. 181) — and
        // every example in Appendix G is written that way, so zero is the
        // common case. Read as zero dots it drew a one-dot line.
        const dflt = at('1A11000001501000123456789').heightDots;
        expect(dflt, 'a 000 field must not be one dot').toBeGreaterThan(50);
        // 0.40 in at 203 dpi is 81 dots, and it must match the explicit form
        expect(dflt).toBe(at('1A11040001501000123456789').heightDots);
    });

    it('takes the Code 128 subset letter as a mode, not as data', () => {
        // "The default code subset is B; otherwise, the first character (A, B,
        // C) of the data field determines the subset." The letter selects the
        // subset and is not part of the encoded value, so leaving it in printed
        // a stray character before the symbol.
        //
        // The record is BUILT rather than written out, because the header is
        // positional: a, b, c, d, eee, ffff, gggg is 1+1+1+1+3+4+4 = 15
        // characters, and a hand-written one that is a digit short silently
        // shifts every field — which is exactly what happened twice while
        // writing this test, the payload arriving as "00C123456".
        // 1E | 1 | 1 | 000 | 0010 | 0100  ->  row 0010, column 0100
        const rec = (data: string) => `\x02L\r1E1100000100100${data}\rE\r`;
        expect(at(rec('C123456')).source.data).toBe('123456');
        expect(at(rec('A123456')).source.data).toBe('123456');
        // a payload that merely BEGINS with one of those letters as text is
        // indistinguishable by design — the manual's rule makes it a subset
        expect(at(rec('B123456')).source.data).toBe('123456');
        // and a letter that is not a subset is left alone
        expect(at(rec('D12345')).source.data).toBe('D12345');
        expect(at(rec('123456')).source.data).toBe('123456');
    });
});

describe('DPL images (<STX>I p.20 and Table 8-11)', () => {
    // Appendix O's 7-bit ASCII image format: each row is `80nndd…d`, nn being
    // the number of character pairs in ASCII hex, and `FFFF` terminates the
    // download. The rows below are the manual's own, and the structure was
    // checked against them — nn = 0x30 = 48 pairs, and 48 bytes is 384 dots.
    const IMG_ROWS = [
        '8030FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0000',
        '8030FFC00000007FFC0003FFFFC001FC0001FC0003FFFFC0018000FFC001FF8000C0003FFFFE000000FFFFE0001FFFFF0000',
        '8030FFC00000000FFC0003FFFFC001FC0001FC0003FFFFC0018000FFC001FF800040001FFFFE0000007FFFC0001FFFFF0000',
    ];
    // a = module, b omitted, f = p (.IMG as received), then the name.
    const load = (name: string) => `\x01D\r\x02I1p${name}\r` + IMG_ROWS.join('\r') + '\rFFFF\r';
    const print = (name: string, mult = '11') => `\x02L\r1Y${mult}00000150100${name}\rE\r`;

    it('draws the bitmap the stream loaded', () => {
        const lab = parseDPL(load('LOGO') + print('LOGO'), PAGE);
        const g = lab.elements.find(e => e.kind === 'graphic') as any;
        expect(g, 'the record must draw the image it names').toBeDefined();
        expect(g.name).toBe('LOGO');
        expect(g.widthDots, '48 bytes per row is 384 dots').toBe(384);
        expect(g.heightDots, 'three dot rows').toBe(3);
        expect(g.rows).toHaveLength(3);
        expect(lab.issues.map(i => i.code)).toContain('dpl-image-loaded');
    });

    it('never prints the image DATA as text', () => {
        // The failure this replaces: a dot row begins with a digit, so it was
        // read as a label record and every row came out as a text field
        // printing the hex of the bitmap. The label showed the image's DATA
        // instead of the image — the worst shape of the silent-drop class.
        const lab = parseDPL(load('LOGO') + print('LOGO'), PAGE);
        const texts = lab.elements.filter(e => e.kind === 'text') as any[];
        expect(texts, 'not one hex row may become text').toHaveLength(0);
        for (const el of lab.elements as any[]) {
            expect(String(el.source?.data ?? ''), 'no element may carry hex data').not.toMatch(/^[0-9A-F]{20,}$/);
        }
    });

    it('honours the width and height multipliers', () => {
        // Table 8-11: c is the width multiplier, d the height multiplier, and
        // they scale the stored bitmap — so 2x1 doubles the width and leaves
        // the row count alone.
        const lab = parseDPL(load('LOGO') + print('LOGO', '21'), PAGE);
        const g = lab.elements.find(e => e.kind === 'graphic') as any;
        expect(g.widthDots).toBe(768);
        expect(g.heightDots).toBe(3);
    });

    it('draws orphan dot rows as nothing rather than as text', () => {
        // The rows normally follow an <STX>I that consumes them. With no such
        // command they belong to no image, and the count field is what tells a
        // real dot row from an ordinary record that happens to begin with 8.
        const lab = parseDPL(`\x02L\r${IMG_ROWS.join('\r')}\rFFFF\r\x02L\r141100001000100HI\rE\r`, PAGE);
        expect(lab.elements.filter(e => e.kind === 'text')).toHaveLength(1);
        expect((lab.elements.find(e => e.kind === 'text') as any).source.data).toBe('HI');
        expect(lab.issues.map(i => i.code)).toContain('dpl-image-row-orphan');
    });

    it('says when the image is not in the stream', () => {
        // An image lives in a printer memory module, so a label can print one
        // this stream never carried. That is named rather than drawn as an
        // empty space.
        const lab = parseDPL(print('MISSING'), PAGE);
        expect(lab.elements.find(e => e.kind === 'graphic')).toBeUndefined();
        expect(lab.issues.map(i => i.code)).toContain('dpl-image-missing');
    });
});

describe('DPL EAN/UPC variants and the price checksum (Appendix F/G/P)', () => {
    // The header is positional — a b c d eee ffff gggg is 1+1+1+1+3+4+4 = 15
    // characters — so records are BUILT from parts here. A hand-written one a
    // digit short shifts every field, which produced three false alarms while
    // this sweep was written.
    const bcidFor = (b: string, data: string) => {
        const record = `1${b}1100000` + '0020' + '0020' + data;
        const lab = parseDPL(`\x02L\r${record}\rE\r`, PAGE);
        const bc = lab.elements.find(e => e.kind === 'barcode') as any;
        return {
            bc,
            bcid: bc
                ? buildBwipSpec(bc.symbology, bc.source.data, { eanUpcVersion: bc.eanUpcVersion })?.main.bcid
                : null,
        };
    };

    it('draws each letter as its own symbol, not as whatever the digit count implies', () => {
        // B, C, F and G all carry the IR's symbology '7', and the letter is what
        // says which member of the family it is. Without that the encoder
        // guesses from the digit count, which resolved a 7-digit UPC-E to a
        // UPC-A, an 8-digit EAN-8 to a UPC-E, and the manual's own 11-digit
        // UPC-A — "If the user provides 11 digits, the printer will compute the
        // checksum" — to nothing at all.
        expect(bcidFor('B', '123456789012').bcid, 'UPC-A').toBe('upca');
        expect(bcidFor('B', '12345678901').bcid, 'UPC-A with the check to be computed').toBe('upca');
        expect(bcidFor('C', '1234567').bcid, 'UPC-E').toBe('upce');
        expect(bcidFor('C', '123456').bcid, 'UPC-E short form').toBe('upce');
        expect(bcidFor('F', '1234567890123').bcid, 'EAN-13').toBe('ean13');
        expect(bcidFor('G', '12345678').bcid, 'EAN-8').toBe('ean8');
        expect(bcidFor('G', '1234567').bcid, 'EAN-8 short form').toBe('ean8');
    });

    it('carries the variant on the element, not just in the encoded symbol', () => {
        // The renderer and the geometry pass both read `eanUpcVersion`, so a
        // missing one shows up as a symbol of the wrong width as well as the
        // wrong kind.
        expect(bcidFor('B', '123456789012').bc.eanUpcVersion).toBe(3);
        expect(bcidFor('C', '1234567').bc.eanUpcVersion).toBe(4);
        expect(bcidFor('F', '1234567890123').bc.eanUpcVersion).toBe(2);
        expect(bcidFor('G', '12345678').bc.eanUpcVersion).toBe(1);
    });

    it('names the V price checksum instead of encoding a broken symbol', () => {
        // "For the printer to generate this checksum, a `V' must be placed in
        // the data stream in the position the checksum is requested ... a
        // checksum will be generated using the next five digits" (Appendix P,
        // p. 255). The V is a REQUEST for a digit the printer computes, so the
        // payload cannot encode as it stands — and the checksum "generated per
        // the EAN/UPC bar code standard" has no DPL stream here to be checked
        // against, so it is named rather than guessed at.
        const lab = parseDPL('\x02L\r1B1100000' + '0020' + '0020' + '12345V01199\rE\r', PAGE);
        expect(lab.issues.map(i => i.code)).toContain('dpl-price-checksum');
        expect(lab.issues.find(i => i.code === 'dpl-price-checksum')?.message).toContain('Appendix P');
    });

    it('reports no price checksum when the data has no V', () => {
        const lab = parseDPL('\x02L\r1B1100000' + '0020' + '0020' + '123456789012\rE\r', PAGE);
        expect(lab.issues.map(i => i.code)).not.toContain('dpl-price-checksum');
    });
});

describe('DPL Appendix B: the manual\'s own programs, end to end', () => {
    // There is no oracle for DPL — Labelary refuses it as input — so these
    // worked examples are the closest thing available to a reference, and they
    // are read as a corpus rather than one at a time.

    it('Figure B-1 parses the same whether written in caret notation or bytes', () => {
        // The manual gives this one label twice. The ASCII file form uses the
        // CARET notation it defines on p. 7 — "the attention-getters ... (i.e.,
        // ^A or Ctrl A)" — and the C program sends the byte. Both must produce
        // the same two fields; before the caret was expanded, `^BL` was read as
        // a label command named "^" and the format never opened.
        const ascii = '^BL\rH07\rD11\r19110080100002510K OHM 1/4 WATT\r1a6210000000050590PCS\rE\r';
        const bytes = '\x02L\rH07\rD11\r19110801000002510K OHM 1/4 WATT\r1a6210000000050 590PCS\rE\r';
        const shape = (src: string) =>
            parseDPL(src, PAGE).elements.map(e => `${e.kind}:${(e as any).source?.data}`);
        expect(shape(ascii)).toHaveLength(2);
        expect(shape(ascii)).toEqual(shape(bytes));
        expect(shape(ascii)[0]).toContain('10K OHM 1/4 WATT');
        expect(shape(ascii)[1]).toContain('590PCS');
    });

    it('sends no noise for either spelling', () => {
        for (const src of ['^BL\rH07\rD11\r191100801000025X\r1a6210000000050Y\rE\r',
                           '\x02L\rH07\rD11\r191108010000025X\r1a6210000000050 Y\rE\r']) {
            const codes = parseDPL(src, PAGE).issues.map(i => i.code);
            expect(codes, src).not.toContain('dpl-command');
            expect(codes, src).not.toContain('dpl-record');
            expect(codes, src).not.toContain('dpl-system-command');
        }
    });

    it('reads the VB application, which is built entirely from the ~ prefix', () => {
        // "CharSet = Chr$(126) `Alternate <stx> character ~" — and the program
        // never sends <STX>CC1, because that printer was put into alternate
        // mode by its menu. So the `~` form has to be honoured on its own,
        // which is why the switch is detected by shape and not by the command.
        const V = '~';
        const label = (s: string) => [
            `${s}L`, 'D11', '1Y3300004750010SLANT1', '19110070415001012345',
            '1a620500420012012345', '191100603600010ACME CORP', '191100303400010Item #',
            '191100303400250Quantity', '1X1100003050240B065035002002', 'E',
        ].join('\r') + '\r';
        const alt = parseDPL(`${V}CC1\r${label(V)}`, PAGE);
        const std = parseDPL(label('\x02'), PAGE);
        const shape = (lab: typeof alt) =>
            lab.elements.map(e => `${e.kind}:${(e as any).source?.data ?? ''}`);
        expect(shape(alt), 'the alternate form draws the whole label').toHaveLength(7);
        expect(shape(alt), 'and draws it exactly as the standard form does').toEqual(shape(std));
        expect(shape(alt)).toContain('text:ACME CORP');
        expect(shape(alt)).toContain('barcode:12345');
        expect(shape(alt)).toContain('box:');
        // The one thing it prints is the image it never loads, which is named.
        expect(alt.issues.map(i => i.code)).toContain('dpl-image-missing');
        expect(alt.issues.map(i => i.code), 'the CC1 switch is not an unknown command')
            .not.toContain('dpl-command');
    });

    it('leaves a caret that is not notation alone', () => {
        // `^` before an uppercase letter at or after `@` IS the notation — `^B`
        // is the byte 0x02, and a stream writing `A^B` is sending an
        // attention-getter, not a caret. What must survive is a caret that
        // denotes nothing, and the label really prints one.
        expect((parseDPL('\x02L\r141100001000100cost^5\rE\r', PAGE).elements[0] as any).source.data)
            .toBe('cost^5');
        expect((parseDPL('\x02L\r14110000100010060% ^\rE\r', PAGE).elements[0] as any).source.data)
            .toBe('60% ^');
        // and the notation really does expand, in data as well as at the start
        expect((parseDPL('\x02L\r141100001000100A^B\rE\r', PAGE).elements[0] as any).source.data)
            .toBe('A');
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
