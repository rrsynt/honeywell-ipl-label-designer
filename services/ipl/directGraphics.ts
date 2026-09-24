// IPL Direct Graphics Mode decoder (PRM Appendix E).
//
// <ESC>g0 enters Direct Graphics mode with raw 8-bit payloads; <ESC>g1 enters
// the same mode but nibblized: every byte is written as two ASCII hex digits
// (PRM Appendix E, "m" parameter — "1,B" becomes the byte 0x1B). BarTender's
// "Binary Downloading = OFF" driver setting emits g1, which is 100% printable
// ASCII and therefore survives clipboard/UTF-8 paste where g0 cannot.
// The frames that follow carry a run-length-encoded bitmap that the printer
// images straight into its image bands (no stored format). BarTender emits
// this for shapes/vector art.
//
// Encoding (all data bytes are raw binary inside literal <STX>/<ETX> frames):
//   0x21 x y                  change origin — x, y each a data value (below)
//   0x22                     end of line → next column
//   0x24 n                   repeat last line n times
//   0x25 n1 n2 …             transitions starting BLACK
//   0x26 n1 n2 …             transitions starting WHITE
//   0x27 b…                  raw bitmap, 7 dots per byte, LSB = first dot
//   0x28                     end of bitmap
// Data values are variable-length: a byte >= 128 is 7 bits on its own, a byte
// 64-127 pairs with the next byte for 13 bits (PRM Appendix E, "Data Types in
// RLE Files"). This applies to origin coordinates and run counts alike.
//
// Orientation (PRM Appendix E, "Using Direct Graphics Commands"): columns
// load left-to-right from the origin's X, bits load BOTTOM-UP from the
// origin's Y — the origin is the graphic's bottom-left corner. The visual
// transform lives in directGraphicToBitmap below.

export interface DirectGraphic {
    /** Placement origin: [x, y] in dots as written by the origin commands. */
    origin: [number, number];
    /**
     * Decoded ink map in DATA space: pixels[col][bit], 1 = black. `col` is
     * the absolute label X (origin X + column index, so the array may have
     * holes); `bit` counts back from the origin's bottom-up Y. Use
     * directGraphicToBitmap for the visual bitmap + placement.
     */
    pixels: number[][];
}

const readData = (bytes: number[], i: number): [number, number] => {
    const b = bytes[i];
    if (b >= 128) return [b & 0x7f, 1];
    if (b >= 64) { const lo = bytes[i + 1] & 0x7f; return [((b & 0x3f) << 7) | lo, 2]; }
    return [b & 0x1f, 1];
};

/**
 * Decodes a `<ESC>g1` nibblized payload back to the raw byte string the g0
 * decoder expects. Only `[0-9A-Fa-f]` counts: whitespace and newlines that an
 * editor inserts when wrapping a pasted hex stream are dropped. An odd number
 * of hex digits (a truncated pair) is reported so the caller can warn — the
 * trailing nibble is dropped rather than shifting every following byte.
 */
export const nibblizedToByteString = (hex: string): { bytes: string; oddNibble: boolean } => {
    let out = '';
    let hi: number | null = null;
    for (let i = 0; i < hex.length; i++) {
        const c = hex.charCodeAt(i);
        const d = c >= 48 && c <= 57 ? c - 48
            : c >= 65 && c <= 70 ? c - 55
            : c >= 97 && c <= 102 ? c - 87
            : -1;
        if (d < 0) continue;
        if (hi === null) hi = d;
        else { out += String.fromCharCode((hi << 4) | d); hi = null; }
    }
    return { bytes: out, oddNibble: hi !== null };
};

/**
 * Extracts Direct Graphic bitmaps from tokenized IPL frames. Feed ALL frames
 * of the stream after `<ESC>g0` (or `<ESC>g1`) was seen; decoding continues
 * across frames until an end-of-bitmap (0x28) closes each graphic.
 *
 * @param frames frame bodies (STX/ETX stripped), in stream order
 * @param mode 0 = raw 8-bit payloads (g0, the default); 1 = nibblized ASCII
 *   hex payloads (g1). In mode 1 the frames are de-nibblized first and the
 *   literal-command classifier is skipped — a hex frame can never start with
 *   `<`, but its decoded bytes must reach the RLE decoder unfiltered.
 * @returns decoded graphics (possibly several per stream)
 */
