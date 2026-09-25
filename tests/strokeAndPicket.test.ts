// Two renderer behaviours the render spec listed as "needs empirical
// calibration" (§15 items 2 and 3), now measured against BarTender output
// rather than guessed at.
//
// Both findings are worth pinning because each one contradicts an assumption
// that looks reasonable on its own:
//
//  * A box stroke could plausibly be centred on the declared l/h outline, or
//    drawn outside it. It is drawn INSIDE.
//  * The picket/drag note (PRM p.53) was called undecidable from a stream, and
//    the spec recommended a UI toggle. It is decidable: field direction f
//    determines whether the bars lie across the web or along the feed, and
//    only the across-the-web case widens w1 to 2.

import './golden/setup';
import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { loadImage, createCanvas } from '@napi-rs/canvas';
import { newRealCanvas } from './golden/setup';
import { bytesToByteString } from '../services/ipl/fileBytes';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { renderLabel, computeLabelExtent } from '../services/ipl/renderer';
import { ensureBarcodesReady } from '../services/ipl/barcodes';
import type { BarcodeElement } from '../services/ipl/types';

const stx = (f: string) => `<STX>${f}<ETX>`;

beforeAll(async () => { await ensureBarcodesReady(); });

/** Ink bounding box and a mid-line stroke width of an image. */
const measure = (img: { width: number; height: number }, draw: (ctx: any) => void) => {
    const c = createCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    draw(ctx);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const dark = (x: number, y: number) => data[(y * c.width + x) * 4] < 128;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
            if (dark(x, y)) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    return {
        w: maxX - minX + 1,
        h: maxY - minY + 1,
        minX, minY, maxX, maxY, dark,
    };
};

describe('box stroke is drawn INSIDE the l x h outline', () => {
    it('the BarTender export frame measures l x h on its OUTER edge', async () => {
        // samples/bartender-tes1.ipl declares "W3;f0;o13,14;h770;l492;w3".
        // The BarTender export was taken with the page turned 90 degrees, so
        // the box lands 770 wide x 492 tall. If the stroke were centred, the
        // outer ink would measure 492+3 x 770+3; if outward, 492+6 x 770+6.
        // It must measure the declared size itself.
        const img: any = await loadImage('testdata/bartender-tes1-export.png');
        const m = measure(img, ctx => ctx.drawImage(img, 0, 0));
        const DECLARED_L = 770, DECLARED_H = 492, STROKE = 3;
        expect(Math.abs(m.w - DECLARED_L), `outer width ${m.w} vs l=${DECLARED_L}`).toBeLessThanOrEqual(1);
        expect(Math.abs(m.h - DECLARED_H), `outer height ${m.h} vs h=${DECLARED_H}`).toBeLessThanOrEqual(1);
        // And the opening is smaller by the stroke on each side, which is what
        // "inside" means: the stroke eats into the declared rectangle.
        const midY = Math.round((m.minY + m.maxY) / 2);
        const midX = Math.round((m.minX + m.maxX) / 2);
        let left = 0; while (left < m.w && m.dark(m.minX + left, midY)) left++;
        let top = 0; while (top < m.h && m.dark(midX, m.minY + top)) top++;
        expect(left, 'left stroke width').toBeGreaterThanOrEqual(STROKE - 1);
        expect(top, 'top stroke width').toBeGreaterThanOrEqual(STROKE - 1);
    });

    it('our renderer agrees: the stroke eats inward, not outward', async () => {
        // Render the box alone so its own ink is unambiguous — tes1 also carries
        // text and barcodes above it, which a whole-image bbox would pick up.
        const label = parseViewerIPL([
            stx('<ESC>P'), stx('<SI>W600<ETX>'), stx('<SI>L400<ETX>'), stx('E1;F1'),
            stx('W2;f0;o20,30;l200;h150;w8'),
            stx('R'), stx('<ESC>E1'),
        ].join(''));
        const extent = computeLabelExtent(label, 203);
        const canvas = newRealCanvas(extent.widthDots, extent.heightDots);
        renderLabel(canvas as unknown as HTMLCanvasElement, label, extent, { dpi: 203, pxPerDot: 1, quality: 1 });
        const m = measure(canvas, ctx => ctx.drawImage(canvas as never, 0, 0));
        // Declared origin (20,30), size 200x150, stroke 8. Inside-drawing means
        // the ink starts exactly at (20,30) and ENDS at (219,179) — the outer
        // edge is the declared rectangle, so nothing pokes out and nothing is
        // lost. Centred drawing would start at 16; outward at 12.
        expect(m.minX, 'ink starts at declared ox').toBe(20);
        expect(m.minY, 'ink starts at declared oy').toBe(30);
        expect(m.maxX, 'ink ends at ox+l-1').toBe(20 + 200 - 1);
        expect(m.maxY, 'ink ends at oy+h-1').toBe(30 + 150 - 1);
    });
});

