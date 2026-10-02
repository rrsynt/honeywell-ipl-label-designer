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
        // A fixed printer clock: the <STX>T formatter bakes the CURRENT date, so a
        // test that leaves `now` at the system default passes only on the day
        // it was written and breaks at the next rollover. Pinned here so the
        // expected string below is stable.
        const cmds = tokenizeDpl('\x02L\r121100001000100<STX>TBCD GHI PQ, TU\rE\r', new Date(2026, 9, 1, 12, 0, 0));
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
        // `y` reports with its own code because the generic one is WRONG for it:
        // a symbol set remaps what every byte prints, which is not "no effect".
        const y = parseDPL('\x02L\rySWD\r141100001000100HI\rQ0001\rE\r', PAGE);
        expect(y.issues.map(i => i.code)).toContain('dpl-symbol-set');
        expect(y.issues.map(i => i.code), 'and not the misleading generic one').not.toContain('dpl-command');
        expect(y.issues[0].message).toContain('Wingdings');
        // `z` really has no reported meaning here, so it keeps the generic code
        const z = parseDPL('\x02L\rz\r141100001000100HI\rQ0001\rE\r', PAGE);
        expect(z.issues.map(i => i.code)).toContain('dpl-command');
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

    it('reads the header a b f name, with b optional and the bank free', () => {
        // Syntax is <STX>I a b f nn...n (p. 20): a = bank, b = data type
        // ('A' or omitted), f = format designator (F/B/b/I/i/P/p), then the
        // name. The old reader stripped a leading 'A' from the whole spec — the
        // BANK — and then took the format one slot early, so only a stream
        // whose bank was not 'A' and whose type was omitted (the manual's own
        // `<STX>IDpTest`) came out right. These four forms pin the parse: the
        // loaded name is read back from the info issue, which names it.
        const nameOf = (head: string) => {
            const lab = parseDPL(`\x01D\r\x02${head}\r` + IMG_ROWS.join('\r') + '\rFFFF\r', PAGE);
            const info = lab.issues.find(i => i.code === 'dpl-image-loaded');
            return /image "([^"]*)"/.exec(info?.message ?? '')?.[1];
        };
        // bank D, type omitted, format F.
        expect(nameOf('IDFTest')).toBe('Test');
        // bank D, type A, format F — the optional slot must not shift the name.
        expect(nameOf('IDAFTest')).toBe('Test');
        // bank A (a legal bank), type omitted, format F.
        expect(nameOf('IAFTest')).toBe('Test');
        // the manual's own sample: bank D, format p, name Test.
        expect(nameOf('IDpTest')).toBe('Test');
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

