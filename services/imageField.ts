// Batch O: image/logo fields. An ImageField carries a monochrome bitmap as
// rows of '0'/'1' characters (top row first) — JSON-safe, and exactly the
// print-dot model IPL raster graphics use: the dot grid is the asset, and
// on a different-dpi printer it occupies different millimeters (manual-
// faithful: a G resource downloaded at 100 dots is 100 dots everywhere).
//
// The bitmap is produced once at import time (threshold+halftone applied
// against the user's source pixels) and stored on the field, so undo, save,
// clipboard and IPL round-trips all behave for free.
import type { Design, Field, ImageField } from '../types';
import { DPI_MAP } from '../constants';

export const MAX_IMAGE_DOTS = 2400; // per axis; ~1200 dots is already ~150mm

/** Rows of '0'/'1' (top first) -> [[0,1,...],...] numeric matrix. */
export const bitmapRowsToMatrix = (rows: string[]): number[][] =>
    rows.map(r => Array.from(r, ch => (ch === '1' ? 1 : 0)));

const matrixToBitmapRows = (m: number[][]): string[] => m.map(r => r.join(''));

/**
 * Resample an existing bitmap to a new dot grid (nearest neighbour, dark-
 * pixel-biased: a target dot inks if ANY source pixel mapping into it is
 * ink — preserves thin strokes when shrinking, which is what logos need).
 */
export const resampleBitmap = (rows: string[], newHeight: number, newWidth: number): string[] => {
    const srcH = rows.length;
    const srcW = srcH ? rows[0].length : 0;
    if (newHeight <= 0 || newWidth <= 0 || srcH === 0 || srcW === 0) return [];
    if (newHeight === srcH && newWidth === srcW) return rows;
    const out: string[] = [];
    for (let y = 0; y < newHeight; y++) {
        const y0 = Math.floor((y * srcH) / newHeight);
        const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * srcH) / newHeight));
        let line = '';
        for (let x = 0; x < newWidth; x++) {
            const x0 = Math.floor((x * srcW) / newWidth);
            const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * srcW) / newWidth));
            let ink = 0;
            outer: for (let sy = y0; sy < y1; sy++) {
                const row = rows[sy];
                for (let sx = x0; sx < x1; sx++) {
                    if (row[sx] === '1') { ink = 1; break outer; }
                }
            }
            line += ink ? '1' : '0';
        }
        out.push(line);
    }
    return out;
};

/**
 * Resize COMMIT: the user set width/height (mm) deliberately, so the dot
 * grid is rebuilt to match — resampleBitmap regenerates the asset, and mm
 * are re-derived exactly from the new dot counts.
 */
export const resampleImageField = (field: ImageField, design: Design): ImageField => {
    const dotsPerMm = DPI_MAP[design.printerSettings.dpi];
    const wantW = Math.max(1, Math.min(MAX_IMAGE_DOTS, Math.round(field.width * dotsPerMm)));
    const wantH = Math.max(1, Math.min(MAX_IMAGE_DOTS, Math.round(field.height * dotsPerMm)));
    const haveH = field.bitmap.length;
    const haveW = haveH ? field.bitmap[0].length : 0;
    if (haveW === wantW && haveH === wantH) {
        const exW = wantW / dotsPerMm, exH = wantH / dotsPerMm;
        if (field.width === exW && field.height === exH) return field;
        return { ...field, width: exW, height: exH };
    }
    const bitmap = resampleBitmap(field.bitmap, wantH, wantW);
    return { ...field, bitmap, width: wantW / dotsPerMm, height: wantH / dotsPerMm };
};

/**
 * DPI COMMIT: a downloaded IPL raster is its dots — switching printers
 * re-derives the physical mm (100 dots at 203dpi ≈ 12.5mm, at 300dpi
 * ≈ 8.5mm) and never regenerates the asset.
 */
export const rederiveImageMm = (field: ImageField, design: Design): ImageField => {
    const dotsPerMm = DPI_MAP[design.printerSettings.dpi];
    const w = field.bitmap[0]?.length ?? 0;
    const h = field.bitmap.length;
    const width = w / dotsPerMm, height = h / dotsPerMm;
    return field.width === width && field.height === height ? field : { ...field, width, height };
};

/**
 * Apply a property-panel update to an image field while keeping bitmap, dot
 * grid and mm consistent: an explicit size edit resamples the asset, a
 * bitmap replacement (new file, invert) re-derives mm from the dot grid.
 */
