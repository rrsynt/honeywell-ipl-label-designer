// Batch V (2026-09-24): unified line-height model. Before: the designer drew
// outline text at 1.35 pitch while the viewer printed 1.15 (17% WYSIWYG skew
// on multi-line fields), and the viewer contradicted ITSELF for bitmap fonts
// (drawElement advanced lines by cellH×1.15 while estimateElementSize — the
// layout math feeding computeLabelExtent — used cellH×1.0). Now: outline =
// 1.15 everywhere (matches the vendored Liberation hhea metrics 1.11–1.13),
// bitmap = exact cell pitch everywhere (fixed printer matrix). No golden has
// multi-line text, so pixel references were untouched — this suite pins the
// model instead.
import './golden/setup';
import { describe, it, expect } from 'vitest';
import { estimateElementSize } from '../services/ipl/renderer';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { getObjectBoundingBox } from '../services/geometry';
import { newRealCanvas } from './golden/setup';
import { POINTS_TO_MM } from '../constants';
import type { Design, TextField } from '../types';

const design = (field: TextField): Design => ({
    name: 'T',
    labelSettings: { width: 100, height: 65, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields: [field], dataSources: [], nextId: 2, guides: { horizontal: [], vertical: [] },
});
const text = (extra: Partial<TextField>): TextField => ({
    id: 1, type: 'text', name: 'X', x: 5, y: 5, rotation: 0,
    dataSource: { type: 'fixed', data: 'A' }, font: '25', fontSize: 12, h_mag: 1, w_mag: 1, ...extra,
});
const DPI = 203;

describe('viewer layout math (estimateElementSize)', () => {
    it('outline multi-line crossDots = lines × hDots × 1.15', () => {
        const label = parseViewerIPL('<STX><ESC>P<ETX><STX>E1;F1<ETX><STX>H0;o10,10;c25;k12;d3,L1<SUB><CR>L2<SUB><CR>L3<ETX><STX>R<ETX>');
        const t = label.elements.find(e => e.kind === 'text')!;
        const hDots = Math.round((12 / 72) * DPI);
        expect(estimateElementSize(t, DPI).crossDots).toBe(Math.round(3 * hDots * 1.15));
    });

    it('bitmap multi-line crossDots = lines × cellH × hMag (pitch 1.0, no 1.15)', () => {
        const label = parseViewerIPL('<STX><ESC>P<ETX><STX>E1;F1<ETX><STX>H0;o10,10;c0;h2;w2;d3,L1<SUB><CR>L2<ETX><STX>R<ETX>');
        const t = label.elements.find(e => e.kind === 'text')!;
        // c0 baseHeight 9, h2 → cell 18 dots; 2 lines = 36 dots exactly.
        expect(estimateElementSize(t, DPI).crossDots).toBe(36);
    });
});

describe('designer ↔ viewer agreement', () => {
    it('a 3-line outline field measures the same box in both engines', () => {
        const field = text({ dataSource: { type: 'fixed', data: 'AAA\nBBB\nCCC' }, font: '25', fontSize: 12 });
        const d = design(field);
        const ctx = newRealCanvas(10, 10).getContext('2d');
        void ctx; // getObjectBoundingBox builds its own measurement canvas
        const box = getObjectBoundingBox(field, d);
        const mmPerDot = 25.4 / DPI;
        // geometry.ts computes fontSizePx = pt × POINTS_TO_MM × dpi/25.4
        // UNROUNDED (the parser's round-to-34 convention is a different path).
        const fontSizePx = 12 * POINTS_TO_MM * DPI / 25.4;
        // designer model: 3 lines × 1.15h − 0.2×1.15h (selection-fit trim)
        const expectedMm = (3 * fontSizePx * 1.15 - fontSizePx * 1.15 * 0.2) * mmPerDot;
        expect(box.height).toBeCloseTo(expectedMm, 4);
        const hDots = Math.round(12 / 72 * DPI);
        // viewer print box (estimateElementSize) is the ADVANCE box: 3 × 1.15h.
        // The designer box must be SMALLER (trim) but within one line-pitch —
        // the pre-Batch-V 1.35 model overshot the print box for 3+ lines.
        const viewer = estimateElementSize(
            { kind: 'text', id: 1, ox: 0, oy: 0, f: 0, font: '25', hMag: 1, wMag: 1, pointSize: 12, source: { type: 'fixed', data: 'AAA\nBBB\nCCC' } } as never,
            DPI,
        );
        const viewerMm = viewer.crossDots * mmPerDot;
        expect(box.height).toBeLessThan(viewerMm);
        expect(box.height).toBeGreaterThan(viewerMm - hDots * 1.15 * mmPerDot); // same order, not 17% off
    });

    it('bitmap field: designer and viewer heights are IDENTICAL (both cell pitch)', () => {
        const field = text({ dataSource: { type: 'fixed', data: 'AA\nBB\nCC' }, font: '0', h_mag: 2 });
        const d = design(field);
        const box = getObjectBoundingBox(field, d);
        const mmPerDot = 25.4 / DPI;
        const viewer = estimateElementSize(
            { kind: 'text', id: 1, ox: 0, oy: 0, f: 0, font: '0', hMag: 2, wMag: 2, source: { type: 'fixed', data: 'AA\nBB\nCC' } } as never,
            DPI,
        );
        expect(box.height).toBeCloseTo(viewer.crossDots * mmPerDot, 6);
    });
});
