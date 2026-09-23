/**
 * Test-environment shims shared by every vitest file that renders labels in
 * Node (golden suite + parity suites). Import this file — never harness.ts —
 * when you only need the environment: harness.ts declares executable suites,
 * and importing it from several test files would re-run all golden pixel
 * comparisons once per importer.
 *
 * The app renderer targets the DOM canvas API. Under vitest/happy-dom the 2D
 * context is a stub, so this setup swaps in real canvases:
 *
 *  - `document.createElement('canvas')` is patched to return @napi-rs/canvas
 *    instances (used by barcodes.ts / graphics.ts for offscreen work).
 *  - `bwip-js/browser` is replaced by an adapter over `bwip-js/node` whose
 *    drawing interface replicates bwip's DrawingBuiltin rasterizer semantics
 *    exactly (integer line splitting, scanline even-odd fill), so barcode
 *    modules land on identical pixels in both environments. The mock also
 *    exposes the real bundle's raw() (via vi.importActual) for the
 *    run-length ratio path and codeword-level test assertions.
 */
import { vi } from 'vitest';
import { createCanvas as napiCreateCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { registerBundledFonts } from './fonts';

// Vendored Liberation fonts make every node render host-independent (see
// ./fonts.ts). Must run before any canvas is asked to measure or draw text.
registerBundledFonts();

export const newRealCanvas = (w: number, h: number) => {
    const c = napiCreateCanvas(Math.max(1, w | 0), Math.max(1, h | 0));
    // renderLabel() assigns CSS style properties; give the native canvas a
    // plain object so those assignments are harmless no-ops.
    if (!(c as unknown as { style?: object }).style) {
        (c as unknown as { style: object }).style = {};
    }
    return c;
};

// Intercept all offscreen canvas creation inside services/ipl/*.
const originalCreateElement = globalThis.document.createElement.bind(globalThis.document);
globalThis.document.createElement = ((tag: string) => {
    if (tag.toLowerCase() === 'canvas') return newRealCanvas(300, 150);
    return originalCreateElement(tag);
}) as typeof document.createElement;

export type NapiCanvas = ReturnType<typeof newRealCanvas>;

/**
 * Replicates bwip-js DrawingBuiltin pixel semantics against a napi canvas.
 * Reference: node_modules/bwip-js/dist/bwip-js-node.mjs (DrawingBuiltin).
 */
export class BwipCanvasDrawing {
    private xymap: (number[][] & { min: number }) | null = null;
    private W = 0;
    private H = 0;

    constructor(private readonly canvas: NapiCanvas) {}

    setopts() {}

    scale(sx: number, sy: number) {
        return [(sx | 0) || 1, (sy | 0) || 1] as const;
    }

    measure(_str: string, _font: unknown, fwidth: number, fheight: number) {
        return { width: fwidth, ascent: fheight, descent: 0 };
    }

    init(w: number, h: number) {
        this.W = w;
        this.H = h;
        this.canvas.width = w;
        this.canvas.height = h;
        const ctx = this.canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        this.xymap = Object.assign([] as number[][], { min: Infinity });
    }

    line(x0: number, y0: number, x1: number, y1: number, lw: number) {
        x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
        lw = Math.round(lw) || 1;
        if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
        if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
        const w2 = (lw / 2) | 0;
        if (x0 === x1) {
            x0 = x0 - lw + w2;
            x1 = x1 + w2 - 1;
        } else {
            y0 = y0 - w2;
            y1 = y1 + lw - w2 - 1;
        }
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) this.setPx(x, y);
        }
    }

    polygon(pts: number[][]) {
        const npts = pts.length;
        for (let j = npts - 1, i = 0; i < npts; j = i++) {
            const xj = pts[j][0] | 0, xi = pts[i][0] | 0;
            const yj = pts[j][1] | 0, yi = pts[i][1] | 0;
            if (xj === xi) {
                // Vertical edges contribute interior points only.
                if (yj > yi) for (let y = yi + 1; y < yj; y++) this.addPoint(xj, y);
                else for (let y = yj + 1; y < yi; y++) this.addPoint(xj, y);
            } else {
                // Horizontal edges follow DrawingBuiltin.polygon exactly.
                if (xj < xi) {
                    const yl = pts[j === 0 ? npts - 1 : j - 1][1];
                    const yr = pts[i === npts - 1 ? 0 : i + 1][1];
                    if (yl > yj) this.addPoint(xj, yj);
                    if (yr > yj) this.addPoint(xi, yj);
                } else {
                    const yl = pts[i === npts - 1 ? 0 : i + 1][1];
                    const yr = pts[j === 0 ? npts - 1 : j - 1][1];
                    if (yl > yj) this.addPoint(xi, yj);
                    if (yr > yj) this.addPoint(xj, yj);
                }
            }
        }
    }

    hexagon(pts: number[][]) {
        this.polygon(pts);
    }

    ellipse(x: number, y: number, rx: number, ry: number) {
        // Filled-disk approximation via scanline pairs (only used by maxicode /
        // dotcode, neither mapped by the viewer today).
        for (let dy = -ry; dy <= ry; dy++) {
            const span = Math.floor(rx * Math.sqrt(Math.max(0, 1 - (dy * dy) / (ry * ry))));
            this.addPoint(x - span, y + dy);
            this.addPoint(x + span + 1, y + dy);
        }
    }

    fill() {
        if (!this.xymap) return;
        const ymin = this.xymap.min;
        const ymax = this.xymap.length - 1;
        for (let y = ymin; y <= ymax; y++) {
            const xs = this.xymap[y];
            if (!xs) continue;
            xs.sort((a, b) => a - b);
            let wn = false;
            let xl = 0;
            for (const x of xs) {
                if (wn) {
                    for (let px = xl; px < x; px++) this.setPx(px, y);
                } else {
                    xl = x;
                }
                wn = !wn;
            }
        }
        this.xymap = Object.assign([] as number[][], { min: Infinity });
    }

    text() {
        // HRI text is never requested (includetext: false).
    }

    end() {}

    private ctx(): SKRSContext2D {
        return this.canvas.getContext('2d');
    }

    private setPx(x: number, y: number) {
        if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
        const ctx = this.ctx();
        ctx.fillStyle = '#000000';
        ctx.fillRect(x, y, 1, 1);
    }

    private addPoint(x: number, y: number) {
        if (!this.xymap) return;
        (this.xymap[y] ??= []).push(x);
        if (y < this.xymap.min) this.xymap.min = y;
    }
}