describe('DPL ILPC font options (Appendix Q, p. 257)', () => {
    // Layout: a b c d (4) + eee (3) + ffff (4) + gggg (4) + hhhh (4) + iiii (4)
    // = 23 characters before the data. Built rather than written out, because a
    // hand-counted header that is a character short shifts every field and
    // looks exactly like a parser bug.
    const smoothRec = (eee: string, h: string, i: string, data: string) =>
        `1911${eee}0020` + '0200' + h + i + data;
    const issuesOf = (eee: string, data: string, h = 'P036', i = 'P020') =>
        parseDPL(`\x02L\r${smoothRec(eee, h, i, data)}\rE\r`, PAGE).issues.map(x => x.code);
    const dataOf = (eee: string, data: string, h = 'P036', i = 'P020') =>
        (parseDPL(`\x02L\r${smoothRec(eee, h, i, data)}\rE\r`, PAGE).elements[0] as any).source.data;

    it('names the CG Times option instead of calling it CG Triumvirate', () => {
        // "Scalable CG TIMES Font Code (`eee' field): SA0 -CG TIMES, SA1 - CG
        // TIMES ITALIC, SA2 - CG TIMES BOLD, SA3 - CG TIMES BOLD ITALIC". All
        // four were reported as the resident CG Triumvirate, which names the
        // wrong face for a field that is explicitly an option.
        for (const code of ['SA0', 'SA1', 'SA2', 'SA3']) {
            const codes = issuesOf(code, 'Greek text');
            expect(codes, code).toContain('dpl-ilpc-font');
            expect(codes, code).not.toContain('dpl-smooth-font');
        }
        // and the plain scalable font is still reported as itself
        const plain = issuesOf('S00', 'Normal text');
        expect(plain).toContain('dpl-smooth-font');
        expect(plain).not.toContain('dpl-ilpc-font');
    });

    it('recognises the double-byte options by their code', () => {
        for (const code of ['U40', 'UK1', 'UC0']) {
            expect(issuesOf(code, 'x'), code).toContain('dpl-ilpc-font');
        }
    });

    it('reads the letter case as the addressing, per the Appendix Q tables', () => {
        // Each double-byte table lists its code twice — "UC0" against Binary
        // Addressing and "uc0" against Hex ASCII Addressing — and both select
        // the same font. So the case carries the addressing on its own, which
        // is why it is read from the code rather than from a name table.
        const bin = issuesOf('U40', 'x');
        expect(bin).toContain('dpl-ilpc-font');
        expect(bin).not.toContain('dpl-ilpc-hex-addressing');

        const hex = issuesOf('uK1', '4D3F2121');
        expect(hex).toContain('dpl-ilpc-hex-addressing');
        expect(hex, 'a code table this build does not know still carries it').not.toContain('dpl-ilpc-font');

        // and the payload of a hex-addressed record is the hex as written,
        // since each pair is one double-byte character
        expect(dataOf('uK1', '4D3F2121')).toBe('4D3F2121');
    });

    it('explains the "<xx>" notation rather than decoding it', () => {
        // The manual's samples are written `1911U4002650150P012P012<4D><3F>`
        // and explained in a note: "The notation '<xx>' in this DPL file should
        // be interpreted by the READER as representing the hexadecimal value of
        // the byte sent to the printer." It is addressed to a person converting
        // the sample, not to the printer — so it is NOT decoded here, and the
        // reader is told why their glyphs came out as hex instead.
        const codes = issuesOf('U40', '<4D><3F><00><00>');
        expect(codes).toContain('dpl-hex-notation');
        expect(dataOf('U40', '<4D><3F><00><00>'), 'the notation is not silently converted').toBe('<4D><3F><00><00>');
        // raw bytes, which IS what the printer receives, take the normal path
        expect(issuesOf('U40', '\x4d\x3f\x00\x00')).not.toContain('dpl-hex-notation');
    });

    it('reads the manual\'s own ILPC sample lines intact', () => {
        // Appendix Q's CG Times sample, verbatim. Its first data field begins
        // with a parenthesised code — part of the DATA, not a parameter.
        const el = parseDPL('\x02L\r1911SA003600020P020P020(WG) Greek Characters from\rE\r', PAGE)
            .elements[0] as any;
        expect(el.source.data).toBe('(WG) Greek Characters from');
    });

    it('takes a scalable font\'s size from the field that carries it', () => {
        // THE SIZE IS NOT IN `eee` for the coded forms. Table 8-5 gives that
        // field two jobs — "Font height; Font selection" over the range
        // `000-999, A04-A72, S00-S9z` — and the `S` forms select a FONT (SA0 is
        // CG Times, S00 a CG Triumvirate size, UK1 a Kanji Gothic). The size
        // lives in the OPTIONAL SCALABLE FONT HEIGHT field `hhhh`, which the
        // same chapter says "must be specified for scalable fonts" and which
        // this parser was discarding unread: every scalable record was drawn at
        // the same 12pt whatever it asked for.
        expect((parseDPL(`\x02L\r${smoothRec('SA0', 'P036', 'P020', 'Greek')}\rE\r`, PAGE).elements[0] as any).pointSize)
            .toBe(36);
        expect((parseDPL(`\x02L\r${smoothRec('SA0', 'P072', 'P020', 'Greek')}\rE\r`, PAGE).elements[0] as any).pointSize)
            .toBe(72);
        // "To specify the size in dots, all four characters must be numeric" —
        // 200 dots at 203 dpi is about 71 points, not 200.
        const dots = (parseDPL(`\x02L\r${smoothRec('SA0', '0200', '0200', 'Greek')}\rE\r`, PAGE).elements[0] as any).pointSize;
        expect(dots, 'dots are converted, not read as points').toBeGreaterThan(60);
        expect(dots).toBeLessThan(80);
        // and the A-form states points in `eee` itself
        expect((parseDPL(`\x02L\r${smoothRec('A36', 'P036', 'P020', 'Text')}\rE\r`, PAGE).elements[0] as any).pointSize)
            .toBe(36);
    });

    it('consumes the size fields only for the form that HAS them', () => {
        // The manual gives the two font-9 forms as SEPARATE record structures,
        // and only one of them carries the optional fields:
        //
        //   Table 8-7, Smooth Font:    eee `000-999, A04 to A72, x04 - x72`,
        //                              no hhhh/iiii — the size IS `eee`.
        //   Table 8-8, Scalable Font:  eee `S00 to Szz, U00-Uzz, u00-uzz`,
        //                              with hhhh/iiii as "Character height/
        //                              width; points, dots".
        //
        // So an earlier version that consumed them on EVERY font-9 record ate
        // the first eight characters of an `A36` record's data — and, worse,
        // did so only when that data happened to LOOK like a size pair, so the
        // same record parsed differently depending on its text.
        expect(dataOf('S00', 'Text'), 'the scalable form has them').toBe('Text');
        expect(dataOf('U40', '\x4d\x3f')).toBe('M?');
        // a smooth-font record whose data merely looks like a size pair keeps it
        const a36 = parseDPL('\x02L\r1911A360020' + '0200' + '2024 Report\rE\r', PAGE).elements[0] as any;
        expect(a36.source.data, 'the smooth form has no such field').toBe('2024 Report');
        expect(a36.pointSize, 'its size comes from eee').toBe(36);
    });

    it('reads the bit-mapped font-9 codes as the INDICES they are', () => {
        // Table H-1: "Font 9 Bit-Mapped Resident Fonts ... 000 - 010 — 5, 6, 8,
        // 10, 12, 14, 18, 24, 30, 36, 48, respectively." The code is an index
        // into that list, so 006 is 18 points, not six — and every one of them
        // was being drawn at the same default.
        const want = [5, 6, 8, 10, 12, 14, 18, 24, 30, 36, 48];
        for (let i = 0; i <= 10; i++) {
            const eee = String(i).padStart(3, '0');
            const el = parseDPL(`\x02L\r1911${eee}0020` + '0200Text\rE\r', PAGE).elements[0] as any;
            expect(el.pointSize, `eee ${eee}`).toBe(want[i]);
            expect(el.source.data, `eee ${eee}`).toBe('Text');
        }
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

    it('writes the EAN/UPC letter the DATA LENGTH names, not always UPC-A', () => {
        // B/C/F/G are four symbols sharing the IR's one symbology id '7', so a
        // design that stores only '7' forces the generator to pick the letter.
        // It used to hardcode 'B' (UPC-A) for every length, so an EAN-13 was
        // exported as a UPC-A record — the printer draws the symbol the LETTER
        // names, so a 13-digit payload under `B` prints the wrong bar code
        // silently. The length decides, exactly as the EPL and TSPL generators
        // do, and the DPL PARSER reads these same letters back into the variant.
        const eanField = (data: string) => ({ id: 1, type: 'barcode', name: 'BC', x: 5, y: 5, rotation: 0, symbology: '7', humanReadable: 'none', h_mag: 60, w_mag: 2, dataSource: { type: 'fixed', data } });
        const letterFor = (data: string) => {
            const rec = generateDPL(design([eanField(data)])).dpl.split('\r').find(l => /^1[A-Za-z]/.test(l))!;
            return rec[1];
        };
        expect(letterFor('123456789012'), 'UPC-A is 12 digits').toBe('b');
        expect(letterFor('1234567'), 'UPC-E is 7 digits').toBe('c');
        expect(letterFor('1234567890123'), 'EAN-13 is 13 digits').toBe('f');
        expect(letterFor('12345678'), 'EAN-8 is 8 digits').toBe('g');
    });

    it('names an EAN/UPC data length no member takes, rather than writing UPC-A', () => {
        const r = generateDPL(design([{ id: 1, type: 'barcode', name: 'BC', x: 5, y: 5, rotation: 0, symbology: '7', humanReadable: 'none', h_mag: 60, w_mag: 2, dataSource: { type: 'fixed', data: '123456' } }]));
        expect(r.warnings.some(w => /BC/.test(w) && /not a length DPL recognizes/.test(w))).toBe(true);
        expect(r.dpl).not.toMatch(/^1[A-Za-z]/m);
    });

    it('round-trips the EAN/UPC variant out and back', () => {
        // The strongest form: a design EAN-13 (symbology '7') must come back
        // reading as EAN-13, not UPC-A. The parser carries `eanUpcVersion`
        // from the letter, so the digit count never has to be guessed.
        const eanField = (data: string) => ({ id: 1, type: 'barcode', name: 'BC', x: 5, y: 5, rotation: 0, symbology: '7', humanReadable: 'none', h_mag: 60, w_mag: 2, dataSource: { type: 'fixed', data } });
        const back = (data: string) => {
            const rec = generateDPL(design([eanField(data)])).dpl;
            const bc = parseDPL(rec, PAGE).elements.find(e => e.kind === 'barcode') as any;
            return bc && buildBwipSpec(bc.symbology, bc.source.data, { eanUpcVersion: bc.eanUpcVersion })?.main.bcid;
        };
        expect(back('1234567890123'), 'EAN-13 stays EAN-13').toBe('ean13');
        expect(back('123456789012'), 'UPC-A stays UPC-A').toBe('upca');
        expect(back('12345678'), 'EAN-8 stays EAN-8').toBe('ean8');
        expect(back('1234567'), 'UPC-E stays UPC-E').toBe('upce');
    });

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

    it('takes the default height from Table F-2, per symbol', () => {
        // Read from the RENDERED page: the table's symbol column and its number
        // columns extract as separate runs with no shared coordinate, and an
        // earlier pairing built from the text alone gave D and F 0.80 in where
        // the page says 0.40. The table is not one value — it runs from 0.08 in
        // for Postnet to 1.40 for the UPC addenda and Postnet's cousins.
        const h = (b: string) => {
            const rec = `1${b}1100000` + '0020' + '0020' + 'X';
            return (parseDPL(`\x02L\r${rec}\rE\r`, PAGE).elements.find(e => e.kind === 'barcode') as any).heightDots;
        };
        expect(h('A'), 'Code 39 is 0.40 in').toBe(81);
        expect(h('B'), 'UPC-A is 0.80 in').toBe(162);
        expect(h('L'), 'Telepen is 1.30 in').toBe(264);
        expect(h('M'), 'the 2-digit addendum is 0.90 in').toBe(183);
        expect(h('P'), 'Postnet is 0.08 in — the shortest in the table').toBe(16);
        expect(h('Q'), 'the UPC addenda are 1.40 in').toBe(284);
        expect(h('U'), 'MaxiCode is 1.00 in').toBe(203);
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

describe('DPL printer clock (<STX>A sets it, <STX>T prints it)', () => {
    // "<STX>A1020319960855034" — the manual's own sample, which it says prints
    // "Mon. Feb 3, 1996, 8:55AM, 034". The date is SIXTEEN digits:
    //   [0] w  [1..2] mm  [3..4] dd  [5..8] yyyy  [9..10] hh  [11..12] MM  [13..15] jjj
    const setThenPrint = (setCmd: string, seed: Date) =>
        parseDPL(
            `${setCmd}\r\x02L\r121100001000100\x02TBCD GHI PQ\rE\r`,
            PAGE, seed,
        );

    it('prints the date the STREAM set, not the system\'s', () => {
        // <STX>T prints "from the printer's internal clock", so a stream that
        // sets that clock and then prints the date must show ITS date. It was
        // showing the caller's — measured: a stream setting 3 Feb 1996 printed
        // "THU OCT 01" for its own date field.
        const lab = setThenPrint('\x02A1020319960855034', new Date(2026, 9, 1));
        const text = (lab.elements.find(e => e.kind === 'text') as any).source.data;
        expect(text, 'the day name comes from the stream\'s date').toContain('FEB 03');
        expect(text).not.toContain('OCT');
        expect(lab.issues.map(i => i.code)).toContain('dpl-clock-set');
    });

    it('reads all sixteen digits at the right offsets', () => {
        // A first attempt counted fifteen and offset every field by one, which
        // read the sample as the 5th of February 1999 — a wrong date presented
        // as a fact. The year, month and day are each checked on their own.
        const lab = setThenPrint('\x02A1020319960855034', new Date(2026, 9, 1));
        const msg = lab.issues.find(i => i.code === 'dpl-clock-set')?.message ?? '';
        expect(msg).toContain('1996');
        expect(msg).toContain('Feb 03');
        expect(msg).toContain('08:55');
    });

    it('follows the byte form and the <STX> notation alike', () => {
        // The notation is normalised inside the tokenizer, and the clock is
        // read BEFORE it — so a notated stream used to keep the system clock
        // while the byte form worked.
        const raw = setThenPrint('\x02A1020319960855034', new Date(2026, 9, 1));
        const notated = parseDPL(
            '<STX>A1020319960855034\r<STX>L\r121100001000100<STX>TBCD GHI PQ\rE\r',
            PAGE, new Date(2026, 9, 1),
        );
        const data = (lab: typeof raw) => (lab.elements.find(e => e.kind === 'text') as any).source.data;
        expect(data(notated)).toBe(data(raw));
    });

    it('names a weekday that contradicts the date, rather than picking one', () => {
        // `w` states the weekday separately and CAN disagree: the manual's own
        // sample has w=1 (Monday) against the 3rd of February 1996, which was a
        // Saturday — the manual's "Mon." there is its own error, the same class
        // as its "SUN" for the 21st of December 1998. The preview follows the
        // date and says so, because a printer holding a date derives the day
        // name rather than being told it.
        const disagree = setThenPrint('\x02A1020319960855034', new Date(2026, 9, 1));
        expect(disagree.issues.find(i => i.code === 'dpl-clock-set')?.message)
            .toContain('different weekday');
        // w=6 is Saturday, which AGREES, and must not warn
        const agrees = setThenPrint('\x02A6020319960855034', new Date(2026, 9, 1));
        expect(agrees.issues.find(i => i.code === 'dpl-clock-set')?.message)
            .not.toContain('different weekday');
    });

    it('keeps the caller\'s clock when the stream sets none', () => {
        const lab = parseDPL('\x02L\r121100001000100\x02TBCD GHI PQ\rE\r', PAGE, new Date(1998, 11, 21));
        expect((lab.elements[0] as any).source.data).toContain('DEC 21');
    });
});

describe('DPL speed commands (Appendix L Table L-1, p. 243)', () => {
    const msgFor = (cmd: string) =>
        parseDPL(`\x02L\r${cmd}\r141100001000100HI\rE\r`, PAGE).issues[0];

    it('reads the speed LETTER, as the manual writes it', () => {
        // "Syntax: Pa — a: Is a single character representing a speed; see
        // Appendix L for valid ranges", and the sample is `PC`, which the
        // manual says prints "at a speed of 2 inches per second". Read as a
        // NUMBER every letter speed became 0 in silence.
        expect(msgFor('PC')?.message).toContain('2 inches per second');
        expect(msgFor('PA')?.message).toContain('1 inches per second');
        expect(msgFor('PZ')?.message).toContain('15 inches per second');
    });

    it('keeps the letter case — A and a are different speeds', () => {
        // Table L-1 gives `A` as 1.0 ips and `a` as 16.0. Upper-casing the
        // selection first, as an early version did, read `Pa` as 1.0 where the
        // table says 16.0 — a wrong answer presented confidently, which is
        // worse than the zero it replaced.
        expect(msgFor('Pa')?.message).toContain('16 inches per second');
        expect(msgFor('PA')?.message).toContain('1 inches per second');
        expect(msgFor('Pe')?.message).toContain('20 inches per second');
    });

    it('reports a backfeed speed from the same table', () => {
        // "The sample sets the printer to a backup speed of 3.5 IPS" for `pF`
        // — the manual's own check that F is 3.5.
        expect(msgFor('pF')?.message).toContain('3.5 inches per second');
        expect(msgFor('pF')?.message).toContain('backfeed');
    });

    it('names a character the table does not define', () => {
        expect(msgFor('P5')?.message).toContain('not one of the characters');
        expect(msgFor('P')?.message, 'a bare P keeps the printer\'s speed').toContain('no speed character');
    });
});

describe('DPL resolutions (Appendix K, p. 240)', () => {
    it('sizes an inch of DPL by the printer\'s resolution, not a constant', () => {
        // Every DPL measurement is a physical distance in hundredths of an
        // inch, so the dots it becomes depend on the machine — Appendix K lists
        // each model's dpi — and the parser had a literal 203 at every call
        // site. It was invisible while the PAGE also came through the same
        // function, because both scaled together and the layout stayed right,
        // but every bar code and box was sized for a 203 dpi printer. Measured:
        // a `eee=040` bar code drew 81 dots at 300 dpi, where its 0.40 in is
        // 120 — a third too short.
        const barAt = (dpi: number) => {
            const page = Math.round(100 / 25.4 * dpi);
            const rec = '1A1104000' + '020' + '0020' + 'X';
            return (parseDPL(`\x02L\r${rec}\rE\r`, page, new Date(), dpi).elements[0] as any).heightDots;
        };
        expect(barAt(203), '0.40 in at 203 dpi').toBe(81);
        expect(barAt(300), '0.40 in at 300 dpi').toBe(120);
        expect(barAt(406)).toBe(162);
        expect(barAt(600)).toBe(240);
    });

    it('leaves the default at 203 dpi', () => {
        // The viewer always passes its selection, but a caller that does not —
        // a test, the cross-check tool — must keep the old behaviour exactly.
        const rec = '1A1104000' + '020' + '0020' + 'X';
        const el = parseDPL(`\x02L\r${rec}\rE\r`, 799).elements[0] as any;
        expect(el.heightDots).toBe(81);
    });

    it('scales a position with the resolution too', () => {
        // A row is in the same hundredths-of-an-inch units as a height, so one
        // inch up from home stays one inch up whatever the printer: `ffff` is
        // 0100 in every case, and the dots it lands at follow the dpi.
        // Layout: a b c d (4) + eee (3) + ffff (4) + gggg (4) = 15, then data.
        const dotsForRow = (dpi: number) => {
            const page = Math.round(200 / 25.4 * dpi);
            const rec = '1411' + '000' + '0100' + '0100' + 'HI';
            const el = parseDPL(`\x02L\r${rec}\rE\r`, page, new Date(), dpi).elements[0] as any;
            return page - el.oy;
        };
        for (const dpi of [203, 300, 600]) {
            // the height of the text is subtracted too, so compare the step
            // between two rows rather than the absolute position
            expect(dotsForRow(dpi), `dpi ${dpi}`).toBeGreaterThan(dpi * 0.9);
        }
    });
});

describe('DPL configuration that MOVES the image (<STX>Kc, Appendix K)', () => {
    const msgFor = (cmd: string) =>
        parseDPL(`\x02L\r\x02${cmd}\r141100001000100HI\rE\r`, PAGE).issues[0];

    it('names a fine tune that shifts the printed image', () => {
        // Appendix K: "CF, Column Adjust Fine Tune — shifting both the
        // horizontal start of print position and the Label Width termination
        // point to the right in dots"; "RF, Row Adjust Fine Tune — shifts the
        // vertical start of print position in dots upward or downward". Both
        // exist so that "multiple printers share label formats", so a stream
        // may carry one — and the generic "has no effect on the preview" is
        // untrue for them, because the label really does move.
        const cf = msgFor('KcCF100');
        expect(cf?.code).toBe('dpl-config-shift');
        expect(cf?.message).toContain('HORIZONTALLY');
        expect(cf?.message).toContain('100');
        const rf = msgFor('KcRF-20');
        expect(rf?.code).toBe('dpl-config-shift');
        expect(rf?.message).toContain('VERTICALLY');
    });

    it('reads several parameters off one command', () => {
        // "<STX>Kcaa1val1[;aaIvalI][;aanvaln]" — the manual's own sample is
        // "KcPA120;CL600;STC", so a shift is rarely alone.
        const both = msgFor('KcCF12;RF-8');
        expect(both?.code).toBe('dpl-config-shift');
        expect(both?.message).toContain('KcCF');
        expect(both?.message).toContain('KcRF');
        // and each value is the one that belongs to its own name
        expect(both?.message).toContain('12 dots');
        expect(both?.message).toContain('-8 dots');
    });

    it('leaves configuration that does NOT move the image to the generic report', () => {
        // The serial-port sample from Appendix J, whose values are LETTERS —
        // a regex that read any two letters plus digits would misreport it.
        for (const cmd of ['KcSPAPB;SPApN;SPAD8;SPAS1;SPAB19', 'KcPA120;CL600;STC', 'KcCL600']) {
            const i = msgFor(cmd);
            expect(i?.code, cmd).toBe('dpl-system-command');
            expect(i?.message, cmd).not.toContain('shifts');
        }
    });
});

describe('DPL symbol sets (Appendix I Tables I-1 and I-2)', () => {
    const msgFor = (cmd: string) =>
        parseDPL(`\x02L\r${cmd}\r141100001000100HI\rE\r`, PAGE).issues[0]?.message ?? '';

    it('keeps the single-byte and double-byte selections apart', () => {
        // "<STX>ySxx" selects a single-byte code page and "<STX>yUxx" a
        // double-byte character map, and "each affects an independent database
        // selection and has no impact on the other" (Table I-2). They are
        // different tables, so the same two characters mean different things
        // under each.
        expect(msgFor('ySE7')).toContain('ISO 8859/7 Latin/Greek');
        expect(msgFor('ySWD')).toContain('Wingdings');
        expect(msgFor('yUUC')).toContain('Unicode (including Korean)');
        expect(msgFor('yUB5')).toContain('BIG 5 (Taiwan) Encoded');
        expect(msgFor('yUUC')).toContain('character map');
        expect(msgFor('ySE7')).toContain('symbol set');
    });

    it('names an identifier it does not have, rather than passing it over', () => {
        expect(msgFor('ySZZ')).toContain('Table I-1');
        expect(msgFor('yUZZ')).toContain('Table I-2');
    });

    it('reads the identifiers from the Datamax column, not the PCL one', () => {
        // Table I-1 gives each code page TWO identifiers — a Datamax one and an
        // HP (PCL) one — and the command takes the Datamax one. `0U` is PC-8's
        // PCL id and is not a Datamax id at all, so a stream using it is
        // correctly reported as unknown; `PC` is the Datamax spelling.
        expect(msgFor('ySPC')).toContain('PC-8, Code Page 437');
        expect(msgFor('yS0U')).toContain('Table I-1');
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

describe('DPL generator: the circle the parser already understood', () => {
    // The parser has drawn DPL's circle record since 7011cd4 — Table 8-14, the
    // centre in the header and one radius in the data. The GENERATOR never
    // emitted one, so a designer ellipse warned "DPL output does not support
    // yet" about a language whose parser drew it. The two sides of a language
    // drifting apart is the shape method-generator-parser-asymmetry describes.
    const one = (f: Record<string, unknown>): Design => ({
        name: 'P', labelSettings: { width: 80, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
        printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
        fields: [f as never], dataSources: [], nextId: 2, guides: { horizontal: [], vertical: [] },
    });
    const circle = { id: 1, type: 'ellipse', name: 'E', x: 10, y: 10, rotation: 0, width: 20, height: 20, thickness: 1, visible: true };

    it('emits a circle record shaped like the manual\'s own sample', () => {
        // Table 8-14: "1 X 11 fff rrrr cccc C 001 0001 rrrr", and the manual's
        // own example is `1X1100001000100C00100010025`. So the slots are
        //   eee  = FILL PATTERN NUMBER (the table lists it beside rrrr)
        //   001  = Fixed Value      <- NOT the fill
        //   0001 = Fixed Value
        //   rrrr = radius
        // The record this generator used to write put `000` where the manual
        // fixes `001`, which is the one slot the PRINTER ignores — so the fill
        // could never be expressed and a solid ellipse printed hollow.
        const rec = generateDPL(one(circle)).dpl.split('\r').find(l => l.includes('C001'));
        expect(rec, 'a circle record is emitted').toBeDefined();
        expect(rec).toHaveLength(27);
        // thickness 1 is an OUTLINE on screen, which is pattern 0, "No Pattern".
        expect(rec!.slice(4, 7), 'the fill pattern lives in the header').toBe('000');
        expect(rec!.slice(15, 16), 'the data field starts with C').toBe('C');
        expect(rec!.slice(16, 19), 'the fixed 001').toBe('001');
        expect(rec!.slice(19, 23), 'the fixed 0001').toBe('0001');
        // radius = half of 20 mm, in hundredths of an inch
        expect(rec!.slice(23)).toBe('0040');
    });

    it('fills the circle when the shape is solid, which thickness 0 means', () => {
        // canvasDrawer fills the path at zero line width, and Table 8-15's
        // pattern 1 is "Solid Black" — so the fill pattern has to follow the
        // shape, or every solid ellipse prints as an outline.
        const solid = generateDPL(one({ ...circle, thickness: 0 })).dpl;
        const rec = solid.split('\r').find(l => l.includes('C001'));
        expect(rec!.slice(4, 7), 'pattern 1 is Solid Black').toBe('001');
    });

    it('round-trips: the parser reads back an equal-sided ellipse', () => {
        const back = parseDPL(generateDPL(one(circle)).dpl, 1200);
        const el = back.elements.find(e => e.kind === 'ellipse') as { widthDots: number; heightDots: number } | undefined;
        expect(el, 'DPL sends a circle, the parser draws one').toBeDefined();
        expect(el!.widthDots).toBe(el!.heightDots);
        expect(el!.widthDots).toBeGreaterThan(100);
        // A hollow shape must NOT come back asking for a fill pattern: the
        // parser warns when the record's pattern is non-zero.
        expect(back.issues.map(i => i.code), 'no fill claimed for an outline').not.toContain('dpl-fill-pattern');
    });

    it('prints an ellipse as a circle of the smaller axis, and says so', () => {
        // A DPL circle carries ONE radius, so two axes cannot be expressed.
        // Printing a circle and saying nothing would be a wrong shape drawn
        // without comment; printing nothing would be a silent drop.
        const r = generateDPL(one({ ...circle, width: 20, height: 10 }));
        expect(r.warnings.some(w => w.includes('ellipse') && w.includes('smaller axis'))).toBe(true);
    });

    it('emits a POLYGON record, which the parser already drew', () => {
        // Table 8-13: "1 X 11 ppp rrrr cccc P 001 0001 rrrr cccc …", rotation
        // "must be 1" and the vertices in the data field. The generator had no
        // polygon branch at all, so a six-sided shape exported as the warning
        // "DPL output does not support yet" about a record DPL defines.
        const hex = { id: 1, type: 'polygon', name: 'P', x: 10, y: 10, rotation: 0, width: 20, height: 20, thickness: 1, sides: 6, visible: true };
        const { dpl, warnings } = generateDPL(one(hex));
        expect(warnings.join(' '), 'no longer unsupported').not.toMatch(/does not support/);
        const rec = dpl.split('\r').find(l => l.includes('P001'))!;
        expect(rec[0], 'rotation must be 1').toBe('1');
        expect(rec.slice(15, 16), 'polygon id').toBe('P');
        // Six vertices: the first rides in the header, five row/column pairs
        // follow the two fixed values. A record that dropped one would print a
        // pentagon, and the round trip below counts them back.
        expect(rec.slice(23), 'five more points, 8 characters each').toHaveLength(5 * 8);
    });

    it('only writes pattern 0 for an outlined polygon', () => {
        // The parser read the body's first three characters as the fill, which
        // are the manual's FIXED `001` — so every polygon reported pattern 1
        // whatever the record said. Reading the header instead is what makes
        // this assertion meaningful: a hollow shape must round-trip as hollow.
        const hex = { id: 1, type: 'polygon', name: 'P', x: 10, y: 10, rotation: 0, width: 20, height: 20, thickness: 1, sides: 6, visible: true };
        const back = parseDPL(generateDPL(one(hex)).dpl, 1200);
        expect(back.issues.map(i => i.code), 'an outline is not filled').not.toContain('dpl-fill-pattern');
        const solidBack = parseDPL(generateDPL(one({ ...hex, thickness: 0 })).dpl, 1200);
        expect(solidBack.issues.map(i => i.code), 'a solid shape does ask for a fill').toContain('dpl-fill-pattern');
    });

    it('reads the FILL PATTERN the way the manual\'s four examples say', () => {
        // The strongest check available for this family, because the numbers
        // come off the page rather than out of our own code: manual p. 142
        // gives four records and names each one's fill in the caption, so the
        // caption is the oracle. "spaces have been added for readability", so
        // these are the same records with the spaces taken out.
        //
        // The fill is `ppp`/`fff` IN THE HEADER. Reading the body's first three
        // characters read the FIXED `001` instead, and every one of these four
        // came back as pattern 1.
        const samples: [string, string, number][] = [
            ['1X1100000100010P00100010040002500100040', 'triangle, "no fill pattern"', 0],
            ['1X1100400100010P001000100500010005002000100200', 'rectangle, "filled with pattern 4"', 4],
            ['1X1100001000100C00100010025', 'circle, "no fill pattern"', 0],
            ['1X1100901000100C00100010025', 'circle, "filled with pattern 9"', 9],
        ];
        for (const [rec, caption, expected] of samples) {
            const parsed = parseDPL(`\x02L\rD11\r${rec}\rQ0001\rE\r`, 1200);
            expect(parsed.elements[0], caption).toBeDefined();
            // The fill pattern does NOT reach the IR — the renderer has no fill
            // model, so it is reported instead of drawn. The report is the
            // observable, and it names the number, which is what makes this a
            // check on the NUMBER rather than on "a warning appeared".
            const warn = parsed.issues.find(i => i.code === 'dpl-fill-pattern');
            if (expected === 0) {
                expect(warn, `${caption} is unfilled, so nothing is reported`).toBeUndefined();
            } else {
                expect(warn, `${caption} names pattern ${expected}`).toBeDefined();
                expect(warn!.message, `${caption} -> pattern number`).toContain(`pattern ${expected} `);
            }
        }
    });
});

describe('DPL generator: images, which the parser already drew', () => {
    // The parser has drawn DPL images since it read `<STX>I` (its "Image
    // (b = Y)" branch, Table 8-11) — dot rows decoded, printed by name, the
    // width/height multipliers honoured. The GENERATOR had no image branch at
    // all, so the designer's Image tool exported "DPL output does not support
    // yet" about a shape the same language's reader already understood, the
    // same one-sided gap the circle and polygon above had.
    const one = (f: Record<string, unknown>): Design => ({
        name: 'P', labelSettings: { width: 80, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
        printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
        fields: [f as never], dataSources: [], nextId: 2, guides: { horizontal: [], vertical: [] },
    });
    // A 4-point downward triangle, 8 dots wide so a row is exactly one byte.
    const bitmap = ['10000000', '11000000', '11100000', '11110000'];
    const image = (over: Record<string, unknown> = {}) => ({
        id: 1, type: 'image', name: 'Logo', x: 10, y: 10, rotation: 0, threshold: 128,
        bitmap, width: bitmap[0].length / (203 / 25.4), height: bitmap.length / (203 / 25.4),
        visible: true, ...over,
    });

    it('downloads the image before the label and prints it by name', () => {
        const { dpl, warnings } = generateDPL(one(image()));
        expect(warnings.join(' '), 'no longer unsupported').not.toMatch(/does not support/);
        // The download must precede the label: an image is not a label record,
        // so `<STX>I` comes first and the `Y` record prints it.
        expect(dpl.indexOf('\x02I1F'), 'a download block is emitted').toBeGreaterThanOrEqual(0);
        expect(dpl.indexOf('\x02I1F'), 'the download precedes <STX>L').toBeLessThan(dpl.indexOf('\x02L'));
        // Appendix O: `80nndd...d`, nn = byte count in ASCII hex. One byte per
        // row -> 01; the triangle's rows are 0x80, 0xC0, 0xE0, 0xF0.
        expect(dpl).toContain('800180');
        expect(dpl).toContain('8001C0');
        expect(dpl).toContain('8001E0');
        expect(dpl).toContain('8001F0');
        expect(dpl, 'the download is terminated').toContain('FFFF');
        // Table 8-11 record: 1 Y 11 000 rrrr cccc name.
        const rec = dpl.split('\r').find(l => l.startsWith('1Y11'));
        expect(rec, 'an image record is emitted').toBeDefined();
        expect(rec!.slice(15), 'it names the downloaded image').toBe('IMG0');
    });

    it('round-trips: the parser draws the bitmap back dot for dot', () => {
        // What catches a transposed or bit-reversed row — which "did it emit a
        // download" would never see. This is the generator↔parser agreement
        // that keeps the two sides of one language from drifting apart.
        const back = parseDPL(generateDPL(one(image())).dpl, 406);
        const g = back.elements.find(e => e.kind === 'graphic') as
            { widthDots: number; heightDots: number; rows: string[] } | undefined;
        expect(g, 'the record draws the image it downloaded').toBeDefined();
        expect(g!.widthDots).toBe(8);
        expect(g!.heightDots).toBe(4);
        expect(back.issues.map(i => i.code), 'nothing goes missing').not.toContain('dpl-image-missing');
        const bits = (row: string) => [...row].map(c => c.charCodeAt(0).toString(2).padStart(8, '0')).join('');
        expect(bits(g!.rows[0]).slice(0, 8)).toBe('10000000');
        expect(bits(g!.rows[3]).slice(0, 8)).toBe('11110000');
    });

    it('names an image wider than a dot-row record can carry', () => {
        // A record counts its bytes in one hex byte, so 2040 dots is the
        // widest an image can be. Wider has no form; dropping it silently is
        // exactly the failure this project names instead.
        const wide = image({ bitmap: ['1'.repeat(2048)], width: 2048 / (203 / 25.4), height: 1 / (203 / 25.4) });
        const { dpl, warnings } = generateDPL(one(wide));
        expect(warnings.some(w => w.includes('Logo') && w.includes('2040'))).toBe(true);
        expect(dpl).not.toContain('\x02I');
    });

    it('says so when an image has no bitmap, rather than an empty download', () => {
        const { dpl, warnings } = generateDPL(one(image({ bitmap: [] })));
        expect(warnings.join(' ')).toMatch(/no bitmap data/);
        expect(dpl).not.toContain('\x02I');
    });

    it('names a rotated image, because a DPL image prints in Rotation 1 only', () => {
        const { dpl, warnings } = generateDPL(one(image({ rotation: 90 })));
        expect(warnings.some(w => w.includes('Logo') && /Rotation 1/.test(w))).toBe(true);
        expect(dpl).toContain('1Y11');
    });
});

// A scalable-font record's four-digit height is in DOTS, and the manual warns
// it "will output differently on printers with different DPI/MMPI resolutions".
// The record maps to the IR's OUTLINE path (c25), which the renderer sizes by
// pointSize x dpi, so the dot->point conversion must use the render dpi too.
// It divided by a hardcoded 203: a `0040` (40-dot) field drew 45 dots at 203 dpi
// but 91 at 406. Same class as the position math this parser already fixed when
// it took dpiHint — this one site was missed.
describe('a DPL font-9 dot size draws the same at any dpi', () => {
    const rec = (eee: string, h: string, data: string) => `1911${eee}0020` + '0200' + h + '0040' + data;
    const crossDots = (dpi: 203 | 300 | 406): number => {
        const el = parseDPL(`\x02L\r${rec('S00', '0040', 'Text')}\rE\r`, PAGE, new Date(), dpi).elements[0];
        return estimateElementSize(el, dpi).crossDots;
    };

    it('renders ~40 dots for 0040 at 203, 300 and 406 dpi', () => {
        for (const dpi of [203, 300, 406] as const) {
            const h = crossDots(dpi);
            expect(h, `at ${dpi} dpi`).toBeGreaterThanOrEqual(40);
            expect(h, `at ${dpi} dpi`).toBeLessThanOrEqual(58);
        }
    });

    it('is the dot count, not a fixed 203 reader (the old bug)', () => {
        // Before the fix the height grew with dpi (45 -> 67 -> 91); now it is flat.
        expect(crossDots(406)).toBeLessThan(crossDots(203) * 1.25);
    });
});
