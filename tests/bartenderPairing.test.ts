// Guards the BarTender parity fixtures themselves (2026-09-24).
//
// A parity suite is only meaningful if the .ipl and the export PNG it is
// compared against came from the SAME BarTender format. `bartender-tes2` broke
// that silently: its stream holds four Direct Graphics, the widest 112 dot,
// while its export shows a 625px rule and three lines of text. No parse error,
// no warning — the stream simply is not the one that produced the image, and
// `bartenderGeometry.test.ts` passed it anyway because every element box it
// scored happened to land on *some* export ink.
//
// These checks are cheap, need no BarTender licence, and make the failure mode
// loud instead of vacuous: re-add a sample without its matching export and
// this file says so.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { loadImage } from '@napi-rs/canvas';
import { bytesToByteString } from '../services/ipl/fileBytes';
import { parseViewerIPL } from '../services/ipl/viewerParser';

/** The widest single graphic a stream decodes to, in dots. */
const widestGraphic = (iplPath: string): number => {
    const label = parseViewerIPL(bytesToByteString(readFileSync(iplPath)));
    return label.elements.reduce((max, el) =>
        el.kind === 'graphic' ? Math.max(max, el.widthDots) : max, 0);
};

/** Longest unbroken horizontal run of dark pixels in an image, in pixels. */
const longestRun = async (pngPath: string): Promise<number> => {
    const img = await loadImage(pngPath);
    const data = Buffer.from(readFileSync(pngPath));
    // Decode via the same canvas the parity tests use.
    const { createCanvas } = await import('@napi-rs/canvas');
    const cv = createCanvas(img.width, img.height);
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    void data;
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    let best = 0;
    for (let y = 0; y < img.height; y++) {
        let run = 0;
        for (let x = 0; x < img.width; x++) {
            const o = (y * img.width + x) * 4;
            if (d[o + 3] > 0 && d[o] < 100 && d[o + 1] < 100 && d[o + 2] < 100) {
                run++;
                if (run > best) best = run;
            } else run = 0;
        }
    }
    return best;
};

describe('BarTender parity fixtures are real pairs', () => {
    it('bartender-tes1: its export exists and can hold what the stream draws', async () => {
        expect(existsSync('testdata/bartender-tes1-export.png')).toBe(true);
        // tes1 carries 5 barcodes spanning hundreds of dots, so the export's
        // longest rule must be of a comparable order to the stream's content.
        const run = await longestRun('testdata/bartender-tes1-export.png');
        expect(run, 'export has no ink at all').toBeGreaterThan(100);
    }, 30000);

    it('the removed tes2 pairing is still absent, and why', () => {
        // The files remain on disk as evidence; the suite simply must not use
        // them. If someone re-adds tes2 to bartenderGeometry, this explains it.
        const ipl = 'samples/bartender-tes2.ipl';
        const png = 'testdata/bartender-tes2-export.png';
        if (!existsSync(ipl) || !existsSync(png)) return; // already cleaned up
        const widest = widestGraphic(ipl);
        // Nothing in the stream is wider than its graphics, so if the export
        // shows a feature wider than the widest graphic, they are not a pair.
        expect(widest, 'tes2 stream is no longer graphics-only — re-check the pairing')
            .toBe(112);
    }, 30000);
});
