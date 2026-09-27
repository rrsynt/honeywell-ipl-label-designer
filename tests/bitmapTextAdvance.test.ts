// Bitmap-font text: the painted advance must equal the printer's model
// (cell width + intercharacter gap, both × w magnification), and the `m`
// parameter of `c` must override the gap.
//
// Why this file exists: every layout quantity (field box, border b, anchors,
// extent, designer selection box) is computed from the cell model — while the
// paint path let `ctx.fillText` use Liberation Mono's own 0.6 em advance. The
// two disagreed by ~33% for c0 (5.4 painted vs 8 modeled dots per character),
// and `w` magnification — "each letter in the field twice as wide", PRM p.55 —
// changed nothing on screen at all. No golden or sample stream contains a
// bitmap-font TEXT field (they use outline c20-c41), so nothing caught it.
//
// The manual's own example is the oracle (PRM270 p.54 / DevGuide p.30):
//   "the letters in font c0 are 7 dots wide by 9 dots high, with a 1-dot gap
//    between characters. If you design a field that prints 10 letters in font
//    c0, the field will be 79 dots wide by 9 dots high."
//
// `m` syntax is from the K10 command reference (Font Type, Select) and every
// PRM edition: `c n [, m ][, p ]` — "m: Intercharacter gap (space between
// characters)". Editions differ on the default when m is absent: PRM says "the
// printer uses the default value of the selected font" (the 1/2-dot values
// above), K10 says "Default is 0". The font default is kept when m is absent,
// because that is the model the 79-dot example pins; the K10 discrepancy is
// recorded in docs/HONEYWELL-SIMULATOR.md rather than silently chosen.

import './golden/setup';
import { describe, it, expect } from 'vitest';
import { newRealCanvas } from './golden/setup';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { renderLabel, computeLabelExtent, estimateElementSize } from '../services/ipl/renderer';
import type { TextElement } from '../services/ipl/types';

const stx = (f: string) => `<STX>${f}<ETX>`;

const parseField = (params: string) => parseViewerIPL([
    stx('<ESC>P'), stx('<SI>W900<ETX>'), stx('<SI>L600<ETX>'),
    stx('E1;F1'), stx(`H0;${params}`), stx('R'), stx('<ESC>E1'),
].join(''));

const textEl = (label: ReturnType<typeof parseViewerIPL>): TextElement =>
    label.elements.find(e => e.kind === 'text') as TextElement;

/**
 * Ink bounding box of a rendered field, in dots. The scan skips a 3-dot
 * margin: renderLabel strokes the physical label edge with a 55%-opacity
 * indigo hairline (renderer.ts "Hairline border marking the physical label
 * edge"), which is UI chrome, not printed ink — counting it would report every
 * field as the size of the whole label.
 */
const inkBox = (label: ReturnType<typeof parseViewerIPL>) => {
    const extent = computeLabelExtent(label, 203);
    const canvas = newRealCanvas(extent.widthDots, extent.heightDots);
    renderLabel(canvas as unknown as HTMLCanvasElement, label, extent, { dpi: 203, pxPerDot: 1, quality: 1 });
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let minX = canvas.width, maxX = -1, minY = canvas.height, maxY = -1;
    for (let y = 3; y < canvas.height - 3; y++) {
        for (let x = 3; x < canvas.width - 3; x++) {
            const i = (y * canvas.width + x) * 4;
            // Any dark ink, including the antialiased edges of small glyphs.
            if (data[i] < 200) {
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
            }
        }
    }
    return { w: maxX - minX + 1, h: maxY - minY + 1 };
};

/** Painted per-character pitch: measured as the difference between a long run
 *  and a single glyph, so glyph ink width cancels out. */
const paintedPitch = (font: string, h: number, w: number, gap?: number) => {
    const c = gap === undefined ? `c${font}` : `c${font},${gap}`;
    const one = inkBox(parseField(`o20,20;${c};h${h};w${w};d3,H`)).w;
    const many = inkBox(parseField(`o20,20;${c};h${h};w${w};d3,${'H'.repeat(21)}`)).w;
    return (many - one) / 20;
};

describe('bitmap text: painted advance matches the printer cell model', () => {
    // Cell widths from constants.FONT_MAP (PRM270 §7.3): c0 7×9 gap1,
    // c2 10×14 gap2, c7 5×7 gap2. Per-character advance = cellWidth + gap.
    const CELLS: Array<{ font: string; cell: number; gap: number }> = [
        { font: '0', cell: 7, gap: 1 },
        { font: '2', cell: 10, gap: 2 },
        { font: '7', cell: 5, gap: 2 },
    ];

    for (const { font, cell, gap } of CELLS) {
        for (const w of [1, 2, 3]) {
            it(`c${font} at w${w} advances ${((cell + gap) * w)} dots per character`, () => {
                expect(paintedPitch(font, 2, w)).toBeCloseTo((cell + gap) * w, 0);
            });
        }
    }

    it('the manual example: 10 characters of c0 are 79 dots wide (PRM270 p.54)', () => {
        const label = parseField('o20,20;c0;h2;w2;d3,ABCDEFGHIJ');
        const el = textEl(label);
        expect(estimateElementSize(el, 203).lengthDots, 'model').toBe(158); // h/w default to 2
        // Painted ink spans the advance box: 9 advances + the last glyph cell.
        const { w } = inkBox(label);
        expect(w).toBeGreaterThanOrEqual(150);
        expect(w).toBeLessThanOrEqual(158);
    });

    it('w magnification visibly widens the run (was a no-op on screen)', () => {
        const at = (w: number) => inkBox(parseField(`o20,20;c0;h2;w${w};d3,${'H'.repeat(10)}`)).w;
        const w1 = at(1), w2 = at(2), w3 = at(3);
        expect(w2 - w1).toBeGreaterThan(w1 * 0.8); // ~doubles
        expect(w3 - w2).toBeGreaterThan(w2 - w1 - 2); // keeps scaling
    });
});

