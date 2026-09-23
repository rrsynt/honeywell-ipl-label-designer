// Workstream 3 (2026-09-24): the two halves of the accuracy triangle that live
// entirely inside this app.
//
//  1. Designer → print: render the SAME design through both engines and compare
//     ink. Designer side: canvasDrawer (drawElements, the screen). Print side:
//     generateIPL → parseViewerIPL → renderLabel (what the viewer/printer
//     produce). This extends rotationWysiwyg's contract from text to raster
//     images, QR, EAN-13 and multiline text.
//  2. Paste safety: generateIPL in Direct Graphics mode → push the output
//     through a UTF-8 encode/decode (the clipboard path) → parse → render, and
//     require the ink to be identical to the pre-paste render. A stored-format
//     image cannot make this promise: its payload carries bytes above 0x7f.
//
// Both engines run at 1 dot = 1 px (designer zoom 2 with PREVIEW_SCALE 4 /
// DPI_MAP 8; viewer pxPerDot 1), on the same 320×320-dot label, so ink bounding
// boxes are directly comparable.
import './golden/setup';
import { describe, it, expect, beforeAll } from 'vitest';
import { newRealCanvas } from './golden/setup';
import { generateIPL } from '../services/iplGenerator';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { renderLabel } from '../services/ipl/renderer';
import { drawElements } from '../services/canvasDrawer';
import { ensureBarcodesReady } from '../services/ipl/barcodes';
import type { Design, ImageField, BarcodeField, TextField } from '../types';

beforeAll(async () => { await ensureBarcodesReady(); });

const DOTS = 320;

const design = (fields: Design['fields'], directGraphics = false): Design => ({
    name: 'RT',
    labelSettings: { width: 40, height: 40, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: {
        model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal',
        mediaSenseMode: 'gap', printSpeed: 6, darkness: 10,
        ...(directGraphics ? { directGraphics: true } : {}),
    },
    fields, dataSources: [], nextId: fields.length + 1, guides: { horizontal: [], vertical: [] },
});

const logo: ImageField = {
    id: 1, type: 'image', name: 'Logo', x: 5, y: 5, rotation: 0, locked: false, visible: true,
    threshold: 128, width: 12 / 8, height: 10 / 8,
    bitmap: [
        '111111111111', '100000000001', '101111111101', '101000000101', '101011110101',
        '101011110101', '101000000101', '101111111101', '100000000001', '111111111111',
    ],
};

const qr: BarcodeField = {
    id: 2, type: 'barcode', name: 'QR', x: 20, y: 5, rotation: 0,
    dataSource: { type: 'fixed', data: 'https://example.test/label' }, symbology: '18',
    humanReadable: 'none', h_mag: 40, w_mag: 3, qrModel: 2, qrEcl: 'M',
};

const ean: BarcodeField = {
    id: 3, type: 'barcode', name: 'EAN', x: 5, y: 25, rotation: 0,
    dataSource: { type: 'fixed', data: '5901234123457' }, symbology: '7',
    humanReadable: 'none', h_mag: 60, w_mag: 2,
};

const multiline: TextField = {
    id: 4, type: 'text', name: 'ML', x: 20, y: 25, rotation: 0,
    dataSource: { type: 'fixed', data: 'LINE ONE\nLINE TWO\nLINE THREE' },
    font: '25', fontSize: 8, h_mag: 1, w_mag: 1,
};

function inkBBox(canvas: { width: number; height: number; getContext(k: '2d'): any }) {
    const ctx = canvas.getContext('2d')! as any;
    if (!ctx) return null;
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const o = (y * canvas.width + x) * 4;
        if (d[o + 3] > 0 && d[o] < 100 && d[o + 1] < 100 && d[o + 2] < 100) {
            x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
    }
    return x1 < 0 ? null : [x0, y0, x1, y1] as [number, number, number, number];
}

const printBox = async (d: Design, source: string) => {
    const label = parseViewerIPL(source);
    const pv = newRealCanvas(DOTS, DOTS);
    renderLabel(pv as unknown as HTMLCanvasElement, label, { widthDots: DOTS, heightDots: DOTS }, { dpi: 203, pxPerDot: 1, quality: 1, rotation: 0 });
    return inkBBox(pv as never);
};

const designBox = (d: Design) => {
    const dv = newRealCanvas(DOTS, DOTS);
    const ctx = dv.getContext('2d')! as unknown as CanvasRenderingContext2D;
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, DOTS, DOTS);
    drawElements(ctx, d, [], { zoom: 2, pan: { x: 0, y: 0 } }, { x: null, y: null }, null, null);
    return inkBBox(dv as never);
};

const agree = (a: [number, number, number, number], b: [number, number, number, number], tol: number, label: string) => {
    for (let i = 0; i < 4; i++) {
        expect(Math.abs(a[i] - b[i]), `${label} ${['x0', 'y0', 'x1', 'y1'][i]} (screen ${a} vs print ${b})`).toBeLessThanOrEqual(tol);
    }
};

describe('designer screen ≡ print render (Workstream 3)', () => {
    for (const [name, field] of [['raster image', logo], ['QR', qr], ['EAN-13', ean], ['multiline text', multiline]] as const) {
        it(`${name}: ink boxes agree within 3px`, async () => {
            const d = design([field]);
            const screen = designBox(d);
            const print = await printBox(d, await generateIPL(d));
            expect(screen, 'designer drew something').not.toBeNull();
            expect(print, 'print drew something').not.toBeNull();
            agree(screen!, print!, 3, name);
        }, 30000);
    }
});

describe('Direct Graphics output survives a UTF-8 paste', () => {
    it('renders identically before and after a TextEncoder round trip', async () => {
        const d = design([logo], true);
        const ipl = await generateIPL(d);
        expect(ipl).toContain('<ESC>g1');
        expect(ipl).toMatch(/^[\x00-\x7f]*$/);

        const pasted = new TextDecoder().decode(new TextEncoder().encode(ipl));
        expect(pasted).toBe(ipl);

        const before = await printBox(d, ipl);
        const after = await printBox(d, pasted);
        expect(before).not.toBeNull();
        agree(before!, after!, 0, 'paste');
    }, 30000);
});
