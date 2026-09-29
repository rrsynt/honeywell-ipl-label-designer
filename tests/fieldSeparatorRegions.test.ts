import { describe, it, expect } from 'vitest';
import { resolveLabelAtBatch } from '../services/ipl/odometer';
import type { ViewerLabel } from '../services/ipl/types';

/**
 * The two Field Separator commands, PRM 2.70:
 *
 *   Numeric Field Separator       <FS>data<FS>   p.111
 *   Alphanumeric Field Separator  <GS>data<GS>   p.97
 *
 * Both say the same thing about regions, and both say it twice:
 *   "You must enclose the data between two sets of <FS>/<GS> commands"
 *   "You may have more than one region in a field as long as they do not
 *    overlap. Each region independently increments or decrements."
 *
 * The odometer accepted only `<FS>…<FS>` and `<FS>…<GS>` — so a correctly
 * written `<GS>data<GS>` region, the shape the manual's own example uses
 * ("<STX><CR><ESC>I1<GS>A<GS><ETX>", p.97), never matched. It neither advanced
 * nor warned: the delimiters were stripped and the value printed constant, so
 * an alphanumeric serial counter looked like a static field.
 */
describe('the alphanumeric <GS> region advances', () => {
    /** The odometer reads an element's fixed data; build the minimum it needs. */
    const label = (data: string, serialStep = 1): ViewerLabel => ({
        widthDots: 812, heightDots: 406,
        elements: [{
            kind: 'text', id: 1, ox: 10, oy: 10, f: 0, font: '0', hMag: 2, wMag: 2,
            source: { type: 'fixed', data }, serialStep,
        } as never],
        issues: [], settings: {},
    } as ViewerLabel);

    const dataAt = (d: string, b: number, step?: number): string =>
        ((resolveLabelAtBatch(label(d, step), b, 203).elements[0] as { source: { data: string } }).source).data;

    it('advances the documented <GS>…<GS> shape', () => {
        // The manual's example payload, advanced per batch.
        expect(dataAt('A<GS>AB<GS>B', 1)).toBe('AACB');
        expect(dataAt('A<GS>AB<GS>B', 2)).toBe('AADB');
        expect(dataAt('A<GS>AB<GS>B', 3)).toBe('AAEB');
    });

    it('keeps the alphabet the manual defines, 0-9 then A-Z', () => {
        // "The order of the characters is 0, 1, 2...8, 9, A, B, C...Y, Z, 0, 1"
        // — so 9 rolls into A, and Z rolls into 0.
        expect(dataAt('<GS>9<GS>', 1)).toBe('A');
        expect(dataAt('<GS>Z<GS>', 1)).toBe('0');
        expect(dataAt('<GS>ZZ<GS>', 1)).toBe('00');
    });

    it('ignores non-alphanumerics inside the region, per the manual', () => {
        // Two rules meet here, and they are not the same rule:
        //   "The printer ignores any non-alphanumeric characters within this
        //    region."        — the character contributes no VALUE
        //   "The length of data does not change."  — it keeps its POSITION
        // So "A-1" advances to "A-2": the dash stays put and the value moves.
        // (Strip it instead and the width shrinks; count it as a digit and the
        // value shifts a place — the first version of this did the latter and
        // produced "0A2".)
        expect(dataAt('<GS>A-1<GS>', 1)).toBe('A-2');
        expect(dataAt('<GS>A-1<GS>', 2)).toBe('A-3');
        expect(dataAt('<GS>1/2<GS>', 1)).toBe('1/3');
    });

    it('still advances the numeric <FS> shape', () => {
        expect(dataAt('A<FS>0001<FS>B', 1)).toBe('A0002B');
        expect(dataAt('A<FS>99<FS>B', 1)).toBe('A00B'); // odometer wrap
    });

    it('advances EVERY region in the field, independently', () => {
        // "You may have more than one region in a field as long as they do not
        // overlap. Each region independently increments or decrements."
        expect(dataAt('A<FS>01<FS>x<FS>99<FS>B', 1)).toBe('A02x00B');
        expect(dataAt('A<FS>01<FS>x<GS>AB<GS>B', 1)).toBe('A02xACB');
        expect(dataAt('<FS>1<FS>-<FS>2<FS>-<FS>3<FS>', 1)).toBe('2-3-4');
    });

    it('honours the field own step, including a negative one', () => {
        expect(dataAt('<GS>AB<GS>', 2, 1)).toBe('AD');
        expect(dataAt('<GS>AB<GS>', 1, -1)).toBe('AA');
        // Step 0 is <ESC>N, "Increment and Decrement, Disable": the value holds.
        expect(dataAt('<GS>AB<GS>', 3, 0)).toBe('AB');
    });

    it('never prints the delimiters themselves', () => {
        // They are control markers, not text.
        for (const d of ['<FS>01<FS>', '<GS>AB<GS>', 'x<FS>1<FS>y<GS>2<GS>z']) {
            expect(dataAt(d, 1)).not.toMatch(/<F?GS?>/);
        }
    });
});
