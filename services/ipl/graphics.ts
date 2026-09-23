// IPL raster graphic fields ("G" definitions with "u<index>,<ascii>" rows).
//
// Packing scheme (matches the designer's generator): each graphic is stored as
// columns; every column's bits are grouped 6-at-a-time into a character whose
// code is 0x40 | (6 packed bits), first bit in the most significant slot.

export type Bitmap = number[][]; // bitmap[y][x], 1 = black

/**
 * Packs column-major bits into IPL ASCII data lines.
 * `bitmap[y][x]` with width = bitmap[0].length, height = bitmap.length.
 */
export const encodeBitmapColumns = (bitmap: Bitmap): string[] => {
    if (bitmap.length === 0 || bitmap[0].length === 0) return [];
    const height = bitmap.length;
    const width = bitmap[0].length;
    const columns: string[] = [];

    for (let x = 0; x < width; x++) {
        let asciiColumn = '';
        for (let i = 0; i < height; i += 6) {
            let byteValue = 0b01000000;
            for (let j = 0; j < 6; j++) {
                const y = i + j;
                if (y < height && bitmap[y][x]) {
                    byteValue |= 1 << (5 - j);
                }
            }
            asciiColumn += String.fromCharCode(byteValue);
        }
        columns.push(asciiColumn);
    }
    return columns;
};

/** Inverse of encodeBitmapColumns. Unknown characters decode as white. */
export const decodeGraphicColumns = (width: number, height: number, data: string[]): Bitmap => {
    const bitmap: Bitmap = Array.from({ length: height }, () => new Array(width).fill(0));
    if (width <= 0 || height <= 0) return bitmap;

    // Two storage orientations exist:
    //  - classic column-major: data[x] = column x, 6 bits per char running
    //    DOWN, MSB-first (our generator's form, PRM p.186)
    //  - BarTender print-head form: data[r] = row r, bits running ACROSS,
    //    LSB-first, rows stored bottom-up (so the visual needs a vertical
    //    flip after decoding). Verified against a real BarTender export.
    const stripsAsRows = data.length === height && height !== width;

    for (let s = 0; s < Math.min(data.length, stripsAsRows ? height : width); s++) {
        const strip = data[s];
        if (!strip) continue;
        const limit = stripsAsRows ? width : height;
        for (let i = 0; i < strip.length && i * 6 < limit; i++) {
            const byteValue = strip.charCodeAt(i) & 0x3f;
            for (let j = 0; j < 6; j++) {
                const bit = stripsAsRows
                    ? (byteValue >> j) & 1          // LSB-first across
                    : (byteValue >> (5 - j)) & 1;   // MSB-first down
                if (stripsAsRows) {
                    const x = i * 6 + j;
                    if (x < width && bit) bitmap[s][x] = 1;
                } else {
                    const y = i * 6 + j;
                    if (y < height && bit) bitmap[y][s] = 1;
                }
            }
        }
    }
    if (stripsAsRows) {
        // Print-head rows are stored bottom-up; flip to visual top-down.
        bitmap.reverse();
    }
    return bitmap;
};

/** Draws a decoded bitmap onto a context at device scale, using an offscreen canvas. */
export const paintBitmap = (
    ctx: CanvasRenderingContext2D,
    bitmap: Bitmap,
    xPx: number,
    yPx: number,
    pxPerDot: number,
): void => {
    const height = bitmap.length;
    if (height === 0) return;
    const width = bitmap[0].length;
    if (width === 0) return;

    const off = document.createElement('canvas');
    off.width = width;
    off.height = height;
    const offCtx = off.getContext('2d');
    if (!offCtx) return;

    const img = offCtx.createImageData(width, height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (bitmap[y][x]) {
                const i = (y * width + x) * 4;
                img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
                img.data[i + 3] = 255;
            }
        }
    }
    offCtx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    // The offscreen canvas may be a napi canvas (Node tests) or a DOM canvas
    // (browser); drawImage accepts either but napi validates strictly, so
    // route through the source canvas when available.
    const src = (off as unknown as { __sourceCanvas?: unknown }).__sourceCanvas ?? off;
    try {
        ctx.drawImage(src as CanvasImageSource, xPx, yPx, width * pxPerDot, height * pxPerDot);
    } catch {
        ctx.drawImage(off as unknown as CanvasImageSource, xPx, yPx, width * pxPerDot, height * pxPerDot);
    }
};
