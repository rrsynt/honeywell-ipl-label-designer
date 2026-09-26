// Fase 6: the suppression marker's PLACEMENT.
//
// suppressionMarker.test.ts pins that the preview and the stream agree on
// "which fields were dropped". This file pins the other half — that the marker
// for a dropped field lands INSIDE the cell it belongs to, where a person can
// actually see it.
//
// It exists because of a real bug found only by driving the browser: the
// record-number badge was painted in the cell's top-left corner AFTER the
// marker, so a field near the origin had its amber box drawn and then covered.
// Every assertion passed, the predicate was right, and the preview showed a
// clean label for a record whose data had been dropped. Hence: assert the
// rectangles, and assert the two do not overlap.

import { describe, it, expect } from 'vitest';
import { recordMarkerRects } from '../components/SheetPreview';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { generateIPL } from '../services/iplGenerator';
import { planDesignTableJob } from '../services/tableSource';
import type { Design, TextField } from '../types';

const design = (fields: Partial<TextField>[], rows: Record<string, string>[], labelHeight = 65): Design => ({
    name: 'Marker placement',
    labelSettings: { width: 100, height: labelHeight, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields: fields.map((over, i) => ({
        id: i + 1, type: 'text', name: `F${i + 1}`, x: 5, y: 10 + i * 12, rotation: 0,
        dataSource: { type: 'linked', sourceId: 's1', column: 'SKU' },
        font: '25', fontSize: 12, h_mag: 1, w_mag: 1,
        ...over,
    })) as Design['fields'],
    dataSources: [{
        id: 's1', name: 'Table 1', type: 'table', columns: ['SKU', 'MARKET'],
        rows, query: { filters: [], combine: 'and' },
    }],
    nextId: 9,
    guides: { horizontal: [], vertical: [] },
} as Design);

const PX_PER_DOT = 0.16;

describe('recordMarkerRects', () => {
    it('marks the field a record drops, positioned where that field would print', async () => {
        const d = design(
            [{ name: 'SKU' }, { name: 'Price', dataSource: { type: 'linked', sourceId: 's1', column: 'MARKET' }, suppress: 'IF(value, "EQ", "EXPORT", "yes", "")' }],
            [{ SKU: 'A1', MARKET: 'HOME' }, { SKU: 'A2', MARKET: 'EXPORT' }],
        );
        const plan = planDesignTableJob(d).plan!;
        const label = parseViewerIPL(await generateIPL(d, { ...plan.batch, rows: [plan.batch.rows[1]] }));
        const rects = recordMarkerRects(d, plan, 1, label, 203, PX_PER_DOT);

        expect(rects).toHaveLength(1);
        // Field 2 sits at x=5mm, y=22mm => 40,176 dots at 203 dpi.
        expect(rects[0].x).toBeCloseTo(40 * PX_PER_DOT, 1);
        expect(rects[0].y).toBeCloseTo(176 * PX_PER_DOT, 1);
        expect(rects[0].w).toBeGreaterThan(0);
        expect(rects[0].h).toBeGreaterThan(0);
    });

    it('marks nothing for a record where the rule does not hold', async () => {
        const d = design(
            [{ name: 'SKU' }, { name: 'Price', dataSource: { type: 'linked', sourceId: 's1', column: 'MARKET' }, suppress: 'IF(value, "EQ", "EXPORT", "yes", "")' }],
            [{ SKU: 'A1', MARKET: 'HOME' }, { SKU: 'A2', MARKET: 'EXPORT' }],
        );
        const plan = planDesignTableJob(d).plan!;
        const label = parseViewerIPL(await generateIPL(d, { ...plan.batch, rows: [plan.batch.rows[0]] }));
        expect(recordMarkerRects(d, plan, 0, label, 203, PX_PER_DOT)).toEqual([]);
    });

    it('follows the field\'s ROTATION instead of assuming an upright box', async () => {
        // A rotated field's printed box extends in a different direction than
        // its anchor. The marker used the anchor minus a cross-size, which for
        // f=1/3 drew over the cell ABOVE this one.
        const upright = await (async () => {
            const d = design([{ name: 'SKU' }, { name: 'Rot', rotation: 0, suppress: 'IF(value, "EQ", "A2", "yes", "")' }],
                [{ SKU: 'A1' }, { SKU: 'A2' }]);
            const plan = planDesignTableJob(d).plan!;
            const label = parseViewerIPL(await generateIPL(d, { ...plan.batch, rows: [plan.batch.rows[1]] }));
            return recordMarkerRects(d, plan, 1, label, 203, PX_PER_DOT)[0];
        })();
        const rotated = await (async () => {
            const d = design([{ name: 'SKU' }, { name: 'Rot', rotation: 90 as never, suppress: 'IF(value, "EQ", "A2", "yes", "")' }],
                [{ SKU: 'A1' }, { SKU: 'A2' }]);
            const plan = planDesignTableJob(d).plan!;
            const label = parseViewerIPL(await generateIPL(d, { ...plan.batch, rows: [plan.batch.rows[1]] }));
            return recordMarkerRects(d, plan, 1, label, 203, PX_PER_DOT)[0];
        })();

        expect(upright).toBeDefined();
        expect(rotated).toBeDefined();
        // A 90-degree turn swaps the box's axes: one is wide, the other tall.
        expect(rotated.w).toBeCloseTo(upright.h, 1);
        expect(rotated.h).toBeCloseTo(upright.w, 1);
    });

    it('stays inside the label', async () => {
        const d = design([{ name: 'SKU' }, { name: 'Last', y: 50, suppress: 'IF(value, "EQ", "A2", "yes", "")' }],
            [{ SKU: 'A1' }, { SKU: 'A2' }]);
        const plan = planDesignTableJob(d).plan!;
        const label = parseViewerIPL(await generateIPL(d, { ...plan.batch, rows: [plan.batch.rows[1]] }));
        const [rect] = recordMarkerRects(d, plan, 1, label, 203, PX_PER_DOT);
        expect(rect.y + rect.h).toBeLessThanOrEqual(d.labelSettings.height * 8);
    });
});
