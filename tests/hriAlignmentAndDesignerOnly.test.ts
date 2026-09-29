// 2026-09-29, write-side sweep: two designer properties were drawn on screen
// but had no representation in ANY of the four generators — `lineEnding` (an
// arrow head on a line) and `hriAlign` (where the human-readable line sits).
// The arrow is a genuine screen-only decoration (IPL `L` has no end-cap), so it
// is now WARNED about. The HRI alignment was a defect: an IPL interpretive field
// is ALWAYS left justified (PRM p.200), but the designer defaulted to 'center',
// so the canvas drew the HRI half a text width right of where the printer puts
// it — and the exporter runs through the same generator, so exports lost it too.
import './golden/setup';
import { describe, it, expect, beforeAll } from 'vitest';
import { ensureBarcodesReady } from '../services/ipl/barcodes';
import { drawElements } from '../services/canvasDrawer';
import { generateIPL } from '../services/iplGenerator';
import { designerOnlyWarnings } from '../services/designerOnly';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { renderLabel, computeLabelExtent } from '../services/ipl/renderer';
import { newRealCanvas } from './golden/setup';
import { DPI_MAP } from '../constants';
import type { BarcodeField, Design, LineField } from '../types';

beforeAll(async () => { await ensureBarcodesReady(); });

const DPI = 203;
const FIELD_X_MM = 5;
const W = 700, H = 500;

const designOf = (fields: Design['fields']): Design => ({
    name: 'T',
    labelSettings: { width: 80, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: DPI, quantity: 1, mediaType: 'thermal-transfer', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields, dataSources: [], nextId: 99, guides: { horizontal: [], vertical: [] },
});

const barcodeField = (extra: Partial<BarcodeField> = {}): BarcodeField => ({
    id: 1, type: 'barcode', name: 'B', x: FIELD_X_MM, y: 5, rotation: 0,
    dataSource: { type: 'fixed', data: '12345678' }, symbology: '6', humanReadable: 'below',
    h_mag: 50, w_mag: 2, ...extra,
});

const dark = (d: Uint8ClampedArray, i: number): boolean => d[i + 3] > 0 && d[i] < 128;

/** Left edge (px) of ink present in `withHri` but absent from `none` — the HRI. */
const hriInkLeft = (none: Uint8ClampedArray | ImageData, withHri: Uint8ClampedArray | ImageData, w: number, h: number): number => {
    const a = none instanceof Uint8ClampedArray ? none : none.data;
    const b = withHri instanceof Uint8ClampedArray ? withHri : withHri.data;
    let minX = Infinity;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            if (dark(b, i) && !dark(a, i) && x < minX) minX = x;
        }
    }
    return minX;
};

/** HRI left edge through the designer canvas, in mm from the label's left edge. */
const designerHriLeftMm = (extra: Partial<BarcodeField>): number => {
    const render = (f: BarcodeField): Uint8ClampedArray => {
        const c = newRealCanvas(W, H) as any;
        const ctx = c.getContext('2d');
        drawElements(ctx, designOf([f]), [], { zoom: 1, pan: { x: 0, y: 0 } } as any, { x: null, y: null }, null, null);
        return ctx.getImageData(0, 0, W, H).data;
    };
    const left = hriInkLeft(render(barcodeField({ ...extra, humanReadable: 'none' })), render(barcodeField(extra)), W, H);
    // zoom 1 => PREVIEW_SCALE px per mm.
    return left / 4;
};

