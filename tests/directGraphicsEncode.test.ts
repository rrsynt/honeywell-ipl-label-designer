import { describe, it, expect } from 'vitest';
import { encodeColumnsToNibblizedRle } from '../services/ipl/graphics';
import { extractDirectGraphics } from '../services/ipl/directGraphics';

/**
 * The nibblized RLE encoder is the inverse of extractDirectGraphics(mode 1):
 * a visual bitmap (top row first) encoded and decoded back must land at the
 * same place with the same ink. Placement follows PRM Appendix E — origin Y is
 * measured from the label's BOTTOM edge and bits load upward from it.
 */
const LABEL_HEIGHT = 800;

const roundTrip = (bitmap: number[][], ox: number, oy: number) => {
    const hex = encodeColumnsToNibblizedRle(bitmap, ox, oy, LABEL_HEIGHT);
    const [g] = extractDirectGraphics([hex], 1);
    // Compare in DATA space, not the ink-cropped visual bitmap: an all-white
    // region has no ink box, so directGraphicToBitmap would shrink it.
    const h = bitmap.length;
    const w = bitmap[0].length;
    const got = Array.from({ length: h }, (_, y) =>
        Array.from({ length: w }, (_, x) => (g.pixels[ox + x]?.[y] ? 1 : 0)));
    return { got, origin: g.origin, hex };
};

describe('nibblized Direct Graphics encoder', () => {
    it('round-trips a solid rectangle', () => {
        const bm = Array.from({ length: 40 }, () => new Array(30).fill(1));
        const out = roundTrip(bm, 100, 200);
        expect(out.origin).toEqual([100, LABEL_HEIGHT - 200]);
        expect(out.got).toEqual(bm);
    });

    it('round-trips a checkerboard (no run of two anywhere)', () => {
        const bm = Array.from({ length: 16 }, (_, y) =>
            Array.from({ length: 16 }, (_, x) => (x + y) % 2));
        const out = roundTrip(bm, 0, 0);
        expect(out.origin).toEqual([0, LABEL_HEIGHT]);
        expect(out.got).toEqual(bm);
    });

    it('round-trips alternating identical columns (repeat command)', () => {
        const col = Array.from({ length: 60 }, (_, y) => (y % 3 === 0 ? 1 : 0));
        const bm = Array.from({ length: 60 }, (_, y) => new Array(25).fill(col[y]));
        const out = roundTrip(bm, 50, 10);
        expect(out.got).toEqual(bm);
    });

    it('places an origin past 64 dots (two-byte data values)', () => {
        const bm = Array.from({ length: 5 }, () => [1, 0, 1]);
        const out = roundTrip(bm, 216, 700);
        expect(out.origin).toEqual([216, LABEL_HEIGHT - 700]);
        expect(out.got).toEqual(bm);
    });

    it('emits only printable ASCII hex', () => {
        const bm = Array.from({ length: 8 }, () => new Array(8).fill(1));
        const hex = encodeColumnsToNibblizedRle(bm, 0, 0, LABEL_HEIGHT);
        expect(hex).toMatch(/^[0-9A-F]+$/);
        expect(hex.length % 2).toBe(0);
    });

    it('prefers transition runs over raw bitmap bytes', () => {
        const bm = Array.from({ length: 50 }, () => new Array(1).fill(1));
        const hex = encodeColumnsToNibblizedRle(bm, 0, 0, LABEL_HEIGHT);
        // 0x27 (raw) nibblizes to "27"; a solid column is one 0x25 transition.
        expect(hex.includes('27')).toBe(false);
        expect(hex.includes('25')).toBe(true);
    });

    it('returns an empty string for an empty bitmap', () => {
        expect(encodeColumnsToNibblizedRle([], 0, 0, LABEL_HEIGHT)).toBe('');
        expect(encodeColumnsToNibblizedRle([[]], 0, 0, LABEL_HEIGHT)).toBe('');
    });
});