export const extractDirectGraphics = (frames: string[], mode: 0 | 1 = 0): DirectGraphic[] => {
    if (mode === 1) {
        // One continuous hex stream: frame boundaries are an artifact of how
        // the editor split the paste, not of the bitmap, so a hex pair must be
        // allowed to straddle them. The literal-command classifier below must
        // NOT see this string — decoded bytes can legitimately spell "<A>" or
        // "<ESC>" (hex 3C..3E), and dropping the one joined frame would discard
        // the whole bitmap instead of a single frame as it does in mode 0.
        const { bytes } = nibblizedToByteString(frames.join(''));
        // The leading sentinel keeps the classifier from matching (it requires
        // the frame to START with "<"), while charCodeAt() & 0xff collapses it
        // to 0x100 & 0xff = 0 — a below-0x21 byte the RLE loop ignores, so it
        // never becomes bitmap data or glues onto a preceding data value.
        frames = bytes ? [`Ā${bytes}`] : [];
    }
    const out: DirectGraphic[] = [];
    let cur: DirectGraphic = { origin: [0, 0], pixels: [] };
    let colIdx = 0;
    let bits: number[] = [];

    // Copy the column: `bits` is one array reused for every column, so storing
    // it by reference would empty every earlier column the moment the next one
    // starts accumulating (only the last column of a graphic survived).
    const flush = () => { cur.pixels[cur.origin[0] + colIdx] = bits.slice(); bits = []; colIdx++; };

    for (const f of frames) {
        // Literal-notation frames (regular IPL commands interleaved with the
        // RLE payload) don't carry bitmap data.
        if (/^<[A-Z]+>|^<ESC>[A-Za-z]/.test(f)) continue;
        const bytes = [...f].map(c => c.charCodeAt(0) & 0xff);
        for (let i = 0; i < bytes.length; i++) {
            const b = bytes[i];
            if (b === 0x28) {
                if (bits.length > 0) flush();
                out.push(cur);
                cur = { origin: [0, 0], pixels: [] };
                colIdx = 0;
                bits = [];
                continue;
            }
            if (b === 0x22) { flush(); continue; }
            if (b === 0x21) {
                if (i + 1 >= bytes.length) break;
                // X and Y are each variable-length data values (PRM Appendix E,
                // "Data Types in RLE Files"): a 7-bit low-order byte, or a
                // 13-bit high-order byte followed by a low-order byte. Reading
                // them at a fixed width breaks origin X >= 64, where BarTender
                // switches to the two-byte form.
                const [x, ux] = readData(bytes, i + 1);
                const [y, uy] = readData(bytes, i + 1 + ux);
                cur.origin = [x, y];
                colIdx = 0;
                i += ux + uy;
                continue;
            }
            if (b === 0x24) {
                // Repeat Last Line (PRM Appendix E, p.262): "Causes the printer
                // to copy the PREVIOUSLY DEFINED column n number of times", and
                // it "is only valid when preceded by a column of encoded, raw
                // data or an end of line command" — i.e. the column to copy is
                // the one just COMMITTED, which an end-of-line (0x22) has
                // already moved out of the buffer.
                //
                // The old code only repeated the still-buffered column and
                // treated the post-0x22 case as pure blank spacing. That is
                // wrong for every stream whose repeated column carries ink, and
                // BarTender's own object output is exactly that: a 0.5in solid
                // box at 203dpi is 40 columns, emitted as one inked column plus
                // 0x24 repeats, and discarding the repeats rendered a hollow
                // 1-dot rule instead of a filled square. See
                // tests/directGraphicsRepeat.test.ts.
                const [n, used] = readData(bytes, i + 1);
                i += used;
                if (bits.length > 0) {
                    // Still buffered: commit it, then write n extra copies.
                    const snap = bits.slice();
                    flush();
                    for (let k = 0; k < n; k++) {
                        cur.pixels[cur.origin[0] + colIdx] = snap.slice();
                        colIdx++;
                    }
                } else {
                    // The buffer was emptied by an end-of-line, so the column
                    // to repeat is the one already committed. A repeat that
                    // follows a blank column repeats that blank -- which is how
                    // a run of empty columns is encoded, and why skipping the
                    // space without copying loses the run's width.
                    const prevIdx = cur.origin[0] + colIdx - 1;
                    const prev = cur.pixels[prevIdx];
                    if (prev) {
                        for (let k = 0; k < n; k++) {
                            cur.pixels[cur.origin[0] + colIdx] = prev.slice();
                            colIdx++;
                        }
                    } else {
                        // No committed column to copy (the repeat is the first
                        // thing in this graphic): advance the spacing only.
                        colIdx += n;
                    }
                }
                continue;
            }
            if (b === 0x25 || b === 0x26) {
                let black = b === 0x25;
                i++;
                while (i < bytes.length && bytes[i] >= 64) {
                    const [n, used] = readData(bytes, i);
                    i += used;
                    for (let k = 0; k < n; k++) bits.push(black ? 1 : 0);
                    black = !black;
                }
                i--;
                continue;
            }
            if (b === 0x27) {
                i++;
                while (i < bytes.length && bytes[i] >= 128) {
                    const v = bytes[i] & 0x7f;
                    for (let bit = 0; bit < 7; bit++) bits.push(((v >> bit) & 1) ? 1 : 0);
                    i++;
                }
                i--;
                continue;
            }
        }
    }
    if (bits.length > 0) flush(); // same convention as the 0x28 branch: a
    // stream that ends mid-column still counts that column's data
    if (cur.pixels.some(r => r && r.some(v => v))) out.push(cur);
    return out;
};

