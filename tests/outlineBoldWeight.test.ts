// No outline font id is painted bold. That behaviour is right; the reason this
// file used to give for it was not, and is corrected here.
//
// WHAT THE OLD COMMENT CLAIMED: "Measured against a real BarTender export ...
// BarTender's own rendering has a median stroke width of 3 px — the same as our
// REGULAR Liberation Mono ... The export is the reference implementation."
//
// WHY THAT EVIDENCE DOES NOT HOLD (re-measured 2026-09-28):
//
//  1. The 3 px is a GLOBAL median over 13567 ink runs in the export, and the
//     export is mostly barcode bars: 43.5% of those runs are exactly 3 px. It
//     was never a text-stroke measurement. In the window that holds ONLY the
//     c26 text (x 318..472, y 102..126) the same statistic is 5 px, and ink per
//     stroke is 7.41 against 4.03 for regular Liberation Mono and 6.44 for bold.
//  2. More decisively, a BarTender export does not draw the printer's face at
//     all — it draws the DESIGN font at the DESIGN size. Proven on a controlled
//     format: tools/bartender/BuildParityLabels.exe authors a text object as
//     "Arial 12pt" and the driver emits `H2;...;c26;b0;h14;w14` for it, yet
//     PreviewExport.exe draws it 184.6 x 31.6 dots — matching Liberation Sans
//     at the authored 12 pt (183x31) and NOT the printer face sized by the
//     emitted h14 (90x14). Same tool, same pipeline as the export above.
//
// So the export cannot testify about printer weight in either direction, and
// the measured heaviness is a property of whatever design font that label used.
//
// THE ASSERTION STILL STANDS, on different grounds: the authoritative face table
// (docs/manuals/Font_Type_Select_K10_937-028-003.htm) does map c26 to "Andale
// Mono Bold" and 26/30-41/64 to bold cuts — so whether the printer emboldens is
// an OPEN QUESTION, not a settled "the name is just a name". Painting regular is
// kept because (a) no printer evidence supports changing it, and (b) geometry.ts
// and canvasDrawer.ts paint every outline field normal-weight, so emboldening
// only the viewer would put the on-screen designer ~9% away from the preview of
// the same label. This test guards against that change being made by accident;
// it no longer claims the export proves the printer agrees.
import './golden/setup';
import { describe, it, expect } from 'vitest';
import { loadImage, createCanvas } from '@napi-rs/canvas';
import { FONT_MAP, fontStack } from '../constants';

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

    // The export CANNOT be the oracle for weight, and this pins why, so the
    // measurement is not "restored" a third time by a future session.
    //
    // The export is dominated by barcode bars, so its global median stroke is a
    // property of the barcodes, not of any glyph: 43.5% of all 13567 ink runs
    // are exactly 3 px. Measured in a window holding ONLY c26 text, the same
    // statistic is 5 px and ink per stroke is 7.41 — heavier than bold
    // Liberation Mono (6.44), let alone regular (4.03). Reading that as
    // "the printer paints bold" would be wrong for a different reason than the
    // old comment was: BarTender's export never draws the printer's face.
    it('the export is not a printer-weight oracle: its median stroke is the barcodes', async () => {
        const img = await loadImage('testdata/bartender-tes1-export.png');
        const c = createCanvas(img.width, img.height);
        const ctx = c.getContext('2d');
        ctx.drawImage(img as never, 0, 0);
        const data = ctx.getImageData(0, 0, img.width, img.height).data;

        // Every ink run in the whole export, and the share that is exactly 3 px.
        const all: number[] = [];
        for (let y = 0; y < img.height; y++) {
            let run = 0;
            for (let x = 0; x < img.width; x++) {
                if (data[(y * img.width + x) * 4] < 128) run++;
                else { if (run > 0 && run < 60) all.push(run); run = 0; }
            }
        }
        const threes = all.filter(r => r === 3).length;
        // Barcode bars dominate: roughly two in five runs is a 3 px bar. If a
        // future re-measurement changes this materially, the old "3 px means
        // regular" reasoning would need revisiting rather than assuming.
        expect(threes / all.length, `3px share of ${all.length} runs`).toBeGreaterThan(0.35);

        // The pure-text window the old test should have used. Its stroke is
        // NOT 3, which is the concrete demonstration that the global median
        // above is measuring barcodes rather than glyphs.
        const textRuns: number[] = [];
        for (let y = 102; y <= 126; y++) {
            let run = 0;
            for (let x = 318; x <= 472; x++) {
                if (data[(y * img.width + x) * 4] < 128) run++;
                else { if (run > 0 && run < 60) textRuns.push(run); run = 0; }
            }
        }
        textRuns.sort((a, b) => a - b);
        const textMedian = textRuns[Math.floor(textRuns.length / 2)] ?? 0;
        expect(textMedian, `text-window median over ${textRuns.length} runs`).toBeGreaterThan(3);
    });

    // The controlled proof that a BarTender export shows the DESIGN font, so
    // it cannot arbitrate what the printer does with an outline id.
    //
    // Fixture: testdata/bartender-mixed-preview.png is PreviewExport.exe's render
    // of mixed.btw, a format whose text object is authored "Arial 12pt" and for
    // which the driver emits `H2;...;c26;b0;h14;w14`. That single format
    // therefore carries BOTH a known design size (12pt = 33.83 dots at 203 dpi)
    // and a known emitted h (14). Measuring what was actually drawn decides
    // which of the two the preview honoured.
    it('a BarTender export draws the design font, at the design size', async () => {
        const img = await loadImage('testdata/bartender-mixed-preview.png');
        const c = createCanvas(img.width, img.height);
        const ctx = c.getContext('2d');
        ctx.drawImage(img as never, 0, 0);
        const data = ctx.getImageData(0, 0, img.width, img.height).data;

        // The top-left text band only (the box and barcode sit below/right).
        let L = 1e9, R = -1, T = -1, B = -1;
        for (let y = 30; y <= 75; y++) for (let x = 0; x < 300; x++) {
            if (data[(y * img.width + x) * 4] < 128) {
                if (x < L) L = x; if (x > R) R = x;
                if (T < 0) T = y; B = y;
            }
        }
        expect(R, 'the fixture must contain text ink').toBeGreaterThan(L);

        // The preview renders a 4 in page at 203 dpi -> 812 dots, into img.width
        // pixels, so px/dot is the scale that converts the measurement to dots.
        const pxPerDot = img.width / (4 * 203);
        const measuredDots = (R - L + 1) / pxPerDot;

        // Same metric on both hypotheses, in dots.
        const drawWidth = (font: string): number => {
            const cc = createCanvas(900, 200);
            const cx = cc.getContext('2d');
            cx.fillStyle = '#fff'; cx.fillRect(0, 0, 900, 200);
            cx.fillStyle = '#000'; cx.font = font; cx.textBaseline = 'top';
            cx.fillText('Sample Text', 10, 40);
            const dd = cx.getImageData(0, 0, 900, 200).data;
            let l = 1e9, r = -1;
            for (let y = 0; y < 200; y++) for (let x = 0; x < 900; x++) {
                if (dd[(y * 900 + x) * 4] < 128) { if (x < l) l = x; if (x > r) r = x; }
            }
            return r - l + 1;
        };

        const design = drawWidth(`${(12 / 72) * 203}px "Liberation Sans"`);   // 12pt, the authored size
        const printer = drawWidth('14px "Liberation Mono"');                  // the emitted h14

        const dDesign = Math.abs(design - measuredDots);
        const dPrinter = Math.abs(printer - measuredDots);
        expect(design, `design ${design} printer ${printer} measured ${measuredDots.toFixed(1)}`)
            .toBeGreaterThan(printer);
        // The design hypothesis must win by a wide margin — a near-tie would
        // mean this fixture cannot tell the two apart.
        expect(dDesign, `design off by ${dDesign.toFixed(1)}, printer off by ${dPrinter.toFixed(1)}`)
            .toBeLessThan(dPrinter / 10);
    });
});
