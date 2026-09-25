// Two more §15 items closed by measurement rather than guesswork.
//
//  * Item 6 — the interpretive default anchor. The manual says only "2 dots
//    below bar code, left justified" (PRM p.191), which leaves open whether
//    "below the bar code" means the field's declared h or the last inked bar
//    row. BarTender never emits i1/i2 at all: it places its human-readable
//    line as a separate H field with explicit coordinates, so there is no
//    reference render to settle it and the field's declared box is the reading
//    the text supports.
//
//  * Item 7 — negative origins. The manual documents 0-19999 and says nothing
//    about what a printer does outside it, so the question was clamp or pass
//    through. BarTender's own `edges` sweep puts four boxes at X=-0.4in and
//    Y=-0.4in, deliberately overhanging, and its preview shows the ink still
//    running to pixel 0 on three sides — the boxes keep their negative origin
//    and the label edge cuts them. They are NOT slid inward.

import './golden/setup';
import { describe, it, expect, beforeAll } from 'vitest';
import { loadImage, createCanvas } from '@napi-rs/canvas';
import { newRealCanvas } from './golden/setup';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { renderLabel, computeLabelExtent } from '../services/ipl/renderer';
import type { BarcodeElement, TextElement } from '../services/ipl/types';

const stx = (f: string) => `<STX>${f}<ETX>`;

beforeAll(async () => { /* renderer only; no barcode engine needed here */ });

