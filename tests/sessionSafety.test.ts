// Batch N: session-safety dirty tracking. The reducer carries a `baseline`
// Design — the exact object that was loaded/saved — so dirtiness is reference
// inequality against the immutable history snapshots (no serialization cost,
// and an UNDO back to the loaded state is clean again for free).
import { describe, it, expect } from 'vitest';
import { appReducer, isDesignDirty } from '../App';
import type { AppState, Design, TextField } from '../types';

const baseDesign: Design = {
    name: 'T', labelSettings: { width: 100, height: 65, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields: [{ id: 1, type: 'text', name: 'A', x: 0, y: 0, rotation: 0, dataSource: { type: 'fixed', data: 'hi' }, font: '25', fontSize: 12, h_mag: 1, w_mag: 1 } as TextField],
    dataSources: [], nextId: 2, guides: { horizontal: [], vertical: [] },
};
// A state as if the design had just been SET_DESIGN-ed: baseline === present.
const cleanState = (design: Design = baseDesign): AppState => ({
    history: { past: [], present: design, future: [], intermediate: null, baseline: design },
    selectedFieldIds: [], savedDesigns: [], clipboard: null, originalDesignName: null, contextMenu: null,
});

describe('isDesignDirty contract', () => {
    it('fresh state is clean', () => {
        expect(isDesignDirty(cleanState())).toBe(false);
    });

    it('an edit that lands in history makes the design dirty', () => {
        const s = appReducer(cleanState(), { type: 'UPDATE_FIELD_PROPERTIES', payload: { fieldId: 1, updates: { x: 12 } } });
        expect(isDesignDirty(s)).toBe(true);
    });

    it('UNDO back to the loaded object is clean again', () => {
        const s = appReducer(cleanState(), { type: 'UPDATE_FIELD_PROPERTIES', payload: { fieldId: 1, updates: { x: 12 } } });
        const back = appReducer(s, { type: 'UNDO' });
        expect(back.history.present).toBe(back.history.baseline); // reference identity, not a copy
        expect(isDesignDirty(back)).toBe(false);
    });

    it('DESIGN_SAVED re-baselines the current design', () => {
        const s = appReducer(cleanState(), { type: 'UPDATE_FIELD_PROPERTIES', payload: { fieldId: 1, updates: { x: 12 } } });
        const saved = appReducer(s, { type: 'DESIGN_SAVED' });
        expect(isDesignDirty(saved)).toBe(false);
    });

    it('SET_DESIGN (new/load/template) is immediately clean', () => {
        const dirty = appReducer(cleanState(), { type: 'UPDATE_FIELD_PROPERTIES', payload: { fieldId: 1, updates: { x: 12 } } });
        const s = appReducer(dirty, { type: 'SET_DESIGN', payload: { design: baseDesign, originalDesignName: 'Other' } });
        expect(isDesignDirty(s)).toBe(false);
    });

    it('an uncommitted nudge/drag is not dirty yet; COMMIT_INTERMEDIATE is', () => {
        let s = appReducer(cleanState(), { type: 'NUDGE_BASELINE' });
        s = appReducer(s, { type: 'UPDATE_INTERMEDIATE', payload: { fields: [{ id: 1, x: 44 }] } });
        expect(isDesignDirty(s)).toBe(false); // present untouched while intermediate lives
        s = appReducer(s, { type: 'COMMIT_INTERMEDIATE' });
        expect(isDesignDirty(s)).toBe(true);
    });

    it('a no-op commit (intermediate identical to present) stays clean', () => {
        const d = { ...baseDesign, fields: baseDesign.fields.map(f => ({ ...f })) };
        let s = { ...cleanState(d) };
        s = appReducer(s, { type: 'UPDATE_INTERMEDIATE', payload: { fields: [{ id: 1, x: s.history.present.fields[0].x }] } });
        s = appReducer(s, { type: 'COMMIT_INTERMEDIATE' });
        expect(isDesignDirty(s)).toBe(false);
    });

    it('deleting the design that is open resets to the clean default', () => {
        const s = appReducer(cleanState(), { type: 'UPDATE_FIELD_PROPERTIES', payload: { fieldId: 1, updates: { x: 12 } } });
        const d = appReducer(s, { type: 'DESIGN_DELETED', payload: { deletedName: 'T', newSavedDesigns: [] } });
        expect(isDesignDirty(d)).toBe(false);
    });

    it('data-source CRUD marks dirty (they mutate present through the same reducer)', () => {
        const s = appReducer(cleanState(), {
            type: 'ADD_DATA_SOURCE', payload: { source: { id: 'v1', type: 'variable', name: 'V', sampleData: '' } },
        });
        expect(isDesignDirty(s)).toBe(true);
    });
});