describe('c parameter m: intercharacter gap override', () => {
    it('parses m into the element and leaves it undefined when absent', () => {
        expect(textEl(parseField('o10,10;c0;d3,AB')).intercharGapDots).toBeUndefined();
        expect(textEl(parseField('o10,10;c0,4;d3,AB')).intercharGapDots).toBe(4);
        expect(textEl(parseField('o10,10;c2,-3;d3,AB')).intercharGapDots).toBe(-3);
    });

    it('m replaces the font default: c0,4 advances 11 dots per character', () => {
        // cell 7 + gap 4 = 11 (default would be 7 + 1 = 8).
        expect(paintedPitch('0', 2, 1, 4)).toBeCloseTo(11, 0);
    });

    it('the model box follows m, so layout and paint agree', () => {
        const el = textEl(parseField('o10,10;c0,4;h2;w2;d3,ABCDEFGHIJ'));
        // 10 chars × (7+4) × 2 mag − last gap 4 × 2 = 220 − 8 = 212.
        expect(estimateElementSize(el, 203).lengthDots).toBe(212);
    });

    it('a negative m overlaps characters instead of being clamped away', () => {
        // cell 7 + (-3) = 4 dots per character: the printer prints the overlap,
        // so the preview must show it rather than quietly spacing normally.
        expect(paintedPitch('0', 2, 1, -3)).toBeCloseTo(4, 0);
        const el = textEl(parseField('o10,10;c0,-3;h2;w2;d3,ABCDEFGHIJ'));
        expect(estimateElementSize(el, 203).lengthDots).toBeGreaterThan(0);
        expect(estimateElementSize(el, 203).lengthDots).toBeLessThan(158);
    });

    it('warns when m is outside the documented range', () => {
        const issues = parseViewerIPL([
            stx('<ESC>P'), stx('<SI>W900<ETX>'), stx('<SI>L600<ETX>'),
            stx('E1;F1'), stx('H0;o10,10;c0,900;d3,AB'), stx('R'), stx('<ESC>E1'),
        ].join('')).issues;
        expect(issues.some(i => i.code === 'interchar-gap-out-of-range')).toBe(true);
        // In range (K10: -199..399) must stay silent.
        const ok = parseViewerIPL([
            stx('<ESC>P'), stx('<SI>W900<ETX>'), stx('<SI>L600<ETX>'),
            stx('E1;F1'), stx('H0;o10,10;c0,399;d3,AB'), stx('R'), stx('<ESC>E1'),
        ].join('')).issues;
        expect(ok.some(i => i.code === 'interchar-gap-out-of-range')).toBe(false);
    });

    // The gap applies to outline faces too: "Selects a font type for
    // human-readable and interpretive fields" is not restricted to the bitmap
    // ids, and this is the example the roadmap chose to prove it.
    it('c25,3 vs c25: an outline field is exactly 3 × (chars − 1) dots wider', () => {
        const chars = 12;
        const plain = estimateElementSize(textEl(parseField(`o20,20;c25;k12;d3,${'H'.repeat(chars)}`)), 203).lengthDots;
        const gapped = estimateElementSize(textEl(parseField(`o20,20;c25,3;k12;d3,${'H'.repeat(chars)}`)), 203).lengthDots;
        expect(gapped - plain).toBe(3 * (chars - 1));
    });

    it('outline m shows up in ink, not just in the model', () => {
        const at = (m?: number) => inkBox(parseField(`o20,20;c25${m === undefined ? '' : `,${m}`};k12;d3,${'H'.repeat(12)}`)).w;
        expect(at(3) - at()).toBeGreaterThanOrEqual(3 * 11 - 4);
        expect(at(3) - at()).toBeLessThanOrEqual(3 * 11 + 4);
    });

    it('a negative outline m tightens the run', () => {
        const plain = estimateElementSize(textEl(parseField(`o20,20;c25;k12;d3,${'H'.repeat(12)}`)), 203).lengthDots;
        const tight = estimateElementSize(textEl(parseField(`o20,20;c25,-4;k12;d3,${'H'.repeat(12)}`)), 203).lengthDots;
        expect(tight - plain).toBe(-4 * 11);
    });

    it('m is not mistaken for a barcode substream parameter on H frames', () => {
        // On B frames c is "Bar Code, Select Type" with its own m meanings;
        // H must not inherit those. Both frames carry m here.
        const label = parseViewerIPL([
            stx('<ESC>P'), stx('<SI>W900<ETX>'), stx('<SI>L600<ETX>'),
            stx('E1;F1'), stx('H0;o10,10;c0,5;d3,AB'),
            stx('B1;o10,30;c6,0,0,1;h60;w2;d3,12345678'),
            stx('R'), stx('<ESC>E1'),
        ].join(''));
        const text = textEl(label);
        expect(text.intercharGapDots).toBe(5);
        const barcode = label.elements.find(e => e.kind === 'barcode') as { symbology: string };
        expect(barcode.symbology).toBe('6');
    });
});
