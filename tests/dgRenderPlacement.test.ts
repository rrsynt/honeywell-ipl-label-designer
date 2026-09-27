// The RENDERER must place BarTender Direct Graphics where the printed label has
// them — not the formula in isolation (dgPlacement.test.ts covers that), but the
// pixels this app actually draws.
//
// Ground truth is BarTender's own preview, which for these fixtures is in page
// coordinates: verified against tools/bartender/BuildParityLabels.cs, whose
// coordinates were the INPUT to building the formats (`grid` puts a box at
// 0.2 in = path x 41, and the preview's first inked column IS 37 with its 1 mm
// stroke; `one-box-landscape` likewise at 110/90).
//
// This test FAILS against the pre-2026-09-28 renderer on purpose: that one
// collapsed every graphic to row `minBit` of the CONTENT canvas, because
// hBase = max(contentExtent, originY) always resolved to originY. Measured, the
// error is ~88 dots on one-box-landscape and ~29 on parity-base — far outside
// the tolerance below, so the test separates rather than flatters.
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

type AnyCanvas = { width: number; height: number; getContext(k: '2d'): any };

/** Topmost inked row inside an x-band. */
const inkTopInBand = (cv: AnyCanvas, x0: number, x1: number) => {
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    for (let y = 0; y < cv.height; y++) {
        for (let x = Math.max(0, x0); x < Math.min(cv.width, x1); x++) {
            const o = (y * cv.width + x) * 4;
            if (d[o + 3] > 0 && d[o] < 100 && d[o + 1] < 100 && d[o + 2] < 100) return y;
        }
    }
    return -1;
};

const CASES = [
    {
        name: 'parity-base',
        ipl: 'samples/bartender-parity-base.ipl',
        png: 'testdata/bartender/parity-base.png',
        // Our graphic elements' x-bands, from the layout (known good
        // horizontally: ink width matches BarTender within 1 dot).
        bands: [[9, 328], [338, 801]] as Array<[number, number]>,
    },
    {
        name: 'one-box-landscape',
        ipl: 'samples/bartender-sweep-one-box-landscape.ipl',
        png: 'testdata/bartender-sweep-one-box-landscape.png',
        bands: [[118, 629]] as Array<[number, number]>,
    },
];

describe('renderer: BarTender Direct Graphics land at the printed position', () => {
    for (const c of CASES) {
        it(`${c.name}: our rendered ink top matches BarTender's`, async () => {
            const raw = bytesToByteString(readFileSync(c.ipl));
            const label = parseViewerIPL(raw, { model: 'PD43', dpi: 203 });
            const extent = computeLabelExtent(label, 203);

            const ours = newRealCanvas(extent.widthDots, extent.heightDots) as unknown as AnyCanvas;
            renderLabel(ours as never, label, extent, { dpi: 203, pxPerDot: 1, quality: 1, rotation: 0 });

            const img = await loadImage(c.png);
            const bt = newRealCanvas(img.width, img.height) as unknown as AnyCanvas;
            bt.getContext('2d').drawImage(img, 0, 0);

            const misses: string[] = [];
            for (const [x0, x1] of c.bands) {
                const want = inkTopInBand(bt, x0, x1);
                const got = inkTopInBand(ours, x0, x1);
                // 6 dots: the model's ceil() and BarTender's own edge
                // rasterisation both move an ink top by a dot or two, and one
                // fixture in the wider sweep measured 0.5 dot off. The bug this
                // catches is 29-88 dots, so the band separates comfortably.
                if (Math.abs(got - want) > 6) {
                    misses.push(`band x[${x0},${x1}): BarTender top ${want}, ours ${got} (off by ${got - want})`);
                }
            }
            expect(misses, misses.join('\n')).toEqual([]);
        }, 60000);
    }
});
