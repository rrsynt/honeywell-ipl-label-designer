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
import { printedLabelMm } from '../services/stockFrame';
import { sheetCellDots } from '../services/printRecords';
import { elementVisualBox } from '../services/ipl/renderer';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { renderLabel, computeLabelExtent } from '../services/ipl/renderer';
import { newRealCanvas } from './golden/setup';
import { DPI_MAP } from '../constants';
import type { BarcodeField, BoxField, Design, LineField } from '../types';

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

    it('names multi-up stock, which no language can gang', () => {
        const d = designOf([barcodeField()]);
        d.labelSettings = { ...d.labelSettings, columns: 2, rows: 1 };
        const w = designerOnlyWarnings('ipl', d);
        expect(w).toHaveLength(1);
        expect(w[0]).toContain('2x1');
        expect(w[0]).toContain('ONE label');
    });

    it('stays silent for ordinary 1x1 stock', () => {
        expect(designerOnlyWarnings('ipl', designOf([barcodeField()]))).toEqual([]);
    });
});

// Multi-up and landscape are both cases where the canvas used to disagree with
// every generator. `columns` made it draw a fraction of the stock and clip the
// rest (fields outside the first cell vanished from the screen while the
// printer printed them); `orientation` made it draw a label whose sides were
// not swapped while the generator sent <SI>W/<SI>L swapped. Both are now the
// whole stock, and landscape is drawn turned a quarter — the same transform the
// viewer's renderLabel uses.
describe('stock geometry: the canvas draws the label the printer is told to make', () => {
    const stockPx = (labelSettings: Partial<Design['labelSettings']>, fields: Design['fields'] = [barcodeField()]) => {
        const d = designOf(fields);
        d.labelSettings = { ...d.labelSettings, ...labelSettings };
        const c = newRealCanvas(1200, 1200) as any;
        const ctx = c.getContext('2d');
        drawElements(ctx, d, [], { zoom: 1, pan: { x: 0, y: 0 } } as any, { x: null, y: null }, null, null);
        const data = ctx.getImageData(0, 0, 1200, 1200).data;
        let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
        for (let y = 0; y < 1200; y++) for (let x = 0; x < 1200; x++) {
            const i = (y * 1200 + x) * 4;
            if (data[i + 3] > 200) { // the opaque stock
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
            }
        }
        return { w: maxX - minX + 1, h: maxY - minY + 1 };
    };

    const streamSize = async (labelSettings: Partial<Design['labelSettings']>) => {
        const d = designOf([barcodeField()]);
        d.labelSettings = { ...d.labelSettings, ...labelSettings };
        const ipl = await generateIPL(d);
        return { W: Number(/<SI>W(\d+)/.exec(ipl)![1]), L: Number(/<SI>L(\d+)/.exec(ipl)![1]) };
    };

    it('draws the WHOLE stock when columns/rows are set, not one cell of it', () => {
        // 80x50mm at PREVIEW_SCALE 4 = 320x200 px, whatever the grid says: the
        // generator prints the full width as one label (<SI>W does not divide).
        const one = stockPx({ columns: 1, rows: 1 });
        const four = stockPx({ columns: 2, rows: 2 });
        expect(one).toEqual({ w: 320, h: 200 });
        expect(four).toEqual(one);
    });

    it('keeps a field outside the first grid cell visible', () => {
        // The old division shrank the clip to one cell and hid this field, so
        // the screen showed a label with ink the printer would print missing.
        const far = barcodeField({ x: 60, y: 5 });
        expect(stockPx({ columns: 2, rows: 1 }, [far]).w).toBe(stockPx({ columns: 1, rows: 1 }, [far]).w);
        const d = designOf([far]);
        d.labelSettings = { ...d.labelSettings, columns: 2, rows: 1 };
        const c = newRealCanvas(1200, 1200) as any;
        const ctx = c.getContext('2d');
        drawElements(ctx, d, [], { zoom: 1, pan: { x: 0, y: 0 } } as any, { x: null, y: null }, null, null);
        const data = ctx.getImageData(0, 0, 1200, 1200).data;
        // x=60mm is 240px; the old 2-up clip ended at 160px, so any ink past
        // that proves the field is no longer cut away.
        let rightmost = -1;
        for (let y = 0; y < 1200; y++) for (let x = 0; x < 1200; x++) {
            const i = (y * 1200 + x) * 4;
            if (data[i + 3] > 0 && data[i] < 128 && x > rightmost) rightmost = x;
        }
        expect(rightmost).toBeGreaterThan(240);
    });

    it('draws and sends the stock exactly as declared, landscape included', async () => {
        // A landscape stock IS one whose width exceeds its length; nothing
        // transposes. Both the canvas and the stream use width as written.
        const wide = stockPx({ orientation: 'landscape' });
        expect(wide).toEqual({ w: 320, h: 200 });
        const streamed = await streamSize({ orientation: 'landscape' });
        expect(streamed).toEqual({ W: 640, L: 400 });
        // The same numbers the driver sends for a landscape page: its 4x2 in
        // fixture declares W388 and no <SI>L, for a stock 96x48 mm.
        const narrow = stockPx({ orientation: 'portrait', width: 50, height: 80 });
        expect(narrow).toEqual({ w: 200, h: 320 });
    });
});

