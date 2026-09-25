// Fase 3: ellipse, polygon and triangle print as downloaded raster graphics,
// because IPL has no command for them. The round trip is the load-bearing
// assertion — a shape that the parser cannot read back is a shape the printer
// was never sent.
//
// This file imports the golden setup so document.createElement('canvas')
// returns a real canvas. The unit-test stub's getImageData is all zeros, which
// would make every shape rasterize to blank paper and the assertions below
// pass while proving nothing.
import './golden/setup';
import { describe, it, expect } from 'vitest';
import { generateIPL } from '../services/iplGenerator';
import { parseIPL } from '../services/iplParser';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { decodeGraphicColumns } from '../services/ipl/graphics';
import type { Design, Field, EllipseField, PolygonField, TriangleField, ImageField } from '../types';

const DPI = 203 as const;

const makeDesign = (fields: Field[]): Design => ({
    name: 'Shapes',
    labelSettings: { width: 80, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: DPI, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields,
    dataSources: [],
    nextId: Math.max(0, ...fields.map(f => f.id)) + 1,
    guides: { horizontal: [], vertical: [] },
});

const ellipse = (id: number, extra: Partial<EllipseField> = {}): EllipseField => ({
    id, type: 'ellipse', name: `Ellipse ${id}`, x: 5, y: 5, rotation: 0,
    width: 20, height: 12, thickness: 0, ...extra,
});

/** Count ink dots in a decoded bitmap. A blank raster is the failure mode the
 *  stub canvas would hide, so every shape asserts it printed SOMETHING. */
const inkOf = (bitmap: number[][]): number => bitmap.reduce((n, row) => n + row.reduce((a, b) => a + b, 0), 0);

const roundTripped = async (field: Field): Promise<ImageField> => {
    const ipl = await generateIPL(makeDesign([field]));
    const parsed = parseIPL(ipl, DPI);
    expect(parsed.fields).toHaveLength(1);
    const back = parsed.fields[0];
    expect(back.type).toBe('image');
    return back as ImageField;
};

describe('shape raster round trip', () => {
    it('a filled ellipse comes back as an image whose bitmap is an ellipse', async () => {
        const back = await roundTripped(ellipse(1));
        const rows = back.bitmap;
        expect(rows.length).toBeGreaterThan(0);

        const bitmap = rows.map(r => r.split('').map(c => (c === '1' ? 1 : 0)));
        const h = bitmap.length;
        const w = bitmap[0].length;

        // The centre of a filled ellipse is ink; its corners are paper. That
        // pair is what distinguishes an ellipse from a box of the same size.
        expect(bitmap[Math.floor(h / 2)][Math.floor(w / 2)]).toBe(1);
        expect(bitmap[0][0]).toBe(0);
        expect(bitmap[0][w - 1]).toBe(0);
        expect(bitmap[h - 1][0]).toBe(0);
        expect(bitmap[h - 1][w - 1]).toBe(0);
    });

    it('a stroked ellipse has an empty centre', async () => {
        const back = await roundTripped(ellipse(1, { thickness: 1 }));
        const bitmap = back.bitmap.map(r => r.split('').map(c => (c === '1' ? 1 : 0)));
        const h = bitmap.length;
        const w = bitmap[0].length;
        expect(bitmap[Math.floor(h / 2)][Math.floor(w / 2)]).toBe(0);
        expect(inkOf(bitmap)).toBeGreaterThan(0);
    });

    it('a triangle points up: apex ink, bottom corners ink, top corners paper', async () => {
        const triangle: TriangleField = {
            id: 1, type: 'triangle', name: 'Triangle 1', x: 2, y: 2, rotation: 0,
            width: 20, height: 16, thickness: 0,
        };
        const back = await roundTripped(triangle);
        const bitmap = back.bitmap.map(r => r.split('').map(c => (c === '1' ? 1 : 0)));
        const h = bitmap.length;
        const w = bitmap[0].length;

        expect(bitmap[0][Math.floor(w / 2)]).toBe(1);
        expect(bitmap[h - 1][0]).toBe(1);
        expect(bitmap[h - 1][w - 1]).toBe(1);
        expect(bitmap[0][0]).toBe(0);
        expect(bitmap[0][w - 1]).toBe(0);
    });

    it('a polygon with fewer than 3 sides emits no graphic', async () => {
        const polygon: PolygonField = {
            id: 1, type: 'polygon', name: 'Polygon 1', x: 2, y: 2, rotation: 0,
            width: 20, height: 20, thickness: 0, sides: 2,
        };
        const ipl = await generateIPL(makeDesign([polygon]));
        expect(ipl).not.toContain('<STX>G');
        expect(parseIPL(ipl, DPI).fields).toHaveLength(0);
    });

    it('the viewer decodes the same ellipse the designer parser does', async () => {
        const ipl = await generateIPL(makeDesign([ellipse(1)]));
        const label = parseViewerIPL(ipl);
        const graphic = label.elements.find(e => e.kind === 'graphic');
        expect(graphic && graphic.kind === 'graphic' && graphic.data && graphic.data.length).toBeTruthy();
        if (graphic && graphic.kind === 'graphic' && graphic.data) {
            const decoded = decodeGraphicColumns(graphic.widthDots, graphic.heightDots, graphic.data);
            expect(inkOf(decoded)).toBeGreaterThan(0);
            // The designer's parser and the viewer must agree on the pixels,
            // or the screen and the printer diverge for the same stream.
            const viaDesigner = (parseIPL(ipl, DPI).fields[0] as ImageField).bitmap;
            const viaViewer = decoded.map(row => row.map(b => (b ? '1' : '0')).join(''));
            expect(viaViewer).toEqual(viaDesigner);
        }
    });

    it('a hidden shape is not sent to the printer', async () => {
        const ipl = await generateIPL(makeDesign([ellipse(1, { visible: false })]));
        expect(ipl).not.toContain('<STX>G');
        expect(parseIPL(ipl, DPI).fields).toHaveLength(0);
    });
});
