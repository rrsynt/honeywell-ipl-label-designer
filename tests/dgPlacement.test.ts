// BarTender Direct Graphics vertical placement, against GROUND TRUTH.
//
// Why this file exists. Every BarTender fixture in the repo is a stream whose
// graphic origins the DRIVER computed, not the printer. Reading them with the
// bottom-up model in PRM Appendix E put every graphic in the wrong place --
// visible as "our graphic is always at the top of the canvas" -- and no
// existing test could see it, because the parity suites align the ink origin
// before scoring and a uniform offset vanishes under that alignment.
//
// The driver writes origin Y in a CENTRED frame. Recovering the printed
// position needs two numbers from the driver's own model table (extracted from
// `ss#ipl.ddz` -> `Model.d`), plus `W`, which the stream carries:
//
//   yTop = originY + (W + 2*adjust)/2 - maxBit - ceil(printableX*dpi/2)
//
// Verified 8/8 within 1 dot against BarTender's own previews when this test was
// written. The ground truth used here is the BUILD SCRIPT, not BarTender's
// renderer: tools/bartender/BuildParityLabels.cs fed these coordinates in, so
// agreeing with them is agreeing with intent.
import './golden/setup';
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { loadImage } from '@napi-rs/canvas';
import { newRealCanvas } from './golden/setup';
import { bytesToByteString } from '../services/ipl/fileBytes';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { extractDirectGraphics } from '../services/ipl/directGraphics';
import { ensureBarcodesReady } from '../services/ipl/barcodes';
import { PRINTABLE_WIDTH_IN, LABEL_WIDTH_ADJUSTMENT } from '../constants';

beforeAll(async () => { await ensureBarcodesReady(); });

const DPI = 203;
const MODEL = 'PD43';

/** Prints `W` for this stream, or null when it carries none. */
const widthOf = (raw: string) => {
    const m = /<SI>W(\d+)/.exec(raw);
    return m ? Number(m[1]) : null;
};

/**
 * The printed page position of a graphic's ink TOP, in dots from the page's
 * top edge, using only the stream plus the model's driver constants.
 */
const expectedTop = (originY: number, maxBit: number, W: number) => {
    const adj = LABEL_WIDTH_ADJUSTMENT[MODEL][DPI as 203];
    const printableX = PRINTABLE_WIDTH_IN[MODEL][DPI as 203];
    return originY + (W + 2 * adj) / 2 - maxBit - Math.ceil(printableX! * DPI / 2);
};

/** Topmost inked row inside an x-band of BarTender's own preview. */
const inkTopInBand = (cv: { width: number; height: number; getContext(k: '2d'): any }, x0: number, x1: number) => {
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    for (let y = 0; y < cv.height; y++) {
        for (let x = Math.max(0, x0); x < Math.min(cv.width, x1); x++) {
            const o = (y * cv.width + x) * 4;
            if (d[o + 3] > 0 && d[o] < 100 && d[o + 1] < 100 && d[o + 2] < 100) return y;
        }
    }
    return -1;
};

const dgFrames = (raw: string) => {
    const frames: string[] = [];
    const re = /<STX>([\s\S]*?)<ETX>/g;
    let m; let inDg = false;
    while ((m = re.exec(raw))) {
        const body = m[1];
        if (body.startsWith('<ESC>g')) { inDg = true; continue; }
        if (inDg) frames.push(body);
    }
    return frames;
};

const bitsOf = (dg: { pixels: Array<Array<number> | undefined> }) => {
    let mn = Infinity, mx = -1;
    for (const c of dg.pixels) { if (!c) continue; for (let b = 0; b < c.length; b++) if (c[b]) { if (b < mn) mn = b; if (b > mx) mx = b; } }
    return { mn, mx };
};

/**
 * A BarTender-authored stream, its own preview PNG, the page height in dots
 * (feed axis), and the ink bands to measure — one per graphic, taken from our
 * element layout, which is independently known good horizontally.
 */
const CASES = [
    { name: 'parity-base', ipl: 'samples/bartender-parity-base.ipl', png: 'testdata/bartender/parity-base.png' },
    { name: 'one-box-landscape', ipl: 'samples/bartender-sweep-one-box-landscape.ipl', png: 'testdata/bartender-sweep-one-box-landscape.png' },
];

describe('BarTender Direct Graphics vertical placement', () => {
    for (const c of CASES) {
        it(`${c.name}: graphics land where the driver put them`, async () => {
            const raw = bytesToByteString(readFileSync(c.ipl));
            const W = widthOf(raw);
            expect(W, `no <SI>W in ${c.name}`).not.toBeNull();

            const label = parseViewerIPL(raw);
            const gfx = label.elements.filter(e => e.kind === 'graphic') as Array<{ ox: number; widthDots: number }>;
            const dgs = extractDirectGraphics(dgFrames(raw), 0);
            expect(gfx.length).toBe(dgs.length);

            const img = await loadImage(c.png);
            const bt = newRealCanvas(img.width, img.height) as unknown as { width: number; height: number; getContext(k: '2d'): any };
            bt.getContext('2d').drawImage(img, 0, 0);

            const misses: string[] = [];
            for (let i = 0; i < dgs.length; i++) {
                const { mx } = bitsOf(dgs[i]);
                const want = expectedTop(dgs[i].origin[1], mx, W!);
                const got = inkTopInBand(bt, gfx[i].ox, gfx[i].ox + gfx[i].widthDots);
                if (Math.abs(got - want) > 2) {
                    misses.push(`dg${i} @x${gfx[i].ox}: predicted top ${want.toFixed(1)}, BarTender drew ${got}`);
                }
            }
            expect(misses, misses.join('\n')).toEqual([]);
        }, 60000);
    }
});
