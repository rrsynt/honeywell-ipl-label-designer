import { describe, it, expect } from 'vitest';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { decodeGraphicColumns } from '../services/ipl/graphics';
import { extractDirectGraphics, directGraphicToBitmap } from '../services/ipl/directGraphics';
import { bytesToByteString } from '../services/ipl/fileBytes';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

describe('Direct Graphics manual commands', () => {
    it.each([
        [0x25, 0x83],
        [0x26, 0x83],
        [0x27, 0x85],
    ])('keeps the final column with or without 0x22 for %j', (...data) => {
        const origin = [0x21, 0x80, 0x40, 0x80];
        const implicit = extractDirectGraphics([String.fromCharCode(...origin, ...data), '\x28']);
        const explicit = extractDirectGraphics([String.fromCharCode(...origin, ...data, 0x22, 0x28)]);
        expect(implicit).toEqual(explicit);
        expect(implicit[0].pixels).toHaveLength(1);
        expect(implicit[0].pixels[0].length).toBeGreaterThan(0);
    });

    it('preserves the final 450-dot column without an end-of-line command', () => {
        const bytes = [
            0x21, 0x80, 0x43, 0xc2, 0x27, 0x90, 0xa8, 0xd5, 0x90,
            0x22, 0x26, 0x84, 0x96, 0x22, 0x22, 0x26, 0x8c, 0x84,
            0x22, 0x24, 0x82, 0x25, 0x88, 0x22, 0x21, 0x93, 0x43,
            0xc2, 0x25, 0x43, 0xc2, 0x28,
        ];
        const graphics = extractDirectGraphics([String.fromCharCode(...bytes)]);
        expect(graphics).toHaveLength(1);
        expect(graphics[0].pixels[19]).toEqual(new Array(450).fill(1));
    });

    // PRM Appendix E p.264 gives these two origins verbatim in its hex example.
    // They pin the variable-length data-value encoding: 0x80 is a lone 7-bit
    // byte, while 0x43 pairs with the following byte for 13 bits (3*128+0x42).
    it('decodes the manual origin examples exactly', () => {
        const origin = (...payload: number[]) =>
            extractDirectGraphics([String.fromCharCode(0x21, ...payload, 0x28)])[0].origin;
        expect(origin(0x80, 0x43, 0xc2)).toEqual([0, 450]);
        expect(origin(0x93, 0x43, 0xc2)).toEqual([19, 450]);
    });

    // A high-order origin byte is two bytes wide, not one: consuming a fixed
    // three bytes per origin desynchronises the rest of the RLE stream.
    it('reads a two-byte origin X without eating the following command', () => {
        const [g] = extractDirectGraphics([
            String.fromCharCode(0x21, 0x41, 0xd8, 0x46, 0x97, 0x22, 0x28),
        ]);
        expect(g.origin).toEqual([216, 791]);
        // Columns are indexed by absolute X, so the one column lands at 216.
        expect(g.pixels.filter(Boolean)).toHaveLength(1);
        expect(g.pixels[216]).toBeDefined();
    });
});

