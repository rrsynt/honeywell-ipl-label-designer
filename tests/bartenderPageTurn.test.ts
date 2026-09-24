// Pins WHY a BarTender preview can look rotated when the stream is not.
//
// The 2026-09-24 sweep produced 16 cases whose previews did not match our render
// at first glance, and they looked like a 45-degree rotation bug. They were not.
// The cause is the one already documented for tes1 (docs/HANDOFF-IPL-RENDER.md):
// BarTender's PAGE SETUP rotates the stock, and that rotation lives outside the
// IPL stream -- there is no q/S/M/T frame in any of these files. A format
// authored btPortrait against a landscape stock is previewed turned 90 degrees
// while the stream still says <ESC>C<SI>W591.
//
// The evidence is a controlled pair: the SAME box, the SAME size and position,
// differing only in the page orientation the script requested.
//
//   one-box             btPortrait  -> preview 593x593  matches at rotation 90
//   one-box-landscape   btLandscape -> preview 796x390  matches at rotation 0
//
// Without the second case this is indistinguishable from a decoder bug, and a
// whole-day search "found" a 94% antiTranspose match on a multi-object fixture
// that was really one object group drifting onto another.
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

/** Overlap of our render against the preview after a quarter-turn preview, aligned
 *  on the ink origin. A single object per label makes this unambiguous. */
const scoreAt = (label: any, extent: any, preview: any, rotation: number) => {
    const R = rotation % 2 === 1;
    const W = R ? extent.heightDots : extent.widthDots;
    const H = R ? extent.widthDots : extent.heightDots;
    const ours = newRealCanvas(W, H);
    renderLabel(ours as unknown as HTMLCanvasElement, label, extent,
        { dpi: 203, pxPerDot: 1, quality: 1, rotation });
    const oM = maskOf(ours);
    const [ox, oy] = inkOrigin(oM, W, H);

    const CW = preview.width + 200, CH = preview.height + 200;
    const eC = newRealCanvas(CW, CH);
    eC.getContext('2d').drawImage(preview as any, 0, 0);
    const eM = maskOf(eC as any);
    const [ex, ey] = inkOrigin(eM, CW, CH);

    const oC = newRealCanvas(CW, CH);
    oC.getContext('2d').drawImage(ours as any, ex - ox, ey - oy);
    const placed = maskOf(oC as any);

    let hit = 0;
    for (let i = 0; i < placed.length; i++) if (placed[i] && eM[i]) hit++;
    return hit / Math.max(1, Math.min(pop(placed), pop(eM)));
};

const load = (name: string) => {
    const label = parseViewerIPL(bytesToByteString(readFileSync(`samples/bartender-sweep-${name}.ipl`)));
    return { label, extent: computeLabelExtent(label, 203) };
};

const loadPreview = async (name: string) => {
    const img = await loadImage(`testdata/bartender-sweep-${name}.png`);
    const cv = newRealCanvas(img.width, img.height);
    cv.getContext('2d').drawImage(img, 0, 0);
    return cv as never;
};

describe('BarTender page-turn is a page-setup property, not a stream rotation', () => {
    it('a btPortrait format is previewed quarter-turned, a btLandscape one is not', async () => {
        const portrait = load('one-box');
        const landscape = load('one-box-landscape');
        const pPreview = await loadPreview('one-box');
        const lPreview = await loadPreview('one-box-landscape');

        // Neither stream asks for a rotation: no page-direction q, no page
        // create S, no page placement M/m/O, no field template T. That is the
        // whole point -- the turn is not in the data we are rendering.
        for (const f of ['one-box', 'one-box-landscape']) {
            const raw = bytesToByteString(readFileSync(`samples/bartender-sweep-${f}.ipl`));
            expect(raw, `${f} must contain no rotation command`)
                .not.toMatch(/<STX>q\d|<SI>S\d|<STX><ESC>[SMOT]/);
        }

        // The landscape control matches as-is.
        const landAsIs = scoreAt(landscape.label, landscape.extent, lPreview, 0);
        const landTurned = Math.max(
            scoreAt(landscape.label, landscape.extent, lPreview, 1),
            scoreAt(landscape.label, landscape.extent, lPreview, 3));
        expect(landAsIs, `landscape as-is ${(landAsIs * 100).toFixed(0)}% vs turned ${(landTurned * 100).toFixed(0)}%`)
            .toBeGreaterThan(0.85);

        // The portrait format does NOT match as-is, but does at a quarter turn.
        const portAsIs = scoreAt(portrait.label, portrait.extent, pPreview, 0);
        const portTurned = Math.max(
            scoreAt(portrait.label, portrait.extent, pPreview, 1),
            scoreAt(portrait.label, portrait.extent, pPreview, 3));
        expect(portAsIs, 'portrait must not match unrotated').toBeLessThan(0.5);
        expect(portTurned, `portrait quarter-turned ${(portTurned * 100).toFixed(0)}%`)
            .toBeGreaterThan(0.85);
    }, 120000);
});
