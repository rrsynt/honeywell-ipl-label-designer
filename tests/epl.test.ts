// EPL (Eltron Programming Language): the parser, the generator, and the places
// the language reaches into the rest of the app.
//
// Every table here is pinned to the **EPL2 Programmer's Manual (Zebra P/N
// 980352-001 Rev. D)**. That is not ceremony: a first implementation written
// from memory had the barcode type letters completely wrong (`1`=Code 39,
// `3`=Code 128), which would have printed every barcode as the wrong
// symbology. The tests below are the ones that would have caught it.
//
// The generator is checked against the parser (round trip) AND, in
// tools/epl-crosscheck.mjs, against an INDEPENDENT engine — because a parser
// and a generator that agree with each other can still both misread the spec.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import './golden/setup';
import { newRealCanvas } from './golden/setup';
import { renderLabel, computeLabelExtent, estimateElementSize } from '../services/ipl/renderer';
import { totalLabelCount } from '../services/ipl/odometer';
import { parseEPL, tokenizeEpl, unescapeEpl, EPL_FONT_SIZES } from '../services/epl/eplParser';
import { generateEPL, escapeEplData } from '../services/epl/eplGenerator';
import { jobSendabilityError, renderJobChunk, type PrintJob } from '../services/printQueue';
import { validateTarget } from '../services/printTargets';
import type { Design } from '../types';

// --- tokenizer --------------------------------------------------------------------

describe('EPL tokenizer', () => {
    it('does NOT split a parameter on a comma inside the quoted data', () => {
        // The manual's own example: those address commas are DATA, not separators.
        const [cmd] = tokenizeEpl('A674,033,1,1,1,1,N,"UNIT 7, SAMPLE PARK, EXAMPLE LANE"');
        expect(cmd.name).toBe('A');
        expect(cmd.params).toBe('674,033,1,1,1,1,N');
        expect(cmd.data).toBe('UNIT 7, SAMPLE PARK, EXAMPLE LANE');
        expect(cmd.params.split(',')).toHaveLength(7);
    });

    it('uses BACKSLASH escapes, not doubled quotes (manual p. 3-5)', () => {
        // EPL is not ZPL: \" prints a quote and \\ prints one backslash.
        expect(unescapeEpl('a\\"b')).toBe('a"b');
        expect(unescapeEpl('a\\\\b')).toBe('a\\b');
        expect(tokenizeEpl('A10,10,0,2,1,1,N,"say \\"hi\\""')[0].data).toBe('say "hi"');
    });

    it('does not mistake an escaped quote for the start of the payload', () => {
        // indexOf('"') would stop at the escaped quote and mis-split the params.
        const [cmd] = tokenizeEpl('A10,10,0,2,1,1,N,"a\\"b"');
        expect(cmd.params).toBe('10,10,0,2,1,1,N');
        expect(cmd.data).toBe('a"b');
    });

    it('reads a command name as LETTERS only, so A10,... is not "A10"', () => {
        // Letting the name swallow digits dropped every field in the first draft.
        const [cmd] = tokenizeEpl('A50,50,0,2,1,1,N,"X"');
        expect(cmd.name).toBe('A');
        expect(cmd.params).toBe('50,50,0,2,1,1,N');
    });

    it('collects variable, counter and clock tokens from an UNQUOTED field', () => {
        // Manual p. 3-4: A50,50,0,2,1,1,N,V01 — no quotes anywhere.
        expect(tokenizeEpl('A50,50,0,2,1,1,N,V01')[0].tokens).toEqual(['V01']);
        expect(tokenizeEpl('A50,100,0,3,1,1,N,C1+2')[0].tokens).toEqual(['C1+2']);
        expect(tokenizeEpl('A50,150,0,4,1,1,N,TT')[0].tokens).toEqual(['TT']);
        expect(tokenizeEpl('A50,200,0,5,1,1,N,TD')[0].tokens).toEqual(['TD']);
    });

    it('reads a bare N, ignores blank lines, and tolerates CRLF', () => {
        const cmds = tokenizeEpl('N\r\n\r\nA10,10,0,2,1,1,N,"X"\r\nP1\r\n');
        expect(cmds.map(c => c.name)).toEqual(['N', 'A', 'P']);
        expect(cmds[2].params).toBe('1'); // P takes the copy count as a parameter
    });
});

// --- the parser -------------------------------------------------------------------

