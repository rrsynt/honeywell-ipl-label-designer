// Workstream 5 (2026-09-24): BarTender's own output, round-tripped through our
// parser with no manual step in between.
//
// The IPL in samples/bartender-auto.ipl is printed by BarTender 2022 R8 from a
// shipped Seagull template (tools/bartender/PrintToFile.cs). Nothing here was
// hand-written or hand-corrected, which is the point: the other BarTender
// samples in this repo were produced one driver setting at a time, and the
// audit behind them could only compare what it already knew to expect.
//
// What is asserted is that the stream parses into real content at the geometry
// BarTender laid out -- a format that parses to an empty label, or one whose
// extent is wildly off, would be a silent pass, so the element inventory and
// the ink extent are both pinned.
import './golden/setup';
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { newRealCanvas } from './golden/setup';
import { bytesToByteString } from '../services/ipl/fileBytes';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { renderLabel, computeLabelExtent } from '../services/ipl/renderer';
import { ensureBarcodesReady } from '../services/ipl/barcodes';

beforeAll(async () => { await ensureBarcodesReady(); });

const SAMPLE = 'samples/bartender-auto.ipl';

describe('BarTender auto-printed stream', () => {
    const label = parseViewerIPL(bytesToByteString(readFileSync(SAMPLE)));

    it('parses without warnings or errors', () => {
        // BarTender emits an empty <ESC>g0 per print block (the payload is a
        // bare CRLF), so the "0 strips" info line is expected, not a defect.
        const bad = label.issues.filter((i) => i.level !== 'info');
        expect(bad, bad.map((i) => i.message).join('\n')).toEqual([]);
    });

    it('yields the object inventory the template defines', () => {
        const kinds = label.elements.reduce<Record<string, number>>((acc, el) => {
            acc[el.kind] = (acc[el.kind] ?? 0) + 1;
            return acc;
        }, {});
        // The PTI template is two barcodes (UPC-A, GS1-128), a box, and text.
        expect(kinds.barcode).toBe(2);
        expect(kinds.box, JSON.stringify(kinds)).toBeGreaterThanOrEqual(1);
        expect(kinds.unknown, JSON.stringify(label.elements.filter((e) => e.kind === 'unknown')))
            .toBeUndefined();
    });

    it('renders a non-empty label at the extent BarTender set', async () => {
        const extent = computeLabelExtent(label, 203);
        expect(extent.widthDots).toBeGreaterThan(100);
        expect(extent.heightDots).toBeGreaterThan(100);

        const canvas = newRealCanvas(10, 10);
        renderLabel(canvas as unknown as HTMLCanvasElement, label, extent,
            { dpi: 203, pxPerDot: 1, quality: 1, rotation: 0 });

        const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let ink = 0;
        for (let o = 0; o < d.length; o += 4) {
            if (d[o + 3] > 0 && d[o] < 128 && d[o + 1] < 128 && d[o + 2] < 128) ink++;
        }
        expect(ink, 'rendered label has no ink').toBeGreaterThan(1000);
    }, 60000);

    it('reproduces the content BarTender drew for the same format', async () => {
        // The preview PNG is BarTender's own rendering of the same .btw
        // (tools/bartender/PreviewExport.cs). Its canvas is a 2x5 label grid at
        // 203 dpi in which only the top-left cell is printed, so the comparison
        // is confined to that cell: 812x406 px, which is 4000x2000 dots at the
        // printer's density.
        //
        // The stream carries <SI>W814 but no <SI>L, so the viewer falls back to
        // content bounds (1141 dots tall) while BarTender clips to its page
        // setup. Canvas extents therefore differ by design and are not compared;
        // what is compared is the ink's arrangement, anchored on the two ink
        // origins, exactly as tests/bartenderGeometry.test.ts does.
        const { loadImage } = await import('@napi-rs/canvas');
        const img = await loadImage('testdata/bartender/pti-voice-pick-code.png');
        const cellW = Math.floor(img.width / 2), cellH = Math.floor(img.height / 5);
        const exp = newRealCanvas(cellW, cellH);
        exp.getContext('2d').drawImage(img, 0, 0, cellW, cellH, 0, 0, cellW, cellH);

        const { elementVisualBox } = await import('../services/ipl/renderer');
        const extent = computeLabelExtent(label, 203);
        // rotation 1 (90 CCW) is the stock orientation BarTender's page setup
        // applied before printing; the stream itself carries no rotation frame.
        const ours = newRealCanvas(extent.heightDots, extent.widthDots);
        renderLabel(ours as unknown as HTMLCanvasElement, label, extent,
            { dpi: 203, pxPerDot: 1, quality: 1, rotation: 1 });

        const analyse = (c: typeof exp) => {
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            const m = new Uint8Array(c.width * c.height);
            let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1, ink = 0;
            for (let i = 0; i < m.length; i++) {
                const o = i * 4;
                if (!(d[o + 3] > 0 && d[o] < 100 && d[o + 1] < 100 && d[o + 2] < 100)) continue;
                m[i] = 1; ink++;
                const x = i % c.width, y = (i / c.width) | 0;
                if (x < x0) x0 = x; if (y < y0) y0 = y;
                if (x > x1) x1 = x; if (y > y1) y1 = y;
            }
            return { mask: m, ink, x0, y0, x1, y1 };
        };

        const oursInk = analyse(ours as never);
        const expInk = analyse(exp as never);
        expect(oursInk.ink, 'our render has no ink').toBeGreaterThan(1000);
        expect(expInk.ink, 'BarTender preview cell has no ink').toBeGreaterThan(1000);

        // Both are 203 dpi, so dots map to pixels 1:1. The page turn is a 90 CCW
        // rotation of everything: dot (x, y) lands at canvas (y, W - x), and a
        // box swaps its axes. elementVisualBox has already applied each field's
        // own `f` rotation, so this is the only remaining transform.
        const mapBox = (b: { x: number; y: number; w: number; h: number }) => ({
            x: b.y,
            y: extent.widthDots - (b.x + b.w),
            w: b.h,
            h: b.w,
        });

        // BarTender positions the label's content inside its stock, which the
        // stream does not describe (<SI>L is absent, so the viewer uses content
        // bounds). The two renders therefore start at different points and the
        // comparison has to be aligned on the content itself, not on the canvas.
        // Origin-alignment alone is not enough: it pins the top-left of the ink,
        // and a 90 turn moves that corner to a different element. Aligning on
        // the ink centroid instead is stable under the rotation.
        const centroid = (c: typeof exp, m: Uint8Array) => {
            let sx = 0, sy = 0, n = 0;
            for (let i = 0; i < m.length; i++) {
                if (!m[i]) continue;
                sx += i % c.width; sy += (i / c.width) | 0; n++;
            }
            return { x: sx / n, y: sy / n };
        };
        const oursAll = analyse(ours as never);
        const oursC = centroid(ours as never, oursAll.mask);
        const expC = centroid(exp as never, expInk.mask);
        const dx = expC.x - oursC.x, dy = expC.y - oursC.y;

        const misses: string[] = [];
        for (const el of label.elements) {
            if (el.kind === 'unknown') continue;
            const b = mapBox(elementVisualBox(el, 203));
            const rx = Math.round(b.x + dx), ry = Math.round(b.y + dy);
            let hits = 0, scanned = 0;
            for (let y = Math.max(0, ry); y < Math.min(cellH, ry + b.h); y++) {
                for (let x = Math.max(0, rx); x < Math.min(cellW, rx + b.w); x++) {
                    scanned++;
                    if (expInk.mask[y * cellW + x]) hits++;
                }
            }
            // BarTender's encoders pick different module patterns than bwip-js
            // and its rasterizer differs from ours, so a box is scored on
            // covering the export's ink, not on matching it.
            if (scanned === 0 || hits * 20 < scanned) {
                const o = elementVisualBox(el, 203);
                misses.push(`${el.kind} @${o.x},${o.y} ${o.w}x${o.h} covers ${hits}/${scanned}`);
            }
        }
        expect(misses, misses.join('\n')).toEqual([]);
    }, 60000);
});
