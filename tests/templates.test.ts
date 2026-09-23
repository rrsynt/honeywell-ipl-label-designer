// Batch L (2026-09-21): the template gallery must never hand the designer a
// broken Design. These tests pin the structural invariants (unique ids,
// nextId, origins in bounds, linked sources resolve) AND the end-to-end
// contract: every template's generateIPL output parses clean in the viewer
// with the expected element kinds.
import './golden/setup'; // real canvas + bwip shims for generateIPL barcode paths
import { describe, it, expect, beforeAll } from 'vitest';
import { TEMPLATES, getTemplate } from '../services/templates';
import { generateIPL } from '../services/iplGenerator';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { ensureBarcodesReady } from '../services/ipl/barcodes';
import type { Design } from '../types';

beforeAll(async () => { await ensureBarcodesReady(); });

describe('template registry', () => {
    it('ids unique, blank first, lookup works', () => {
        const ids = TEMPLATES.map(t => t.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids[0]).toBe('blank');
        expect(getTemplate('shipping')?.name).toContain('Shipping');
        expect(getTemplate('nope')).toBeUndefined();
    });

    it('every template builds a structurally valid design', () => {
        for (const t of TEMPLATES) {
            const d = t.build();
            const ids = d.fields.map(f => f.id);
            expect(new Set(ids).size, t.id + ' unique ids').toBe(ids.length);
            expect(d.nextId, t.id + ' nextId above all ids').toBeGreaterThan(Math.max(0, ...ids));
            for (const f of d.fields) {
                expect(f.x, `${t.id}/${f.name} x`).toBeGreaterThanOrEqual(0);
                expect(f.y, `${t.id}/${f.name} y`).toBeGreaterThanOrEqual(0);
                expect(f.x, `${t.id}/${f.name} x in width`).toBeLessThan(d.labelSettings.width);
                expect(f.y, `${t.id}/${f.name} y in height`).toBeLessThan(d.labelSettings.height);
            }
            // linked sources must resolve
            for (const f of d.fields) {
                if ('dataSource' in f && f.dataSource.type === 'linked') {
                    const srcId = (f.dataSource as { type: 'linked'; sourceId: string }).sourceId;
                    expect(d.dataSources.some(ds => ds.id === srcId), `${t.id} linked source`).toBe(true);
                }
            }
        }
    });

    it('every field FITS the label fully — not just its origin', async () => {
        // The origin-in-bounds check above is weak: a long text or wide
        // barcode at a legal origin still overflows the stock. Measure the
        // real designer bounding box (shared bwip encoder, mm units).
        const { getObjectBoundingBox } = await import('../services/geometry');
        for (const t of TEMPLATES) {
            const d = t.build();
            for (const f of d.fields) {
                const bb = getObjectBoundingBox(f, d);
                expect(f.x + bb.width, `${t.id}/${f.name} right`).toBeLessThanOrEqual(d.labelSettings.width + 0.01);
                expect(f.y + bb.height, `${t.id}/${f.name} bottom`).toBeLessThanOrEqual(d.labelSettings.height + 0.01);
            }
        }
    });

    it('viewer-path fit: fields measured like the PRINTER renders them', async () => {
        // Designer measureText uses real font metrics; the viewer/print path
        // approximates outline width at 0.6em and renders [DATE]/[TIME]
        // placeholders (wider than final data). Templates must fit THAT
        // worst case, and must not collide with each other there either.
        const { generateIPL } = await import('../services/iplGenerator');
        const { parseViewerIPL } = await import('../services/ipl/viewerParser');
        const { resolveLabelAtBatch } = await import('../services/ipl/odometer');
        const { estimateElementSize, computeLabelExtent } = await import('../services/ipl/renderer');
        const DOTS_PER_MM = 8; // 203 dpi
        for (const t of TEMPLATES.filter(x => x.id !== 'blank')) {
            const d = t.build();
            // Batch 0 resolved: <FS>/<GS> odometer markers are control
            // characters, not printable text — the printer (and the viewer's
            // real render via resolveLabelAtBatch) never shows them, so
            // measuring them would inflate serial counters' boxes.
            const label = resolveLabelAtBatch(parseViewerIPL(await generateIPL(d)), 0, 203);
            const extent = computeLabelExtent(label, 203);
            const boxes = label.elements
                .filter(e => e.kind !== 'unknown')
                .map(e => {
                    const { lengthDots, crossDots } = estimateElementSize(e, 203);
                    return { e, x1: e.ox / DOTS_PER_MM, y1: e.oy / DOTS_PER_MM,
                             x2: (e.ox + lengthDots) / DOTS_PER_MM, y2: (e.oy + crossDots) / DOTS_PER_MM };
                });
            for (const b of boxes) {
                expect(b.x2, `${t.id}/${b.e.kind}#${b.e.id} right (viewer metrics)`).toBeLessThanOrEqual(extent.widthDots / DOTS_PER_MM + 0.01);
                expect(b.y2, `${t.id}/${b.e.kind}#${b.e.id} bottom (viewer metrics)`).toBeLessThanOrEqual(extent.heightDots / DOTS_PER_MM + 0.01);
            }
            for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
                const a = boxes[i], b = boxes[j];
                // box/line fields frame content by design; HRI interpretive
                // texts sit on their host barcode by design.
                if (a.e.kind === 'box' || b.e.kind === 'box' || a.e.kind === 'line' || b.e.kind === 'line') continue;
                if ((a.e as { interpretiveOf?: number }).interpretiveOf !== undefined || (b.e as { interpretiveOf?: number }).interpretiveOf !== undefined) continue;
                const ox = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
                const oy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
                expect(ox <= 0.01 || oy <= 0.01, `${t.id}: ${a.e.kind}#${a.e.id} overlaps ${b.e.kind}#${b.e.id} by ${ox.toFixed(1)}x${oy.toFixed(1)}mm`).toBe(true);
            }
        }
    });

    it('blank is the classic empty canvas', () => {
        const d = getTemplate('blank')!.build();
        expect(d.fields).toHaveLength(0);
        expect(d.name).toBe('Untitled Design');
    });
});