describe('EPL parser', () => {
    const sample = ['N', 'A40,20,0,3,2,2,N,"HELLO EPL"', 'B40,70,0,3,2,4,70,B,"12345"', 'LO50,200,400,20', 'X40,220,4,340,300', 'P1'].join('\n');

    it('parses a whole label into the IR', () => {
        const label = parseEPL(sample);
        expect(label.elements.map(e => e.kind)).toEqual(['text', 'barcode', 'line', 'box']);
        expect(label.issues.filter(i => i.level === 'error')).toHaveLength(0);
    });

    it('maps barcode type 3 to Code 39 — NOT type 1, which is Code 128', () => {
        // Manual Table 2-1, p. 3-12. This is the assertion that matters most.
        const bc = parseEPL('N\nB10,10,0,3,2,2,60,B,"12345"').elements[0] as any;
        expect(bc.symbology).toBe('0'); // IR id 0 = code39
        expect(bc.hri).toBe(1);          // 'B' = human-readable below
    });

    it('maps the rest of the EPL type letters', () => {
        const symbolOf = (type: string, data = '12345') =>
            (parseEPL(`N\nB10,10,0,${type},2,2,60,B,"${data}"`).elements[0] as any)?.symbology;
        expect(symbolOf('1')).toBe('6');   // Code 128 auto
        expect(symbolOf('1A')).toBe('6');  // forced subset A
        expect(symbolOf('0')).toBe('6');   // UCC/SSCC
        expect(symbolOf('1E')).toBe('6');  // UCC/EAN 128
        expect(symbolOf('2')).toBe('2');   // ITF
        expect(symbolOf('2C')).toBe('2');  // ITF + mod10
        expect(symbolOf('E30', '1234567890128')).toBe('7');
        expect(symbolOf('UA0', '012345678905')).toBe('7');
    });

    it('carries the EAN/UPC variant the letter names', () => {
        const versionOf = (type: string, data: string) =>
            (parseEPL(`N\nB10,10,0,${type},2,2,60,B,"${data}"`).elements[0] as any)?.eanUpcVersion;
        expect(versionOf('E30', '1234567890128')).toBe(2); // ean13
        expect(versionOf('E80', '12345670')).toBe(1);      // ean8
        expect(versionOf('UA0', '012345678905')).toBe(3);  // upca
        expect(versionOf('UE0', '1234567')).toBe(4);       // upce
    });

    it('marks 3C as Code 39 whose check digit the host supplies', () => {
        expect((parseEPL('N\nB10,10,0,3C,2,2,60,B,"12345"').elements[0] as any).code39Mode).toBe('2');
    });

    it('names the mod 10 check digit 2C and 2D cannot draw', () => {
        // EPL Table 2-1 (p. 3-12): '2C' is "Interleaved 2 of 5 with mod 10
        // check digit" and '2D' is "... with human readable check digit". In
        // both the PRINTER appends the digit; this encoder cannot, so the field
        // drew as plain I2of5 in silence. Same substitution IPL c2,m1 names.
        const codes = (type: string) =>
            parseEPL(`N\nB10,10,0,${type},2,2,60,B,"12345678"`).issues.map(i => i.code);
        expect(codes('2C')).toContain('epl-i2of5-check-digit');
        expect(codes('2D')).toContain('epl-i2of5-check-digit');
        // The control: plain '2' has no printer check digit, so nothing to say.
        expect(codes('2')).not.toContain('epl-i2of5-check-digit');
        // And '3C' is Code 39's host-supplied digit — a different mechanism,
        // already carried, so it must not pick up the I2of5 message.
        expect(codes('3C')).not.toContain('epl-i2of5-check-digit');
    });

    it('names a known-but-unencodable type instead of saying "unknown"', () => {
        const named = (type: string) => parseEPL(`N\nB10,10,0,${type},2,2,60,B,"12345"`).issues.find(i => i.code === 'epl-barcode-unencoded')?.message;
        expect(named('9')).toMatch(/Code 93/);
        expect(named('K')).toMatch(/Codabar/);
        expect(named('PL')).toMatch(/Planet/);
        expect(named('M')).toMatch(/MSI-3/);
        // And such a field draws nothing rather than something wrong.
        expect(parseEPL('N\nB10,10,0,9,2,2,60,B,"12345"').elements).toHaveLength(0);
    });

    it('R offsets every element that follows it (manual p. 3-96)', () => {
        const t = parseEPL('N\nR100,50\nA10,10,0,2,1,1,N,"X"').elements[0] as any;
        expect(t.ox).toBe(110);
        expect(t.oy).toBe(60);
    });

    it('reads X as a box between two CORNERS, in either order', () => {
        const box = parseEPL('N\nX300,220,4,40,300').elements[0] as any;
        expect(box.kind).toBe('box');
        expect(box.widthDots).toBe(260);
        expect(box.heightDots).toBe(80);
        expect(box.ox).toBe(40);
        expect(box.oy).toBe(220);
        const flipped = parseEPL('N\nX40,300,4,300,220').elements[0] as any;
        expect([flipped.ox, flipped.oy, flipped.widthDots, flipped.heightDots]).toEqual([40, 220, 260, 80]);
    });

    it('reads LO as x,y,horizontal,vertical — the manual\'s own example', () => {
        // Manual p. 3-69: LO50,200,400,20 is 400 long and 20 thick.
        const h = parseEPL('N\nLO50,200,400,20').elements[0] as any;
        expect([h.lengthDots, h.thicknessDots, h.f]).toEqual([400, 20, 0]);
        const v = parseEPL('N\nLO200,50,20,400').elements[0] as any;
        expect([v.lengthDots, v.thicknessDots, v.f]).toEqual([400, 20, 1]);
    });

    it('marks LW white, so it erases, and leaves LO black', () => {
        // Manual p. 3-71: LW is the WHITE line — it removes ink rather than
        // adding any. The old code pushed it as an ordinary line, which the
        // renderer painted BLACK, and then reported "not painted" — a message
        // describing the opposite of what the code did. The control here is LO:
        // a probe that cannot tell the two apart cannot see this at all.
        const lw = parseEPL('N\nLW10,10,100,8').elements[0] as any;
        const lo = parseEPL('N\nLO10,10,100,8').elements[0] as any;
        expect(lw.white).toBe(true);
        expect(lo.white).toBeUndefined();
        // Geometry is otherwise identical — only the ink differs.
        expect([lw.lengthDots, lw.thicknessDots, lw.f]).toEqual([lo.lengthDots, lo.thicknessDots, lo.f]);
    });

    it('stops warning that LW is unpaintable — it is painted, in white', () => {
        // The message read "this renderer cannot express [erasing]... It is
        // listed here but not painted", and both halves were wrong. The ink
        // itself is measured in the render test below; this only asserts the
        // misleading message is gone.
        expect(parseEPL('N\nLW10,10,100,8').issues.map(i => i.code)).not.toContain('epl-lw-erase');
    });

    it('pins the resident font sizes from the manual, and knows there is no font 0', () => {
        expect(EPL_FONT_SIZES[1]).toEqual({ width: 8, height: 12 });
        expect(EPL_FONT_SIZES[2]).toEqual({ width: 10, height: 16 });
        expect(EPL_FONT_SIZES[3]).toEqual({ width: 12, height: 20 });
        expect(EPL_FONT_SIZES[4]).toEqual({ width: 14, height: 24 });
        expect(EPL_FONT_SIZES[5]).toEqual({ width: 32, height: 48 });
        expect(EPL_FONT_SIZES[0]).toBeUndefined();
    });

    it('falls back for a soft font with a warning, said once for the whole label', () => {
        const label = parseEPL('N\nA10,10,0,A,1,1,N,"one"\nA10,50,0,A,1,1,N,"two"');
        expect(label.elements).toHaveLength(2);
        expect(label.issues.filter(i => i.code === 'epl-soft-font')).toHaveLength(1);
    });

    it('reports a variable field as a variable rather than inventing a value', () => {
        const t = parseEPL('N\nA50,50,0,2,1,1,N,V01').elements[0] as any;
        expect(t.source.type).toBe('variable');
        expect(t.source.data).toBe('');
    });

    it('carries the font multipliers into IR magnification', () => {
        // A p5,p6 = 3,2 — p5 is HORIZONTAL and p6 VERTICAL (manual p. 3-4), so
        // the width magnification is 3 and the height magnification is 2.
        // This test asserted [hMag, wMag] = [3, 2] before the axes were
        // checked against the manual, which locked the swap in place.
        const t = parseEPL('N\nA10,10,0,2,3,2,N,"BIG"').elements[0] as any;
        expect([t.wMag, t.hMag]).toEqual([3, 2]);
    });

    it('reports reverse printing instead of carrying a flag nothing reads', () => {
        // p7=R prints white on black. The parser used to set ElementBase.reverse
        // and no renderer ever read it, so the label drew as ordinary black text
        // with no word said. The flag is gone and the difference is reported.
        const r = parseEPL('N\nA10,10,0,2,1,1,R,"INV"');
        expect(r.elements).toHaveLength(1);
        expect(r.issues.map(i => i.code)).toContain('epl-reverse-text');
        expect((r.elements[0] as { reverse?: boolean }).reverse).toBeUndefined();
    });

    it('stays silent for a field that is not reversed', () => {
        const r = parseEPL('N\nA10,10,0,2,1,1,N,"PLAIN"');
        expect(r.issues.map(i => i.code)).not.toContain('epl-reverse-text');
    });

    it('draws the three 2D symbols EPL2 defines, by their type letter', () => {
        // Manual pp. 3-20 / 3-25 / 3-29: p3 is D=Data Matrix, M=MaxiCode,
        // P=PDF417. There is NO QR in EPL2 — not an omission here but a fact of
        // the language, whose contents list only those three.
        const byLetter = (letter: string) =>
            (parseEPL(`N
b10,20,${letter},"DATA"`).elements[0] as any)?.symbology;
        expect(byLetter('D')).toBe('17');
        expect(byLetter('M')).toBe('14');
        expect(byLetter('P')).toBe('12');
    });

    it('reads the letter-prefixed optional parameters of a 2D symbol', () => {
        // p4-p7 carry their own prefix (c columns, r rows, h module size,
        // v inverse) rather than being positional.
        expect((parseEPL('N\nb10,20,D,h7,"DATA"').elements[0] as any).moduleDots).toBe(7);
    });

    it('names an unknown 2D type, and says EPL has no QR at all', () => {
        const label = parseEPL('N\nb10,20,Z,"DATA"');
        expect(label.elements).toHaveLength(0);
        expect(label.issues.find(i => i.code === 'epl-2d-unsupported')?.message).toMatch(/no QR code/i);
    });

    it('reports the commands outside the subset by name', () => {
        const label = parseEPL('N\nGW10,10,20,5\nb10,10,Q,"x"');
        expect(label.issues.some(i => i.code === 'epl-gw-unsupported')).toBe(true);
        expect(label.issues.some(i => i.code === 'epl-2d-unsupported')).toBe(true);
    });

    it('LE draws an INVERSION, the same operation TSPL calls REVERSE', () => {
        // LE is Line Draw Exclusive OR (manual p. 3-68): "Any area, line, image
        // or field that this line intersects or overlays will have the image
        // reversed or inverted ... all black will be reversed to white and all
        // white will be reversed to black within the line's area."
        //
        // That is exactly what TSPL's REVERSE does, so it is the same element —
        // and NOT a white fill, which would leave black ink underneath and
        // still look like it had erased it.
        //
        // The control is LO, its black counterpart, so a probe that cannot see
        // LO cannot tell "drawn" from "not looked at".
        const lo = parseEPL('N\nLO50,200,400,20\nP1\n');
        expect(lo.elements, 'LO must draw — without this the probe is blind').toHaveLength(1);

        const le = parseEPL('N\nLE50,200,400,20\nP1\n');
        const el = le.elements[0] as any;
        expect(el.kind, 'an inversion is its own element, not a line').toBe('reverse');
        expect([el.ox, el.oy, el.widthDots, el.heightDots]).toEqual([50, 200, 400, 20]);
        // A region of the image buffer is not a rotated field.
        expect(el.f).toBe(0);
        expect(le.issues.map(i => i.code), 'and it needs no complaint').toEqual([]);
    });

    it('still reports LE with bad parameters rather than ignoring the line', () => {
        const le = parseEPL('N\nLE50,200\nP1\n');
        expect(le.issues.some(i => i.code === 'epl-le-params')).toBe(true);
    });

    it('LS reads EPL\'s parameter order: thickness is THIRD, not last', () => {
        // LS p1,p2,p3,p4,p5 — manual p. 3-70: x, y, THICKNESS, end x, end y.
        // Every other line command here ends with its lengths (LO/LW take
        // x,y,h-length,v-length) and TSPL's DIAGONAL puts thickness LAST, so
        // reading LS as "x,y,x2,y2,thickness" is the natural mistake — it
        // would take the END X for a thickness and draw the wrong line.
        const el = parseEPL('N\nLS10,10,20,200,200\nP1\n').elements[0] as any;
        expect(el.kind).toBe('diagonal');
        expect(el.thicknessDots, 'the THIRD value is the thickness').toBe(20);
        expect(el.ex, 'and the fourth is the end x').toBe(200);
        expect(el.ey, 'the fifth the end y').toBe(200);
        expect([el.ox, el.oy]).toEqual([10, 10]);
    });

    it('names every silence-list entry the manual does not define', () => {
        // The silence list exists so ordinary printer settings do not drown the
        // issues panel. An entry that is NOT a command at all therefore does the
        // opposite of its job: it turns an unrecognized line into no message,
        // which is the one outcome this parser is built to avoid.
        //
        // Checked against the manual's own definitions rather than from memory:
        // docs/manuals/EPL2_Programmers_Manual_980352-001.txt records one
        // "NAME  Comm and -  Title" heading per documented command.
        //
        // A positive control runs FIRST. Without it, a heading pattern that
        // matched nothing would "prove" that no silenced entry is a command —
        // the vacuous pass this project keeps meeting.
        const manual = fs.readFileSync(
            path.join(process.cwd(), 'docs', 'manuals', 'EPL2_Programmers_Manual_980352-001.txt'), 'utf8');
        const defined = new Set(
            [...manual.matchAll(/([A-Za-z^;?@%$][A-Za-z0-9^;?@%$]{0,5})\s+Comm\s*and\s*-\s*([^.\n]{2,60})/g)]
                .map(m => m[1]));
        // Control: commands we KNOW the manual documents must be in that set.
        for (const known of ['A', 'LO', 'LW', 'LE', 'eR', 'oH', 'q', 'Q', 'FS']) {
            expect(defined, `the heading scan must find ${known}`).toContain(known);
        }

        const src = fs.readFileSync(
            path.join(process.cwd(), 'services', 'epl', 'eplParser.ts'), 'utf8');
        const i = src.indexOf('const PRINTER_SETTINGS = new Set([');
        const body = src.slice(i, src.indexOf(']);', i)).replace(/\/\/[^\n]*/g, '');
        const listed = [...body.matchAll(/'([^']+)'/g)].map(m => m[1]);
        expect(listed.length, 'the silence list must have been read').toBeGreaterThan(40);

        const notCommands = listed.filter(c => !defined.has(c));
        expect(notCommands, 'these silence an unrecognized command instead of naming it')
            .toEqual([]);

        // Being a documented command is not enough on its own — GG is one, and
        // it DRAWS a graphic by name from the printer's memory. Silence is only
        // defensible for a setting that cannot change the image, so the one
        // drawn-but-undrawable command is checked to report rather than to
        // vanish.
        expect(parseEPL('N\nGG50,50,"LOGO"').issues.map(i => i.code)).toContain('epl-gg-stored-graphic');
    });

    it('says nothing about ordinary printer settings', () => {
        expect(parseEPL('N\nQ203,25\nq400\nS4\nD8\nP1\nV01').issues).toHaveLength(0);
    });

});