describe('Direct Graphics Mode (BarTender shapes)', () => {
    it('tes1: decodes RLE shapes as graphic elements', async () => {
        const src = bytesToByteString(await readFile(path.resolve('samples/bartender-tes1.ipl')));
        const label = parseViewerIPL(src);
        const kinds = label.elements.map(e => e.kind);
        expect(kinds).toContain('graphic');
        const g = label.elements.find(e => e.kind === 'graphic') as any;
        expect(g.widthDots).toBeGreaterThan(0);
        expect(g.heightDots).toBeGreaterThan(0);
        expect(g.data.length).toBeGreaterThan(0);
        // decoded bitmap has ink
        const bm = decodeGraphicColumns(g.widthDots, g.heightDots, g.data);
        const ink = bm.flat().filter(v => v).length;
        expect(ink).toBeGreaterThan(100);
        // no unknown-frame spam from the RLE payload
        expect(label.issues.filter(i => i.code === 'unknown-frame')).toHaveLength(0);
    });

    it('tes2: full-raster label decodes to a graphic', async () => {
        const src = bytesToByteString(await readFile(path.resolve('samples/bartender-tes2.ipl')));
        const label = parseViewerIPL(src);
        expect(label.elements.length).toBeGreaterThan(0);
        const g = label.elements.find(e => e.kind === 'graphic') as any;
        expect(g).toBeDefined();
        expect(g.data.length).toBeGreaterThan(10);
    });

    // PRM Appendix E placement: origin (X,Y) is bottom-up, columns advance
    // rightward from X, bit i sits at bottom-up Y-originY-i (top-down
    // y = labelHeight - originY + i). Before this model landed, all graphics
    // clamped to ox=0 and stacked on the left edge.
    it('tes1: places graphics by origin, not clamped to x=0', async () => {
        const src = bytesToByteString(await readFile(path.resolve('samples/bartender-tes1.ipl')));
        const label = parseViewerIPL(src);
        const gfx = label.elements.filter(e => e.kind === 'graphic') as any[];
        expect(gfx).toHaveLength(3);
        // Origins [24,791], [104,791], [216,791]. ox is the first INK column
        // (origin X for dg0; dg1/dg2 leave empty leading columns).
        expect(gfx.map(g => g.ox)).toEqual([24, 105, 220]);
        // No <SI>L; the fallback height is max(content extent 784, max
        // originY 791) = 791, so top-down y = 791 - 791 + minBit = minBit.
        // The box anchor is unchanged by the bit-order fix: that reverses the
        // rows INSIDE the box (directGraphicVisualBox keeps minBit as the top
        // edge for the same reason).
        expect(gfx.map(g => g.oy)).toEqual([49, 4, 10]);
        // Arrow (dg0): ink bits 49..165 -> height 117, columns 24..93 -> width 70.
        expect(gfx[0].widthDots).toBe(70);
        expect(gfx[0].heightDots).toBe(117);
    });

    it('tes2: places all four graphics at distinct origins', async () => {
        const src = bytesToByteString(await readFile(path.resolve('samples/bartender-tes2.ipl')));
        const label = parseViewerIPL(src);
        const gfx = label.elements.filter(e => e.kind === 'graphic') as any[];
        expect(gfx).toHaveLength(4);
        // Origins [66,691], [194,691], [242,691], [474,691]. No non-DG
        // content, so the fallback height is max(originY)=691: bit 0 of an
        // origin-691 graphic lands at y=0.
        expect(gfx.map(g => g.ox)).toEqual([66, 197, 245, 474]);
        expect(gfx.map(g => g.oy)).toEqual([12, 254, 6, 369]);
        // The two rule graphics are 220 dots TALL. Their WIDTH is whatever the
        // 0x24 (Repeat Last Line) runs produce: 1 column used to be expected
        // here, which was the decoder discarding every repeat of the committed
        // column. The manual is explicit -- "causes the printer to copy the
        // PREVIOUSLY DEFINED column n number of times" (PRM2.70 p.262) -- and
        // BarTender's own object output depends on it: a solid 40-dot box is
        // emitted as one inked column plus repeats, so dropping them drew a
        // hollow 1-dot rule instead of a filled square. See
        // tests/directGraphicsRepeat.test.ts and docs/research/DG-REPEAT-2026.md.
        expect(gfx[2].heightDots).toBe(220);
        expect(gfx[2].widthDots).toBeGreaterThan(1);
    });

    // Direct Graphics bit order. PRM Appendix E ("Using Direct Graphics
    // Commands") says each column "loads from the bottom to the top", and the
    // column it decodes places the payload's LAST set bit nearest the origin,
    // so the bit index runs AWAY from the origin and the bitmap rows must be
    // reversed relative to the data. Getting this backwards mirrors every
    // rasterized graphic vertically — invisible to any test that counts ink or
    // uses a single-row bitmap, which is exactly how it survived 1185 green
    // tests until a sample appeared whose whole text BarTender rasterizes.
    it('directGraphicToBitmap: bit index runs away from the origin', () => {
        // One graphic, two columns, deliberately ASYMMETRIC: column 0 inks only
        // bit 0, column 1 inks only bit 5. Bit 5 is the furthest along the
        // axis, so it is the TOP row and bit 0 is the BOTTOM row.
        const bytes = [
            0x21, 0x80, 0x80,       // origin [0, 0]
            0x25, 0x81, 0x22,       // column 0: 1 black dot (bit 0), end-of-line
            0x26, 0x85, 0x81, 0x22, // column 1: 5 white, 1 black (bit 5), end-of-line
            0x28,
        ];
        const [dg] = extractDirectGraphics([String.fromCharCode(...bytes)]);
        const { bitmap } = directGraphicToBitmap(dg, 10);

        // Rows are the data's bit axis, reversed: row 0 is bit 5, row 5 is bit 0.
        expect(bitmap.length).toBe(6);
        expect(bitmap[0]).toEqual([0, 1]);
        expect(bitmap[5]).toEqual([1, 0]);
        // A reversal leaves the ink count untouched - asserting it here would
        // make this test pass on the mirrored render too.
        expect(bitmap.flat().filter(v => v).length).toBe(2);
    });

    it('directGraphicToBitmap: a 3-row stack keeps its top-to-bottom order', () => {
        // Three columns, each inking a different bit, so the whole picture is
        // vertically asymmetric and a mirror is unmistakable.
        const bytes = [
            0x21, 0x80, 0x80,
            0x25, 0x81, 0x22,             // col 0: 1 black           -> bit 0
            0x26, 0x83, 0x81, 0x22,       // col 1: 3 white, 1 black  -> bit 3
            0x26, 0x85, 0x81, 0x22,       // col 2: 5 white, 1 black  -> bit 5
            0x28,
        ];
        const [dg] = extractDirectGraphics([String.fromCharCode(...bytes)]);
        const { bitmap } = directGraphicToBitmap(dg, 10);
        const rowsWithInk = bitmap.map((r, i) => (r.some(v => v) ? i : -1)).filter(i => i >= 0);
        // bit 5 -> row 0, bit 3 -> row 2, bit 0 -> row 5
        expect(rowsWithInk).toEqual([0, 2, 5]);
        // column index is NOT reversed: col 0 stays on the left.
        expect(bitmap[0][0]).toBe(0);
        expect(bitmap[0][2]).toBe(1);
    });

    it('warns when Direct Graphics mode never ends, and still decodes the partial', () => {
        // Enter <ESC>g0, send one RLE frame, then the stream ends without 0x28.
        const src =
            '<STX><ESC>P<ETX><STX>E1;F1<ETX><STX>H0;o10,10;c0;d3,HI<ETX><STX>R<ETX>' +
            '<STX><ESC>g0<ETX>' +
            '<STX>' + String.fromCharCode(0x21, 0x80, 0x80, 0x25, 0x83) + '<ETX>';
        const label = parseViewerIPL(src);
        expect(label.issues.some(i => i.code === 'direct-graphics-unterminated')).toBe(true);
        const gfx = label.elements.filter(e => e.kind === 'graphic');
        expect(gfx).toHaveLength(1);
    });

    it('regular streams are unaffected', () => {
        const label = parseViewerIPL('<STX><ESC>P<ETX><STX>E1;F1<ETX><STX>H0;o10,10;c0;d3,HI<ETX><STX>R<ETX>');
        expect(label.elements.map(e => e.kind)).toEqual(['text']);
        expect(label.issues.filter(i => i.level === 'error')).toHaveLength(0);
    });
});
