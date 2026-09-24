// Workstream 5 (2026-09-24): BarTender's own output, round-tripped through our
// parser with no manual step in between.
//
// Every .ipl here is printed by BarTender 2022 R8 (tools/bartender/
// PrintToFile.cs) and every PNG is BarTender's own preview of the same .btw
// (tools/bartender/PreviewExport.cs). Nothing was hand-written or hand-corrected,
// which is the point: the other BarTender samples were produced one driver
// setting at a time, so the audit behind them could only compare what it already
// knew to expect.
//
// Two sources, because they fail differently. `bartender-auto` is a shipped
// Seagull template, so its layout is not ours. `bartender-parity-base` is a
// format we specified ourselves and placed in the Format Builder -- the one case
// where we know what every object was meant to be, so a wrong parse is
// unambiguous rather than a matter of judgement.
//
// What is asserted is that the stream parses into real content at the geometry
// BarTender laid out. A format that parses to an empty label, or one whose
// extent is wildly off, would be a silent pass, so the element inventory and
// the ink arrangement are both pinned.
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

/**
 * `rotation` is the stock orientation BarTender applied during page setup,
 * OUTSIDE the IPL stream (no q/S/M frame exists -- see
 * docs/HANDOFF-IPL-RENDER.md). Measured per sample, not assumed: 1 is 90 CCW.
 * `expect` lists the object inventory the format was built to contain.
 */
const CASES = [
    {
        name: 'bartender-auto',
        ipl: 'samples/bartender-auto.ipl',
        png: 'testdata/bartender/pti-voice-pick-code.png',
        // The PTI template's page setup is a 2x5 label grid; only the top-left
        // cell carries content, so the comparison is confined to it.
        grid: [2, 5] as const,
        rotation: 1,
        expect: { barcode: 2, box: 1 },
    },
    {
        name: 'bartender-parity-base',
        ipl: 'samples/bartender-parity-base.ipl',
        png: 'testdata/bartender/parity-base.png',
        // Single-label format, so the preview is the label itself rather than
        // a page grid. `grid` says how many label cells the canvas holds.
        grid: [1, 1] as const,
        rotation: 0,
        expect: { barcode: 3, box: 1 },
    },
] as const;

