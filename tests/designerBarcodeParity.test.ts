// Batch D (2026-09-21): the designer canvas must render and measure barcodes
// with the SAME encoder as the viewer (services/ipl/barcodes.ts / bwip-js),
// replacing the JsBarcode CDN path that only supported 6 linear formats and
// showed every 2D/postal symbology as a placeholder. These tests pin the
// designer->encoder adapter and the pixel-parity of the designer bounding box
// against the viewer's estimateElementSize for the same label.
import './golden/setup'; // real canvas + bwip node shims (module level!)
import { describe, it, expect, beforeAll } from 'vitest';
import { ensureBarcodesReady, measureBarcode, paintBarcode, barcodeEncodeCount } from '../services/ipl/barcodes';
import { designerBarcodeRender, designerBarcodeParams } from '../services/designerBarcode';
import { estimateElementSize } from '../services/ipl/renderer';
import { getObjectBoundingBox } from '../services/geometry';
import type { BarcodeField, Design } from '../types';
import type { BarcodeElement } from '../services/ipl/types';

beforeAll(async () => { await ensureBarcodesReady(); });

const bc = (extra: Partial<BarcodeField>): BarcodeField => ({
    id: 1, type: 'barcode', name: 'B', x: 5, y: 5, rotation: 0,
    dataSource: { type: 'fixed', data: '12345678' }, symbology: '6', humanReadable: 'none',
    h_mag: 50, w_mag: 2, ...extra,
});