// --- LW paints white, measured -----------------------------------------------------
//
// The parse assertions above say what the IR CARRIES. These measure what the
// renderer actually puts on the canvas, because the failure being fixed was a
// disagreement between the two: the element was pushed like any other line and
// painted BLACK, while a message said it was not painted at all.

describe('LW paints white where LO paints black', () => {
    // quality 1 keeps the device scale equal to pxPerDot: renderLabel defaults
    // to quality 2, which silently doubles it and put the first version of this
    // probe's band in the wrong place — it read LO's ink as zero.
    const PX = 4;          // pxPerDot, with quality 1
    const LINE = { x0: 40, y0: 40, len: 100, thick: 8 };

    /** Dark pixels inside the line's own rectangle, in device pixels. */
    const inkInLineBand = (source: string) => {
        const label = parseEPL(source);
        const extent = computeLabelExtent(label, 203);
        const canvas = newRealCanvas(extent.widthDots * PX, extent.heightDots * PX);
        renderLabel(canvas as never, label, extent, { dpi: 203, pxPerDot: PX, quality: 1 });
        const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let dark = 0;
        for (let y = LINE.y0 * PX; y < (LINE.y0 + LINE.thick) * PX; y++) {
            for (let x = LINE.x0 * PX; x < (LINE.x0 + LINE.len) * PX; x++) {
                const o = (y * canvas.width + x) * 4;
                if (d[o] < 100 && d[o + 1] < 100 && d[o + 2] < 100) dark++;
            }
        }
        return dark;
    };

    const line = (cmd: string) => `N\n${cmd}${LINE.x0},${LINE.y0},${LINE.len},${LINE.thick}\nP1\n`;

    it('puts ink down for LO and none for LW', () => {
        // The label is filled white before anything is drawn, so a white line
        // over untouched stock is invisible — which is exactly what the printer
        // does with it. The control is LO in the same band: if that does not
        // ink, the probe is blind and "LW inked nothing" would mean nothing.
        const lo = inkInLineBand(line('LO'));
        const lw = inkInLineBand(line('LW'));
        expect(lo, 'LO must lay ink down — without this the probe is blind').toBeGreaterThan(0);
        expect(lw, `LW must lay NO ink down (LO had ${lo}, LW had ${lw})`).toBe(0);
    });

    it('erases ink that is already there', () => {
        // The stronger claim, and the one that matters: LW removes ink rather
        // than merely failing to add any. A filled box is laid down first, then
        // the line across its top band — LO keeps that crossing dark, LW clears
        // it. Measured: the band goes from solid ink to none.
        const box = 'X0,0,60,200,200';
        const crossing = inkInLineBand(`N\n${box}\nLO${LINE.x0},${LINE.y0},${LINE.len},${LINE.thick}\nP1\n`);
        const cleared = inkInLineBand(`N\n${box}\nLW${LINE.x0},${LINE.y0},${LINE.len},${LINE.thick}\nP1\n`);
        expect(crossing, "the box's top band must be inked").toBeGreaterThan(0);
        expect(cleared, `LW must clear it (LO ${crossing}, LW ${cleared})`).toBe(0);
    });
});

