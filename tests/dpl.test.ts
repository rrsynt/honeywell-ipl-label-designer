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
