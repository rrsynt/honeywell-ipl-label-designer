import { describe, it, expect } from 'vitest';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { tokenizeFrames, tokenizeFramesWithLines } from '../services/ipl/tokenizer';
import { getObjectBoundingBox } from '../services/geometry';
import type { Design, TextField, BarcodeField } from '../types';

// Regression tests for the 2026-09-20 audit batch 1 (DoS caps + geometry fix).
// See memory ipl-audit-findings-pending.md.

const stx = (f: string) => `<STX>${f}<ETX>`;

describe('Direct Graphics frame cap (audit K1)', () => {
    it('caps unbounded DG buffering and leaves the mode with a warning', () => {
        // 6000 payload frames without an end-of-bitmap (0x28): the parser must
        // stop buffering, report, and return to command parsing — not grow
        // forever. Follow with a setup frame to prove commands parse again.
        const frames = [
            stx('<ESC>P'),
            stx('<ESC>g0'),
            ...Array.from({ length: 6000 }, () => stx('xxxxx')),
            stx('<SI>W500'),
        ];
        const start = Date.now();
        const label = parseViewerIPL(frames.join('\n'));
        expect(Date.now() - start).toBeLessThan(5000);
        expect(label.issues.some(i => i.code === 'direct-graphics-limit')).toBe(true);
        // After leaving DG mode the setup frame was processed normally:
        expect(label.widthDots).toBe(500);
    });
});

describe('raster/box dimension clamp (audit K2)', () => {
    const hugeStream = [
        stx('<SI>W99999'),
        stx('<SI>L99999'),
        stx('<ESC>P'),
        stx('G1;x99999;y99999;u1,@@'),
        stx('E1;F1'),
        stx('U1;o10,10;c1'),
        stx('W2;o20,20;l99999;h99999;w2'),
        stx('R'),
    ].join('\n');

    it('clamps declared label size and issues warnings', () => {
        const label = parseViewerIPL(hugeStream);
        expect(label.widthDots).toBe(20000);
        expect(label.heightDots).toBe(20000);
        const codes = label.issues.filter(i => i.code === 'dimension-clamped');
        expect(codes.length).toBeGreaterThanOrEqual(2);
    });

    it('clamps graphic definition and placed U element', () => {
        const label = parseViewerIPL(hugeStream);
        const g = label.elements.find(e => e.kind === 'graphic') as { widthDots: number; heightDots: number };
        expect(g).toBeDefined();
        expect(g.widthDots).toBeLessThanOrEqual(20000);
        expect(g.heightDots).toBeLessThanOrEqual(20000);
        expect(label.issues.some(i => i.code === 'graphic-dim-clamped')).toBe(true);
    });

    it('clamps box field dimensions', () => {
        const label = parseViewerIPL(hugeStream);
        const box = label.elements.find(e => e.kind === 'box') as { widthDots: number; heightDots: number };
        expect(box.widthDots).toBe(20000);
        expect(box.heightDots).toBe(20000);
    });

    it('leaves normal dimensions untouched', () => {
        const label = parseViewerIPL([
            stx('<SI>W812'), stx('<SI>L400'), stx('<ESC>P'), stx('E1;F1'),
            stx('W1;o10,10;l300;h200;w2'), stx('R'),
        ].join('\n'));
        expect(label.widthDots).toBe(812);
        const box = label.elements[0] as { widthDots: number };
        expect(box.widthDots).toBe(300);
        expect(label.issues.filter(i => i.code.includes('clamp'))).toHaveLength(0);
    });
});

describe('tokenizer line mapping after O(n) cursor rewrite (audit K1b)', () => {
    it('reports exact 1-based STX lines across a large multi-frame source', () => {
        // 20k frames with embedded newlines: the incremental cursor must give
        // the same answers the old re-scan did (pins correctness, the cost is
        // what changed).
        const lines: string[] = [];
        for (let i = 0; i < 20000; i++) lines.push(stx(`H${i};o1,${i}`));
        const src = lines.join('\n');
        const spans = tokenizeFramesWithLines(src);
        expect(spans).toHaveLength(20000);
        expect(spans[0].line).toBe(1);
        expect(spans[19999].line).toBe(20000);
        expect(spans[4999].content).toBe('H4999;o1,4999');
    });

    it('keeps content extraction unchanged', () => {
        expect(tokenizeFrames('\x02R\x03\n\x02<ESC>P\x03')).toEqual(['R', '<ESC>P']);
    });
});

describe('geometry handles linked data sources (audit K6)', () => {
    const designWith = (mk: () => TextField | BarcodeField): Design => ({
        name: 't',
        labelSettings: { width: 100, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
        printerSettings: { model: 'Generic', dpi: 203, quantity: 1, mediaType: 'thermal-transfer', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
        fields: [],
        dataSources: [
            { id: 'v1', type: 'variable', name: 'VAR1', sampleData: 'ABCDE' },
            { id: 'c1', type: 'counter', name: 'CNT1', start: 7, step: 1, padding: 4 },
        ],
        nextId: 10,
        guides: { horizontal: [], vertical: [] },
    } as Design);

    const bitmapText = (dataSource: TextField['dataSource']): TextField => ({
        id: 1, name: 'T1', type: 'text', x: 10, y: 10, rotation: 0, locked: false, visible: true,
        dataSource, font: '0', fontSize: 12, h_mag: 1, w_mag: 1,
    } as TextField);

    const mmPerDot = 25.4 / 203; // geometry.ts: mm-per-dot at 203 dpi

    // Advance model since the T1 font-table consolidation: font 0 = 7-dot cell
    // + 1-dot gap, last gap dropped (10 chars of c0 = 79 dots, PRM270 p.54).
    const rowWidth = (chars: number) => (chars * 8 - 1) * mmPerDot;

    it('measures a linked variable at its sample width (was 0 → resize divided by zero)', () => {
        const design = designWith(() => bitmapText({ type: 'linked', sourceId: 'v1' }));
        const field = bitmapText({ type: 'linked', sourceId: 'v1' });
        const box = getObjectBoundingBox(field, design);
        // 'ABCDE' = 5 chars
        expect(box.width).toBeCloseTo(rowWidth(5), 5);
        expect(box.width).toBeGreaterThan(0);
        expect(Number.isFinite(box.width)).toBe(true);
    });

    it('measures a linked counter at its padded start value', () => {
        const design = designWith(() => bitmapText({ type: 'linked', sourceId: 'c1' }));
        const field = bitmapText({ type: 'linked', sourceId: 'c1' } as TextField['dataSource']);
        const box = getObjectBoundingBox(field, design);
        // '0007' = 4 chars
        expect(box.width).toBeCloseTo(rowWidth(4), 5);
    });

    it('dangling sourceId falls back to a non-zero placeholder, never empty', () => {
        const design = designWith(() => bitmapText({ type: 'linked', sourceId: 'gone' }));
        const field = bitmapText({ type: 'linked', sourceId: 'gone' } as TextField['dataSource']);
        const box = getObjectBoundingBox(field, design);
        // '[unlinked]' = 10 chars
        expect(box.width).toBeCloseTo(rowWidth(10), 5);
    });
});