// Orientation is DESCRIPTIVE: a landscape stock is one whose width exceeds its
// length, and nothing transposes. The app used to turn the stock a quarter for
// it — `<SI>W`/`<SI>L`, every field origin, every rotation, and the canvas — and
// the driver does not (samples/bartender-sweep-one-box-landscape.ipl, fixture in
// tools/bartender/BuildParityLabels.cs:228: a box 0.6 in from the page's LEFT
// edge prints there, on a stock that declares W388 for 96x48 mm).
describe('printedLabelMm: the stock is what the settings say', () => {
    it('never transposes, whatever the orientation says', () => {
        expect(printedLabelMm({ width: 100, height: 60 })).toEqual({ widthMm: 100, heightMm: 60 });
        expect(printedLabelMm({ width: 60, height: 100 })).toEqual({ widthMm: 60, heightMm: 100 });
    });
});

// Guides belong to the SCREEN's axes: a guide is pulled off a ruler and lands at
// that pixel, and its purpose is to be lined up against something by eye. Drawn
// through the label's own quarter turn instead (as they were before), a vertical
// guide pulled off the left ruler on a landscape stock came out as a horizontal
// line across the label — the opposite axis from the one dragged.
describe('ruler guides keep the SCREEN axis on a turned stock', () => {
    const guideInk = (orientation: 'portrait' | 'landscape', guides: { horizontal: number[]; vertical: number[] }) => {
        const d = designOf([barcodeField()]);
        d.labelSettings = { ...d.labelSettings, orientation };
        d.guides = guides;
        const c = newRealCanvas(1200, 1200) as any;
        const ctx = c.getContext('2d');
        drawElements(ctx, d, [], { zoom: 1, pan: { x: 0, y: 0 } } as any, { x: null, y: null }, null, null);
        const data = ctx.getImageData(0, 0, 1200, 1200).data;
        // The guide is cyan-400 over the white stock; the stock underneath is
        // pure white and everything else on a bare design is black bars, so a
        // blue-green-dominant pixel is the guide.
        let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1, n = 0;
        for (let y = 0; y < 1200; y++) for (let x = 0; x < 1200; x++) {
            const i = (y * 1200 + x) * 4;
            if (data[i + 3] > 0 && data[i + 2] > 150 && data[i + 2] - data[i] > 40) {
                n++;
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
            }
        }
        return { n, w: maxX - minX + 1, h: maxY - minY + 1, minX, minY };
    };

    it('a VERTICAL guide is drawn tall, on both orientations', () => {
        const portrait = guideInk('portrait', { horizontal: [], vertical: [20] });
        const landscape = guideInk('landscape', { horizontal: [], vertical: [20] });
        expect(portrait.h).toBeGreaterThan(portrait.w * 5);
        // The regression: this used to come out WIDE on a turned stock.
        expect(landscape.h).toBeGreaterThan(landscape.w * 5);
    });

    it('a HORIZONTAL guide is drawn wide, on both orientations', () => {
        const portrait = guideInk('portrait', { horizontal: [20], vertical: [] });
        const landscape = guideInk('landscape', { horizontal: [20], vertical: [] });
        expect(portrait.w).toBeGreaterThan(portrait.h * 5);
        expect(landscape.w).toBeGreaterThan(landscape.h * 5);
    });
});

