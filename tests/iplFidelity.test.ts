import { describe, it, expect, beforeAll } from 'vitest';
import { encodeBitmapColumns, decodeGraphicColumns } from '../services/ipl/graphics';
import { IPL_SYMBOLOGY_TO_BCID, resolveBcid, measureBarcode, paintBarcode, ensureBarcodesReady } from '../services/ipl/barcodes';
import { generateIPL } from '../services/iplGenerator';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { estimateElementSize } from '../services/ipl/renderer';
import type { GraphicElement } from '../services/ipl/types';

const DPI = 203;

describe('graphics packing (generator <-> viewer parity)', () => {
    it('round-trips a known single-column bitmap', () => {
        // bits [1,0,1,0,1,0] -> 0b01000000 | 32 | 8 | 2 = 'j' (106)
        const bitmap = [[1], [0], [1], [0], [1], [0]];
        expect(encodeBitmapColumns(bitmap)).toEqual(['j']);
        expect(decodeGraphicColumns(1, 6, ['j'])).toEqual(bitmap);
    });

    it('round-trips a multi-column bitmap with padding', () => {
        const bitmap: number[][] = [];
        for (let y = 0; y < 11; y++) {
            bitmap.push(Array.from({ length: 7 }, (_, x) => ((x + y) % 3 === 0 ? 1 : 0)));
        }
        const encoded = encodeBitmapColumns(bitmap);
        expect(encoded).toHaveLength(7);
        encoded.forEach(col => expect(col).toHaveLength(2)); // ceil(11/6)
        expect(decodeGraphicColumns(7, 11, encoded)).toEqual(bitmap);
    });

    it('decodes unknown chars as white and tolerates short data', () => {
        const decoded = decodeGraphicColumns(3, 12, ['@', undefined as unknown as string, '@@']);
        expect(decoded.every(row => row.every(px => px === 0))).toBe(true);
    });
});

describe('barcode symbology mapping', () => {
    beforeAll(async () => { await ensureBarcodesReady(); });
    it('maps all documented IPL ids to bwip-js formats', () => {
        expect(IPL_SYMBOLOGY_TO_BCID['0']).toBe('code39');
        expect(IPL_SYMBOLOGY_TO_BCID['2']).toBe('interleaved2of5');
        expect(IPL_SYMBOLOGY_TO_BCID['6']).toBe('code128');
        expect(IPL_SYMBOLOGY_TO_BCID['12']).toBe('pdf417');
        expect(IPL_SYMBOLOGY_TO_BCID['17']).toBe('datamatrix');
    });

    it('resolves EAN/UPC by data length', () => {
        expect(resolveBcid('7', '4006381333931')).toBe('ean13');
        expect(resolveBcid('7', '96385074')).toBe('ean8');
        expect(resolveBcid('7', '036000291452')).toBe('upca');
        expect(resolveBcid('7', '12345')).toBeNull();
    });

    it('measures linear symbols at one pixel per module', () => {
        const m = measureBarcode('6', 'ABC123');
        expect(m).not.toBeNull();
        expect(m!.isMatrix).toBe(false);
        expect(m!.widthModules).toBeGreaterThan(10);
    });

    it('identifies matrix symbols (DataMatrix, PDF417)', () => {
        const dm = measureBarcode('17', 'HELLO-IPL');
        expect(dm).not.toBeNull();
        expect(dm!.isMatrix).toBe(true);

        const p4 = measureBarcode('12', 'PDF TEST DATA');
        expect(p4!.isMatrix).toBe(true);
        // Matrix symbols render square-ish bitmaps
        expect(p4!.heightPx).toBeGreaterThan(5);
    });

    it('returns null for invalid or unsupported input', () => {
        expect(measureBarcode('99', 'WHATEVER')).toBeNull();
        expect(measureBarcode('7', 'NOT-A-EAN')).toBeNull();
        expect(measureBarcode('6', '')).toBeNull();
        expect(measureBarcode('2', 'A1B2')).toBeNull(); // I2of5 needs digits
        expect(measureBarcode('7', 'BAD-DATA!')).toBeNull();
    });

    it('paintBarcode reports success/failure to the caller', () => {
        const canvas = document.createElement('canvas');
        canvas.width = 400; canvas.height = 200;
        const ctx = canvas.getContext('2d')!;
        expect(paintBarcode(ctx, '6', 'ABC123', 0, 0, 2, 2, 80)).toBe(true);
        expect(paintBarcode(ctx, '17', 'DM-OK', 0, 0, 2, 4, 80)).toBe(true);
        expect(paintBarcode(ctx, '7', 'NOPE', 0, 0, 2, 2, 80)).toBe(false);
    });
});

describe('graphic round-trip through the generator stream', () => {
    it('viewer decodes G/U raster emitted for rounded boxes', async () => {
        const design = {
            name: 'Box',
            labelSettings: { width: 60, height: 40, columns: 1, rows: 1, unit: 'mm' as const, orientation: 'portrait' as const },
            printerSettings: {
                model: 'PD43', dpi: DPI as 203, quantity: 1,
                mediaType: 'thermal-transfer' as const,
                mediaSenseMode: 'gap' as const, printSpeed: 6, darkness: 10,
            },
            fields: [{
                id: 1, type: 'box' as const, name: 'Box 1', x: 5, y: 5, rotation: 0 as const,
                width: 20.25, height: 12.75, thickness: 0.25, cornerRadius: 2,
            }],
            dataSources: [],
            nextId: 2,
            guides: { horizontal: [], vertical: [] },
        };

        const ipl = await generateIPL(design);
        expect(ipl).toMatch(/G1,/);
        expect(ipl).toContain('U1;');

        const label = parseViewerIPL(ipl);
        const graphic = label.elements.find(e => e.kind === 'graphic') as GraphicElement;
        expect(graphic).toBeDefined();
        expect(graphic.graphicId).toBe(1);

        // happy-dom's stubbed canvas yields an all-white raster, but the
        // plumbing must deliver exactly one packed column per dot column.
        const expectedWidth = Math.round(20.25 * (DPI / 25.4));
        expect(graphic.data).toHaveLength(expectedWidth);
        expect(graphic.widthDots).toBe(expectedWidth);

        // Extent accounts for real graphic size
        const size = estimateElementSize(graphic, DPI);
        expect(size.lengthDots).toBe(expectedWidth);
    });
});