for (const c of CASES) {
    describe(`BarTender auto-printed stream: ${c.name}`, () => {
        const label = parseViewerIPL(bytesToByteString(readFileSync(c.ipl)));

        it('parses without warnings or errors', () => {
            // BarTender emits an empty <ESC>g0 per print block (the payload is a
            // bare CRLF), so the "0 strips" info line is expected, not a defect.
            const bad = label.issues.filter((i) => i.level !== 'info');
            expect(bad, bad.map((i) => i.message).join('\n')).toEqual([]);
        });

        it('yields the object inventory the format defines', () => {
            const kinds = label.elements.reduce<Record<string, number>>((acc, el) => {
                acc[el.kind] = (acc[el.kind] ?? 0) + 1;
                return acc;
            }, {});
            for (const [kind, n] of Object.entries(c.expect)) {
                expect(kinds[kind], JSON.stringify(kinds)).toBe(n);
            }
            expect(kinds.unknown, JSON.stringify(label.elements.filter((e) => e.kind === 'unknown')))
                .toBeUndefined();
        });

        it('renders a non-empty label at the extent BarTender set', () => {
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

        // Completeness guard. The per-element check below is one-sided — a box
        // that landed on other ink still passes — so a stream carrying only a
        // fraction of the format's content could pass it while the preview is
        // visibly missing most of the label. The bogus tes2 pairing scored 21%
        // and passed anyway. This asserts we paint a comparable share of the
        // ink BarTender painted for the same format.
        it('renders a comparable share of the export ink (completeness)', async () => {
            const extent = computeLabelExtent(label, 203);
            const rotated = c.rotation % 2 === 1;
            const ours = newRealCanvas(
                rotated ? extent.heightDots : extent.widthDots,
                rotated ? extent.widthDots : extent.heightDots);
            renderLabel(ours as unknown as HTMLCanvasElement, label, extent,
                { dpi: 203, pxPerDot: 1, quality: 1, rotation: c.rotation });

            const img = await loadImage(c.png);
            const cellW = Math.floor(img.width / c.grid[0]), cellH = Math.floor(img.height / c.grid[1]);
            const exp = newRealCanvas(cellW, cellH);
            exp.getContext('2d').drawImage(img, 0, 0, cellW, cellH, 0, 0, cellW, cellH);

            const count = (cv: { width: number; height: number; getContext(k: '2d'): any }) => {
                const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
                let n = 0;
                for (let o = 0; o < d.length; o += 4) {
                    if (d[o + 3] > 0 && d[o] < 100 && d[o + 1] < 100 && d[o + 2] < 100) n++;
                }
                return n;
            };
            const ourInk = count(ours as never), btInk = count(exp as never);
            const ratio = ourInk / btInk;
            expect(ratio, `our ink ${ourInk} vs BarTender ${btInk} (${(ratio * 100).toFixed(0)}%)`)
                .toBeGreaterThan(0.6);
            expect(ratio, `our ink ${ourInk} vs BarTender ${btInk} (${(ratio * 100).toFixed(0)}%)`)
                .toBeLessThan(1.6);
        }, 60000);

        it('reproduces the content BarTender drew for the same format', async () => {
            // The preview PNG is BarTender's own rendering of the same .btw. Its
            // canvas is a 2x5 label grid at 203 dpi in which only the top-left
            // cell is printed, so the comparison is confined to that cell.
            //
            // The stream may carry no <SI>L, in which case the viewer falls back
            // to content bounds while BarTender clips to its page setup. Canvas
            // extents then differ by design and are not compared; what is
            // compared is the ink's arrangement.
            const img = await loadImage(c.png);
            const cellW = Math.floor(img.width / c.grid[0]), cellH = Math.floor(img.height / c.grid[1]);
            const exp = newRealCanvas(cellW, cellH);
            exp.getContext('2d').drawImage(img, 0, 0, cellW, cellH, 0, 0, cellW, cellH);

            const extent = computeLabelExtent(label, 203);
            const rotated = c.rotation % 2 === 1;
            const ours = newRealCanvas(
                rotated ? extent.heightDots : extent.widthDots,
                rotated ? extent.widthDots : extent.heightDots);
            renderLabel(ours as unknown as HTMLCanvasElement, label, extent,
                { dpi: 203, pxPerDot: 1, quality: 1, rotation: c.rotation });

            const analyse = (cv: typeof exp) => {
                const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
                const m = new Uint8Array(cv.width * cv.height);
                let ink = 0;
                for (let i = 0; i < m.length; i++) {
                    const o = i * 4;
                    if (!(d[o + 3] > 0 && d[o] < 100 && d[o + 1] < 100 && d[o + 2] < 100)) continue;
                    m[i] = 1; ink++;
                }
                return { mask: m, ink };
            };
            const centroid = (cv: typeof exp, m: Uint8Array) => {
                let sx = 0, sy = 0, n = 0;
                for (let i = 0; i < m.length; i++) {
                    if (!m[i]) continue;
                    sx += i % cv.width; sy += (i / cv.width) | 0; n++;
                }
                return { x: sx / n, y: sy / n };
            };

            const oursInk = analyse(ours as never);
            const expInk = analyse(exp as never);
            expect(oursInk.ink, 'our render has no ink').toBeGreaterThan(1000);
            expect(expInk.ink, 'BarTender preview cell has no ink').toBeGreaterThan(1000);

            // The page turn is a rotation of everything, applied outside the
            // stream. elementVisualBox has already applied each field's own `f`
            // rotation, so this is the only remaining transform. 1 is a 90 CCW
            // turn, which swaps the axes; 0 leaves boxes alone.
            type Box = { x: number; y: number; w: number; h: number };
            const mapBox = c.rotation % 4 === 1
                ? (b: Box): Box => ({
                    x: b.y, y: extent.widthDots - (b.x + b.w), w: b.h, h: b.w,
                })
                : (b: Box) => b;

            // BarTender positions the content inside its stock, which the stream
            // does not describe, so the two renders start at different points.
            // Origin-alignment alone is not enough: it pins the top-left of the
            // ink, and a 90 turn moves that corner to a different element.
            // Aligning on the ink centroid is stable under the rotation.
            const oursC = centroid(ours as never, oursInk.mask);
            const expC = centroid(exp as never, expInk.mask);
            const dx = expC.x - oursC.x, dy = expC.y - oursC.y;

            const misses: string[] = [];
            for (const el of label.elements) {
                if (el.kind === 'unknown') continue;
                const o = elementVisualBox(el, 203);
                const b = mapBox(o);
                const rx = Math.round(b.x + dx), ry = Math.round(b.y + dy);
                let hits = 0, scanned = 0;
                for (let y = Math.max(0, ry); y < Math.min(cellH, ry + b.h); y++) {
                    for (let x = Math.max(0, rx); x < Math.min(cellW, rx + b.w); x++) {
                        scanned++;
                        if (expInk.mask[y * cellW + x]) hits++;
                    }
                }
                // BarTender's encoders pick different module patterns than
                // bwip-js and its rasterizer differs from ours, so a box is
                // scored on covering the export's ink, not on matching it.
                if (scanned === 0 || hits * 20 < scanned) {
                    misses.push(`${el.kind} @${o.x},${o.y} ${o.w}x${o.h} covers ${hits}/${scanned}`);
                }
            }
            expect(misses, misses.join('\n')).toEqual([]);
        }, 60000);
    });
}
