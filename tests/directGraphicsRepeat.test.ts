// 0x24 "Repeat Last Line" must copy the PREVIOUSLY COMMITTED column.
//
// PRM2.70 Appendix E p.262: "Causes the printer to copy the previously defined
// column n number of times", and it "is only valid when preceded by a column of
// encoded, raw data or an end of line command". The second clause is the one
// that matters: after an end-of-line (0x22) the buffer is already empty, so the
// column to repeat is the one sitting in the output array -- which is the only
// case BarTender actually emits.
//
// The old decoder only repeated the still-buffered column and treated the
// post-0x22 case as blank spacing. That renders a solid box as a hollow rule:
// BarTender emits a 0.5in box at 203dpi as 40 columns -- one inked column plus
// 39 repeats -- and dropping the repeats left 4 columns of 1-dot edges, so a
// filled square came out as a 32-segment wireframe. Found by comparing against
// BarTender's own preview of an automation-generated 16-box lattice.
//
// These tests pin the semantics from three directions: the manual's worked
// example, a synthetic filled square, and the real BarTender stream.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { bytesToByteString } from '../services/ipl/fileBytes';
import { extractDirectGraphics, directGraphicToBitmap } from '../services/ipl/directGraphics';
import { parseViewerIPL } from '../services/ipl/viewerParser';

describe('Direct Graphics 0x24 Repeat Last Line', () => {
    it('reproduces the manual Appendix E worked example (PRM2.70 p.264)', () => {
        // 21 80 43 C2  origin X0 Y450
        // 27 90 A8 D5 90 22   raw bitmap: 1 dot, 2 dots, 3 dots, 1 dot
        // 26 84 96 22          4 white then 22 black
        // 22                   end of line (an EMPTY committed column)
        // 26 8C 84 22          13 white then 4 black
        // 24 82                repeat the last line 2 times
        // 25 88 22             9 black
        // 21 93 43 C2          origin X19 Y450
        // 25 43 C2             transition black
        // 28                   end of bitmap
        const payload = [
            0x21, 0x80, 0x43, 0xc2,
            0x27, 0x90, 0xa8, 0xd5, 0x90, 0x22,
            0x26, 0x84, 0x96, 0x22,
            0x22,
            0x26, 0x8c, 0x84, 0x22,
            0x24, 0x82,
            0x25, 0x88, 0x22,
            0x21, 0x93, 0x43, 0xc2,
            0x25, 0x43, 0xc2,
            0x28,
        ];
        const [dg] = extractDirectGraphics([String.fromCharCode(...payload)]);
        expect(dg.origin).toEqual([19, 450]);

        const col = (i: number) => dg.pixels[i] ?? [];
        const ink = (i: number) => col(i).filter(v => v).length;

        // Bit index equals the Y the manual's table prints, on a 450-tall label.
        expect(col(0).map((v, i) => (v ? i : -1)).filter(i => i >= 0)).toEqual([4, 10, 12, 14, 16, 18, 20, 25]);
        expect(ink(1)).toBe(22);          // 4 white then 22 black
        expect(col(2)).toEqual([]);        // the lone 0x22 commits a blank column
        expect(ink(3)).toBe(4);            // 13 white then 4 black
        // THE regression: these two exist only because 0x24 copies col 3.
        expect(col(4)).toEqual(col(3));
        expect(col(5)).toEqual(col(3));
        // 25 88 22 is 9 black per the manual's table (88 - 80 = 8, plus the
        // transition's own first dot). Trailing blank bits are not stored, so the
        // column length is 8 -- assert the ink pattern, not the array length.
        expect(ink(6)).toBe(8);
    });

    it('a repeated solid column becomes a solid run, not a hollow rule', () => {
        // One column of 40 black dots, then 0x24 repeating it 39 times: a
        // 40-column filled block, which is what a 0.5in box at 203dpi is.
        //
        // Data values must encode >= 64, because the 0x25/0x26 loops only read
        // `bytes[i] >= 64`: a byte below 64 ends the run instead of continuing
        // it. The 7-bit form is the compact choice, so 40 is 40 + 128 = 0xA8
        // and 39 is 0xA7.
        const p = [
            0x21, 0x00, 0x00,          // origin X0 Y0
            0x25, 0xa8, 0x22,          // transition black: 40 dots, end of line
            0x24, 0xa7,                // repeat last line 39 times
            0x28,
        ];
        const [dg] = extractDirectGraphics([String.fromCharCode(...p)]);
        const inked = dg.pixels.filter(c => c && c.some(v => v));
        // 1 committed column + 39 repeats = 40 inked columns. The old decoder
        // committed the first and skipped the repeats, leaving 1.
        expect(inked.length).toBe(40);
        for (const c of inked) expect(c.filter(v => v).length).toBe(40);
    });
});

describe('BarTender object output decodes as solid, not as outlines', () => {
    it('an automation-generated box lattice yields filled columns', () => {
        // 16 solid 0.5in boxes on a 4x4in page, placed and printed by BarTender
        // itself (tools/bartender/BuildParityLabels.cs). Before the 0x24 fix each
        // graphic decoded to 3 inked columns and rendered as a 1-dot rule; the
        // preview shows 16 solid 109x109 boxes.
        //
        // `data` holds the placed bitmap: a sparse array indexed by row, each
        // entry a base64 string of 1 bit per dot (MSB first), blank rows absent.
        // So the filled area is counted by decoding those rows, and a solid box
        // is what makes the row count equal the box height.
        const src = bytesToByteString(readFileSync('samples/bartender-sweep-grid.ipl'));
        const label = parseViewerIPL(src);
        const gfx = label.elements.filter(e => e.kind === 'graphic') as any[];
        expect(gfx.length).toBe(4); // BarTender merges same-thickness objects per column band

        let totalInk = 0;
        for (const g of gfx) {
            const rows: string[] = Object.keys(g.data).map(k => g.data[k] as string);
            expect(rows.length, `graphic at ${g.ox},${g.oy} has ${rows.length} rows`).toBeGreaterThan(100);
            for (const row of rows) {
                const bits = Buffer.from(row, 'base64');
                for (const byte of bits) {
                    let v = byte;
                    for (let k = 0; k < 8; k++) { if (v & 0x80) totalInk++; v <<= 1; }
                }
            }
        }
        // 16 boxes, each 0.5in square at 203dpi = 40x40 dots with a 1-dot border
        // and no fill, so ~4*40 = 160 dots of rule per box. The old decode
        // collapsed each box to its two horizontal edges (~8 dots), which is
        // about 20x less.
        expect(totalInk, `decoded ${totalInk} ink dots`).toBeGreaterThan(2000);
    });
});