describe('the BarTender `edges` sweep keeps negative origins (item 7)', () => {
    it('its own preview shows overhanging ink reaching the label edge', async () => {
        // The sweep ("boxes at X=-0.4in etc") is the evidence for pass-through:
        // if BarTender clamped or slid the overhanging boxes inward, no ink
        // would reach the outer pixels.
        const img: any = await loadImage('C:/Temp/bt-sweep-png/edges.png');
        const c = createCanvas(img.width, img.height);
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const { data } = ctx.getImageData(0, 0, c.width, c.height);
        const dark = (x: number, y: number) => data[(y * c.width + x) * 4] < 128;
        let minX = c.width, minY = c.height, maxX = -1, maxY = -1;
        for (let y = 0; y < c.height; y++) {
            for (let x = 0; x < c.width; x++) {
                if (dark(x, y)) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        expect(minX, 'ink reaches the left edge').toBe(0);
        expect(minY, 'ink reaches the top edge').toBe(0);
        expect(maxX, 'ink reaches the right edge').toBe(c.width - 1);
    });

    it('our parser passes the coordinate through unchanged', () => {
        // The renderer must place the field at the origin the host wrote. Any
        // clamp here would print ink where the host never asked for it.
        const label = parseViewerIPL([
            stx('<ESC>P'), stx('<SI>W400<ETX>'), stx('<SI>L400<ETX>'), stx('E1;F1'),
            stx('W1;f0;o-32,20;l100;h100;w4'),
            stx('R'), stx('<ESC>E1'),
        ].join(''));
        const box = label.elements.find(e => e.kind === 'box') as { ox: number; oy: number };
        expect(box.ox).toBe(-32);
        expect(box.oy).toBe(20);
    });

    it('renders the overhang by letting the canvas clip it', () => {
        // A field starting left of the canvas loses exactly the off-label part
        // and keeps the rest — the same picture BarTender produces.
        const width = 200, height = 120;
        const label = parseViewerIPL([
            stx('<ESC>P'), stx(`<SI>W${width}<ETX>`), stx(`<SI>L${height}<ETX>`), stx('E1;F1'),
            stx('W1;f0;o-40,20;l100;h60;w6'),
            stx('R'), stx('<ESC>E1'),
        ].join(''));
        const extent = computeLabelExtent(label, 203);
        const canvas = newRealCanvas(extent.widthDots, extent.heightDots);
        renderLabel(canvas as unknown as HTMLCanvasElement, label, extent, { dpi: 203, pxPerDot: 1, quality: 1 });
        const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        const dark = (x: number, y: number) => data[(y * canvas.width + x) * 4] < 128;
        // Visible half: the box spans x=-40..59, so ink must start at 0.
        let minX = canvas.width;
        for (let x = 0; x < canvas.width; x++) {
            for (let y = 0; y < canvas.height; y++) {
                if (dark(x, y)) { minX = x; break; }
            }
            if (minX !== canvas.width) break;
        }
        expect(minX, 'the surviving part still prints from the label edge').toBe(0);
    });

    it('says what actually happens instead of claiming a clamp', () => {
        const label = parseViewerIPL([
            stx('<ESC>P'), stx('E1;F1'), stx('H0;o-10,-10;c0;d3,X'), stx('R'), stx('<ESC>E1'),
        ].join(''));
        const issue = label.issues.find(i => i.code === 'origin-negative');
        expect(issue).toBeDefined();
        expect(issue!.message).toMatch(/not clamped/i);
        expect(issue!.message).not.toMatch(/clamp to the label edge/i);
    });
});

describe('the interpretive anchor is the field box, not the last bar (item 6)', () => {
    it('places the default HRI 2 dots below the bar code field box', () => {
        // Manual: "Field origin ... 2 dots below bar code, left justified"
        // (PRM p.191). The field's declared height is the box the printer
        // knows about, so h + 2 is the only reading the text supports.
        const label = parseViewerIPL([
            stx('<ESC>P'), stx('E1;F1'),
            stx('B1;o50,100;c0;w2;h80;i1;d3,12345'),
            stx('I1'),
            stx('R'), stx('<ESC>E1'),
        ].join(''));
        const interp = label.elements.find(
            (e): e is TextElement => e.kind === 'text' && e.interpretiveOf !== undefined,
        )!;
        expect(interp.ox, 'left justified with the host').toBe(50);
        expect(interp.oy, 'host oy + host height + 2').toBe(100 + 80 + 2);
    });

    it('follows the host wherever it is, including a negative origin', () => {
        const label = parseViewerIPL([
            stx('<ESC>P'), stx('E1;F1'),
            stx('B1;o-20,40;c0;w2;h50;i1;d3,9'),
            stx('I1'),
            stx('R'), stx('<ESC>E1'),
        ].join(''));
        const interp = label.elements.find(
            (e): e is TextElement => e.kind === 'text' && e.interpretiveOf !== undefined,
        )!;
        expect(interp.ox).toBe(-20);
        expect(interp.oy).toBe(40 + 50 + 2);
    });

    it('the gap is measured from the declared h, so an h-less barcode uses the default', () => {
        // Default bar code height is 50 dots (PRM p.53), so an explicit-anchor
        // test must not accidentally pin a 0-height barcode to an 0+2 anchor.
        const label = parseViewerIPL([
            stx('<ESC>P'), stx('E1;F1'),
            stx('B1;o10,10;c0;w2;i1;d3,9'),
            stx('I1'),
            stx('R'), stx('<ESC>E1'),
        ].join(''));
        const host = label.elements.find(e => e.kind === 'barcode') as BarcodeElement;
        const interp = label.elements.find(
            (e): e is TextElement => e.kind === 'text' && e.interpretiveOf !== undefined,
        )!;
        expect(host.heightDots).toBe(50);
        expect(interp.oy).toBe(10 + 50 + 2);
    });

    it('an explicit o on the interpretive still wins', () => {
        const label = parseViewerIPL([
            stx('<ESC>P'), stx('E1;F1'),
            stx('B1;o50,100;c0;w2;h80;i1;d3,12345'),
            stx('I1;o7,9'),
            stx('R'), stx('<ESC>E1'),
        ].join(''));
        const interp = label.elements.find(
            (e): e is TextElement => e.kind === 'text' && e.interpretiveOf !== undefined,
        )!;
        expect(interp.ox).toBe(7);
        expect(interp.oy).toBe(9);
    });
});
