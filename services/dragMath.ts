// Pure decision logic lifted out of Workspace.tsx's React mouse handlers so
// the drag behaviors the 2026-09-20 audit flagged (K3 shift-deselect crash,
// T6 rotation snap) can be pinned by unit tests without a DOM. The handlers
// keep their event plumbing; these functions own the arithmetic.

import type { Field } from '../types';

/**
 * Which field ids a click should drag, given the current selection and the
 * Shift modifier. Exactly the branch that was inline in handleMouseDown
 * (Workspace.tsx). K3's crash came from this returning [] (shift-clicking the
 * only selected field deselects it) and the handler then entering 'move' with
 * an empty drag set — the caller must not start a move when this is empty.
 */
export const computeDragSelectionIds = (
    clickedId: number,
    selectedIds: number[],
    shiftKey: boolean,
): number[] => {
    const isSelected = selectedIds.includes(clickedId);
    if (isSelected && shiftKey) return selectedIds.filter(id => id !== clickedId);
    if (shiftKey) return [...selectedIds, clickedId];
    return isSelected ? selectedIds : [clickedId];
};

/**
 * Grow an id set to whole groups (Batch O): whenever it contains a grouped
 * field, every field sharing that field's groupId joins too. A set with no
 * group members is returned unchanged (same array reference-free, but
 * semantically identical) so callers can apply it unconditionally. Shared by
 * the reducer's SELECT_FIELD and Workspace's click/marquee drag paths so
 * "click one, pick up all" can never diverge between selection and dragging.
 */
export const expandIdsWithGroups = <T extends { id: number; groupId?: number }>(
    fields: T[],
    ids: number[],
): number[] => {
    if (ids.length === 0) return ids;
    const idSet = new Set(ids);
    const groupIds = new Set(fields.filter(f => idSet.has(f.id) && f.groupId !== undefined).map(f => f.groupId as number));
    if (groupIds.size === 0) return ids;
    const out = new Set(ids);
    for (const f of fields) if (f.groupId !== undefined && groupIds.has(f.groupId)) out.add(f.id);
    return [...out];
};

/**
 * Snap a rotation drag to the nearest 90°. IPL's f parameter is 0-3 quadrants
 * (Field.rotation is 0/90/180/270); the pre-fix 45° snap emitted f0.5, which
 * firmware rejects (audit T6). `angleDiffDeg` is the pointer's swept angle
 * since drag start; `initialRotation` is the field's rotation when the drag
 * began. Returns the quadrant to commit.
 * The modulo is double-wrapped: a drag sweeping more than one full turn
 * counter-clockwise made (initial + angleDiff + 360) still negative, and JS
 * `%` keeps the dividend's sign — the old inline expression could therefore
 * return -90/-180/-270, values outside Field['rotation'] (found by the
 * batch-6 behavior tests; the extraction fixes it).
 */
export const snapRotation = (initialRotation: number, angleDiffDeg: number): Field['rotation'] => {
    const newRotation = (((initialRotation + angleDiffDeg) % 360) + 360) % 360;
    return ((Math.round(newRotation / 90) * 90) % 360) as Field['rotation'];
};