// --- the generator ----------------------------------------------------------------

const design = (fields: Design['fields'], over: Partial<Design> = {}): Design => ({
    ...over,
    name: 'EPL test',
    labelSettings: { width: 100, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 2, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields,
    dataSources: over.dataSources ?? [],
    nextId: 99,
    guides: { horizontal: [], vertical: [] },
} as unknown as Design);

/** Rotation is a quarter-turn literal union on Field, so the helper must be typed. */
type Rotation = 0 | 90 | 180 | 270;

const textField = (over: Record<string, unknown> = {}) => ({
    id: 1, type: 'text' as const, name: 'T', x: 10, y: 10, rotation: 0 as Rotation,
    dataSource: { type: 'fixed' as const, data: 'HELLO' },
    font: '0', fontSize: 12, h_mag: 1, w_mag: 1, ...over,
});
const barcodeField = (over: Record<string, unknown> = {}) => ({
    id: 2, type: 'barcode' as const, name: 'B', x: 10, y: 30, rotation: 0 as Rotation,
    dataSource: { type: 'fixed' as const, data: '12345' },
    symbology: '0', humanReadable: 'below', h_mag: 60, w_mag: 2, ...over,
});
const withFields = (fields: unknown[]) => design(fields as unknown as Design["fields"]);
const eplLines = (fields: unknown[]) => generateEPL(withFields(fields)).epl.split('\n');

describe('EPL generator', () => {
    it('wraps the label with N ... P<copies> and the size commands', () => {
        const lines = eplLines([textField()]);
        expect(lines[0]).toBe('N');
        expect(lines.some(l => l.startsWith('q'))).toBe(true);
        expect(lines.some(l => l.startsWith('Q'))).toBe(true);
        expect(lines[lines.length - 1]).toBe('P2');
    });

    it('emits A for text, with the EPL font for the design font', () => {
        const a = eplLines([textField()]).find(l => l.startsWith('A'))!;
        expect(a).toContain('"HELLO"');
        expect(a.split(',')[3]).toBe('1');
    });

    it('round-trips the bitmap font number through EPL, in rank order', () => {
        // The generator's font map must be the parser's exact reverse. It sent
        // design font 1 -> EPL 3 and 2 -> EPL 2, swapping the middle two: a
        // saved design's font 1 reloaded as font 2. Both tables keep the rank
        // 0<1<2 (7x9 < 7x11 < 10x14) = 1<2<3 (8x12 < 10x16 < 12x20).
        const p4 = (font: string) => eplLines([textField({ font })]).find(l => l.startsWith('A'))!.split(',')[3];
        expect(p4('0')).toBe('1');
        expect(p4('1')).toBe('2');
        expect(p4('2')).toBe('3');
        const { epl } = generateEPL(withFields([textField({ font: '1' })]));
        expect((parseEPL(epl).elements[0] as { font?: string }).font).toBe('1');
    });

    it('puts the WIDTH multiplier in p5 and the HEIGHT in p6', () => {
        // Manual p. 3-4: p5 is the horizontal multiplier, p6 the vertical. The
        // generator wrote h_mag into p5, so a wide text printed tall and vice
        // versa — the swap the parser's own comment records fixing on its side.
        const axisOf = (h: number, w: number) => {
            const parts = eplLines([textField({ h_mag: h, w_mag: w })]).find(l => l.startsWith('A'))!.split(',');
            return [parts[4], parts[5]]; // [p5 horizontal, p6 vertical]
        };
        expect(axisOf(1, 4)).toEqual(['4', '1']); // h_mag 1, w_mag 4 -> wide
        expect(axisOf(4, 1)).toEqual(['1', '4']); // h_mag 4, w_mag 1 -> tall
        // And the round trip reads the same axes back.
        const { epl } = generateEPL(withFields([textField({ h_mag: 1, w_mag: 4 })]));
        const el = parseEPL(epl).elements[0] as { hMag: number; wMag: number };
        expect([el.hMag, el.wMag]).toEqual([1, 4]);
    });

    it('emits B with type 3 for Code 39 — the inverse of the parser table', () => {
        expect(eplLines([barcodeField()]).find(l => l.startsWith('B'))!.split(',')[3]).toBe('3');
    });

    it('emits 1A/1B/1C for a forced Code 128 start subset, so it round-trips', () => {
        // EPL Table 2-1: '1' is auto A/B/C, '1A'/'1B'/'1C' force a start
        // subset. The generator wrote plain '1' for a forced subset and the
        // parser mapped 1A/1B/1C to plain code128 — the subset lost both ways.
        const typeOf = (sub?: string) => eplLines([barcodeField({ symbology: '6', code128_subset: sub })])
            .find(l => l.startsWith('B'))!.split(',')[3];
        expect(typeOf('a')).toBe('1A');
        expect(typeOf('b')).toBe('1B');
        expect(typeOf('c')).toBe('1C');
        expect(typeOf('auto')).toBe('1');
        const { epl } = generateEPL(withFields([barcodeField({ symbology: '6', code128_subset: 'c' })]));
        expect((parseEPL(epl).elements[0] as { code128StartSubset?: string }).code128StartSubset).toBe('c');
    });

    it('emits the BAR height, not the HRI-inclusive box height', () => {
        // p7 is "Bar code height in dots" (manual p. 3-11); the interpretive row
        // is a separate parameter. box.height adds that row, so emitting it
        // over-tallened the symbol by one text row whenever the HRI was on.
        const heightOf = (hri: string) => eplLines([barcodeField({ h_mag: 200, humanReadable: hri })])
            .find(l => l.startsWith('B'))!.split(',')[6];
        expect(heightOf('below')).toBe('200');
        expect(heightOf('none')).toBe('200');
    });

    it('emits 3C for a host-verified Code 39 check digit, so it round-trips', () => {
        // The parser reads '3C' as code39Mode '2' (host supplies the digit and
        // the printer verifies). The generator wrote plain '3' for every Code 39
        // variant, so a design with that check digit lost it on export and came
        // back as no check digit — the silent drift the reverse table forbids.
        const typeOf = (ck: string) => {
            const { epl } = generateEPL(withFields([barcodeField({ code39_checkDigit: ck })]));
            return epl.split('\n').find(l => l.startsWith('B'))!.split(',')[3];
        };
        expect(typeOf('host-verifies')).toBe('3C');
        expect(typeOf('none')).toBe('3');
        // The round trip: what the generator writes is what the parser reads.
        const { epl } = generateEPL(withFields([barcodeField({ code39_checkDigit: 'host-verifies' })]));
        expect((parseEPL(epl).elements[0] as { code39Mode?: string }).code39Mode).toBe('2');
    });

    it('names the Code 39 printer check digit EPL cannot add', () => {
        // EPL has no "printer enters the digit" Code 39 type — '3C' is the
        // host-verified one. The nearest honest form is plain '3', and the
        // difference is named rather than silent.
        const { warnings } = generateEPL(withFields([barcodeField({ code39_checkDigit: 'printer-generated' })]));
        expect(warnings.some(w => /printer add/i.test(w))).toBe(true);
    });

    it('resolves the EAN/UPC letter from the DATA LENGTH', () => {
        const typeOf = (data: string) => eplLines([barcodeField({ symbology: '7', dataSource: { type: 'fixed', data } })])
            .find(l => l.startsWith('B'))!.split(',')[3];
        expect(typeOf('1234567890128')).toBe('E30');
        expect(typeOf('012345678905')).toBe('UA0');
        expect(typeOf('12345670')).toBe('E80');
        expect(typeOf('1234567')).toBe('UE0');
    });

    it('skips an EAN/UPC whose length EPL does not know, and says which', () => {
        const { epl, warnings } = generateEPL(withFields([barcodeField({ symbology: '7', dataSource: { type: 'fixed', data: '123' } })]));
        expect(epl.split('\n').some(l => l.startsWith('B'))).toBe(false);
        expect(warnings.some(w => /digits/.test(w))).toBe(true);
    });

    it('prints HRI below with a warning when ABOVE was asked for', () => {
        // EPL has no "above". Dropping the line would lose the digits, which is
        // worse than moving it — so it prints below and the move is announced.
        const { epl, warnings } = generateEPL(withFields([barcodeField({ humanReadable: 'above' })]));
        expect(epl.split('\n').find(l => l.startsWith('B'))!.split(',')[7]).toBe('B');
        expect(warnings.some(w => /above/.test(w) && /below/.test(w))).toBe(true);
    });

    it('emits no HRI when none was asked for', () => {
        expect(eplLines([barcodeField({ humanReadable: 'none' })]).find(l => l.startsWith('B'))!.split(',')[7]).toBe('N');
    });

    it('emits X with the FAR CORNER, not a width and height', () => {
        const p = eplLines([{ id: 3, type: 'box', name: 'X', x: 5, y: 5, rotation: 0, width: 20, height: 10, thickness: 0.5 }])
            .find(l => l.startsWith('X'))!.slice(1).split(',').map(Number);
        expect(p[3] - p[0]).toBe(160); // 20mm at 203dpi
        expect(p[4] - p[1]).toBe(80);  // 10mm
    });

    it('warns about rounded corners, which EPL boxes cannot draw', () => {
        expect(generateEPL(withFields([{ id: 3, type: 'box', name: 'X', x: 5, y: 5, rotation: 0, width: 20, height: 10, thickness: 0.5, cornerRadius: 3 }]))
            .warnings.some(w => /rounded/.test(w))).toBe(true);
    });

    it('emits LO with the length on the axis the line runs along', () => {
        const line = (rot: number) => ({ id: 4, type: 'line', name: 'L', x: 5, y: 40, rotation: rot, length: 40, thickness: 0.5 });
        const h = eplLines([line(0)]).find(l => l.startsWith('LO'))!.slice(2).split(',').map(Number);
        expect(h[2]).toBeGreaterThan(h[3]);
        const v = eplLines([line(90)]).find(l => l.startsWith('LO'))!.slice(2).split(',').map(Number);
        expect(v[3]).toBeGreaterThan(v[2]);
    });

    it('emits the b command for the 2D symbols EPL has', () => {
        const twoD = (symbology: string) => generateEPL(withFields([
            barcodeField({ symbology, name: 'C', dataSource: { type: 'fixed', data: 'DATA' } }),
        ])).epl.split('\n').find(l => l.startsWith('b'))!;
        expect(twoD('17').split(',')[2]).toBe('D');   // Data Matrix
        expect(twoD('14').split(',')[2]).toBe('M');   // MaxiCode
        expect(twoD('12').split(',')[2]).toBe('P');   // PDF417
        expect(twoD('17')).toContain('"DATA"');
    });

    it('writes no module-size parameter for MaxiCode, which has none', () => {
        // MaxiCode's p5 is "x,y" associated-symbol numbering (manual p. 3-25),
        // not a module size — the symbol is fixed-size. The `,h<size>` copied
        // from the Data Matrix form (where h IS the module size) was a
        // parameter the printer does not define for MaxiCode.
        const maxi = generateEPL(withFields([
            barcodeField({ symbology: '14', name: 'C', dataSource: { type: 'fixed', data: 'DATA' } }),
        ])).epl.split('\n').find(l => l.startsWith('b'))!;
        expect(maxi).not.toMatch(/,h\d/);
        expect(maxi).toMatch(/^b\d+,\d+,M,"DATA"$/);
        // The control: Data Matrix KEEPS its module size, which is real there.
        const dm = generateEPL(withFields([
            barcodeField({ symbology: '17', name: 'C', dataSource: { type: 'fixed', data: 'DATA' } }),
        ])).epl.split('\n').find(l => l.startsWith('b'))!;
        expect(dm).toMatch(/,h\d/);
    });

    it('refuses a QR code BY NAME, because EPL2 has none', () => {
        const { epl, warnings } = generateEPL(withFields([barcodeField({ symbology: '18', name: 'QR' })]));
        expect(epl.split('\n').some(l => l.startsWith('b'))).toBe(false);
        expect(warnings.some(w => /QR/.test(w) && /does not have/.test(w))).toBe(true);
    });

    it('names an unsupported field type instead of dropping it silently', () => {
        const { epl, warnings } = generateEPL(withFields([{ id: 5, type: 'image', name: 'Logo', x: 1, y: 1, rotation: 0, width: 10, height: 10, data: '' }]));
        expect(warnings.some(w => /Logo/.test(w) && /image/.test(w))).toBe(true);
        expect(epl).toContain('P2'); // the rest of the label still prints
    });

    it('names an unsupported symbology', () => {
        expect(generateEPL(withFields([barcodeField({ symbology: '18', name: 'QR' })])).warnings.some(w => /QR/.test(w))).toBe(true);
    });

    it('ROUND TRIP: what it emits, the parser reads back as the same elements', () => {
        const { epl } = generateEPL(withFields([
            textField(), barcodeField(),
            { id: 3, type: 'box', name: 'X', x: 5, y: 5, rotation: 0, width: 20, height: 10, thickness: 0.5 },
            { id: 4, type: 'line', name: 'L', x: 5, y: 40, rotation: 0, length: 40, thickness: 0.5 },
        ]));
        const label = parseEPL(epl);
        expect(label.issues.filter(i => i.level === 'error')).toHaveLength(0);
        expect(label.elements.map(e => e.kind)).toEqual(['text', 'barcode', 'box', 'line']);
        expect((label.elements[1] as any).symbology).toBe('0');
        expect((label.elements[1] as any).hri).toBe(1);
    });

    it('escapes quotes and backslashes the EPL way, and the parser undoes it', () => {
        expect(escapeEplData('say "hi"')).toBe('say \\"hi\\"');
        expect(escapeEplData('back\\slash')).toBe('back\\\\slash');
        const { epl } = generateEPL(withFields([textField({ dataSource: { type: 'fixed', data: 'a"b\\c' } })]));
        expect((parseEPL(epl).elements[0] as any).source.data).toBe('a"b\\c');
    });
});

// --- where EPL reaches into the rest of the app ------------------------------------

describe('EPL as a printer language', () => {
    it('is accepted by the printer-target form', () => {
        const { target, error } = validateTarget({ name: 'Line 1', host: '10.0.0.5', port: '9100', language: 'epl' as never, dpi: 203 });
        expect(error).toBeNull();
        expect(target?.language).toBe('epl');
    });

    it('still refuses a language it does not speak', () => {
        // The message names every language the app does speak, so it grows as
        // languages are added — matching the prefix keeps this about the
        // REFUSAL rather than the list. The example used to be 'dpl', which has
        // since become a language here, so it is now one with no parser at all.
        expect(validateTarget({ name: 'x', host: 'h', port: '9100', language: 'sbpl' as never, dpi: 203 }).error).toMatch(/^Language must be IPL/);
    });

    it('REFUSES a record range, exactly as ZPL does', () => {
        // generateEPL emits one label per stream with the copies in `P`, so a
        // table-backed design would print one record and drop the rest.
        //
        // The design needs a field LINKED to the table AND mapped to one of its
        // columns: planDesignTableJob returns null when nothing maps, and an
        // unmapped table is not a job at all — so there would be no records to
        // refuse. The field is named after the column, which is how autoMapFields
        // finds it.
        const tableDesign = design([{ ...textField({ name: 'SKU', dataSource: { type: 'linked', sourceId: 's1' } }) } as never], {
            dataSources: [{
                id: 's1', name: 'Table', type: 'table', columns: ['SKU'],
                rows: [{ SKU: 'A' }, { SKU: 'B' }], query: { filters: [], combine: 'and' },
            } as never],
        });
        expect(jobSendabilityError(tableDesign, { language: 'epl' })).toMatch(/EPL.*record range/i);
        expect(jobSendabilityError(tableDesign, { language: 'ipl' })).toBeNull();
        // A single-record design is fine on EPL.
        expect(jobSendabilityError(design([textField()]), { language: 'epl' })).toBeNull();
    });

    it('renders EPL for an EPL target — NOT IPL', () => {
        // The silent hazard: renderJobChunk fell through to generateIPL for
        // anything that was not 'zpl', so an EPL target would have printed IPL.
        const job = {
            id: 'j1', createdAt: 1, updatedAt: 1, designName: 'D', designChecksum: 'x',
            design: design([textField()]),
            recordFrom: 1, recordTo: 1, copies: 3, collation: 'collated',
            target: { id: 't', name: 'E', host: 'h', port: '9100', language: 'epl', dpi: 203 },
            labels: 3, chunkCount: 1, sentChunks: 0, status: 'queued',
        } as unknown as PrintJob;

        return renderJobChunk(job, 0).then(stream => {
            expect(stream.startsWith('N\n')).toBe(true);   // EPL starts with N
            expect(stream).toContain('A');                  // an EPL text field
            expect(stream).not.toContain('<STX>');          // definitely not IPL
            expect(stream.split('\n').pop()).toBe('P3');    // the job's copies reached it
        });
    });
});

// --- the sample file ----------------------------------------------------------------

describe('the checked-in EPL sample', () => {
    it('parses cleanly, so the sample and the parser cannot drift apart', () => {
        const file = path.join(process.cwd(), 'samples', 'product.epl');
        expect(fs.existsSync(file), 'samples/product.epl is missing').toBe(true);
        const label = parseEPL(fs.readFileSync(file, 'utf8'));
        expect(label.elements.length).toBeGreaterThan(0);
        expect(label.issues.filter(i => i.level === 'error')).toHaveLength(0);
    });
});

// q and Q are the label's own size (manual pp. 3-89, 3-91), in dots. They were
// ignored, so the viewer sized every EPL page from its content bbox instead:
// a 4x2 in landscape label measured 91x21 mm — the ink — rather than the paper.
describe('label size from q and Q', () => {
    const withSize = (q?: number, Q?: string) => parseEPL([
        'N',
        ...(q === undefined ? [] : [`q${q}`]),
        ...(Q === undefined ? [] : [`Q${Q}`]),
        'A10,10,0,3,1,1,N,"X"',
        'P1',
    ].join('\n'));

    it('reports the width and length the stream declares', () => {
        const label = withSize(812, '406,24');
        expect(label.widthDots).toBe(812);
        expect(label.heightDots).toBe(406);
    });

    it('a landscape stock is wider than it is long, as declared', () => {
        const label = withSize(812, '406');
        expect(label.widthDots! > label.heightDots!).toBe(true);
    });

    it('the gap parameter of Q is not mistaken for the length', () => {
        // Q406,24 — the length is 406; 24 is the gap for the next label.
        expect(withSize(812, '406,24').heightDots).toBe(406);
    });

    it('one dimension alone is reported as no size, not as half a page', () => {
        // The viewer's fallback (size from content) is honest; a 812-wide page
        // of unknown length would not be.
        expect(withSize(812, undefined).widthDots).toBeNull();
        expect(withSize(undefined, '406').heightDots).toBeNull();
    });

    it('a stream with no size at all still reports none', () => {
        const label = withSize(undefined, undefined);
        expect(label.widthDots).toBeNull();
        expect(label.heightDots).toBeNull();
    });

    it('R does not clear a size already set', () => {
        // R is the reference point, and it offsets elements rather than sizing
        // the page; most streams set it, so treating it as a reset would drop
        // the size of nearly every label.
        const label = parseEPL(['N', 'q812', 'R10,20', 'Q406', 'A10,10,0,3,1,1,N,"X"', 'P1'].join('\n'));
        expect(label.widthDots).toBe(812);
        expect(label.heightDots).toBe(406);
    });
});

// P is the print command (manual p. 3-87): P1 prints one copy, Pn n copies. The
// EPL GENERATOR emits it for the design's quantity, so a stream this app writes
// carries the copy count — but the parser returned no settings at all, and the
// viewer's batch controls stay hidden while totalLabelCount reads 1.
describe('P carries the copy count', () => {
    const withP = (p: string) => parseEPL([
        'N', 'q812', 'Q406,24', 'A10,10,0,3,1,1,N,"X"', p,
    ].join('\n'));

    it('P3 is three labels, not one', () => {
        const label = withP('P3');
        expect(label.settings.quantity).toBe(3);
        // The viewer's own count, which is what the batch buttons key off.
        expect(totalLabelCount(label)).toBe(3);
    });

    it('P1 is one label', () => {
        expect(totalLabelCount(withP('P1'))).toBe(1);
    });

    it('a stream with no P at all stays at one label', () => {
        const label = parseEPL(['N', 'q812', 'Q406,24', 'A10,10,0,3,1,1,N,"X"'].join('\n'));
        expect(totalLabelCount(label)).toBe(1);
    });

    it('a nonsense count cannot reach zero or a fraction', () => {
        // Zero copies is not a thing, and the clamp is what keeps the preview
        // from asking for a negative or fractional batch.
        expect(totalLabelCount(withP('P0'))).toBe(1);
        expect(totalLabelCount(withP('P'))).toBe(1);
    });

    it('round-trips the designer generator: quantity in, same quantity out', async () => {
        // The generator writes P{quantity}; parsing its own output must return
        // that quantity, or the two halves of the app disagree about how many
        // labels a job prints.
        const { generateEPL } = await import('../services/epl/eplGenerator');
        const design = {
            name: 'T',
            labelSettings: { width: 100, height: 65, columns: 1, rows: 1, unit: 'mm' as const, orientation: 'landscape' as const },
            printerSettings: { model: 'PD43', dpi: 203 as const, quantity: 4, mediaType: 'thermal-transfer' as const,
                               mediaSenseMode: 'gap' as const, printSpeed: 6, darkness: 10 },
            fields: [], dataSources: [], nextId: 1, guides: { horizontal: [], vertical: [] },
        };
        const out = generateEPL(design as never);
        expect(out.epl).toContain('P4');
        expect(totalLabelCount(parseEPL(out.epl))).toBe(4);
    });
});

// oW — Customize Bar Code Parameters (manual p. 3-82): p1..p5 are the narrow
// white, narrow black, wide white, wide black and gap widths for every bar code
// printed after it. The manual says plainly what it is for — to "reduce the bar
// code size", beyond the symbology's design tolerances — which is exactly the
// thing a preview draws. It sat in PRINTER_SETTINGS, so a stream that used it
// drew the design's bar widths under no message at all.
describe('oW changes the printed bar widths and must say so (2026-09-30)', () => {
    const warn = (line: string) => parseEPL(`N\n${line}\nB10,10,0,1,2,4,50,B,"12345"\nP1\n`)
        .issues.filter(i => i.code === 'epl-ow-bar-widths');

    it('reports a stream that departs from the documented defaults', () => {
        const hit = warn('oW1,1,2,2,1')[0];
        expect(hit, 'halving every bar width is not the default').toBeDefined();
        expect(hit.level).toBe('warning');
        // All five widths, so the user can see which one they changed.
        for (const v of ['narrow white 1', 'narrow black 1', 'wide white 2', 'wide black 2']) {
            expect(hit.message, `the message must name ${v}`).toContain(v);
        }
        // It also says what this preview does instead, which is the actionable
        // part.
        expect(hit.message).toMatch(/preview draws each symbol from its own module/i);
    });

    it('stays silent on the documented defaults', () => {
        // The control. A command that fires on every stream would be noise, and
        // the manual's own defaults change nothing — issuing oW with the
        // default values is what the manual tells you to do as a placeholder
        // ("use the default parameter values as placeholders").
        expect(warn('oW2,2,4,4,3')).toHaveLength(0);
        // And with the command absent entirely.
        expect(warn('')).toHaveLength(0);
    });

    it('fills missing parameters from the defaults, like the printer', () => {
        // Fewer than five parameters is not an error the manual describes; the
        // unspecified ones keep their default, which is what this asserts so a
        // short oW cannot be read as "all zero".
        const hit = warn('oW1,1')[0];
        expect(hit).toBeDefined();
        expect(hit.message).toContain('1,1,4,4,3');
    });

    it('the control: its silent neighbours are still silent', () => {
        // oR and oB are genuinely printer settings that cannot change the
        // image, so they stay in the list. A probe that fires on them could not
        // tell "reported correctly" from "reports everything".
        for (const cmd of ['oR', 'oB']) {
            expect(parseEPL(`N\n${cmd}\nP1\n`).issues, cmd).toHaveLength(0);
        }
    });
});

// A p1,p2,p3,p4,p5,p6,p7,"DATA" — p5 is the HORIZONTAL multiplier and p6 the
// VERTICAL one (manual p. 3-4), and the documented value sets differ: horizontal
// allows 1,2,3,4,5,6,8 while vertical also allows 7 and 9. The parser had them
// the other way round, so a horizontal stretch was applied to the height.
describe('A applies p5 horizontally and p6 vertically (2026-09-30)', () => {
    type Mags = { hMag: number; wMag: number; pointSize?: number };
    const el = (line: string) => parseEPL(`N\n${line}\nP1\n`).elements[0] as Mags;
    // The element's own size, which is what the layout and the anchor use.
    // estimateElementSize takes the whole element, not just its magnifications.
    const size = (line: string) =>
        estimateElementSize(parseEPL(`N\n${line}\nP1\n`).elements[0], 203);

    it('reads p5 as the width magnification', () => {
        const base = el('A10,10,0,1,1,1,N,"MMMM"');
        expect([base.wMag, base.hMag]).toEqual([1, 1]);

        const wide = el('A10,10,0,1,4,1,N,"MMMM"');
        expect(wide.wMag, 'p5=4 stretches the TEXT horizontally').toBe(4);
        expect(wide.hMag, 'p6=1 means no vertical change').toBe(1);

        const tall = el('A10,10,0,1,1,4,N,"MMMM"');
        expect(tall.wMag, 'p5=1 means no horizontal change').toBe(1);
        expect(tall.hMag, 'p6=4 stretches the LINE HEIGHT').toBe(4);
    });

    it('stretches the right axis, measured', () => {
        // The point of the fix, in the units that matter: a wider field is
        // longer, a taller field is CROSSER — and neither touches the other.
        const base = size('A10,10,0,1,1,1,N,"MMMM"');
        const wide = size('A10,10,0,1,4,1,N,"MMMM"');
        const tall = size('A10,10,0,1,1,4,N,"MMMM"');

        expect(wide.lengthDots, 'p5=4 makes the run four times as long')
            .toBeGreaterThan(base.lengthDots * 3);
        expect(wide.crossDots, 'and does not change the line height')
            .toBe(base.crossDots);

        expect(tall.lengthDots, 'p6=4 leaves the run alone').toBe(base.lengthDots);
        expect(tall.crossDots, 'while growing the line height')
            .toBeGreaterThan(base.crossDots * 2);
    });

    it('still reports an out-of-range multiplier, now on the right axis', () => {
        // 7 and 9 are legal VERTICALLY but not horizontally, so the check has
        // to be made against the horizontal set — otherwise the message would
        // fire on a value the manual allows.
        const warnOf = (line: string) =>
            parseEPL(`N\n${line}\nP1\n`).issues.map(i => i.code);
        expect(warnOf('A10,10,0,1,7,1,N,"X"'), 'p5=7 is not a documented horizontal value')
            .toContain('epl-h-multiplier');
        expect(warnOf('A10,10,0,1,1,7,N,"X"'), 'p6=7 IS a documented vertical value')
            .not.toContain('epl-h-multiplier');
    });
});

// PDF417 is the ONE EPL 2D command with a positional tail. The manual gives
// "b p1,p2,p3,p4,p5[,p6][,p7]..." where p4 (www) is the maximum print WIDTH in
// dots and p5 (hhh) the maximum HEIGHT, and only then come the prefixed
// options p6 (s = error correction) and p7 (c = compression). Data Matrix and
// MaxiCode keep their h/m prefix form.
//
// The parser looked for an h-prefixed option for every type, so a PDF417's
// stated height was never read and the symbol fell back to the module default.
describe('EPL PDF417 takes a positional tail, its siblings do not (2026-09-30)', () => {
    const read = (src: string) => parseEPL(`N\n${src}\nP1\n`).elements[0] as {
        symbology: string; heightDots: number; moduleDots: number;
        pdfEcLevel?: string; pdfColumns?: string;
    };
    const codes = (src: string) => parseEPL(`N\n${src}\nP1\n`).issues.map(i => i.code);

    it('reads the maximum height from p5, where the manual puts it', () => {
        const el = read('b80,100,P,700,600,"DATA"');
        expect(el.symbology).toBe('12');
        expect(el.heightDots, 'p5 (hhh) is the maximum print height').toBe(600);
    });

    it('reads the error-correction level from the s prefix', () => {
        expect(read('b80,100,P,700,600,s5,"DATA"').pdfEcLevel).toBe('5');
    });

    it('reports the maximum width rather than mistaking it for columns', () => {
        // www is a dot ceiling, not the IR's pdfColumns — which counts the
        // symbol's DATA columns. Storing 700 there would have told the encoder
        // to lay out 700 columns.
        const el = read('b80,100,P,700,600,"DATA"');
        expect(el.pdfColumns, 'a dot width is not a column count').toBeUndefined();
        expect(codes('b80,100,P,700,600,"DATA"')).toContain('epl-pdf417-max-width');
    });

    it('leaves Data Matrix and MaxiCode on their prefix form', () => {
        // The control: these two really do use h/m, so a change that made every
        // 2D type positional would break them.
        expect(read('b80,100,D,h5,"DATA"').symbology).toBe('17');
        expect(read('b80,100,M,h5,m2,"DATA"').symbology).toBe('14');
        expect(codes('b80,100,D,h5,"DATA"'), 'Data Matrix has no positional tail').toEqual([]);
    });
});

// MaxiCode's mode is POSITIONAL, like PDF417's box and unlike Data Matrix's
// prefixed options. The manual gives "bp1,p2,p3,[p4,]" with
//   p4 = Mode Selection: M2 Mode 2, M3 Mode 3, m4 Mode 4, m6 Mode 6
// and automatic selection when p4 is omitted — the mixed case is the manual's
// own, not a typo in this test.
//
// The parser looked for a prefixed "m" option, which matched nothing: measured,
// all four documented forms produced an EMPTY mode, so every MaxiCode came out
// with automatic selection whatever the stream asked for.
describe('EPL MaxiCode mode is positional (2026-09-30)', () => {
    const mode = (src: string) => (parseEPL(`N\n${src}\nP1\n`).elements[0] as {
        maxiMode?: string;
    }).maxiMode;
    const codes = (src: string) => parseEPL(`N\n${src}\nP1\n`).issues.map(i => i.code);

    it('reads all four documented selections, in the manual case', () => {
        expect(mode('b80,100,M,M2,"DATA"')).toBe('2');
        expect(mode('b80,100,M,M3,"DATA"')).toBe('3');
        expect(mode('b80,100,M,m4,"DATA"')).toBe('4');
        expect(mode('b80,100,M,m6,"DATA"')).toBe('6');
    });

    it('leaves the mode unset when p4 is omitted', () => {
        // The documented default is automatic selection, which the encoder
        // performs from the data — so an absent p4 must produce no mode AND no
        // message, or every ordinary MaxiCode would carry a warning.
        expect(mode('b80,100,M,"DATA"')).toBeUndefined();
        expect(codes('b80,100,M,"DATA"')).toEqual([]);
    });

    it('names a mode written in the wrong place instead of ignoring it', () => {
        // A stream that puts the mode where PDF417's option block goes is
        // readable but not the manual's form; saying so beats drawing the
        // wrong symbol quietly.
        expect(codes('b80,100,M,h5,m2,"DATA"')).toContain('epl-maxicode-mode-position');
        // The control: the correct positional form, with the data that modes 2
        // and 3 require. Those modes carry "cl,co,pc,lpm" (manual p. 3-26);
        // the bare "DATA" this test used to pass is not a structured carrier
        // message, and the encoder rejects it — the field used to fall back to
        // a placeholder box with nothing said. It is now named.
        expect(codes('b80,100,M,M2,"300,840,068107317,DATA"')).toEqual([]);
        expect(codes('b80,100,M,M2,"DATA"')).toContain('epl-maxicode-scm');
    });

    it('reassembles the "cl,co,pc,lpm" data into the SCM the encoder needs', () => {
        // Manual p. 3-26: modes 2 and 3 carry the class, country and postal
        // code as the leading fields of the DATA, comma-separated. The encoder
        // takes them INSIDE the data, GS-separated in AIM's order, and it
        // REJECTS the comma form — so before this, every EPL mode 2/3 MaxiCode
        // drew as a placeholder box, with `buildBwipSpec` reporting no problem
        // the whole time. The data is converted at parse, and this asserts the
        // encoded form rather than the message.
        const GS = '\u001d';
        const data = (src: string) => (parseEPL(`N\n${src}\nP1\n`).elements[0] as any)?.source?.data;

        expect(data('b80,100,M,M2,"300,840,068107317,DATA"')).toBe(`068107317${GS}840${GS}300${GS}DATA`);
        expect(data('b80,100,M,M3,"300,863,107317,DATA"')).toBe(`107317${GS}863${GS}300${GS}DATA`);
        // Modes 4 and 6 have no structured fields and pass through untouched.
        expect(data('b80,100,M,m4,"DATA"')).toBe('DATA');
        expect(data('b80,100,M,m6,"DATA"')).toBe('DATA');
    });

    it('ROUND TRIP: the generator writes the comma form back', () => {
        const parsed = parseEPL('N\nb80,100,M,M2,"300,840,068107317,DATA"\nP1\n');
        const el = parsed.elements[0] as any;
        const out = generateEPL(withFields([barcodeField({
            symbology: '14', maxiMode: 2, dataSource: { type: 'fixed', data: el.source.data },
        })]));
        // Back to class,country,post,message — the manual's own spelling.
        expect(out.epl).toContain('"300,840,068107317,DATA"');
        // and it re-parses to the same SCM.
        const back = parseEPL(`N\n${out.epl.split('\n').find(l => l.startsWith('b'))}\nP1\n`);
        expect((back.elements[0] as any).source.data).toBe(el.source.data);
    });
});
