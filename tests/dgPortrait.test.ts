// The btPortrait Direct Graphics path, against GROUND TRUTH.
//
// Landscape and portrait driver frames are DIFFERENT, and the stream records
// neither — so orientation and page height are caller inputs. This pins the
// portrait formula, which was measured with purpose-built fixtures and is
// anchored to the page's height rather than the graphic's own origin:
//
//     inkLeft = originY - maxBit + (W + 18)/2 - 424
//     inkTop  = pageHeightDots - originX - inkWidth - 8
//
// with the payload TRANSPOSED (the 1.2x0.6 in object arrives as 146 cols x
// 268 bits; BarTender's preview draws it 267x146).
//
// Ground truth is the build script that created each fixture — the coordinates
// were the INPUT, so agreeing with them is agreeing with intent, not with
// another renderer. BarTender's own previews agree with them too (measured:
// ink at (90,49) against a ground truth of (89.5,48.9)).
import './golden/setup';
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { newRealCanvas } from './golden/setup';
import { bytesToByteString } from '../services/ipl/fileBytes';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { renderLabel, computeLabelExtent } from '../services/ipl/renderer';
import { ensureBarcodesReady } from '../services/ipl/barcodes';

beforeAll(async () => { await ensureBarcodesReady(); });

const DPI = 203;
const HM = (mm: number) => (mm / 2) / 25.4 * DPI;

type AnyCanvas = { width: number; height: number; getContext(k: '2d'): any };
const inkBox = (cv: AnyCanvas) => {
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let x0 = cv.width, y0 = cv.height, x1 = -1, y1 = -1;
    for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
        const o = (y * cv.width + x) * 4;
        if (!(d[o + 3] > 0 && d[o] < 100 && d[o + 1] < 100 && d[o + 2] < 100)) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
};

/**
 * Fixtures live outside the repo (a BarTender script generates them), so they
 * are skipped when absent rather than failing on a machine that lacks them.
 * Each row: name, page height in dots on the FEED axis, and the object's
 * ground-truth position from BuildPortrait.cs / BuildSweep.cs / BuildV.cs.
 */
const CASES = [
    // page 3x2 in portrait; object X=0.5 Y=0.3, W=1.2 H=0.6 in, 3mm stroke
    { name: 'por-3x2', ipl: 'C:/Temp/bt-p/por-3x2.ipl', pageH: 406, objX: 0.5, objY: 0.3, objW: 1.2, objH: 0.6 },
    // page 2x3 in portrait, same object
    { name: 'por-2x3', ipl: 'C:/Temp/bt-p/por-2x3.ipl', pageH: 609, objX: 0.5, objY: 0.3, objW: 1.2, objH: 0.6 },
    // VALIDATION fixture: page 3x2.5 in, object X=0.4 Y=1.1, W=0.9 H=0.5 in —
    // every number differs from the derivation set on purpose
    { name: 'v-3x25', ipl: 'C:/Temp/bt-v/v-3x25.ipl', pageH: 507.5, objX: 0.4, objY: 1.1, objW: 0.9, objH: 0.5 },
];

describe('btPortrait Direct Graphics land at the printed position', () => {
    for (const c of CASES) {
        it(`${c.name}: matches the build-script ground truth`, () => {
            if (!existsSync(c.ipl)) { console.log(`${c.name}: fixture not present — skipping`); return; }

            const raw = bytesToByteString(readFileSync(c.ipl));
            const label = parseViewerIPL(raw, {
                model: 'PD43', dpi: DPI as 203,
                orientation: 'portrait', pageHeightDots: c.pageH,
            });

            const gfx = label.elements.filter(e => e.kind === 'graphic');
            expect(gfx.length, `${c.name}: expected one graphic`).toBe(1);

            const extent = computeLabelExtent(label, DPI);
            const cv = newRealCanvas(Math.max(extent.widthDots, 700), Math.max(extent.heightDots, 700)) as unknown as AnyCanvas;
            renderLabel(cv as never, label, extent, { dpi: DPI, pxPerDot: 1, quality: 1, rotation: 0 });
            const got = inkBox(cv);

            const wantX = c.objX * DPI - HM(3);
            const wantY = c.objY * DPI - HM(3);
            expect(Math.abs(got.x0 - wantX), `${c.name}: ink left ${got.x0}, ground truth ${wantX.toFixed(1)}`).toBeLessThanOrEqual(3);
            expect(Math.abs(got.y0 - wantY), `${c.name}: ink top ${got.y0}, ground truth ${wantY.toFixed(1)}`).toBeLessThanOrEqual(3);

            // Dimensions must match too — a transposition error keeps the ink
            // box size but swaps it, so position alone would not catch it.
            const wantW = c.objW * DPI + 2 * HM(3);
            const wantH = c.objH * DPI + 2 * HM(3);
            expect(Math.abs(got.w - wantW), `${c.name}: ink width ${got.w}, expected ${wantW.toFixed(0)}`).toBeLessThanOrEqual(3);
            expect(Math.abs(got.h - wantH), `${c.name}: ink height ${got.h}, expected ${wantH.toFixed(0)}`).toBeLessThanOrEqual(3);
        }, 60000);
    }

    it('a portrait stream with no page height is flagged, not silently misplaced', () => {
        const c = CASES[0];
        if (!existsSync(c.ipl)) { console.log('fixture not present — skipping'); return; }
        const raw = bytesToByteString(readFileSync(c.ipl));
        const label = parseViewerIPL(raw, { model: 'PD43', dpi: DPI as 203, orientation: 'portrait' });
        const codes = label.issues.map(i => i.code);
        expect(codes, 'missing page height must raise an info').toContain('dg-portrait-page-height-missing');
    });

    it('an unknown orientation is flagged rather than assumed silently', () => {
        const c = CASES[0];
        if (!existsSync(c.ipl)) { console.log('fixture not present — skipping'); return; }
        const raw = bytesToByteString(readFileSync(c.ipl));
        const label = parseViewerIPL(raw, { model: 'PD43', dpi: DPI as 203 });
        const codes = label.issues.map(i => i.code);
        expect(codes, 'unknown orientation must raise an info').toContain('dg-orientation-unknown');
    });
});
