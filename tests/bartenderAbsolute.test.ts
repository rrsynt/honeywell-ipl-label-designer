// Absolute-placement parity: the checks that do NOT align on the ink origin.
//
// WHY THIS FILE EXISTS. Every other BarTender parity suite — bartenderSweep,
// bartenderGeometry, bartenderAuto, bartenderPageTurn — aligns our ink origin
// onto the export's before scoring. That is deliberate and correct for what they
// measure (arrangement, object coverage), but it makes them structurally blind
// to a UNIFORM TRANSLATION: slide the whole label and every one of their scores
// is unchanged. A uniform slide is exactly what a units error, an origin
// regression, or a mirrored page turn produces, so the defect class those suites
// cannot see is the class they are most likely to meet.
//
// Everything here is asserted in ABSOLUTE coordinates with no alignment step.
// Three independent references, weakest to strongest:
//
//   1. Content SIZE vs BarTender's own preview. A scale error — wrong dpi,
//      transposed axes, a doubled magnification — moves this.
//   2. Content ORIGIN vs BarTender's own preview, with the offset PINNED.
//      See the note on PAGE_LAYER below before changing a pinned number.
//   3. Lattice sparsity/size vs ground truth from tools/bartender/
//      BuildParityLabels.cs. This reference is independent of BarTender's
//      rendering entirely: the coordinates were fed IN to build the formats.
//
// Only rotation-0 fixtures are used. For those the page axes map straight onto
// our canvas axes; for the quarter-turned samples the comparison would be
// between two different orientations, which tests the page-turn model rather
// than absolute placement. bartenderPageTurn already covers that model with a
// controlled landscape/portrait pair.
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

const DPI = 203;
/** BuildParityLabels.cs writes mm; its 1 mm ≡ 8 dots at this dpi. */
const MM = DPI / 25.4;
const inch = (v: number) => Math.round(v * DPI);

type AnyCanvas = { width: number; height: number; getContext(k: '2d'): any };

interface InkBox { x0: number; y0: number; w: number; h: number; }

/** Ink bounding box in CANVAS pixels. The canvas hairline border is excluded by
 *  the colour threshold (rgba(99,102,241,.55) is far lighter than <100), so this
 *  counts element content only. */
