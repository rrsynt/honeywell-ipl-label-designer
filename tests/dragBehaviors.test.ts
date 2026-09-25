import { describe, it, expect } from 'vitest';
import { computeDragSelectionIds, guideMmFromRuler, snapRotation } from '../services/dragMath';
import { getHandleAtPos, isPointInRotatedRect } from '../services/canvasDrawer';
import { PREVIEW_SCALE } from '../constants';
import type { Design, BoxField, TextField, WorkspaceState } from '../types';

// Batch 6 remainder: drag behaviors (audit K3/T6/T8) previously pinned only
// at reducer level. The decision logic now lives in pure functions
// (services/dragMath.ts) or already-pure canvasDrawer helpers, so it can be
// tested without a DOM.

const stubCtx = { measureText: (s: string) => ({ width: s.length * 8 }) } as unknown as CanvasRenderingContext2D;

const boxField: BoxField = {
    id: 1, type: 'box', name: 'B', x: 0, y: 0, rotation: 0,
    width: 10, height: 5, thickness: 1,
};
const design = {
    name: 'T',
    labelSettings: { width: 100, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields: [boxField], dataSources: [], nextId: 2, guides: { horizontal: [], vertical: [] },
} as unknown as Design;

const ws = (zoom: number): WorkspaceState => ({ zoom, pan: { x: 0, y: 0 } } as WorkspaceState);

describe('computeDragSelectionIds (audit K3 shift-deselect)', () => {
    it('shift-clicking the only selected field yields an EMPTY set — the guard that prevents the move crash', () => {
        expect(computeDragSelectionIds(7, [7], true)).toEqual([]);
    });
    it('shift-click adds an unselected field to the group', () => {
        expect(computeDragSelectionIds(3, [1, 2], true)).toEqual([1, 2, 3]);
    });
    it('shift-click removes a field from a multi-selection', () => {
        expect(computeDragSelectionIds(2, [1, 2, 3], true)).toEqual([1, 3]);
    });
    it('plain click on a member of a multi-selection drags the whole group', () => {
        expect(computeDragSelectionIds(2, [1, 2, 3], false)).toEqual([1, 2, 3]);
    });
    it('plain click on an unselected field collapses selection to it', () => {
        expect(computeDragSelectionIds(9, [1, 2], false)).toEqual([9]);
    });
});

describe('snapRotation (audit T6: 90° quadrants only)', () => {
    it('snaps to the nearest quadrant, never 45°', () => {
        expect(snapRotation(0, 44)).toBe(0);
        expect(snapRotation(0, 46)).toBe(90);
        expect(snapRotation(0, 136)).toBe(180);
        expect(snapRotation(0, 310)).toBe(270);
    });
    it('wraps through 0 in both directions', () => {
        expect(snapRotation(0, -10)).toBe(0);
        expect(snapRotation(270, 45)).toBe(0);
        expect(snapRotation(90, -300)).toBe(180);
    });
    it('output is always a valid IPL f quadrant for any sweep', () => {
        for (let a = -720; a <= 720; a += 7) {
            expect([0, 90, 180, 270]).toContain(snapRotation(90, a));
        }
    });
});

describe('guideMmFromRuler (guide pulled off a ruler)', () => {
    // At zoom 1 a millimetre is PREVIEW_SCALE px. The ruler's "0" tick is drawn
    // at pan + RULER_SIZE (Rulers.tsx), while the label's "0" is painted at pan,
    // so the ruler width has to come off or the guide misses its tick by it.
    const pxPerMm = PREVIEW_SCALE;
    const pan = 50;
    const ruler = 30;
    it('lands on the millimetre whose tick the pointer is on', () => {
        // the 20mm tick is drawn at 20*pxPerMm + pan + ruler = 160
        expect(guideMmFromRuler(160, pan, ruler, pxPerMm)).toBe(20);
        expect(guideMmFromRuler(0 * pxPerMm + pan + ruler, pan, ruler, pxPerMm)).toBe(0);
    });
    it('the pre-fix reading (ruler width left in) is off by the ruler width', () => {
        const pointer = 20 * pxPerMm + pan + ruler;
        const withoutRuler = (pointer - pan) / pxPerMm;
        expect(withoutRuler).toBe(27.5);
        expect(guideMmFromRuler(pointer, pan, ruler, pxPerMm)).not.toBe(withoutRuler);
    });
    it('follows the pan and the zoom', () => {
        // zoom 2: 8px per mm, ruler still 30px, pan 40 → 10mm tick at 10*8+40+30
        expect(guideMmFromRuler(150, 40, ruler, 8)).toBe(10);
    });
});

describe('getHandleAtPos rotation-handle hit test (audit T8: zoom double-scale)', () => {
    // Box 10x5 mm → at zoom z the box is 40z x 20z px; the drawn handle sits
    // at (boxWidth/2, -OFFSET*z) = (20z, -20z).
    it('hits the handle at the DRAWN position for every zoom (1 and 2)', () => {
        for (const zoom of [1, 2]) {
            const handle = { x: 20 * zoom, y: -20 * zoom };
            expect(getHandleAtPos(stubCtx, boxField, design, handle.x, handle.y, ws(zoom))).toBe('rotate');
        }
    });
    it('does NOT hit the old double-scaled position (offset*zoom*zoom)', () => {
        // correct handle at zoom 2 is (40,-40); the pre-fix hit test looked at
        // (40, -80) — far from both, so it must return null there.
        expect(getHandleAtPos(stubCtx, boxField, design, 40, -80, ws(2))).toBeNull();
    });
    it('bottom-right corner still hits resize-br', () => {
        expect(getHandleAtPos(stubCtx, boxField, design, 80, 40, ws(2))).toBe('resize-br');
    });
    it('respects rotation: a screen point that maps onto the rotated handle hits it', () => {
        const rotated = { ...boxField, rotation: 90 as const };
        // Batch W CCW: the field frame is ctx.rotate(-90°), so the local
        // handle at (40,-40) lands at screen (-40,-40).
        expect(getHandleAtPos(stubCtx, rotated, design, -40, -40, ws(2))).toBe('rotate');
    });
    it('finds the handles where they are drawn, pan included', () => {
        const panned = { zoom: 1, pan: { x: 50, y: 50 } } as WorkspaceState;
        // box 10x5mm → 40x20px; resize handle at the bottom-right corner
        expect(getHandleAtPos(stubCtx, boxField, design, 50 + 40, 50 + 20, panned)).toBe('resize-br');
        // rotation handle sits ROTATION_HANDLE_OFFSET above the top edge
        expect(getHandleAtPos(stubCtx, boxField, design, 50 + 20, 50 - 20, panned)).toBe('rotate');
    });
    it('a point inside the field body returns no handle', () => {
        expect(getHandleAtPos(stubCtx, boxField, design, 40, 20, ws(2))).toBeNull();
    });
});

describe('isPointInRotatedRect (hit-test core behind select/drag/marquee)', () => {
    const scale = PREVIEW_SCALE; // zoom 1
    it('inside/outside for an unrotated box', () => {
        expect(isPointInRotatedRect(stubCtx, boxField, design, 20, 10, ws(1))).toBe(true);
        expect(isPointInRotatedRect(stubCtx, boxField, design, 10 * scale + 1, 10, ws(1))).toBe(false);
    });
    it('rotated 90° CCW (Batch W): the box occupies x∈[0,h], y∈[-w,0] around its origin', () => {
        const rotated = { ...boxField, rotation: 90 as const };
        // 10×5mm box at zoom 1: w=40px along x, h=20px along y. CCW puts the
        // content above-right of the origin: screen (10,-20) is inside.
        expect(isPointInRotatedRect(stubCtx, rotated, design, 10, -20, ws(1))).toBe(true);
        // the old CW-side point is outside under CCW
        expect(isPointInRotatedRect(stubCtx, rotated, design, -10, 20, ws(1))).toBe(false);
    });
    it('hits a field at the screen position it is painted at, pan included', () => {
        // drawElements translates the whole scene by the canvas pan, and the
        // mouse handlers pass raw screen points. The hit test used to ignore
        // the pan, so with the default pan of (50,50) every click landed 50px
        // up-left of the field under the cursor: the first click started a
        // marquee instead of selecting it.
        const panned = { zoom: 1, pan: { x: 50, y: 50 } } as WorkspaceState;
        expect(isPointInRotatedRect(stubCtx, boxField, design, 50 + 20, 50 + 10, panned)).toBe(true);
        // the same point with no pan is far outside the box
        expect(isPointInRotatedRect(stubCtx, boxField, design, 50 + 20, 50 + 10, ws(1))).toBe(false);
    });
    it('centered text: box is symmetric about the origin in local x', () => {
        const text: TextField = { id: 2, type: 'text', name: 'T', x: 0, y: 0, rotation: 0, align: 'center', dataSource: { type: 'fixed', data: 'AB' }, font: '25', fontSize: 12, h_mag: 1, w_mag: 1 };
        // measureText stub: 8px/char → width 16, centered → local x ∈ [-8, 8]
        expect(isPointInRotatedRect(stubCtx, text, design, -7, 2, ws(1))).toBe(true);
        expect(isPointInRotatedRect(stubCtx, text, design, -9, 2, ws(1))).toBe(false);
    });
});