/** HRI left edge through the export/viewer pipeline, in mm from the left edge. */
const printedHriLeftMm = async (extra: Partial<BarcodeField>): Promise<number> => {
    const pxPerDot = 2;
    const pxPerMm = pxPerDot * DPI_MAP[DPI as 203];
    // renderLabel RESIZES the canvas, so the scan must use the canvas's own
    // width as its stride — not the size we happened to allocate.
    const render = async (f: BarcodeField): Promise<{ data: Uint8ClampedArray; w: number; h: number }> => {
        const label = await parseViewerIPL(await generateIPL(designOf([f])));
        const c = newRealCanvas(W, H) as any;
        c.style = {};
        renderLabel(c, label, computeLabelExtent(label, DPI), { dpi: DPI, pxPerDot, quality: 1 } as any);
        return { data: c.getContext('2d').getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
    };
    const none = await render(barcodeField({ ...extra, humanReadable: 'none' }));
    const withHri = await render(barcodeField(extra));
    expect(withHri.w).toBe(none.w);
    return hriInkLeft(none.data, withHri.data, none.w, none.h) / pxPerMm;
};

const lineField = (extra: Partial<LineField> = {}): LineField => ({
    id: 2, type: 'line', name: 'L', x: 5, y: 20, rotation: 0, length: 40, thickness: 1, ...extra,
});

describe('HRI alignment: the designer draws what the printer prints', () => {
    it('the default (unset) HRI is left justified, matching the printed label', async () => {
        const designer = designerHriLeftMm({});
        const printed = await printedHriLeftMm({});
        // Left justified => the HRI starts at the field's own left edge. The
        // slack is the first glyph's left side bearing (5.25mm for a canvas
        // 'monospace' 1), NOT tolerance for centring: the field is ~12mm wide,
        // so a centred HRI would land past 11mm and fail this by a mile.
        expect(designer).toBeLessThan(FIELD_X_MM + 0.5);
        expect(printed).toBeLessThan(FIELD_X_MM + 0.5);
        // The two pipelines use different monospace faces, so allow a glyph
        // of side-bearing difference between them.
        expect(Math.abs(designer - printed)).toBeLessThan(1);
    });

    it('an explicit left alignment is identical to the default', async () => {
        expect(designerHriLeftMm({ hriAlign: 'left' })).toBeCloseTo(designerHriLeftMm({}), 1);
    });

    it('the designer still honours an explicit non-left choice on screen', async () => {
        // The screen may show what the user asked for; the warning is what
        // tells them it will not print that way.
        const centered = designerHriLeftMm({ hriAlign: 'center' });
        const left = designerHriLeftMm({ hriAlign: 'left' });
        expect(centered).toBeGreaterThan(left + 0.5);
    });
});

describe('designerOnlyWarnings — screen-only properties are named, not dropped', () => {
    it('stays silent for an ordinary design', () => {
        expect(designerOnlyWarnings('ipl', designOf([barcodeField()]))).toEqual([]);
        expect(designerOnlyWarnings('ipl', designOf([lineField()]))).toEqual([]);
    });

    it('names a line drawn with an arrow head', () => {
        const w = designerOnlyWarnings('ipl', designOf([lineField({ lineEnding: 'arrow' })]));
        expect(w).toHaveLength(1);
        expect(w[0]).toContain('"L"');
        expect(w[0]).toContain('arrow');
    });

    it('names a barcode whose HRI is aligned away from left', () => {
        const w = designerOnlyWarnings('ipl', designOf([barcodeField({ hriAlign: 'right' })]));
        expect(w).toHaveLength(1);
        expect(w[0]).toContain('"B"');
        expect(w[0]).toContain('anchored at the start');
    });

    it('says nothing for a barcode with no HRI, or one already left aligned', () => {
        expect(designerOnlyWarnings('ipl', designOf([barcodeField({ humanReadable: 'none', hriAlign: 'right' })]))).toEqual([]);
        expect(designerOnlyWarnings('ipl', designOf([barcodeField({ hriAlign: 'left' })]))).toEqual([]);
    });

    it('ignores a hidden field', () => {
        expect(designerOnlyWarnings('ipl', designOf([lineField({ lineEnding: 'arrow', visible: false })]))).toEqual([]);
    });

    it('reports the same gap for every printer language, not just IPL', () => {
        // Neither the arrow head nor the HRI anchor is representable in ZPL,
        // EPL or TSPL either, so a language other than IPL must not lose the
        // warning just because the message names no IPL command.
        const d = designOf([lineField({ lineEnding: 'arrow' }), barcodeField({ hriAlign: 'right' })]);
        for (const lang of ['ipl', 'zpl', 'epl', 'tspl'] as const) {
            expect(designerOnlyWarnings(lang, d), lang).toHaveLength(2);
        }
    });
});
