// Batch U: verify the per-glyph advance tables match live measureText across
// point sizes, and that the monospace case stays byte-exact with the old 0.6em.
import './golden/setup';
import { describe, it, expect } from 'vitest';
import { newRealCanvas } from './golden/setup';
import { outlineTextBlockWidthDots } from '../services/ipl/fontMetrics';
import { OUTLINE_FONTS } from '../services/ipl/viewerParser';
import type { TextField } from '../types';

describe('outlineTextBlockWidthDots calibration', () => {
    const PX = 100;
    it('monospace is exactly 0.6em (byte-stability for existing goldens)', () => {
        const c = newRealCanvas(100, 100);
        const ctx = c.getContext('2d');
        // Measure at px scale, then express in per-mille of em
        ctx.font = `${PX}px "Liberation Mono"`;
        const measuredRatio = (+ctx.measureText('HELLO').width / (PX * 5)).toFixed(3); // W,H,E,L,O are uniform
        expect(measuredRatio).toBe('0.600'); // exact 0.6

        // Now via our table — should return exactly maxChars × 0.6hDots for any hDots
        const hDots = Math.round((12 / 72) * 203); // k12 at 203dpi
        expect(outlineTextBlockWidthDots(['HELLO'], hDots, 'monospace')).toBe(Math.round(hDots * 5 * 0.6));

        // Cross-check: same as canvas measure scaled to hDots
        const actual = Math.round(ctx.measureText('HELLO').width * hDots / PX);
        expect(outlineTextBlockWidthDots(['HELLO'], hDots, 'monospace')).toBe(actual);
    });

    it('proportional families deviate from 0.6 and are calibrated via table', () => {
        const c = newRealCanvas(100, 100);
        const ctx = c.getContext('2d');
        const familySans = '"Liberation Sans"';
        ctx.font = `${PX}px ${familySans}`;
        const sansMeasuredRatio = +ctx.measureText('HELLO').width / (PX * 5); // per-char
        expect(sansMeasuredRatio.toFixed(3)).not.toBe('0.600'); // Swiss narrow ≠ 0.6

        const hDots = Math.round((12 / 72) * 203);
        const sansTable = outlineTextBlockWidthDots(['HELLO'], hDots, 'sans-serif');
        const expectedByRatio = Math.round(sansMeasuredRatio * hDots * 5);
        // Table should match the measured ratio within ~1dot
        expect(sansTable).toBeCloseTo(expectedByRatio, -1);
        expect(sansTable).not.toBe(Math.round(hDots * 5 * 0.6)); // definitely not 0.6

        // Dutch Roman (c28) serif: also non-uniform
        ctx.font = `${PX}px "Liberation Serif"`;
        const serifMeasuredRatio = +ctx.measureText('HELLO').width / (PX * 5);
        expect(serifMeasuredRatio.toFixed(3)).not.toBe('0.600');
        const serifTable = outlineTextBlockWidthDots(['HELLO'], hDots, 'serif');
        const serifExpected = Math.round(serifMeasuredRatio * hDots * 5);
        expect(serifTable).toBeCloseTo(serifExpected, -1);
    });

    it('schoolbook (c67) matches the vendored Century Schoolbook substitute', () => {
        // c67 used to resolve to `serif`, which is Times-compatible (CG Times,
        // for c28/c66) and metered c67 ~10–13% narrow — 59.8 per-mille on
        // average versus the printer's face. TeX Gyre Schola (GUST Font
        // License) is metrically IDENTICAL to Century Schoolbook, so the table
        // below is measured off it and this pins the two together: if the
        // vendored .otf is ever swapped for a non-matching face, this fails
        // instead of silently metering every c67 field wrong.
        const c = newRealCanvas(100, 100);
        const ctx = c.getContext('2d');
        ctx.font = `${PX}px "TeX Gyre Schola"`;
        // The control that matters: an unresolvable family silently falls back
        // to a default face, so a typo'd name would still produce *a* width.
        // Two bogus names agreeing (and differing from this one) proves the
        // face really resolved.
        const bogusA = (() => { ctx.font = `${PX}px "BogusFamilyAAA"`; return ctx.measureText('PRODUCT NAME').width; })();
        const bogusB = (() => { ctx.font = `${PX}px "BogusFamilyBBB"`; return ctx.measureText('PRODUCT NAME').width; })();
        expect(bogusA).toBe(bogusB);
        ctx.font = `${PX}px "TeX Gyre Schola"`;
        expect(ctx.measureText('PRODUCT NAME').width).not.toBe(bogusA);

        for (const line of ['PRODUCT NAME', '0123456789', 'WWW iii', '.,:;()']) {
            const measuredEm = ctx.measureText(line).width / PX;
            const hDots = 34; // 12pt at 203dpi
            const tableW = outlineTextBlockWidthDots([line], hDots, 'schoolbook');
            expect(Math.abs(tableW - measuredEm * hDots), line).toBeLessThanOrEqual(1);
        }
    });

    it('schoolbook is genuinely distinct from serif and monospace', () => {
        // If these ever collapse to the same numbers the "fix" is a no-op and
        // c67 is back to being metered by a face it does not print in.
        const hDots = 34;
        const sb = outlineTextBlockWidthDots(['PRODUCT NAME'], hDots, 'schoolbook');
        expect(sb).not.toBe(outlineTextBlockWidthDots(['PRODUCT NAME'], hDots, 'serif'));
        expect(sb).not.toBe(outlineTextBlockWidthDots(['PRODUCT NAME'], hDots, 'monospace'));
        // Direction matters: Century Schoolbook runs WIDER than Times.
        expect(sb).toBeGreaterThan(outlineTextBlockWidthDots(['PRODUCT NAME'], hDots, 'serif'));
    });

    it('falls back to defaults for non-ASCII codepoints', () => {
        const hDots = Math.round((12 / 72) * 203);
        // SANS table: 'A'=667, 'B'=667; \x80 is outside printable ASCII →
        // DEFAULT 524/1000 em. Total = 667+524+667 = 1858/1000 em.
        const outSans = outlineTextBlockWidthDots(['A\x80B'], hDots, 'sans-serif');
        expect(outSans).toBeCloseTo(1.858 * hDots, 0);
        // and it must NOT be 3×0.6=1.8em — the default genuinely differs
        expect(outSans).not.toBeCloseTo(1.8 * hDots, 2);
    });

    // Wide (UAX #11) codepoints are a full em, and the family AVERAGE is not.
    // Charging 524 for a kanji measured a c50 field ~48% narrow: the box came
    // out 53 dots around 97 dots of ink, and the text ran past the label's
    // right edge. Measured in the browser, these are exactly 1000 per-mille in
    // both the sans and the mono stack, so the number is a property of the
    // glyphs rather than a fit.
    it('measures wide (CJK) codepoints at a full em, not the family average', () => {
        const hDots = Math.round((12 / 72) * 203); // 34
        for (const family of ['sans-serif', 'serif', 'schoolbook', 'monospace', undefined]) {
            // 3 chars -> 3.0 em exactly, whatever the family. The width helper
            // returns an unrounded dot count; callers round.
            expect(outlineTextBlockWidthDots(['日本語'], hDots, family),
                `3 kanji in ${family ?? 'undefined'}`).toBeCloseTo(3 * hDots, 6);
            // And it must NOT be the old average, which gave 53 dots instead
            // of 102 — the defect this pins.
            expect(outlineTextBlockWidthDots(['日本語'], hDots, family),
                `3 kanji in ${family ?? 'undefined'} must not use the ${family} average`)
                .not.toBeCloseTo(3 * 0.524 * hDots, 3);
        }
        // Fullwidth forms and Hangul are wide too; accented Latin is NOT.
        expect(outlineTextBlockWidthDots(['Ａ'], hDots, 'monospace')).toBeCloseTo(hDots, 6);
        expect(outlineTextBlockWidthDots(['가'], hDots, 'monospace')).toBeCloseTo(hDots, 6);
        expect(outlineTextBlockWidthDots(['é'], hDots, 'sans-serif')).toBeCloseTo(0.524 * hDots, 6);
    });

    it('the wide rule survives a mixed ASCII + CJK line', () => {
        const hDots = Math.round((12 / 72) * 203);
        // 'A'=667 (SANS), then two kanji at 1000 each.
        expect(outlineTextBlockWidthDots(['A日本'], hDots, 'sans-serif'))
            .toBeCloseTo((667 + 1000 + 1000) / 1000 * hDots, 6);
    });

    it('tables are scale-invariant (verify at 20,40,100px)', () => {
        const c = newRealCanvas(100, 100);
        const ctx = c.getContext('2d');
        const family = '"Liberation Sans"';
        for (const px of [20, 40, 100]) {
            ctx.font = `${px}px ${family}`;
            for (const line of ['0123456789', 'ABCDEF', '.,:;()']) {
                const measuredPx = ctx.measureText(line).width;
                const em = measuredPx / px; // whole-string width in em
                const hDots = Math.round((12 / 72) * px); // fake point-size scaled by px
                const tableW = outlineTextBlockWidthDots([line], hDots, 'sans-serif');
                const expected = Math.round(em * hDots);
                expect(Math.abs(tableW - expected), `${line}@${px}px`).toBeLessThanOrEqual(1); // within ~1dot
            }
        }
    });
});

describe('designer import reads rotated fields at their printed origin (Batch W identity)', () => {
    it('an f1 outline field imports at o directly — no width/height compensation', async () => {
        const { parseIPL } = await import('../services/iplParser');
        const dpi = 203;
        const text = 'SWISS 721 LABEL';
        const ipl = [
            '<STX><ESC>C<SI>W812<SI>L400<ETX>',
            '<STX><ESC>P<ETX>',
            '<STX>E1;F1;<ETX>',
            `<STX>H0;o400,300;c61;k14;f1;d3,${text}<ETX>`,
            '<STX>R<ETX>',
        ].join('\n');
        const d = parseIPL(ipl, dpi);
        const f = d.fields[0] as TextField;
        // Under the manual's CCW rule the printed origin IS the unrotated
        // top-left the designer stores — identity in both directions.
        expect(f.x).toBeCloseTo(400 / 8, 4);
        expect(f.y).toBeCloseTo(300 / 8, 4);
        expect(f.rotation).toBe(90);
    });
});