describe('w1 widens to 2 in picket mode only', () => {
    const parseBarcode = (f: number, w: number): BarcodeElement => {
        const label = parseViewerIPL([
            stx('<ESC>P'), stx('E1;F1'),
            stx(`B1;o40,40;f${f};c0;w${w};h80;d3,ABC123`),
            stx('R'), stx('<ESC>E1'),
        ].join(''));
        return label.elements.find(e => e.kind === 'barcode') as BarcodeElement;
    };
    const issuesOf = (f: number, w: number) => parseViewerIPL([
        stx('<ESC>P'), stx('E1;F1'),
        stx(`B1;o40,40;f${f};c0;w${w};h80;d3,ABC123`),
        stx('R'), stx('<ESC>E1'),
    ].join('')).issues;

    it('f0 and f2 are drag: bars run along the feed, w1 is kept', () => {
        // Verified on our renderer: f0/f2 draw vertical bars (row crossings
        // 20, column crossings 0 at the same module width).
        expect(parseBarcode(0, 1).moduleDots).toBe(1);
        expect(parseBarcode(2, 1).moduleDots).toBe(1);
        expect(issuesOf(0, 1).some(i => i.code === 'picket-width-widened')).toBe(false);
    });

    it('f1 and f3 are picket: bars cross the web, w1 becomes 2', () => {
        // f1/f3 draw HORIZONTAL bars, i.e. parallel to the print head, which is
        // picket mode. A 1-dot bar across the head is not physically reachable,
        // so the printer substitutes 2 (PRM p.53).
        expect(parseBarcode(1, 1).moduleDots).toBe(2);
        expect(parseBarcode(3, 1).moduleDots).toBe(2);
        expect(issuesOf(1, 1).some(i => i.code === 'picket-width-widened')).toBe(true);
    });

    it('a width the user asked for above 1 is left alone in both modes', () => {
        for (const f of [0, 1, 2, 3]) {
            expect(parseBarcode(f, 3).moduleDots, `f${f}`).toBe(3);
            expect(issuesOf(f, 3).some(i => i.code === 'picket-width-widened'), `f${f}`).toBe(false);
        }
    });

    it('the default w (absent) follows the same rule as an explicit w1', () => {
        // The manual default is 1 (PRM270 p.171), so a picket field with no w
        // must widen exactly as an explicit w1 does.
        const label = parseViewerIPL([
            stx('<ESC>P'), stx('E1;F1'), stx('B1;o40,40;f1;c0;h80;d3,ABC123'), stx('R'), stx('<ESC>E1'),
        ].join(''));
        const bc = label.elements.find(e => e.kind === 'barcode') as BarcodeElement;
        expect(bc.moduleDots).toBe(2);
    });

    it('the widened width is what actually gets drawn', () => {
        // The clamp has to reach the canvas, not just the model. Measure the
        // symbol LENGTH — the axis the bars advance along: drag (f0) lays it
        // along x, picket (f1) along y because the field is turned a quarter.
        // Same data and same h, so any length difference is the module width.
        const draw = (f: number, w: number) => {
            const label = parseViewerIPL([
                stx('<ESC>P'), stx('<SI>W600<ETX>'), stx('<SI>L600<ETX>'), stx('E1;F1'),
                stx(`B1;o40,40;f${f};c0;w${w};h80;i0;d3,ABC123`), stx('R'), stx('<ESC>E1'),
            ].join(''));
            const extent = computeLabelExtent(label, 203);
            const c = newRealCanvas(extent.widthDots, extent.heightDots);
            renderLabel(c as unknown as HTMLCanvasElement, label, extent, { dpi: 203, pxPerDot: 1, quality: 1 });
            const m = measure(c, ctx => ctx.drawImage(c as never, 0, 0));
            // f0 bars run along y, so the symbol advances along x; f1 the reverse.
            return f % 2 === 0 ? m.w : m.h;
        };

        // The decisive comparison: a w1 PICKET field must come out exactly like
        // a w2 picket field, because the printer promotes it before printing.
        expect(draw(1, 1), 'w1 picket == w2 picket').toBe(draw(1, 2));
        // ...and unlike the same field in drag mode, where w1 stays a single dot.
        expect(draw(0, 1)).not.toBe(draw(0, 2));
        // The module really doubled: same bar count, so ~2x the length.
        const ratio = draw(0, 2) / draw(0, 1);
        expect(ratio, `w2/w1 length ratio ${ratio}`).toBeGreaterThan(1.8);
        expect(ratio).toBeLessThan(2.2);
    });
});