// The sheet preview sizes each cell from the PRINTED label, and draws the label
// into that same cell extent. Reading the raw settings instead made a landscape
// cell 100x65 where the label prints 65x100, so a tall label was stretched
// across a wide cell — the preview showed a shape the printer never makes.
describe('sheet preview cells match the printed label', () => {
    const design = (orientation: 'portrait' | 'landscape'): Design => ({
        ...designOf([barcodeField()]),
        labelSettings: { width: 100, height: 65, columns: 1, rows: 1, unit: 'mm', orientation },
    });

    it('portrait keeps the settings as written', () => {
        const cell = sheetCellDots(design('portrait'));
        // 100mm x 8 dots/mm at 203 dpi
        expect(cell).toEqual({ widthDots: 800, heightDots: 520 });
    });

    it('landscape uses the width as written, which is what the stream sends', () => {
        // The app used to transpose here. The driver does not: its landscape
        // fixture declares W388 for a 96x48 mm stock and prints the box where
        // it was authored.
        const cell = sheetCellDots(design('landscape'));
        expect(cell).toEqual({ widthDots: 800, heightDots: 520 });
    });

    it('agrees with printedLabelMm in both orientations', () => {
        for (const o of ['portrait', 'landscape'] as const) {
            const d = design(o);
            const { widthMm, heightMm } = printedLabelMm(d.labelSettings);
            const cell = sheetCellDots(d);
            expect(cell.widthDots).toBe(Math.round(widthMm * 8));
            expect(cell.heightDots).toBe(Math.round(heightMm * 8));
        }
    });
});

// The invariant that was broken for landscape: a field authored at (x,y) must
// come back out of the stream at (x,y). The old transpose moved it to
// (height − y, x) with a quarter turn, so the same design printed somewhere the
// designer never showed — measured as (55, −20) mm for a field authored at
// (10, 10) on a 65x100 stock, i.e. off the label entirely.
describe('generate -> parse: a field stays where it was authored', () => {
    const boxAt = (x: number, y: number, rotation: 0 | 90 | 180 | 270 = 0): BoxField => ({
        id: 1, type: 'box', name: 'B', x, y, rotation, width: 30, height: 20, thickness: 1,
    });

    const placedMm = async (orientation: 'portrait' | 'landscape', field: BoxField) => {
        const d = designOf([field]);
        d.labelSettings = { ...d.labelSettings, orientation };
        const label = await parseViewerIPL(await generateIPL(d));
        const el = label.elements.find(e => e.kind === 'box')!;
        const b = elementVisualBox(el, 203);
        const MM = 203 / 25.4;
        return { x: b.x / MM, y: b.y / MM, w: b.w / MM, h: b.h / MM, f: el.f };
    };

    it('portrait: unrotated box lands on its own corner', async () => {
        const p = await placedMm('portrait', boxAt(10, 10));
        expect(p.x).toBeCloseTo(10, 1);
        expect(p.y).toBeCloseTo(10, 1);
        expect(p.f).toBe(0);
    });

    it('landscape: the SAME, with no transpose and no added rotation', async () => {
        const l = await placedMm('landscape', boxAt(10, 10));
        expect(l.x).toBeCloseTo(10, 1);
        expect(l.y).toBeCloseTo(10, 1);
        expect(l.f).toBe(0); // the old code forced f1 here
    });

    it('landscape: a field near the right edge stays inside the stock', async () => {
        // The old transpose pushed fields off the label; this one is authored
        // with 5mm to spare on a 100mm-wide stock.
        const l = await placedMm('landscape', boxAt(65, 20));
        // The 1-dot rounding of a half-thickness stroke shows up as 0.06mm.
        expect(l.x).toBeCloseTo(65, 0);
        expect(l.x + l.w).toBeLessThanOrEqual(100);
    });

    it('landscape: a rotation the user set is preserved, not compounded', async () => {
        // The old code added 90 to every field's rotation on top of the
        // transpose, so an authored 90 came back as 180.
        const l = await placedMm('landscape', boxAt(10, 10, 90));
        expect(l.f).toBe(1);
    });
});
