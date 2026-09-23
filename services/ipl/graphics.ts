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

/**
 * Encodes a visual bitmap (top row first) as nibblized Direct Graphics RLE —
 * the inverse of extractDirectGraphics(..., 1). Placement follows PRM Appendix
 * E: columns load left-to-right from the origin's X and bit i of a column sits
 * at bottom-up Y = originY - i, so bit 0 is the visual top row and the origin
 * sits at the graphic's bottom edge.
 *
 * `originX`/`originY` are the VISUAL top-left in dots (what the designer
 * stores); `labelHeightDots` converts originY into the bottom-up origin the
 * printer expects. The result is uppercase ASCII hex with no delimiters.
 */
export const encodeColumnsToNibblizedRle = (
    bitmap: Bitmap,
    originX: number,
    originY: number,
    labelHeightDots: number,
): string => {
    if (bitmap.length === 0 || bitmap[0].length === 0) return '';
    const height = bitmap.length;
    const width = bitmap[0].length;
    const bytes: number[] = [];

    // A data value (PRM Appendix E, "Data Types in RLE Files"): >= 128 fits in
    // one lone 7-bit byte; anything larger needs the 13-bit two-byte form.
    const pushData = (n: number) => {
        if (n < 128) { bytes.push(0x80 | n); return; }
        bytes.push(0x40 | ((n >> 7) & 0x3f), 0x80 | (n & 0x7f));
    };

    // Origin Y counts from the label's bottom edge and bit 0 is the visual top
    // row (directGraphics.ts), so the bottom-up origin equals the label height
    // minus the visual top.
    bytes.push(0x21);
    pushData(originX);
    pushData(labelHeightDots - originY);

    // Encode one column top-to-bottom, preferring transition runs
    // (0x25/0x26) over raw 7-dot bytes (0x27) — the same choice BarTender makes.
    const encodeColumn = (col: number[]) => {
        const runs: { black: boolean; n: number }[] = [];
        for (const bit of col) {
            const black = bit === 1;
            const last = runs.at(-1);
            if (last && last.black === black) last.n++;
            else runs.push({ black, n: 1 });
        }
        const transBytes = 1 + runs.reduce((s, r) => s + (r.n < 128 ? 1 : 2), 0);
        // Raw bitmap bytes carry 7 dots each and the decoder keeps all 7, so
        // raw mode is only exact when the column height is a multiple of 7.
        // Otherwise the padding dots would spill into the bitmap.
        const rawBytes = col.length % 7 === 0 ? 1 + col.length / 7 : Infinity;
        if (transBytes <= rawBytes) {
            bytes.push(runs[0].black ? 0x25 : 0x26);
            for (const r of runs) pushData(r.n);
        } else {
            bytes.push(0x27);
            for (let i = 0; i < col.length; i += 7) {
                let v = 0x80;
                for (let b = 0; b < 7 && i + b < col.length; b++) if (col[i + b]) v |= 1 << b;
                bytes.push(v);
            }
        }
    };

    for (let x = 0; x < width; x++) {
        // Bit 0 is the visual top row (see the origin comment above).
        const col: number[] = [];
        for (let y = 0; y < height; y++) col.push(bitmap[y][x] ? 1 : 0);
        encodeColumn(col);
        // Columns identical to this one collapse into one Repeat Last Line.
        // The repeat copies the column STILL BUFFERED, so it must come before
        // the 0x22 that commits it, and the count is the number of ADDITIONAL
        // copies — the decoder adds them on top of the column just encoded
        // (directGraphics.ts).
        let copies = 0;
        while (x + 1 + copies < width) {
            let still = true;
            for (let y = 0; y < height; y++) if ((bitmap[y][x + 1 + copies] ? 1 : 0) !== (bitmap[y][x] ? 1 : 0)) { still = false; break; }
            if (!still) break;
            copies++;
        }
        if (copies > 0) {
            // The repeat commits the buffered column plus its copies, so no
            // end-of-line follows it — a 0x22 here would flush the now-empty
            // buffer and insert a blank column.
            bytes.push(0x24);
            pushData(copies);
        } else if (x < width - 1) {
            bytes.push(0x22);
        }
        x += copies;
    }
    bytes.push(0x28);
    return bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
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
