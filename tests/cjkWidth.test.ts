// CJK must paint at the width fontMetrics charges it.
//
// fontMetrics.ts charges a full em (1000 per-mille) for a wide codepoint, which
// is what the printer does. But the vendored faces (Liberation, Inconsolata,
// TeX Gyre Schola) contain no CJK glyphs at all, so the stack decides what
// actually gets drawn. Before the CJK fallback was added, naming only a Latin
// face sent the ideographs to a host fallback that drew them at 0.75 em through
// the sans stack and 0.60 em through the mono one — the field was metered wide
// and painted narrow, and c50/c51 are exactly the Kanji ids.
//
// This measures the RENDERED advance, not the stack string, so it fails if a
// future stack edit reintroduces the mismatch.
import './golden/setup';
import { describe, it, expect } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { FONT_FAMILIES, type FontFamily } from '../constants';
import { outlineTextBlockWidthDots } from '../services/ipl/fontMetrics';

const EM = 200;

/** Rendered advance per character, in em. */
const advancePerEm = (family: FontFamily, text: string): number => {
    const c = createCanvas(EM * 10, EM * 3);
    const ctx = c.getContext('2d');
    ctx.font = `${EM}px ${FONT_FAMILIES[family]}`;
    return ctx.measureText(text).width / text.length / EM;
};

/** Whether any ink is drawn at all — a missing glyph draws nothing. */
const inkPixels = (family: FontFamily, text: string): number => {
    const c = createCanvas(EM * 6, EM * 3);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#000000'; ctx.font = `${EM}px ${FONT_FAMILIES[family]}`;
    ctx.textBaseline = 'top'; ctx.fillText(text, 8, 8);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 128) n++;
    return n;
};

const CJK = '漢字';

describe('CJK is painted at the full em the layout math charges', () => {
    // The measurement must be able to detect a wrong stack, or it proves
    // nothing: a stack of Latin-only faces is the exact regression to catch.
    it('the control — a Latin-only stack does NOT reach a full em', () => {
        const c = createCanvas(EM * 10, EM * 3);
        const ctx = c.getContext('2d');
        ctx.font = `${EM}px "Liberation Sans", Arial, Helvetica, sans-serif`;
        const ratio = ctx.measureText(CJK).width / CJK.length / EM;
        expect(ratio, 'a Latin-only stack should NOT measure a full em, or this test is blind')
            .toBeLessThan(0.95);
    });

    it('every family reaches a full em for kanji', () => {
        for (const family of Object.keys(FONT_FAMILIES) as FontFamily[]) {
            const ratio = advancePerEm(family, CJK);
            expect(ratio, `${family} kanji advance ${ratio.toFixed(3)} em`)
                .toBeGreaterThan(0.95);
            expect(ratio, `${family} kanji advance ${ratio.toFixed(3)} em`)
                .toBeLessThan(1.05);
        }
    });

    it('kanji actually draw ink in every family', () => {
        for (const family of Object.keys(FONT_FAMILIES) as FontFamily[]) {
            expect(inkPixels(family, CJK), `${family} drew no kanji ink`)
                .toBeGreaterThan(200);
        }
    });

    it('the Latin advance of each family is unchanged by the CJK fallback', () => {
        // The CJK names sit after the Latin face, so Latin text must still
        // measure what the calibrated tables expect. A sampling of two glyphs
        // per family is enough: any CJK face winning for Latin would move these
        // far more than the tolerance below.
        const mono = advancePerEm('monospace', 'HH');
        expect(mono, `monospace Latin advance ${mono.toFixed(3)}`).toBeCloseTo(0.600, 2);
        const sans = advancePerEm('sans-serif', 'HH');
        expect(sans, `sans-serif Latin advance ${sans.toFixed(3)}`).toBeCloseTo(0.722, 2);
    });

    it('the layout math still charges a full em for a wide codepoint', () => {
        // The renderer's side of the contract. If this ever changed to match a
        // narrow fallback instead of the printer, the two would agree again but
        // both would be wrong.
        expect(outlineTextBlockWidthDots(['漢'], 1000, 'sans-serif')).toBe(1000);
        expect(outlineTextBlockWidthDots(['漢'], 1000, 'monospace')).toBe(1000);
        expect(outlineTextBlockWidthDots(['漢'], 1000, 'letter-gothic')).toBe(1000);
    });
});