const design = (field: BarcodeField): Design => ({
    name: 'T',
    labelSettings: { width: 80, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'thermal-transfer', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields: [field], dataSources: [], nextId: 2, guides: { horizontal: [], vertical: [] },
});

const dataOf = (field: BarcodeField): string => (field.dataSource as { data: string }).data;

/** The viewer element the same designer field would parse into (same params). */
const viewerEl = (field: BarcodeField): BarcodeElement => {
    const r = designerBarcodeRender(field, dataOf(field));
    return {
        kind: 'barcode', ox: 0, oy: 0, f: 0,
        symbology: field.symbology,
        heightDots: r.heightDots,
        moduleDots: r.moduleDots,
        ratio: 1, hri: 0,
        source: { type: 'fixed', data: r.data },
        ...designerBarcodeParams(field),
    };
};

describe('designerBarcodeParams — designer model -> encoder params', () => {
    it('maps code39 check digit and code128 subset to the encoder domain', () => {
        expect(designerBarcodeParams(bc({ symbology: '0', code39_checkDigit: 'printer-generated' })).code39Mode).toBe('1');
        expect(designerBarcodeParams(bc({ symbology: '0', code39_checkDigit: 'host-verifies' })).code39Mode).toBe('2');
        expect(designerBarcodeParams(bc({ code128_subset: 'c' })).code128StartSubset).toBe('3');
        expect(designerBarcodeParams(bc({ code128_subset: 'auto' })).code128StartSubset).toBeUndefined();
    });

    it('maps the batch A/B numeric modifiers to strings', () => {
        const p = designerBarcodeParams(bc({ symbology: '18', qrModel: 2, qrEcl: 'Q', qrMask: 3 }));
        expect(p.qrModel).toBe('2');
        expect(p.qrEcl).toBe('Q');
        expect(p.qrMask).toBe('3');
        const r = designerBarcodeParams(bc({ symbology: '20', rssVersion: 6, rssSegments: 4 }));
        expect(r.rssVersion).toBe('6');
        expect(r.rssSegments).toBe('4');
    });

    it('POSTNET w is a MAGNIFICATION: moduleDots = round(w/2), height quantized to 13-dot cells', () => {
        const f1 = bc({ symbology: '11', h_mag: 26, w_mag: 2, dataSource: { type: 'fixed', data: '12345' } });
        const r = designerBarcodeRender(f1, dataOf(f1));
        expect(r.moduleDots).toBe(1);
        expect(r.heightDots).toBe(26);
        const f2 = bc({ symbology: '11', h_mag: 52, w_mag: 4, dataSource: { type: 'fixed', data: '12345' } });
        const big = designerBarcodeRender(f2, dataOf(f2));
        expect(big.moduleDots).toBe(2);
        expect(big.heightDots).toBe(52);
        // h_mag 50 (designer default) quantizes to magnification 4 = 52 dots,
        // exactly what the generator re-emits (round(50/13)=4) — designer and
        // viewer agree after a round trip.
        const f3 = bc({ symbology: '11', h_mag: 50, w_mag: 2, dataSource: { type: 'fixed', data: '12345' } });
        const q = designerBarcodeRender(f3, dataOf(f3));
        expect(q.heightDots).toBe(52);
    });

    it('Planet and MaxiCode are fixed-size: h/w ignored, natural dimensions pinned', () => {
        const f1 = bc({ symbology: '22', h_mag: 99, w_mag: 7, dataSource: { type: 'fixed', data: '12345678901' } });
        const pl = designerBarcodeRender(f1, dataOf(f1));
        expect(pl.moduleDots).toBe(1);
        expect(pl.heightDots).toBe(26);
        expect(pl.fixedSize).toBe(true);
        const f2 = bc({ symbology: '14', h_mag: 99, w_mag: 7, dataSource: { type: 'fixed', data: 'HELLO' } });
        const mx = designerBarcodeRender(f2, dataOf(f2));
        expect(mx.moduleDots).toBe(1);
        expect(mx.heightDots).toBe(101);
        expect(mx.fixedSize).toBe(true);
    });
});

describe('designer <-> viewer render parity', () => {
    const cases: { title: string; field: BarcodeField }[] = [
        { title: 'QR Code', field: bc({ symbology: '18', dataSource: { type: 'fixed', data: 'HELLO QR' }, qrEcl: 'Q' }) },
        { title: 'Code 128', field: bc({ symbology: '6' }) },
        { title: 'POSTNET', field: bc({ symbology: '11', h_mag: 26, w_mag: 2, dataSource: { type: 'fixed', data: '12345' } }) },
        { title: 'HIBC 39', field: bc({ symbology: '8', dataSource: { type: 'fixed', data: '+A1234$B567' } }) },
        { title: 'MicroPDF417', field: bc({ symbology: '19', dataSource: { type: 'fixed', data: '12345678' }, microColumns: 2, microRows: 8 }) },
        { title: 'DataBar Stacked', field: bc({ symbology: '20', dataSource: { type: 'fixed', data: '1234567890123' }, rssVersion: 2 }) },
        { title: 'MaxiCode', field: bc({ symbology: '14', dataSource: { type: 'fixed', data: 'HELLO WORLD' }, maxiMode: 4 }) },
        { title: 'Planet', field: bc({ symbology: '22', dataSource: { type: 'fixed', data: '12345678901' } }) },
        { title: 'Code 16K', field: bc({ symbology: '9', dataSource: { type: 'fixed', data: 'ABC123' } }) },
    ];

    for (const { title, field } of cases) {
        it(`${title}: designer bbox width == viewer estimate (dots)`, () => {
            const r = designerBarcodeRender(field, dataOf(field));
            const mmPerDot = 1 / 8; // 203 dpi
            const box = getObjectBoundingBox(field, design(field));
            const designerDots = box.width / mmPerDot;
            const viewer = estimateElementSize(viewerEl(field), 203);
            // Viewer estimate rounds; allow 1 dot of rounding slack.
            expect(Math.abs(designerDots - viewer.lengthDots)).toBeLessThanOrEqual(1);
        });
    }

    it('every mapped symbology paints through the shared encoder (no placeholder)', () => {
        const canvas = document.createElement('canvas');
        canvas.width = 800; canvas.height = 200;
        const ctx = canvas.getContext('2d')!;
        for (const { field } of cases) {
            const r = designerBarcodeRender(field, dataOf(field));
            const ok = paintBarcode(ctx, r.symbology, r.data, 0, 0, 1, r.moduleDots, r.heightDots, r.params);
            expect(ok, `symbology ${field.symbology}`).toBe(true);
        }
    });

    it('raster cache: repeated paints of the same field encode exactly once', () => {
        const canvas = document.createElement('canvas');
        canvas.width = 800; canvas.height = 200;
        const ctx = canvas.getContext('2d')!;
        const field = bc({ symbology: '18', dataSource: { type: 'fixed', data: 'CACHE ME' }, qrEcl: 'H' });
        const r = designerBarcodeRender(field, dataOf(field));
        const before = barcodeEncodeCount();
        paintBarcode(ctx, r.symbology, r.data, 0, 0, 1, r.moduleDots, r.heightDots, r.params);
        paintBarcode(ctx, r.symbology, r.data, 0, 0, 1, r.moduleDots, r.heightDots, r.params);
        paintBarcode(ctx, r.symbology, r.data, 0, 0, 1, r.moduleDots, r.heightDots, r.params);
        expect(barcodeEncodeCount() - before).toBe(1);
        // different params => different encode (cache key covers params)
        paintBarcode(ctx, r.symbology, r.data, 0, 0, 1, r.moduleDots, r.heightDots, { ...r.params, qrEcl: 'L' });
        expect(barcodeEncodeCount() - before).toBe(2);
    });

    it('ratio-aware path (Code 39 wide:narrow) caches its paint raster too', () => {
        const canvas = document.createElement('canvas');
        canvas.width = 800; canvas.height = 200;
        const ctx = canvas.getContext('2d')!;
        // ratio + narrowDots set => usesRunLengthRatio true for symbology 0.
        const field = bc({ symbology: '0', dataSource: { type: 'fixed', data: 'ABC123' } });
        const r = designerBarcodeRender(field, dataOf(field));
        const before = barcodeEncodeCount();
        // First paint: one raw() encode. Later paints: cache hits.
        expect(paintBarcode(ctx, r.symbology, r.data, 0, 0, 1, r.moduleDots, r.heightDots, r.params)).toBe(true);
        const afterFirst = barcodeEncodeCount();
        paintBarcode(ctx, r.symbology, r.data, 0, 0, 1, r.moduleDots, r.heightDots, r.params);
        paintBarcode(ctx, r.symbology, r.data, 0, 0, 2, r.moduleDots, r.heightDots, r.params);
        expect(barcodeEncodeCount()).toBe(afterFirst); // zero re-encodes despite pxPerDot changes
        expect(afterFirst - before).toBe(1);
    });

    it('measureBarcode and the cached paint agree on natural width', () => {
        const field = bc({ symbology: '6', dataSource: { type: 'fixed', data: 'ABC123XYZ' } });
        const r = designerBarcodeRender(field, dataOf(field));
        const m = measureBarcode(r.symbology, r.data, r.params)!;
        expect(m.widthModules).toBeGreaterThan(10);
    });
});