export const rebaseImage = (prev: Field, updates: Record<string, unknown>, design: Design): Field => {
    if (prev.type !== 'image') return { ...prev, ...updates } as Field;
    const next = { ...prev, ...updates } as ImageField;
    if (updates.bitmap !== undefined) return rederiveImageMm(next, design);
    if (updates.width !== undefined || updates.height !== undefined) return resampleImageField(next, design);
    return next;
};

/** Re-derive mm for every image field (used when printerSettings.dpi changes). */
export const rederiveAllImages = (design: Design): Design => {
    if (!design.fields.some(f => f.type === 'image')) return design;
    const fields = design.fields.map(f => f.type === 'image' ? rederiveImageMm(f, design) : f);
    return { ...design, fields };
};

/**
 * COMMIT_INTERMEDIATE hook: live drags resize image fields cheaply (mm
 * only, bitmap untouched, preview draws scaled). At commit the dot grid is
 * rebuilt to match — once per gesture, never per mousemove.
 */
export const conformImages = (design: Design): Design => {
    if (!design.fields.some(f => f.type === 'image')) return design;
    let changed = false;
    const fields = design.fields.map(f => {
        if (f.type !== 'image') return f;
        const conformed = resampleImageField(f, design);
        if (conformed !== f) changed = true;
        return conformed;
    });
    return changed ? { ...design, fields } : design;
};

/**
 * How a grey value becomes one bit. 'threshold' cuts on luminance (crisp for
 * logos). 'bayer' is ordered dithering (the historical `halftone: true`).
 * 'floyd-steinberg' spreads each pixel's rounding error onto its neighbours,
 * which is what keeps a photograph's mid-tones on a 1-bit thermal head.
 * A boolean is accepted because every existing caller passes one: true means
 * 'bayer', false means 'threshold', so those callers change nothing.
 */
export type DitherMode = 'threshold' | 'bayer' | 'floyd-steinberg';

const resolveDither = (halftone: boolean | DitherMode): DitherMode =>
    halftone === true ? 'bayer' : halftone === false ? 'threshold' : halftone;

/**
 * Downscale an RGBA ImageData to a dot bitmap. Pixels are composited over
 * white (transparency = paper) and reduced to 1 bit by `dither`.
 * Returns [] when the target grid is degenerate.
 */
export const imageDataSourceToBitmap = (
    data: Uint8ClampedArray, srcW: number, srcH: number,
    dotsW: number, dotsH: number, threshold: number, halftone: boolean | DitherMode,
): string[] => {
    if (dotsW <= 0 || dotsH <= 0 || srcW <= 0 || srcH <= 0) return [];
    const mode = resolveDither(halftone);

    // Luminance of the downscaled grid, row-major. Computed once so both the
    // per-pixel modes and the error-diffusion pass read the same source.
    const lum = new Float64Array(dotsW * dotsH);
    for (let y = 0; y < dotsH; y++) {
        const y0 = Math.floor((y * srcH) / dotsH);
        const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * srcH) / dotsH));
        for (let x = 0; x < dotsW; x++) {
            const x0 = Math.floor((x * srcW) / dotsW);
            const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * srcW) / dotsW));
            // Average over the source block (area downscale: keeps thin marks
            // and prevents moiré vs a single-pixel sample).
            let acc = 0, n = 0;
            for (let sy = y0; sy < y1; sy++) {
                for (let sx = x0; sx < x1; sx++) {
                    const i = (sy * srcW + sx) * 4;
                    const a = data[i + 3] / 255;
                    acc += 0.299 * (data[i] * a + 255 * (1 - a))
                         + 0.587 * (data[i + 1] * a + 255 * (1 - a))
                         + 0.114 * (data[i + 2] * a + 255 * (1 - a));
                    n++;
                }
            }
            lum[y * dotsW + x] = n ? acc / n : 255;
        }
    }

    if (mode === 'floyd-steinberg') return floydSteinberg(lum, dotsW, dotsH, threshold);

    const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const rows: string[] = [];
    for (let y = 0; y < dotsH; y++) {
        let line = '';
        for (let x = 0; x < dotsW; x++) {
            const v = lum[y * dotsW + x];
            const cut = mode === 'bayer'
                ? threshold + (BAYER[(y % 4) * 4 + (x % 4)] / 16 - 0.5) * 2 * 48
                : threshold;
            line += v < cut ? '1' : '0';
        }
        rows.push(line);
    }
    return rows;
};

/**
 * Floyd–Steinberg error diffusion. Each pixel is rounded to ink or paper and
 * the error (how far the rounding moved it) is handed to the four pixels that
 * have not been visited yet: 7/16 to the right, 3/16 below-left, 5/16 below,
 * 1/16 below-right. Rows alternate direction so the error does not drift to
 * one side of the image. A mid-grey therefore prints as roughly half ink,
 * where a plain threshold would print it as a solid block.
 */
