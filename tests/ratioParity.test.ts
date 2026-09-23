// Run-length wide:narrow ratio rendering (PRM p.170 r-parameter).
// Imports the golden setup at module level for the canvas + bwip shims.
import './golden/setup';
import { describe, it, expect } from 'vitest';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { renderLabel, computeLabelExtent } from '../services/ipl/renderer';
import { ensureBarcodesReady, measureBarcode, rawToRunPattern, ratioValue } from '../services/ipl/barcodes';

describe('wide:narrow ratio (PRM r-parameter)', () => {
    it('ratioValue maps r codes: 0=2.5, 1=3, 2=2, unknown=3', () => {
        expect(ratioValue(0)).toBe(2.5);
        expect(ratioValue(1)).toBe(3);
        expect(ratioValue(2)).toBe(2);
        expect(ratioValue(undefined)).toBe(3);
    });

    it('rawToRunPattern classifies bwip narrow/wide runs onto the half-module grid', () => {
        // Code 39 'A' at 3:1: bwip stores narrow=1, wide=3. At ratio 2 the
        // pattern must compress every wide to 4 half-modules (=2 narrow).
        const code39 = { sbs: [1, 3, 1, 1, 3, 1, 3, 1], bbs: [0, 0, 0, 0], bhs: [1, 1, 1, 1] };
        const p3 = rawToRunPattern(code39, 3);
        const p2 = rawToRunPattern(code39, 2);
        expect(p3?.units).toEqual([2, 6, 2, 2, 6, 2, 6, 2]);
        expect(p2?.units).toEqual([2, 4, 2, 2, 4, 2, 4, 2]);
        // bars at even indices, spaces at odd
        expect(p3?.isBar).toEqual([true, false, true, false, true, false, true, false]);
    });

    it('rawToRunPattern rejects non-binary runs and composite (bbs) symbols', () => {
        // intermediate width (min=2, a run of 3: neither narrow nor wide) -> bail
        expect(rawToRunPattern({ sbs: [2, 3, 2, 3], bbs: [0, 0, 0, 0], bhs: [1, 1, 1, 1] }, 3)).toBeNull();
        // composite layers (bbs non-zero) -> bail, caller falls back to toCanvas
        expect(rawToRunPattern({ sbs: [1, 3], bbs: [2, 1], bhs: [1, 1] }, 3)).toBeNull();
    });

    it('rawToRunPattern accepts bar-terminated odd run counts (Industrial 2of5)', () => {
        // industrial2of5 starts AND stops with a bar -> sbs is always odd.
        const odd = { sbs: [3, 1, 3, 1, 1, 1, 3], bbs: [0, 0, 0, 0, 0, 0, 0], bhs: [1, 1, 1, 1, 1, 1, 1] };
        const p = rawToRunPattern(odd, 2.5);
        expect(p?.units).toEqual([5, 2, 5, 2, 2, 2, 5]);
        // last element is a bar (trailing stop), mapping is bar-first regardless
        expect(p?.isBar[6]).toBe(true);
    });

    it('renders ITF bars at the declared wide:narrow ratio (dot-exact)', async () => {
        await ensureBarcodesReady();
        const mk = (cmd: string) =>
            `<STX><ESC>P;E1;F1;B1;o10,10;${cmd}d3,1234;R<ETX>`;
        const barWidths = async (cmd: string): Promise<number[]> => {
            const label = parseViewerIPL(mk(cmd));
            const extent = computeLabelExtent(label, 203);
            const canvas = document.createElement('canvas') as unknown as {
                width: number; height: number; getContext: (t: '2d') => CanvasRenderingContext2D;
            };
            canvas.width = Math.max(400, extent.widthDots);
            canvas.height = Math.max(60, extent.heightDots);
            renderLabel(canvas as unknown as HTMLCanvasElement, label,
                { widthDots: canvas.width, heightDots: canvas.height },
                { dpi: 203, pxPerDot: 1, quality: 1 } as never);
            const row = canvas.getContext('2d').getImageData(0, 20, canvas.width, 1).data;
            let s = '';
            for (let x = 0; x < canvas.width; x++) s += (row[x * 4 + 3] > 128 && row[x * 4] < 128) ? '1' : '0';
            const rle: Array<[string, number]> = [];
            for (const ch of s) {
                if (rle.length && rle[rle.length - 1][0] === ch) rle[rle.length - 1][1]++;
                else rle.push([ch, 1]);
            }
            const bars = rle.filter(([c, n]) => c === '1' && n > 0).map(([, n]) => n);
            return [...new Set(bars)].sort((a, b) => a - b);
        };
        // narrow element = w dots; wide = ratio * w
        expect(await barWidths('c2;h20;w2;')).toEqual([2, 6]);        // default r1 3:1
        expect(await barWidths('c2;h20;w2;r2;')).toEqual([2, 4]);     // 2:1
        expect(await barWidths('c2;h20;w2;r0;')).toEqual([2, 5]);     // 2.5:1, even w
        expect(await barWidths('c2;h20;w4;r0;')).toEqual([4, 10]);    // 2.5:1 at w4
        // PRM rule: odd narrow width with r0 substitutes r1 (3:1)
        expect(await barWidths('c2;h20;w1;r0;')).toEqual([1, 3]);
    });

    it('renders Industrial 2of5 (bar-terminated, odd sbs) at its ratio too', async () => {
        await ensureBarcodesReady();
        // c3 symbology: every bwip raw() symbol has an ODD run count — the
        // run-length path must still apply r (regression: parity bail dropped
        // all c3 fields silently).
        const w3 = measureBarcode('3', '1234', { ratio: 2, narrowDots: 2 });
        const w1 = measureBarcode('3', '1234', { ratio: 1, narrowDots: 2 });
        expect(w1).not.toBeNull();
        expect(w3).not.toBeNull();
        // 2:1 must be measurably narrower than 3:1 for the same data.
        expect(w3!.widthModules).toBeLessThan(w1!.widthModules);
    });

    it('module-based symbologies ignore the r parameter entirely', async () => {
        await ensureBarcodesReady();
        // Code 93 (1), Code 128 (6) and EAN/UPC (7) have no wide:narrow ratio;
        // their measurement must be identical across r values.
        for (const [sym, data] of [['1', 'ABC'], ['6', '1234'], ['7', '5901234123457']] as const) {
            const a = measureBarcode(sym, data, { ratio: 1, narrowDots: 2 });
            const b = measureBarcode(sym, data, { ratio: 2, narrowDots: 2 });
            expect(a).not.toBeNull();
            expect(b?.widthModules).toBe(a!.widthModules);
        }
    });
});
