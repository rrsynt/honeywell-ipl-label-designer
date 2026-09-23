// Workstream 2 remainder (2026-09-24): geometry parity against BarTender's own
// exported PNGs (testdata/bartender-tes{1,2}-export.png).
//
// BarTender rotates the whole label during page setup, OUTSIDE the IPL stream
// (no q/S/M frame exists — see docs/HANDOFF-IPL-RENDER.md), so the comparison
// renders with the viewer's rotation preview. Measured, not assumed: rotation
// 1 (90° CCW) reproduces the export's arrangement; rotation 3 (90° CW) mirrors
// it. The earlier "90° CW" note had the direction backwards.
//
// What is asserted is placement, not pixels. BarTender's barcode encoders and
// bwip-js pick different module patterns for the same data, and its text
// rasterizer differs from ours, so a pixel diff is meaningless. Instead every
// element box — rotated, then shifted so our ink origin meets the export's —
// must cover a minimum density of the export's ink. A field that moved, or
// whose size drifted, lands on blank paper and fails.
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

describe('BarTender export geometry', () => {
    for (const sample of ['bartender-tes1', 'bartender-tes2']) {
        it(`${sample}: every element box covers export ink after a 90° CCW turn`, async () => {
            const label = parseViewerIPL(bytesToByteString(readFileSync(`samples/${sample}.ipl`)));
            const extent = computeLabelExtent(label, 203);
            const ours = newRealCanvas(10, 10);
            renderLabel(ours as unknown as HTMLCanvasElement, label, extent,
                { dpi: 203, pxPerDot: 1, quality: 1, rotation: 1 });

            const img = await loadImage(`testdata/${sample}-export.png`);
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
                // (the sparsest, tes2's single-dot rules, sit near 1 in 3) and
                // far above the zero a misplaced box scores.
                if (scanned === 0 || inkCount * 20 < scanned) {
                    misses.push(`${el.kind} @${b.x},${b.y} ${b.w}x${b.h} covers ${inkCount}/${scanned} export px`);
                }
            }
            expect(misses, misses.join('\n')).toEqual([]);
        }, 60000);
    }
});
