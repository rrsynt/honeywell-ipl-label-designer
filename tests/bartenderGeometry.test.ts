// Geometry parity against BarTender's own exported PNGs
// (testdata/bartender-tes1-export.png).
//
// BarTender rotates the whole label during page setup, OUTSIDE the IPL stream
// (no q/S/M frame exists — see docs/HANDOFF-IPL-RENDER.md), so the comparison
// renders with the viewer's rotation preview. Measured, not assumed: rotation
// 1 (90° CCW) reproduces the export's arrangement; rotation 3 (90° CW) mirrors
// it.
//
// What is asserted is placement, not pixels. BarTender's barcode encoders and
// bwip-js pick different module patterns for the same data, and its text
// rasterizer differs from ours, so a pixel diff is meaningless. Instead every
// element box — rotated, then shifted so our ink origin meets the export's —
// must cover a minimum density of the export's ink. A field that moved, or
// whose size drifted, lands on blank paper and fails.
//
// `bartender-tes2` was REMOVED 2026-09-24. It is NOT a decoder bug and the
// earlier suite was not proving parity: `samples/bartender-tes2.ipl` decodes to
// exactly 4 Direct Graphics — the widest is 112 dot — while
// `testdata/bartender-tes2-export.png` contains a 625px rule and three lines of
// text, none of which can fit in those graphics. The stream and the export are
// not the same format, so the comparison was meaningless and passed vacuously.
// Regenerate a real pair with tools/bartender/PrintToFile.exe +
// PreviewExport.exe before adding a third sample back.
import './golden/setup';
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadImage } from '@napi-rs/canvas';
import { newRealCanvas } from './golden/setup';
import { bytesToByteString } from '../services/ipl/fileBytes';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { renderLabel, computeLabelExtent, elementVisualBox } from '../services/ipl/renderer';
import { ensureBarcodesReady } from '../services/ipl/barcodes';

beforeAll(async () => { await ensureBarcodesReady(); });

const inkExtent = (canvas: { width: number; height: number; getContext(k: '2d'): any }): [number, number] => {
    const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let x0 = canvas.width, y0 = canvas.height;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const o = (y * canvas.width + x) * 4;
        if (d[o + 3] > 0 && d[o] < 100 && d[o + 1] < 100 && d[o + 2] < 100) {
            if (x < x0) x0 = x; if (y < y0) y0 = y;
        }
    }
    return [x0, y0];
};

const inkMask = (canvas: { width: number; height: number; getContext(k: '2d'): any }): Uint8Array => {
    const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const m = new Uint8Array(canvas.width * canvas.height);
    for (let i = 0; i < m.length; i++) {
        const o = i * 4;
        if (d[o + 3] > 0 && d[o] < 100 && d[o + 1] < 100 && d[o + 2] < 100) m[i] = 1;
    }
    return m;
};

const popcount = (m: Uint8Array): number => {
    let n = 0;
    for (let i = 0; i < m.length; i++) n += m[i];
    return n;
};

describe('BarTender export geometry', () => {
    it('bartender-tes1: every element box covers export ink after a 90° CCW turn', async () => {
        const label = parseViewerIPL(bytesToByteString(readFileSync('samples/bartender-tes1.ipl')));
        const extent = computeLabelExtent(label, 203);
        const ours = newRealCanvas(10, 10);
        renderLabel(ours as unknown as HTMLCanvasElement, label, extent,
            { dpi: 203, pxPerDot: 1, quality: 1, rotation: 1 });

        const img = await loadImage('testdata/bartender-tes1-export.png');
        const exp = newRealCanvas(img.width, img.height);
        exp.getContext('2d').drawImage(img, 0, 0);

        const [ox, oy] = inkExtent(ours as never);
        const [ex, ey] = inkExtent(exp as never);
        const dx = ex - ox, dy = ey - oy;
        const mask = inkMask(exp as never);

        const misses: string[] = [];
        for (const el of label.elements) {
            if (el.kind === 'unknown') continue;
            const b = elementVisualBox(el, 203);
            // 90° CCW takes dot (x, y) to canvas (y, widthDots - 1 - x).
            const rx = Math.round(b.y + dx);
            const ry = Math.round(extent.widthDots - (b.x + b.w) + dy);
            const rw = Math.round(b.h), rh = Math.round(b.w);
            let inkCount = 0, scanned = 0;
            for (let y = Math.max(0, ry); y < Math.min(img.height, ry + rh); y++) {
                for (let x = Math.max(0, rx); x < Math.min(img.width, rx + rw); x++) {
                    scanned++;
                    if (mask[y * img.width + x]) inkCount++;
                }
            }
            // One ink dot per 20 of box area: far below every measured box
            // (the sparsest boxes here, tes1's single-digit rules, sit near 1 in
            // 3) and far above the zero a misplaced box scores.
            if (scanned === 0 || inkCount * 20 < scanned) {
                misses.push(`${el.kind} @${b.x},${b.y} ${b.w}x${b.h} covers ${inkCount}/${scanned} export px`);
            }
        }
        expect(misses, misses.join('\n')).toEqual([]);
    }, 60000);

    // The placement check above is one-sided: a box that moved ONTO other ink
    // still passes, and a stream that renders far LESS than the export passes
    // too. This is the check that caught the bogus tes2 pairing, so it guards
    // the guard — a real BarTender stream cannot be missing most of its ink.
    it('bartender-tes1: we render a comparable amount of ink to the export', async () => {
        const label = parseViewerIPL(bytesToByteString(readFileSync('samples/bartender-tes1.ipl')));
        const extent = computeLabelExtent(label, 203);
        const ours = newRealCanvas(extent.heightDots, extent.widthDots);
        renderLabel(ours as unknown as HTMLCanvasElement, label, extent,
            { dpi: 203, pxPerDot: 1, quality: 1, rotation: 1 });

        const img = await loadImage('testdata/bartender-tes1-export.png');
        const exp = newRealCanvas(img.width, img.height);
        exp.getContext('2d').drawImage(img, 0, 0);

        const ourInk = popcount(inkMask(ours as never));
        const btInk = popcount(inkMask(exp as never));
        // BarTender and bwip-js choose different module patterns and our
        // outline-font proxy is slightly heavier, so an exact ratio is not
        // meaningful — but a stream that renders a fifth of the export's ink
        // is not a parity case, it is a different format (tes2 scored 21%).
        const ratio = ourInk / btInk;
        expect(ratio, `our ink ${ourInk} vs BarTender ${btInk} (${(ratio * 100).toFixed(0)}%)`)
            .toBeGreaterThan(0.6);
        expect(ratio, `our ink ${ourInk} vs BarTender ${btInk} (${(ratio * 100).toFixed(0)}%)`)
            .toBeLessThan(1.6);
    }, 60000);
});
