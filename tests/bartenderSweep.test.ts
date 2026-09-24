// Parity against BarTender-AUTHORED formats, as opposed to the two hand-placed
// samples in bartenderGeometry/bartenderAuto.
//
// These fixtures are special because BarTender itself placed every object:
// tools/bartender/BuildParityLabels.cs creates each .btw through the script
// language (the only route whose documents accept design-object writes -- see
// the header of that file), then PrintToFile.exe produces the .ipl and
// PreviewExport.exe the .png. So the object coordinates are BarTender's, not
// ours, and any placement disagreement is a renderer bug rather than a
// transcription error.
//
// The grid case is the one that found the 0x24 "Repeat Last Line" bug: a solid
// 0.5in box is emitted as one inked column plus repeats, and dropping the
// repeats rendered a hollow 1-dot rule. Its ink total matched BarTender's even
// while the picture was wrong, which is why these cases assert the PICTURE and
// not just the ink count.
import './golden/setup';
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadImage } from '@napi-rs/canvas';
import { newRealCanvas } from './golden/setup';
import { bytesToByteString } from '../services/ipl/fileBytes';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { renderLabel, computeLabelExtent } from '../services/ipl/renderer';
import { ensureBarcodesReady } from '../services/ipl/barcodes';

beforeAll(async () => { await ensureBarcodesReady(); });

const maskOf = (cv: any) => {
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const m = new Uint8Array(cv.width * cv.height);
    for (let i = 0; i < m.length; i++) {
        const o = i * 4;
        if (d[o + 3] > 0 && d[o] < 100 && d[o + 1] < 100 && d[o + 2] < 100) m[i] = 1;
    }
    return m;
};
const pop = (m: Uint8Array) => { let n = 0; for (let i = 0; i < m.length; i++) n += m[i]; return n; };
const inkOrigin = (m: Uint8Array, W: number, H: number) => {
    let x0 = W, y0 = H;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x]) { if (x < x0) x0 = x; if (y < y0) y0 = y; }
    return [x0, y0] as const;
};
const centroid = (m: Uint8Array, W: number) => {
    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i < m.length; i++) if (m[i]) { sx += i % W; sy += (i / W) | 0; n++; }
    return { x: sx / n, y: sy / n };
};

type Case = { name: string; ipl: string; png: string; minScore: number };

// Scores were measured on 2026-09-24 at 1 dot = 1 px, aligned on the INK ORIGIN
// (not the centroid: on a multi-object label a centroid offset can be dragged by
// one shifted group, which is what made the first round of transform matching
// report a 94% "mirror" that was really two object groups overlapping).
//
// The band is deliberately not 100%: the residual is the page-turn model plus
// BarTender's own edge rasterisation, neither a placement error. What these
// numbers DO catch is a decoder that drops or misplaces content -- the 0x24 bug
// scored 57% here.
//
// Both cases are btPortrait against a landscape stock, so their previews are
// quarter-turned by the page setup. `bartenderPageTurn.test.ts` proves that with
// a controlled landscape/portrait pair, so a low score here means a placement
// problem and not a missing rotation.
const CASES: Case[] = [
    // 16 solid 0.5in boxes on a 4x4in lattice. Caught the 0x24 bug.
    { name: 'grid', ipl: 'samples/bartender-sweep-grid.ipl', png: 'testdata/bartender-sweep-grid.png', minScore: 0.90 },
    // 6 tall boxes on 6x2in landscape stock.
    { name: 'landscape', ipl: 'samples/bartender-sweep-landscape.ipl', png: 'testdata/bartender-sweep-landscape.png', minScore: 0.95 },
];

describe('BarTender-authored geometry parity', () => {
    for (const c of CASES) {
        it(`${c.name}: our render reproduces BarTender's picture`, async () => {
            const label = parseViewerIPL(bytesToByteString(readFileSync(c.ipl)));
            const extent = computeLabelExtent(label, 203);
            const img = await loadImage(c.png);
            const exp = newRealCanvas(img.width, img.height);
            exp.getContext('2d').drawImage(img, 0, 0);
            const eM = maskOf(exp);
            expect(pop(eM), 'BarTender preview is blank').toBeGreaterThan(1000);

            let best = { score: -1, rot: 0 };
            for (const rot of [0, 1, 2, 3] as const) {
                const R = rot % 2 === 1;
                const W = R ? extent.heightDots : extent.widthDots;
                const H = R ? extent.widthDots : extent.heightDots;
                const ours = newRealCanvas(W, H);
                renderLabel(ours as unknown as HTMLCanvasElement, label, extent,
                    { dpi: 203, pxPerDot: 1, quality: 1, rotation: rot });
                const oM = maskOf(ours);
                if (!pop(oM)) continue;
                // Ink-ORIGIN alignment on a padded canvas. Centroid alignment
                // was tried first and is wrong for multi-object labels: one
                // displaced group drags the shared centroid and the score then
                // says nothing about any individual object.
                const [ox, oy] = inkOrigin(oM, W, H);
                const CW = img.width + 200, CH = img.height + 200;
                const eP = newRealCanvas(CW, CH);
                eP.getContext('2d').drawImage(exp as any, 0, 0);
                const ePM = maskOf(eP as any);
                const [ex, ey] = inkOrigin(ePM, CW, CH);
                const oP = newRealCanvas(CW, CH);
                oP.getContext('2d').drawImage(ours as any, ex - ox, ey - oy);
                const pM = maskOf(oP as any);
                let hit = 0;
                for (let i = 0; i < pM.length; i++) if (pM[i] && ePM[i]) hit++;
                const score = hit / Math.max(1, Math.min(pop(pM), pop(ePM)));
                if (score > best.score) best = { score, rot };
            }

            expect(best.score, `${c.name}: best overlap ${(best.score * 100).toFixed(0)}% at rotation ${best.rot}`)
                .toBeGreaterThanOrEqual(c.minScore);
        }, 120000);
    }

    it('a repeated column is honoured, so a solid box stays solid', () => {
        // The specific mechanism behind the grid case, asserted directly: the
        // stream carries 0x24 repeats, and the decoded bitmap must contain the
        // repeated columns' ink.
        const label = parseViewerIPL(bytesToByteString(readFileSync('samples/bartender-sweep-grid.ipl')));
        const gfx = label.elements.filter(e => e.kind === 'graphic') as any[];
        expect(gfx.length).toBeGreaterThan(0);
        for (const g of gfx) {
            const rows: string[] = Object.keys(g.data).map(k => g.data[k] as string);
            // A 109-dot-tall solid box cannot produce fewer than 100 rows.
            expect(rows.length, `graphic at ${g.ox},${g.oy} decoded ${rows.length} rows`).toBeGreaterThan(100);
        }
    });
});
