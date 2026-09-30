// Character rotation `rn` for human-readable fields (PRM p.170): 0 horizontal,
// 1 = 90° CCW. It is NOT the same thing as field direction `fn` (p.177), and
// the manual's own worked example (PRM p.40) uses both on one field:
//
//   f3;  Rotates field 8 by 270 degrees counterclockwise around the origin.
//   r1;  Rotates the characters in field 8 by 90 degrees counterclockwise.
//
// so `f` turns the whole field box while `r` turns each glyph in place with
// the advance still running along the field axis — together they give a column
// of upright characters. These tests pin that separation, because folding the
// two into one rotation is the obvious wrong reading.
import './golden/setup';
import { describe, it, expect } from 'vitest';
import { newRealCanvas } from './golden/setup';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { renderLabel, computeLabelExtent, estimateElementSize } from '../services/ipl/renderer';
import type { TextElement, BarcodeElement } from '../services/ipl/types';

const stx = (f: string) => `<STX>${f}<ETX>`;

const textEl = (label: ReturnType<typeof parseViewerIPL>, i = 0): TextElement =>
    label.elements.filter(e => e.kind === 'text')[i] as TextElement;

const parse = (fieldParams: string) => parseViewerIPL(
    [stx('<ESC>P'), stx('E1;F1'), stx(`H0;${fieldParams}`), stx('R'), stx('<ESC>E1')].join(''),
);

/**
 * Ink box and ink area of a rendered label. The canvas is sized generously
 * (240x240) rather than from computeLabelExtent, because a rotated field is
 * positioned relative to its origin and a tight extent can put the drawing
 * partly off-canvas -- which reads as "rotation broke the render".
 */
