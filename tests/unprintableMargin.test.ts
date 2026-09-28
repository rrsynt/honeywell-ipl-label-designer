import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UNPRINTABLE_MARGIN_MM, PRINTER_MODELS } from '../constants';

/**
 * The unprintable band is data, and data that was once guessed wrong. An
 * earlier revision carried a flat 1 mm for every model with a comment saying it
 * was "NOT a measured printer specification" — and it was wrong in both
 * directions: three times too small for the PD41, and inventing a band on the
 * PD43 that the driver says does not exist.
 *
 * These figures now come from the printer driver's own model table
 * (`ss#ipl.ddz` -> `Model.d`, `Stock.UnprintableWidth`). The values are pinned
 * here rather than trusted to a comment, because a plausible-looking number is
 * exactly what went wrong before.
 */
describe('UNPRINTABLE_MARGIN_MM', () => {
    it('states the driver\'s own figures for the models we ship', () => {
        // Model.d: PD43_203 / PC23d_203 / PC43d_203 / PM43_203 all read
        // "Stock.UnprintableWidth=0.00 in"; PD41_203 reads "=3.00 mm".
        expect(UNPRINTABLE_MARGIN_MM['PD43']).toBe(0);
        expect(UNPRINTABLE_MARGIN_MM['PD41']).toBe(3);
        // PD45S is not in the driver's table; PD43/PC43/PM43 all read 0.00.
        expect(UNPRINTABLE_MARGIN_MM['PD45S']).toBe(0);
        // No head to describe, so no band and no guide.
        expect(UNPRINTABLE_MARGIN_MM['Generic']).toBe(0);
    });

    it('is plausible for a thermal print head, which is the sanity bound', () => {
        // The driver's whole table spans 0.00 in to 0.12 in (with PD41 the
        // outlier at 3.00 mm). Anything outside that is a typo, not a finding.
        for (const [model, mm] of Object.entries(UNPRINTABLE_MARGIN_MM)) {
            expect(mm, `${model} must not be negative`).toBeGreaterThanOrEqual(0);
            expect(mm, `${model} is larger than any figure in the driver table`)
                .toBeLessThanOrEqual(4);
        }
    });

    it('covers every model the app offers', () => {
        // A model with no entry falls back to 0 and silently draws no guide,
        // which is the same failure mode as the guess — so the key set is
        // checked rather than assumed.
        for (const model of Object.keys(PRINTER_MODELS)) {
            expect(UNPRINTABLE_MARGIN_MM, `${model} has no margin entry`)
                .toHaveProperty([model]);
        }
    });

    it('is honest about what it does not model', () => {
        // The source table carries WIDTH only — there is no per-edge or
        // feed-axis key anywhere in Model.d — so a reader must not take these
        // as a four-sided margin. The comment above the constant says so; this
        // asserts the comment is still there, because deleting it would let the
        // next reader assume a feed-axis figure exists.
        const src = readFileSync(join(__dirname, '..', 'constants.ts'), 'utf8');
        const block = src.slice(src.indexOf('export const UNPRINTABLE_MARGIN_MM'));
        const header = src.slice(src.lastIndexOf('/**', src.indexOf('export const UNPRINTABLE_MARGIN_MM')), src.indexOf('export const UNPRINTABLE_MARGIN_MM'));
        expect(header).toContain('Stock.UnprintableWidth');
        expect(header).toMatch(/width only|cannot reach/i);
        expect(block.length).toBeGreaterThan(0);
    });
});