vi.mock('bwip-js/browser', async () => {
    // paintBarcode() calls toCanvas synchronously and immediately draws from the
    // offscreen canvas, so the adapter must rasterize before returning.
    // bwip's render(options, drawing) is synchronous when given a drawing object.
    const adapt = (canvas: HTMLCanvasElement, options: Record<string, unknown>) => {
        if (!nodeRender) throw new Error('bwip-js/node not loaded yet');
        nodeRender(options, new BwipCanvasDrawing(canvas as unknown as NapiCanvas));
    };
    // The run-length ratio path reads bwip's module grids via raw(). The ESM
    // bundle's *named* `raw` export is a _ToAny variant needing a drawing;
    // the API we want is the default export's raw (ToRaw). importActual
    // bypasses this mock to reach the real bundle.
    const actual = (await vi.importActual('bwip-js/browser')) as unknown as {
        default: { raw: (options: Record<string, unknown>) => unknown[] };
    };
    const raw = (options: Record<string, unknown>) => actual.default.raw(options);
    return { toCanvas: adapt, raw, default: { toCanvas: adapt, raw } };
});

// Populated by the top-level await below; the mock factory closes over it and
// only dereferences it at call time (well after module initialization).
// Exported so parity tests can rasterize reference symbols directly.
export let nodeRender: ((options: unknown, drawing: unknown) => void) | null = null;
nodeRender = (await import('bwip-js/node')).render as typeof nodeRender;
