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
        // The two single-column line graphics stay 1 dot wide, 220 tall.
        expect(gfx[2].widthDots).toBe(1);
        expect(gfx[2].heightDots).toBe(220);
    });

    it('directGraphicToBitmap: manual worked example places bits downward from origin', () => {
        // PRM p.263: a graphic at X0,Y450 loads "up to Y425" — bit i sits at
        // bottom-up Y = 450 - i. On a 450-tall label that is top-down y = i,
        // so bit 0 is the TOP row. 26 columns, one ink bit each at bit 0.
        const bytes = [0x21, 0x80, 0x43, 0xc2]; // origin [0,450]
        for (let c = 0; c < 26; c++) bytes.push(0x25, 0x81, 0x22); // 1 black dot, end-of-line
        bytes.push(0x28);
        const [dg] = extractDirectGraphics([String.fromCharCode(...bytes)]);
        const { bitmap, offsetX, offsetY } = directGraphicToBitmap(dg, 450);
        expect(offsetX).toBe(0);
        expect(offsetY).toBe(0);
        expect(bitmap.length).toBe(1);
        expect(bitmap[0].filter(v => v).length).toBe(26);
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