/** Ink bounding box in DATA space: col range and bit range. */
const inkBounds = (dg: DirectGraphic) => {
    let minCol = Infinity, maxCol = -1, minBit = Infinity, maxBit = -1;
    for (let c = 0; c < dg.pixels.length; c++) {
        const strip = dg.pixels[c];
        if (!strip) continue;
        for (let b = 0; b < strip.length; b++) {
            if (!strip[b]) continue;
            if (c < minCol) minCol = c;
            if (c > maxCol) maxCol = c;
            if (b < minBit) minBit = b;
            if (b > maxBit) maxBit = b;
        }
    }
    return { minCol, maxCol, minBit, maxBit };
};

/**
 * Computes the VISUAL bounding box of a decoded graphic on the label, given
 * the label height in dots (PRM Appendix E: the origin's Y is measured from
 * the label's BOTTOM edge; see directGraphicToBitmap for the full transform).
 */
export const directGraphicVisualBox = (dg: DirectGraphic, labelHeightDots: number): { x: number; y: number; w: number; h: number } => {
    const { minCol, maxCol, minBit, maxBit } = inkBounds(dg);
    if (maxCol < 0) return { x: dg.origin[0], y: labelHeightDots - dg.origin[1], w: 0, h: 0 };
    return {
        x: minCol,
        y: labelHeightDots - dg.origin[1] + minBit,
        w: maxCol - minCol + 1,
        h: maxBit - minBit + 1,
    };
};

/**
 * Renders a decoded graphic into a VISUAL bitmap (upright, top-down).
 *
 * PRM Appendix E placement ("Using Direct Graphics Commands"): the origin
 * (X,Y) is in bottom-up coordinates — Y counts from the label's bottom edge
 * (the manual's worked example loads a graphic from Y450 down to Y425, and a
 * line from Y450 down to Y0). Columns advance rightward from origin X; bit i
 * of a column sits at bottom-up Y = originY - i, i.e. top-down
 * y = labelHeightDots - originY + i (bits grow DOWNWARD on the label).
 */
export const directGraphicToBitmap = (dg: DirectGraphic, labelHeightDots: number): Bitmap2D => {
    const box = directGraphicVisualBox(dg, labelHeightDots);
    const { minBit } = inkBounds(dg);
    const bm: number[][] = [];
    if (box.w <= 0 || box.h <= 0) return { bitmap: bm, offsetX: box.x, offsetY: box.y };
    for (let y = 0; y < box.h; y++) bm.push(new Array(box.w).fill(0));
    for (let s = 0; s < dg.pixels.length; s++) {
        const strip = dg.pixels[s];
        if (!strip) continue;
        for (let i = 0; i < strip.length; i++) {
            if (!strip[i]) continue;
            bm[i - minBit][s - box.x] = 1;
        }
    }
    return { bitmap: bm, offsetX: box.x, offsetY: box.y };
};

export interface Bitmap2D {
    bitmap: number[][];
    /** Placement offset in dots relative to the label's top-left. */
    offsetX: number;
    offsetY: number;
}
