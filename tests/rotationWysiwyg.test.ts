// Batch W (2026-09-24): the rotation-direction + align-baking contract,
// asserted the only way that actually proves it — render the SAME design
// through both engines and compare ink. Designer side: canvasDrawer
// (drawElements, the screen). Print side: generateIPL → parseViewerIPL →
// renderLabel (what the viewer/printer produce). Before Batch W the designer
// drew fields CLOCKWISE while IPL rotates them COUNTERCLOCKWISE (DevGuide
// p.27: "the field origin remains on the corner where it was before you
// rotated the field"), and text align was never baked into the print origin
// — a center-aligned field displayed centered but printed flush-left. The
// probe that found it: f1 designer [140,163] vs print [127,60].
//
// Both engines run at 1 dot = 1 px here (designer zoom 2 with PREVIEW_SCALE
// 4 / DPI_MAP 8; viewer pxPerDot 1), on the same 320×320-dot label, so ink
// bounding boxes are directly comparable.
import './golden/setup';
import { describe, it, expect } from 'vitest';
import { newRealCanvas } from './golden/setup';
import { generateIPL } from '../services/iplGenerator';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { renderLabel } from '../services/ipl/renderer';
import { drawElements } from '../services/canvasDrawer';
import type { Design, TextField } from '../types';

const mk = (rot: 0 | 90 | 180 | 270, align?: 'left' | 'center' | 'right'): Design => ({
    name: 'W',
    labelSettings: { width: 40, height: 40, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields: [{ id: 1, type: 'text', name: 'T', x: 20, y: 20, rotation: rot, align, dataSource: { type: 'fixed', data: 'HELLO WORLD' }, font: '25', fontSize: 12, h_mag: 1, w_mag: 1 } as TextField],
    dataSources: [], nextId: 2, guides: { horizontal: [], vertical: [] },
});

function inkBBox(canvas: { width: number; height: number; getContext(k: '2d'): any }) {
    const ctx = canvas.getContext('2d')! as any;
    if (!ctx) return null;
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const o = (y * canvas.width + x) * 4;
        // alpha > 200 = SOLID ink. The designer draws the label card with a
        // 50%-black drop shadow (canvasDrawer), which is dark enough to pass a
        // colour test and would otherwise be measured as printed ink wherever
        // the canvas is larger than the label; requiring near-opaque pixels
        // excludes it. The viewer's indigo label-edge hairline is already
        // excluded by the g channel (102).
        if (d[o + 3] > 200 && d[o] < 100 && d[o + 1] < 100 && d[o + 2] < 100) {
            x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
    }
    return x1 < 0 ? null : [x0, y0, x1, y1] as [number, number, number, number];
}

// Bitmap-face text with a width magnification, for the parity sweep below.
// These ids are the ones whose advance the printer defines as a fixed cell
// (PRM270 p.54) and whose `w` "makes each letter twice as wide" (PRM p.55) —
// the two facts the shared paint helper now enforces. Before it, the designer
// widened the run by scaling the host face (104px for a 79-dot box) while the
// viewer ignored `w` entirely (77px vs 154px for the same design).
const CELL_W: Record<string, number> = { '0': 7, '2': 10, '7': 5 };
const CELL_GAP: Record<string, number> = { '0': 1, '2': 2, '7': 2 };

// 60 × 40 mm = 480 × 320 dots at 203 dpi, the same canvas both engines render
// into below — at w3 the longest run (c2: 10 × 12 × 3 − 6 = 354 dots) still
// fits inside the label, so neither engine clips and the boxes are comparable.
const mkBitmap = (font: string, w_mag: number): Design => ({
    name: 'WB',
    labelSettings: { width: 60, height: 40, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields: [{ id: 1, type: 'text', name: 'T', x: 5, y: 5, rotation: 0, dataSource: { type: 'fixed', data: 'HHHHHHHHHH' }, font, fontSize: 12, h_mag: 2, w_mag } as TextField],
    dataSources: [], nextId: 2, guides: { horizontal: [], vertical: [] },
});

describe('designer screen ≡ print render (Batch W)', () => {
    for (const rot of [0, 90, 180, 270] as const) {
        for (const align of ['left', 'center', 'right'] as const) {
            it(`rotation ${rot}°, align ${align}: ink boxes agree within 3px`, async () => {
                const d = mk(rot, align);
                // PRINT side
                const label = parseViewerIPL(await generateIPL(d));
                const pv = newRealCanvas(320, 320);
                renderLabel(pv as unknown as HTMLCanvasElement, label, { widthDots: 320, heightDots: 320 }, { dpi: 203, pxPerDot: 1, quality: 1, rotation: 0 });
                const printBox = inkBBox(pv as never);
                // DESIGNER side (zoom 2 → 1 dot = 1 px)
                const dv = newRealCanvas(320, 320);
                const ctx = dv.getContext('2d')! as unknown as CanvasRenderingContext2D;
                ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 320, 320);
                drawElements(ctx, d, [], { zoom: 2, pan: { x: 0, y: 0 } }, { x: null, y: null }, null, null);
                const designBox = inkBBox(dv as never);
                expect(designBox, 'designer drew something').not.toBeNull();
                expect(printBox, 'print drew something').not.toBeNull();
                for (let i = 0; i < 4; i++) {
                    expect(Math.abs(designBox![i] - printBox![i]), `${['x0', 'y0', 'x1', 'y1'][i]} rot=${rot} align=${align} (designer ${designBox} vs print ${printBox})`).toBeLessThanOrEqual(3);
                }
            }, 30000);
        }
    }

    // Bitmap faces under width magnification — the pair of engines must agree
    // on the printer's cell pitch, not merely on where the field starts.
    for (const font of ['0', '2', '7'] as const) {
        for (const w of [1, 2, 3] as const) {
            it(`bitmap c${font} at w${w}: designer and print ink widths agree within 3px`, async () => {
                const d = mkBitmap(font, w);
                const label = parseViewerIPL(await generateIPL(d));
                const pv = newRealCanvas(480, 320);
                renderLabel(pv as unknown as HTMLCanvasElement, label, { widthDots: 480, heightDots: 320 }, { dpi: 203, pxPerDot: 1, quality: 1, rotation: 0 });
                const printBox = inkBBox(pv as never);
                const dv = newRealCanvas(480, 320);
                const ctx = dv.getContext('2d')! as unknown as CanvasRenderingContext2D;
                ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 480, 320);
                drawElements(ctx, d, [], { zoom: 2, pan: { x: 0, y: 0 } }, { x: null, y: null }, null, null);
                const designBox = inkBBox(dv as never);
                expect(designBox, 'designer drew something').not.toBeNull();
                expect(printBox, 'print drew something').not.toBeNull();
                for (let i = 0; i < 4; i++) {
                    expect(Math.abs(designBox![i] - printBox![i]), `${['x0', 'y0', 'x1', 'y1'][i]} c${font} w${w} (designer ${designBox} vs print ${printBox})`).toBeLessThanOrEqual(3);
                }
                // And the run must actually widen with w: agreement on a width
                // that never changes would prove nothing (the old viewer
                // ignored w for bitmap faces entirely).
                const width = printBox![2] - printBox![0] + 1;
                const perChar = width / 10;
                const expected = (CELL_W[font] + CELL_GAP[font]) * w;
                expect(perChar, `c${font} w${w} should advance ~${expected} dots per character`).toBeGreaterThan(expected - 3);
                expect(perChar).toBeLessThan(expected + 1);
            }, 30000);
        }
    }
});