const inkBox = (fieldParams: string) => {
    const source = [
        stx('<ESC>P'), stx('<SI>W240<ETX>'), stx('<SI>L240<ETX>'),
        stx('E1;F1'), stx(`H0;${fieldParams}`), stx('R'), stx('<ESC>E1'),
    ].join('');
    const label = parseViewerIPL(source);
    const extent = computeLabelExtent(label, 203);
    const canvas = newRealCanvas(extent.widthDots, extent.heightDots);
    renderLabel(canvas as unknown as HTMLCanvasElement, label, extent, { dpi: 203, pxPerDot: 1, quality: 1 });
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, ink = 0;
    for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
            if (data[(y * canvas.width + x) * 4] < 128) {
                ink++;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    return { w: maxX - minX + 1, h: maxY - minY + 1, ink };
};

describe('charRotationOf parsing', () => {
    it('defaults to horizontal when r is absent', () => {
        expect(textEl(parse('o10,10;c0;d3,AB')).charRot).toBe(0);
    });

    it('reads r0 as horizontal and r1 as 90 degrees', () => {
        expect(textEl(parse('o10,10;c0;r0;d3,AB')).charRot).toBe(0);
        expect(textEl(parse('o10,10;c0;r1;d3,AB')).charRot).toBe(1);
    });

    it('warns and falls back for an undocumented rotation', () => {
        // The manual documents only 0 and 1 for text fields; it prints nothing
        // for 2/3, so inventing a 180/270 reading would be guesswork.
        const label = parse('o10,10;c0;r2;d3,AB');
        expect(textEl(label).charRot).toBe(0);
        expect(label.issues.some(i => i.code === 'char-rotation-invalid')).toBe(true);
    });

    it('applies to interpretive fields too', () => {
        const label = parseViewerIPL([
            stx('<ESC>P'), stx('E1;F1'),
            stx('B1;o10,10;c0;h50;w2;d3,99'),
            stx('I1;o10,80;c0;r1'),
            stx('R'), stx('<ESC>E1'),
        ].join(''));
        const interp = label.elements.filter(
            (e): e is TextElement => e.kind === 'text' && e.interpretiveOf !== undefined,
        )[0];
        expect(interp?.charRot).toBe(1);
    });
});

describe('r1 does not move the field box', () => {
    it('measures the same length and cross size as r0', () => {
        // The advance runs along the field axis either way, so every anchor
        // derived from estimateElementSize must be identical.
        const flat = textEl(parse('o10,10;c0;h2;w2;r0;d3,ABCDE'));
        const turned = textEl(parse('o10,10;c0;h2;w2;r1;d3,ABCDE'));
        expect(estimateElementSize(turned, 203)).toEqual(estimateElementSize(flat, 203));
    });
});

describe('r1 is a rotation: extents transpose, ink is conserved', () => {
    // 'L' is deliberately asymmetric — a square glyph (or a string) would
    // transpose its box into itself and prove nothing.
    const GLYPH = 'c25;k28;d3,L';

    it('r1 transposes the drawn box exactly as f3 does', () => {
        const flat = inkBox(`o80,60;${GLYPH}`);
        const turned = inkBox(`o80,60;r1;${GLYPH}`);
        const fieldTurned = inkBox(`o80,60;f3;r0;${GLYPH}`);
        // 90° rotation swaps width and height...
        expect(turned.w).toBe(flat.h);
        expect(turned.h).toBe(flat.w);
        // ...which is the same transposition a quarter-turned FIELD produces.
        expect(turned.w).toBe(fieldTurned.w);
        expect(turned.h).toBe(fieldTurned.h);
    });

    it('conserves ink (a rotation moves pixels, it does not lose them)', () => {
        const flat = inkBox(`o80,60;${GLYPH}`);
        const turned = inkBox(`o80,60;r1;${GLYPH}`);
        // Two anti-aliased rasterisations of the same glyph at the same size:
        // exact equality is not guaranteed, a few percent is.
        expect(turned.ink).toBeGreaterThan(flat.ink * 0.95);
        expect(turned.ink).toBeLessThan(flat.ink * 1.05);
    });

    it('f3 + r1 undoes the field turn, giving an upright column', () => {
        // The manual's own idiom (p.40): f3 turns the field, r1 un-turns the
        // glyphs. The pair must land back on the unrotated extents, which is
        // what "upright column" means geometrically.
        const flat = inkBox(`o80,60;f0;r0;${GLYPH}`);
        const both = inkBox(`o80,60;f3;r1;${GLYPH}`);
        expect(both.w).toBe(flat.w);
        expect(both.h).toBe(flat.h);
        // And the field really did carry both parameters.
        const label = parse('o80,60;c25;k28;f3;r1;d3,L');
        expect(textEl(label).f).toBe(3);
        expect(textEl(label).charRot).toBe(1);
    });
});

describe('the interpretive field sets its bar code\'s HRI font', () => {
    // PRM p.189 "Font Type, Select: Selects a font type for human-readable
    // fields" and the Bar Code Field table (p.171): enabling `i` creates an
    // interpretive field, and the In field is where that field's font is
    // stated. The renderer draws the HRI under the bar in font 0 at h2/w2 —
    // the DOCUMENTED DEFAULT (p.191) — so a stream naming anything else needs
    // it carried.
    //
    // The designer importer has always read this (services/iplParser.ts
    // harvests an hriFontMap); the VIEWER dropped it, so the same stream
    // previewed differently from how it imported. The IR already had the
    // fields for it — hriFont/hriPointSize existed on BarcodeElement but no
    // parser ever wrote them and no renderer ever read them, the same dead
    // declaration as ElementBase.reverse before it.
    const withInterp = (interp: string) => parseViewerIPL([
        stx('<ESC>C<SI>W812<SI>L400'),
        stx('<ESC>P'), stx('E1;F1'),
        stx('B1;o60,120;c6;h100;w2;i1;d3,12345678901'),
        stx(interp),
        stx('R'), stx('<ESC>E1'),
    ].join(''));
    const bar = (interp: string) =>
        withInterp(interp).elements.find(e => e.kind === 'barcode') as BarcodeElement;

    it('carries the font and point size the In names', () => {
        // The control first: with nothing declared, the fields stay absent and
        // the renderer's documented default applies.
        const plain = bar('I1');
        expect(plain.hriFont).toBeUndefined();
        expect(plain.hriPointSize).toBeUndefined();

        expect(bar('I1;c5').hriFont).toBe('5');
        expect(bar('I1;c5;k30').hriFont).toBe('5');
        expect(bar('I1;c5;k30').hriPointSize).toBe(30);
        // A point size with no font keeps the default face at the new size.
        expect(bar('I1;k30').hriFont).toBe('0');
        expect(bar('I1;k30').hriPointSize).toBe(30);
        // Naming font 0 explicitly is the default, so nothing is carried —
        // otherwise every ordinary stream would grow a field that means no
        // change.
        expect(bar('I1;c0').hriFont).toBeUndefined();
    });

    it('draws a taller HRI when the In asks for a point size', () => {
        // The IR carrying it is not the point; the PIXELS are. Measured in the
        // band beneath the bars: the default font 0 at h2 gives 13 dots, and
        // k30 raises it to 19. A font-only change moves the ink without moving
        // the height, because c5 has a bigger cell but fewer characters fit.
        const hri = (interp: string) => {
            const label = withInterp(interp);
            const extent = computeLabelExtent(label, 203);
            const PX = 2;
            const cv = newRealCanvas(extent.widthDots * PX, extent.heightDots * PX);
            renderLabel(cv as never, label, extent, { dpi: 203, pxPerDot: PX, quality: 1 });
            const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
            let ink = 0, minY = 1e9, maxY = -1;
            for (let y = Math.round(220 * PX); y < cv.height; y++)
                for (let x = Math.round(60 * PX); x < Math.round(500 * PX); x++) {
                    const o = (y * cv.width + x) * 4;
                    if (d[o] < 100 && d[o + 1] < 100 && d[o + 2] < 100) {
                        ink++; if (y < minY) minY = y; if (y > maxY) maxY = y;
                    }
                }
            return { ink, height: maxY < 0 ? 0 : Math.round((maxY - minY + 1) / PX) };
        };
        const base = hri('I1');
        const sized = hri('I1;k30');
        expect(base.ink, 'the default HRI must draw — control').toBeGreaterThan(0);
        // The ink height, not the cell height: font 0's cell at h2 is 18 dots
        // but digits do not fill it, so a 10-16 band is the honest statement.
        // Pinning the exact figure would freeze a font-metric artefact.
        expect(base.height).toBeGreaterThan(9);
        expect(base.height).toBeLessThan(17);
        expect(sized.height, `k30 should be taller (base ${base.height}, sized ${sized.height})`).toBeGreaterThan(base.height);
        expect(sized.ink).toBeGreaterThan(base.ink);
    });
});