describe('templates generate parseable IPL (viewer contract)', () => {
    for (const t of TEMPLATES.filter(x => x.id !== 'blank')) {
        it(`${t.id}: generateIPL -> parseViewerIPL with zero errors and matching element count`, async () => {
            const d = t.build();
            const ipl = await generateIPL(d);
            const label = parseViewerIPL(ipl);
            expect(label.issues.filter(i => i.level === 'error').map(i => i.message), t.id).toEqual([]);
            // every visible designer field yields a viewer element (HRI adds an
            // interpretive text element for barcodes, so >= not ==)
            expect(label.elements.length, t.id).toBeGreaterThanOrEqual(d.fields.length);
            expect(label.elements.some(e => e.kind === 'barcode'), t.id + ' has barcodes').toBe(true);
        });
    }

    it('shipping label carries date + variable + Code128 + QR semantics', async () => {
        const d = getTemplate('shipping')!.build();
        const ipl = await generateIPL(d);
        const label = parseViewerIPL(ipl);
        const kinds = label.elements.map(e => e.kind);
        const barcodes = label.elements.filter(e => e.kind === 'barcode') as { symbology: string }[];
        expect(barcodes.map(b => b.symbology).sort(), 'Code128 + QR symbologies').toEqual(['18', '6']);
        expect(kinds).toContain('line');
        expect(kinds).toContain('box');
        // the [DATE]-backed text field parses as a date source
        const dateEl = label.elements.find(e => e.kind === 'text' && (e as { source: { type: string } }).source.type === 'date');
        expect(dateEl, 'date-sourced text element').toBeTruthy();
    });

    it('lot sticker counter source feeds the linked field in generated output', async () => {
        const d = getTemplate('lot')!.build();
        const ipl = await generateIPL(d);
        // counter start 1, padding 4 -> sample '0001' embedded in the print block
        expect(ipl).toContain('0001');
        const label = parseViewerIPL(ipl);
        expect(label.issues.filter(i => i.level === 'error')).toEqual([]);
    });

    it('price tag EAN-13 data survives deep validation (13 digits)', async () => {
        const d = getTemplate('price')!.build();
        const ipl = await generateIPL(d);
        const label = parseViewerIPL(ipl);
        expect(label.issues.filter(i => i.code === 'barcode-data-invalid')).toEqual([]);
    });
});
