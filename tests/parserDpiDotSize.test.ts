// A printer stream states its sizes in DOTS. The preview renders at the
// resolution the reader selects (203 / 300 / 406), and the IR carries an
// OUTLINE field's size as `pointSize`, which the renderer turns back into dots
// as `pointSize / 72 * dpi`. So any parser that converts a dot size to a point
// size MUST divide by the same dpi — or the field draws too large at 300/406.
//
// Only the OUTLINE path is affected: a BITMAP field carries hMag/wMag (dots)
// and the renderer ignores its pointSize, so the same conversion there is
// harmless. This file pins the three parsers that DO reach the outline path:
//   ZPL  ^A0        -> c25
//   IPL  c25 h/w    -> c25
//   DPL  font 9 hhhh -> c25
// Each had a hardcoded 203 (dfb1295 for ZPL; the DPL/IPL sites fixed with it),
// so a field drew bigger the higher the dpi instead of staying the size the
// stream asked for. The invariant: THE DRAWN SIZE IS THE DECLARED DOT SIZE,
// at every dpi.
import './golden/setup';
import { describe, it, expect } from 'vitest';
import { parseZPL } from '../services/zpl/zplParser';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { parseDPL } from '../services/dpl/dplParser';
import { estimateElementSize } from '../services/ipl/renderer';

const crossDots = (el: unknown, dpi: number): number => estimateElementSize(el as never, dpi).crossDots;

describe('a declared dot size draws the same at 203, 300 and 406 dpi', () => {
    // ZPL: ^A0N,50,50 declares a 50-dot-tall field.
    const zpl = (dpi: 203 | 300 | 406) =>
        crossDots(parseZPL('^XA^PW800^LL520^FO50,50^A0N,50,50^FDtext^FS^XZ', dpi).elements[0], dpi);

    // IPL: c25 h17 declares a 17-dot base height (no k, so h drives the size).
    const ipl = (dpi: 203 | 300 | 406) => {
        const code = '<STX><ESC>P<ETX><STX>E1;F1<ETX><STX>H0;o10,10;c25;h17;w17;d3,HELLO<ETX><STX>R<ETX>';
        return crossDots(parseViewerIPL(code, { dpi }).elements[0], dpi);
    };

    // DPL: font 9 with a four-digit height field, in DOTS (0040 = 40).
    const dpl = (dpi: 203 | 300 | 406) => {
        const rec = `1911S000020` + '0200' + '0040' + '0040' + 'Text';
        return crossDots(parseDPL(`\x02L\r${rec}\rE\r`, 406, new Date(), dpi).elements[0], dpi);
    };

    const cases: Array<[string, (dpi: number) => number, number]> = [
        ['ZPL ^A0 50 dots', zpl, 50],
        ['IPL c25 h17', ipl, 17],
        ['DPL font 9 0040', dpl, 40],
    ];

    for (const [name, draw, declared] of cases) {
        it(`${name}: flat across dpi, near the declared height`, () => {
            const at203 = draw(203);
            const at300 = draw(300);
            const at406 = draw(406);
            // Sanity: the size is in the right ballpark of what was declared
            // (allow the outline line-height leading, ~1 to 1.45x).
            for (const [dpi, h] of [[203, at203], [300, at300], [406, at406]] as const) {
                expect(h, `${name} at ${dpi} dpi`).toBeGreaterThanOrEqual(declared * 0.9);
                expect(h, `${name} at ${dpi} dpi`).toBeLessThanOrEqual(declared * 1.6);
            }
            // The invariant: it must NOT grow with dpi. Before the fix each of
            // these grew roughly with the dpi ratio (e.g. ZPL 39 -> 75 -> 155
            // dots across 203 -> 300 -> 406).
            expect(at300, `${name}: 300 must not exceed 203 by much`).toBeLessThan(at203 * 1.25);
            expect(at406, `${name}: 406 must not exceed 203 by much`).toBeLessThan(at203 * 1.25);
        });
    }

    it('does not touch a BITMAP field, which is already in dots', () => {
        // The control: c2 is a bitmap cell, so h17 is magnification-like dots and
        // the render ignores pointSize — identical at every dpi, before and after.
        const bitmap = (dpi: 203 | 300 | 406) => {
            const code = '<STX><ESC>P<ETX><STX>E1;F1<ETX><STX>H0;o10,10;c2;h3;w3;d3,HELLO<ETX><STX>R<ETX>';
            return crossDots(parseViewerIPL(code, { dpi }).elements[0], dpi);
        };
        expect(bitmap(203)).toBe(bitmap(300));
        expect(bitmap(300)).toBe(bitmap(406));
    });
});