const inkBox = (cv: AnyCanvas): InkBox => {
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let x0 = cv.width, y0 = cv.height, x1 = -1, y1 = -1;
    for (let y = 0; y < cv.height; y++) {
        for (let x = 0; x < cv.width; x++) {
            const o = (y * cv.width + x) * 4;
            if (!(d[o + 3] > 0 && d[o] < 100 && d[o + 1] < 100 && d[o + 2] < 100)) continue;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
    }
    return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
};

/** Inked column runs (start index + length), left to right. */
const colRuns = (cv: AnyCanvas) => {
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const a = new Array<number>(cv.width).fill(0);
    for (let y = 0; y < cv.height; y++) {
        for (let x = 0; x < cv.width; x++) {
            const o = (y * cv.width + x) * 4;
            if (d[o + 3] > 0 && d[o] < 100 && d[o + 1] < 100 && d[o + 2] < 100) a[x]++;
        }
    }
    const out: Array<{ x: number; w: number }> = [];
    let s = -1;
    for (let i = 0; i <= a.length; i++) {
        const on = i < a.length && a[i] > 0;
        if (on && s < 0) s = i;
        if (!on && s >= 0) { out.push({ x: s, w: i - s }); s = -1; }
    }
    return out;
};

const render = (ipl: string) => {
    const label = parseViewerIPL(bytesToByteString(readFileSync(ipl)));
    const extent = computeLabelExtent(label, DPI);
    const cv = newRealCanvas(extent.widthDots, extent.heightDots) as unknown as AnyCanvas;
    renderLabel(cv as never, label, extent, { dpi: DPI, pxPerDot: 1, quality: 1, rotation: 0 });
    return { label, extent, cv, box: inkBox(cv) };
};

const preview = async (png: string) => {
    const img = await loadImage(png);
    const cv = newRealCanvas(img.width, img.height) as unknown as AnyCanvas;
    cv.getContext('2d').drawImage(img, 0, 0);
    return { cv, box: inkBox(cv) };
};

/**
 * THE PAGE LAYER — read this before touching a pinned offset.
 *
 * BarTender's preview is in PAGE coordinates: verified against
 * BuildParityLabels.cs, not assumed. The `grid` format places its first box at
 * 0.2 in ⇒ path x = 41; with 1 mm line thickness the ink starts at 37, and the
 * preview's first inked column IS 37. Same for one-box-landscape: 0.6 in ⇒ 122,
 * thickness 3 mm ⇒ ink at 110, preview 110. So preview (0,0) = page (0,0).
 *
 * (An earlier note in this repo described the preview as "cropped 8 dots per
 * edge". The 16-dot size difference is real — the preview canvas is exactly
 * 16 dots smaller in BOTH dimensions on all five fixtures — but a crop implies
 * a SHIFT, and there is none. The preview is a page-anchored window that ends
 * 16 dots early, not a centred crop. The two models differ by 8 dots of
 * position, which is precisely the size of several real effects here, so the
 * wrong one would have hidden them.)
 *
 * Our render, by contrast, places content at the stream's absolute dot
 * coordinates and grows the canvas to fit it. The two therefore disagree on
 * where the page origin is, by an amount that is currently UNEXPLAINED and
 * differs per fixture (dy 31 vs 89 across two fixtures on the SAME stock).
 *
 * These offsets are pinned as a REGRESSION BASELINE, not as a correctness
 * claim: they are what our renderer produces today, so any change in them —
 * including a uniform slide introduced by a bug — fails this test. If you
 * deliberately change page-origin handling, re-measure and update them, and
 * say so in the message; do not "fix" them to match BarTender without first
 * explaining the difference.
 */
const CASES = [
    {
        name: 'parity-base',
        ipl: 'samples/bartender-parity-base.ipl',
        png: 'testdata/bartender/parity-base.png',
        // Vector + Direct Graphics mixed; 7 elements.
        offset: { x: -7, y: 29 },
    },
    {
        name: 'one-box-landscape',
        ipl: 'samples/bartender-sweep-one-box-landscape.ipl',
        png: 'testdata/bartender-sweep-one-box-landscape.png',
        // Single Direct Graphics object on a landscape stock.
        offset: { x: -8, y: 89 },
    },
] as const;

/** Sub-pixel rasterisation and encoder differences move an ink box by 1 dot. */
const SIZE_TOL = 2;
/** The pinned page-layer offsets are deterministic; allow no more than raster noise. */
const OFFSET_TOL = 2;

describe('BarTender parity: absolute placement (no ink-origin alignment)', () => {
    for (const c of CASES) {
        describe(c.name, () => {
            it('renders content at the size BarTender rendered it', async () => {
                const { cv } = render(c.ipl);
                const bt = await preview(c.png);
                const ours = inkBox(cv);

                // A scale error — wrong dpi, transposed axes, doubled
                // magnification — shows up here and nowhere else in the suite.
                expect(Math.abs(ours.w - bt.box.w),
                    `ink width: ours ${ours.w} vs BarTender ${bt.box.w}`).toBeLessThanOrEqual(SIZE_TOL);
                expect(Math.abs(ours.h - bt.box.h),
                    `ink height: ours ${ours.h} vs BarTender ${bt.box.h}`).toBeLessThanOrEqual(SIZE_TOL);
            }, 60000);

            it('keeps the content origin where it is today (pinned page-layer offset)', async () => {
                const { cv } = render(c.ipl);
                const bt = await preview(c.png);
                const ours = inkBox(cv);

                const dx = bt.box.x0 - ours.x0;
                const dy = bt.box.y0 - ours.y0;

                // Asserting the OFFSET rather than the position keeps the message
                // useful: a failure says how far it moved, which is the quantity
                // a regression guard exists to report.
                expect(Math.abs(dx - c.offset.x),
                    `${c.name}: horizontal offset moved from ${c.offset.x} to ${dx} — the whole label slid ${dx - c.offset.x} dot(s). `
                    + `A uniform slide is invisible to every origin-aligned suite.`).toBeLessThanOrEqual(OFFSET_TOL);
                expect(Math.abs(dy - c.offset.y),
                    `${c.name}: vertical offset moved from ${c.offset.y} to ${dy} — the whole label slid ${dy - c.offset.y} dot(s).`).toBeLessThanOrEqual(OFFSET_TOL);
            }, 60000);
        });
    }
});

/**
 * Lattice geometry against BuildParityLabels.cs. Independent of BarTender's
 * renderer: these coordinates were the INPUT to building the formats, so
 * agreeing with them is agreement with the intent, not with another rasteriser.
 *
 * A lattice is the right fixture for this: a position-dependent error (a
 * rounding rule, an origin flip, a rotation anchor) appears as a wrong SPACING
 * or a wrong box SIZE rather than one outlier, and neither can be absorbed by
 * any alignment because they are differences within a single render.
 */
describe('BarTender parity: lattice geometry vs build-script ground truth', () => {
    it('grid: 16 boxes at 0.9 in pitch, 0.5 in square, 1 mm stroke', () => {
        const { cv } = render('samples/bartender-sweep-grid.ipl');
        const runs = colRuns(cv);

        // 4 columns of boxes (the lattice repeats 4x4; rows coincide with columns).
        expect(runs, `expected 4 inked column groups, got ${runs.length} at ${runs.map(r => r.x)}`).toHaveLength(4);

        // Ground truth: 0.9 in pitch = 182.7 dots; ink width = 0.5 in (101.5)
        // plus a 1 mm stroke (±4) = 109.5.
        const gtPitch = 0.9 * DPI;
        const gtWidth = 0.5 * DPI + 1 * MM;
        for (let i = 0; i < runs.length; i++) {
            expect(Math.abs(runs[i].w - gtWidth),
                `box ${i} ink width ${runs[i].w}, ground truth ${gtWidth.toFixed(1)}`).toBeLessThanOrEqual(SIZE_TOL);
            if (i === 0) continue;
            const pitch = runs[i].x - runs[i - 1].x;
            expect(Math.abs(pitch - gtPitch),
                `box ${i - 1}->${i} pitch ${pitch}, ground truth ${gtPitch.toFixed(1)}`).toBeLessThanOrEqual(SIZE_TOL);
        }
    }, 60000);

    it('landscape: 6 boxes at 0.95 in pitch, 0.7x1.3 in, 2 mm stroke', () => {
        const { cv } = render('samples/bartender-sweep-landscape.ipl');
        const runs = colRuns(cv);

        expect(runs, `expected 6 inked column groups, got ${runs.length}`).toHaveLength(6);

        // 0.7 in wide + 2 mm stroke (±8); 1.3 in tall + 2 mm stroke.
        const gtW = 0.7 * DPI + 2 * MM;
        const gtH = 1.3 * DPI + 2 * MM;
        const gtPitch = 0.95 * DPI;
        const box = inkBox(cv);
        expect(Math.abs(box.h - gtH), `height ${box.h}, ground truth ${gtH.toFixed(1)}`).toBeLessThanOrEqual(SIZE_TOL);

        for (let i = 0; i < runs.length; i++) {
            expect(Math.abs(runs[i].w - gtW),
                `box ${i} ink width ${runs[i].w}, ground truth ${gtW.toFixed(1)}`).toBeLessThanOrEqual(SIZE_TOL);
            if (i === 0) continue;
            const pitch = runs[i].x - runs[i - 1].x;
            expect(Math.abs(pitch - gtPitch),
                `box ${i - 1}->${i} pitch ${pitch}, ground truth ${gtPitch.toFixed(1)}`).toBeLessThanOrEqual(SIZE_TOL);
        }
    }, 60000);
});
