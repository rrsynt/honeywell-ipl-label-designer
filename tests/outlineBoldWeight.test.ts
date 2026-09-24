// The "bold" in outline font NAMES is part of the printer font's name, not an
// instruction to embolden. Measured against a real BarTender export whose c26
// fields are literally named "Swiss Mono 721 bold", BarTender's own rendering
// has a median stroke width of 3 px — the same as our REGULAR Liberation Mono
// and one pixel thinner than its Bold.
//
// This is pinned because the tauter reading (the name says bold, so paint
// bold) is the intuitive one, and acting on it moved 2698 pixels of an
// already-verified golden. The export is the reference implementation; the
// name is not.
import './golden/setup';
import { describe, it, expect } from 'vitest';
import { loadImage, createCanvas } from '@napi-rs/canvas';
import { FONT_MAP, fontStack } from '../constants';

/**
 * Median horizontal run of dark pixels — a stroke-width proxy that survives
 * the rotation between the export (798×518) and our render (801×784), since
 * rotating a page does not change how thick a stroke is.
 */
const medianStrokeFrom = (data: Uint8ClampedArray, width: number, height: number): number => {
    const runs: number[] = [];
    for (let y = 0; y < height; y++) {
        let run = 0;
        for (let x = 0; x < width; x++) {
            const dark = data[(y * width + x) * 4] < 128;
            if (dark) run++;
            else {
                // Runs longer than 60 px are solid fills (barcode bars, box
                // rules), not text strokes.
                if (run > 0 && run < 60) runs.push(run);
                run = 0;
            }
        }
    }
    runs.sort((a, b) => a - b);
    return runs[Math.floor(runs.length / 2)] ?? 0;
};

/** Stroke width of an image file. */
const medianStrokeFile = async (pngPath: string): Promise<number> => {
    const img = await loadImage(pngPath);
    const c = createCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(img as never, 0, 0);
    return medianStrokeFrom(ctx.getImageData(0, 0, img.width, img.height).data, img.width, img.height);
};

describe('outline "bold" fonts are drawn at regular weight', () => {
    it('no outline font id renders in a bold face', () => {
        // If a `weight` flag were reintroduced, this is the assertion that
        // catches it: fontStack is the single funnel every text element's
        // ctx.font goes through.
        for (const [id, def] of Object.entries(FONT_MAP)) {
            expect(fontStack(def.family), `c${id}`).not.toMatch(/^bold /);
        }
    });

    it('c26 paints with the regular stack', () => {
        expect(fontStack(FONT_MAP['26'].family)).toBe('"Liberation Mono", "Courier New", monospace');
    });

    it('the BarTender export stroke width matches our regular, not our bold', async () => {
        const reference = await medianStrokeFile('testdata/bartender-tes1-export.png');

        // Same glyphs at the same size, regular vs bold, in isolation so the
        // measurement is not diluted by the rest of the label.
        const draw = (font: string) => {
            const c = createCanvas(400, 60);
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, 400, 60);
            ctx.fillStyle = '#000000';
            ctx.font = font;
            ctx.textBaseline = 'top';
            ctx.fillText('Sample Text', 4, 4);
            return medianStrokeFrom(ctx.getImageData(0, 0, 400, 60).data, 400, 60);
        };

        const regular = draw('34px "Liberation Mono"');
        const bold = draw('bold 34px "Liberation Mono"');

        // Bold must actually be distinguishable, or this test proves nothing.
        expect(bold, 'bold and regular strokes must differ').toBeGreaterThan(regular);
        // The export is the reference: its stroke width has to land on the
        // regular side. Anything else argues for painting these ids bold.
        expect(reference, `export ${reference} regular ${regular} bold ${bold}`).toBe(regular);
        expect(reference).not.toBe(bold);
    });
});
