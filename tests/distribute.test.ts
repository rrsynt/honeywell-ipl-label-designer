// Unit tests for the distribute-selection reducer case in App.tsx (Batch M).
// Distribute equalizes the gaps between the outermost edges of the selected,
// unlocked fields along one axis, keeping the first field's near edge and the
// last field's far edge pinned — the pelengkap of the existing align tools.
// BoxField is used everywhere so extents are fully deterministic (explicit
// width/height, no font rasterisation, no barcode engine).
import { describe, it, expect } from 'vitest';
import { appReducer } from '../App';
import type { AppState, Design, BoxField } from '../types';

const baseDesign: Design = {
    name: 'T', labelSettings: { width: 100, height: 65, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields: [], dataSources: [], nextId: 1, guides: { horizontal: [], vertical: [] },
};
const baseState = (design: Design, sel: number[] = []): AppState => ({
    history: { past: [], present: design, future: [], intermediate: null, baseline: design },
    selectedFieldIds: sel, savedDesigns: [], clipboard: null, originalDesignName: null, contextMenu: null,
});

const box = (id: number, x: number, y: number, w = 10, h = 10, locked = false): BoxField => ({
    id, type: 'box', name: `B${id}`, x, y, rotation: 0, width: w, height: h, thickness: 1, locked,
});

const positions = (design: Design, axis: 'x' | 'y') =>
    design.fields.map(f => (axis === 'x' ? f.x : f.y));

describe('distribute horizontally', () => {
    it('equalizes gaps and keeps the outer edges pinned', () => {
        // Boxes width 10 at x = 0, 15, 80 → leftmost edge 0, rightmost edge 90.
        // span = 90, totalWidth = 30, gap = (90 - 30) / 2 = 30 → x = 0, 40, 80.
        const d = { ...baseDesign, fields: [box(1, 0, 5), box(2, 15, 5), box(3, 80, 5)] };
        const s = appReducer(baseState(d, [1, 2, 3]), { type: 'DISTRIBUTE_SELECTED_FIELDS', payload: { axis: 'horizontal' } });
        expect(positions(s.history.present, 'x')).toEqual([0, 40, 80]);
    });

    it('does not change the vertical positions', () => {
        const d = { ...baseDesign, fields: [box(1, 0, 3), box(2, 15, 7), box(3, 80, 1)] };
        const s = appReducer(baseState(d, [1, 2, 3]), { type: 'DISTRIBUTE_SELECTED_FIELDS', payload: { axis: 'horizontal' } });
        expect(positions(s.history.present, 'y')).toEqual([3, 7, 1]);
    });

    it('respects the field order regardless of array index (sorts by near edge)', () => {
        // Field ids shuffled relative to x so a naive array-order walk would break.
        const d = { ...baseDesign, fields: [box(3, 80, 5), box(1, 0, 5), box(2, 15, 5)] };
        const s = appReducer(baseState(d, [1, 2, 3]), { type: 'DISTRIBUTE_SELECTED_FIELDS', payload: { axis: 'horizontal' } });
        const byId = Object.fromEntries(s.history.present.fields.map(f => [f.id, f.x]));
        expect(byId).toEqual({ 1: 0, 2: 40, 3: 80 });
    });
});

describe('distribute vertically', () => {
    it('equalizes vertical gaps', () => {
        const d = { ...baseDesign, fields: [box(1, 5, 0), box(2, 5, 15), box(3, 5, 50)] };
        // heights 10: span = 60, totalHeight = 30, gap = 15 → y = 0, 25, 50.
        const s = appReducer(baseState(d, [1, 2, 3]), { type: 'DISTRIBUTE_SELECTED_FIELDS', payload: { axis: 'vertical' } });
        expect(positions(s.history.present, 'y')).toEqual([0, 25, 50]);
    });

    it('does not change the horizontal positions', () => {
        const d = { ...baseDesign, fields: [box(1, 3, 0), box(2, 7, 15), box(3, 1, 50)] };
        const s = appReducer(baseState(d, [1, 2, 3]), { type: 'DISTRIBUTE_SELECTED_FIELDS', payload: { axis: 'vertical' } });
        expect(positions(s.history.present, 'x')).toEqual([3, 7, 1]);
    });
});

describe('distribute guards', () => {
    it('fewer than three selected is a no-op (returns the same state ref)', () => {
        const d = { ...baseDesign, fields: [box(1, 0, 0), box(2, 15, 0)] };
        const st = baseState(d, [1, 2]);
        expect(appReducer(st, { type: 'DISTRIBUTE_SELECTED_FIELDS', payload: { axis: 'horizontal' } })).toBe(st);
    });

    it('fewer than three UNLOCKED among selection is a no-op (locks shrink the pool)', () => {
        // Three selected but one locked → only two movable → nothing to distribute.
        const d = { ...baseDesign, fields: [box(1, 0, 0), box(2, 15, 0), box(3, 80, 0, 10, 10, true)] };
        const st = baseState(d, [1, 2, 3]);
        expect(appReducer(st, { type: 'DISTRIBUTE_SELECTED_FIELDS', payload: { axis: 'horizontal' } })).toBe(st);
    });

    it('never moves a locked field sitting in the middle — and the movable pool still spreads', () => {
        // Pool = ids 1,3,4 at x 0/30/90 (box 2 locked at 20): span 100,
        // totalExtent 30, gap (100-30)/2 = 35 → cursor walk 0, 0+10+35=45,
        // 45+10+35=90 (far edge pinned). Locked stays 20.
        const d = { ...baseDesign, fields: [box(1, 0, 5), box(2, 20, 5, 10, 10, true), box(3, 30, 5), box(4, 90, 5)] };
        const s = appReducer(baseState(d, [1, 2, 3, 4]), { type: 'DISTRIBUTE_SELECTED_FIELDS', payload: { axis: 'horizontal' } });
        const byId = Object.fromEntries(s.history.present.fields.map(f => [f.id, f.x]));
        expect(byId).toEqual({ 1: 0, 2: 20, 3: 45, 4: 90 });
    });

    it('redistributing an already-even layout is a no-op (same state ref, epsilon guard)', () => {
        // Regression guard (review M2): without the |delta|<1e-9 check this
        // pushes a spurious undo step whose first Undo is a visible no-op.
        const d = { ...baseDesign, fields: [box(1, 0, 5), box(2, 40, 5), box(3, 80, 5)] };
        const st = baseState(d, [1, 2, 3]);
        expect(appReducer(st, { type: 'DISTRIBUTE_SELECTED_FIELDS', payload: { axis: 'horizontal' } })).toBe(st);
    });

    it('pushes exactly one undo step and records a future-clearing history entry', () => {
        const d = { ...baseDesign, fields: [box(1, 0, 0), box(2, 15, 0), box(3, 80, 0)] };
        const s = appReducer(baseState(d, [1, 2, 3]), { type: 'DISTRIBUTE_SELECTED_FIELDS', payload: { axis: 'horizontal' } });
        expect(s.history.past).toHaveLength(1);
        expect(s.history.future).toHaveLength(0);
        // UNDO restores the pre-distribute layout.
        const back = appReducer(s, { type: 'UNDO' });
        expect(positions(back.history.present, 'x')).toEqual([0, 15, 80]);
    });

    it('ignores unselected fields (they neither move nor join the span)', () => {
        // Box 4 sits far right but is unselected → span must be driven by the
        // three selected boxes only (0..90), giving x = 0,40,80, box 4 unchanged.
        const d = { ...baseDesign, fields: [box(1, 0, 5), box(2, 15, 5), box(3, 80, 5), box(4, 95, 5)] };
        const s = appReducer(baseState(d, [1, 2, 3]), { type: 'DISTRIBUTE_SELECTED_FIELDS', payload: { axis: 'horizontal' } });
        expect(positions(s.history.present, 'x')).toEqual([0, 40, 80, 95]);
    });
});