const floydSteinberg = (lum: Float64Array, w: number, h: number, threshold: number): string[] => {
    const px = Float64Array.from(lum);
    const ink = new Uint8Array(w * h);
    const spread = (x: number, y: number, err: number, frac: number) => {
        if (x >= 0 && x < w && y >= 0 && y < h) px[y * w + x] += err * frac;
    };
    for (let y = 0; y < h; y++) {
        const ltr = y % 2 === 0;
        for (let k = 0; k < w; k++) {
            const x = ltr ? k : w - 1 - k;
            const i = y * w + x;
            const isInk = px[i] < threshold;
            ink[i] = isInk ? 1 : 0;
            const err = px[i] - (isInk ? 0 : 255);
            const dir = ltr ? 1 : -1;
            spread(x + dir, y, err, 7 / 16);
            spread(x - dir, y + 1, err, 3 / 16);
            spread(x, y + 1, err, 5 / 16);
            spread(x + dir, y + 1, err, 1 / 16);
        }
    }
    const rows: string[] = [];
    for (let y = 0; y < h; y++) {
        let line = '';
        for (let x = 0; x < w; x++) line += ink[y * w + x] ? '1' : '0';
        rows.push(line);
    }
    return rows;
};

/**
 * Build a ready ImageField from a bitmap: mm derived exactly from the dot
 * grid at `dpi` (id 0 — ADD_FIELD assigns the real one).
 */
export const makeImageFieldFromBitmap = (bitmap: string[], dpi: Design['printerSettings']['dpi'], x: number, y: number, name: string, threshold: number): ImageField => {
    const h = bitmap.length;
    const w = h ? bitmap[0].length : 0;
    const dotsPerMm = DPI_MAP[dpi];
    return {
        id: 0, type: 'image', name, x, y, rotation: 0, locked: false, visible: true,
        bitmap, width: w / dotsPerMm, height: h / dotsPerMm, threshold,
    };
};

/** Flip ink/paper in every row (white-on-dark logos). */
export const invertBitmap = (rows: string[]): string[] =>
    rows.map(r => r.replace(/1/g, '#').replace(/0/g, '1').replace(/#/g, '0'));

/** 40x40 checkerboard placeholder (~5mm at 203dpi): what the Image tool
 *  drops before the user picks a file in the properties panel. */
export const placeholderImage = (dpi: Design['printerSettings']['dpi']): { bitmap: string[]; width: number; height: number } => {
    const bitmap: string[] = [];
    for (let y = 0; y < 40; y++) {
        let line = '';
        for (let x = 0; x < 40; x++) line += ((x >> 3) + (y >> 3)) % 2 ? '1' : '0';
        bitmap.push(line);
    }
    const dotsPerMm = DPI_MAP[dpi];
    return { bitmap, width: 40 / dotsPerMm, height: 40 / dotsPerMm };
};

/**
 * Decode a picked image File to a row-bitmap via <img> + a scratch canvas.
 * The dot grid is width-capped at `maxDotsW` keeping the source aspect, and
 * the height axis is capped too (so a tall image never exceeds the budget
 * per axis). Throws on decode failure. Kept separate from the pure
 * converters so unit tests can drive imageDataSourceToBitmap with synthetic
 * pixels.
 */
export const loadImageFileToBitmap = (file: File, maxDotsW: number, threshold: number, halftone: boolean | DitherMode): Promise<string[]> =>
    new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            try {
                const srcW = img.naturalWidth || img.width;
                const srcH = img.naturalHeight || img.height;
                if (srcW <= 0 || srcH <= 0) throw new Error('zero-size image');
                // 1 source pixel -> 1 print dot (upscaling a small logo would
                // add no detail and bloats the design JSON), capped per axis.
                let w = Math.min(srcW, maxDotsW);
                let h = Math.max(1, Math.round(w * srcH / srcW));
                if (h > MAX_IMAGE_DOTS) { h = MAX_IMAGE_DOTS; w = Math.max(1, Math.round(h * srcW / srcH)); }
                const canvas = document.createElement('canvas');
                canvas.width = srcW;
                canvas.height = srcH;
                const ctx = canvas.getContext('2d');
                if (!ctx) throw new Error('cannot read image');
                ctx.drawImage(img, 0, 0);
                const data = ctx.getImageData(0, 0, srcW, srcH).data;
                resolve(imageDataSourceToBitmap(data, srcW, srcH, w, h, threshold, halftone));
            } catch (e) {
                reject(e);
            } finally {
                URL.revokeObjectURL(url);
            }
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image decode failed')); };
        img.src = url;
    });
