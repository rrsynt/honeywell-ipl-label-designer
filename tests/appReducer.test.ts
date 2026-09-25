// Unit tests for the data-source reducer cases in App.tsx (exported for this).
import { describe, it, expect } from 'vitest';
import { appReducer } from '../App';
import { newVariable, newCounter } from '../services/dataSources';
import { generateIPL } from '../services/iplGenerator';
import type { AppState, Design, Field, TextField } from '../types';

const baseDesign: Design = {
    name: 'T', labelSettings: { width: 100, height: 65, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields: [], dataSources: [], nextId: 1, guides: { horizontal: [], vertical: [] },
};
const baseState = (design: Design): AppState => ({
    history: { past: [], present: design, future: [], intermediate: null, baseline: design },
    selectedFieldIds: [], savedDesigns: [], clipboard: null, originalDesignName: null, contextMenu: null,
} as AppState);

describe('data-source reducer', () => {
    it('ADD appends and records one history step', () => {
        const v = newVariable('A');
        const s1 = appReducer(baseState(baseDesign), { type: 'ADD_DATA_SOURCE', payload: { source: v } });
        expect(s1.history.present.dataSources).toHaveLength(1);
        expect(s1.history.past).toHaveLength(1);
    });

    it('two adds dispatched back-to-back (React-batching regression) both land', () => {
        // The bug this guards: computing the next list in the UI from props
        // meant the second dispatch overwrote the first. Reducer-side math on
        // the freshest state keeps both.
        const s1 = appReducer(baseState(baseDesign), { type: 'ADD_DATA_SOURCE', payload: { source: newVariable('V1') } });
        const s2 = appReducer(s1, { type: 'ADD_DATA_SOURCE', payload: { source: newCounter('C1') } });
        expect(s2.history.present.dataSources.map(d => d.name)).toEqual(['V1', 'C1']);
    });

    it('UPDATE replaces by id; identical content is a no-op (same state ref)', () => {
        const v = newVariable('A');
        const s1 = appReducer(baseState(baseDesign), { type: 'ADD_DATA_SOURCE', payload: { source: v } });
        const s2 = appReducer(s1, { type: 'UPDATE_DATA_SOURCE', payload: { source: { ...v, sampleData: 'x' } } });
        expect(s2.history.present.dataSources[0]).toMatchObject({ sampleData: 'x' });
        const s3 = appReducer(s2, { type: 'UPDATE_DATA_SOURCE', payload: { source: { ...v, sampleData: 'x' } } });
        expect(s3).toBe(s2); // no history entry for a no-op
    });

    it('DELETE removes the source AND unlinks fields that referenced it', () => {
        const v = newVariable('A');
        const fields = [
            { id: 1, type: 'text', name: 'T1', dataSource: { type: 'linked', sourceId: v.id } },
            { id: 2, type: 'text', name: 'T2', dataSource: { type: 'fixed', data: 'keep' } },
        ] as unknown as Field[];
        const design = { ...baseDesign, dataSources: [v], fields };
        const s1 = appReducer(baseState(design), { type: 'DELETE_DATA_SOURCE', payload: { id: v.id } });
        const ds = (i: number) => (s1.history.present.fields[i] as { dataSource: unknown }).dataSource;
        expect(s1.history.present.dataSources).toHaveLength(0);
        expect(ds(0)).toEqual({ type: 'variable', defaultData: '' });
        expect(ds(1)).toEqual({ type: 'fixed', data: 'keep' });
    });

    it('undo returns the pre-add state (history contract)', () => {
        const s1 = appReducer(baseState(baseDesign), { type: 'ADD_DATA_SOURCE', payload: { source: newVariable('A') } });
        const s2 = appReducer(s1, { type: 'UNDO' });
        expect(s2.history.present.dataSources).toHaveLength(0);
    });
});

const designWithFields = (...fields: Field[]): Design => ({ ...baseDesign, fields, nextId: 100 });

describe('field selection reducer (audit T4)', () => {
    const d = designWithFields(
        { id: 1, type: 'text', name: 'A', x: 0, y: 0, rotation: 0 } as TextField,
        { id: 2, type: 'text', name: 'B', x: 0, y: 0, rotation: 0 } as TextField,
    );
    const multi = { ...baseState(d), selectedFieldIds: [1, 2] };

    it('plain click collapses a multi-selection to just the clicked field', () => {
        const s = appReducer(multi, { type: 'SELECT_FIELD', payload: { id: 1, shiftKey: false } });
        expect(s.selectedFieldIds).toEqual([1]);
    });

    it('shift-click toggles membership without collapsing', () => {
        expect(appReducer(multi, { type: 'SELECT_FIELD', payload: { id: 1, shiftKey: true } }).selectedFieldIds).toEqual([2]);
        expect(appReducer(multi, { type: 'SELECT_FIELD', payload: { id: 3, shiftKey: true } }).selectedFieldIds).toEqual([1, 2, 3]);
    });
});

describe('locked-field protection (audit T5)', () => {
    const locked = { id: 1, type: 'text', name: 'A', x: 0, y: 0, rotation: 0, locked: true } as TextField;
    const open = { id: 2, type: 'text', name: 'B', x: 0, y: 0, rotation: 0 } as TextField;
    const d = designWithFields(locked, open);

    it('DELETE skips locked fields even when they are selected', () => {
        const s = appReducer({ ...baseState(d), selectedFieldIds: [1, 2] }, { type: 'DELETE_SELECTED_FIELDS' });
        expect(s.history.present.fields.map(f => f.id)).toEqual([1]);
    });

    it('all-locked selection is a no-op (same state ref, no history entry)', () => {
        const st = { ...baseState(d), selectedFieldIds: [1] };
        expect(appReducer(st, { type: 'DELETE_SELECTED_FIELDS' })).toBe(st);
    });

    it('locking a field drops it from the selection; unlocking keeps it', () => {
        const st = { ...baseState(designWithFields({ ...locked, locked: false }, open)), selectedFieldIds: [1, 2] };
        const s1 = appReducer(st, { type: 'TOGGLE_FIELD_LOCK', payload: { id: 1 } });
        expect(s1.selectedFieldIds).toEqual([2]);
        const s2 = appReducer({ ...baseState(d), selectedFieldIds: [2] }, { type: 'TOGGLE_FIELD_LOCK', payload: { id: 1 } });
        expect(s2.selectedFieldIds).toEqual([2]); // unlocking field 1 (not selected) leaves selection alone
    });

    it('ALIGN does not move locked fields', () => {
        const fix: TextField['dataSource'] = { type: 'fixed', data: '' };
        const tf = { type: 'text', font: '0', fontSize: 12, h_mag: 1, w_mag: 1, rotation: 0, x: 0, y: 0, dataSource: fix };
        const lockedField = { ...tf, id: 1, name: 'A', locked: true } as TextField;
        const moved = { ...tf, id: 2, name: 'B', x: 10, y: 10 } as TextField;
        const d2 = designWithFields(lockedField, moved);
        const s = appReducer({ ...baseState(d2), selectedFieldIds: [1, 2] }, { type: 'ALIGN_SELECTED_FIELDS', payload: { alignment: 'left' } });
        const f2 = s.history.present.fields.find(f => f.id === 2) as TextField;
        const f1 = s.history.present.fields.find(f => f.id === 1) as TextField;
        expect(f1.x).toBe(0); // locked stays
        expect(f2.x).toBe(0); // unlocked aligns to the leftmost edge
    });
});

describe('nudge baseline + commit (audit K5)', () => {
    const d = designWithFields({ id: 1, type: 'text', name: 'A', x: 5, y: 5, rotation: 0 } as TextField);

    it('baseline pushes ONE undo point; repeats never add more', () => {
        let s = { ...baseState(d) };
        s = appReducer(s, { type: 'NUDGE_BASELINE' });
        expect(s.history.past).toHaveLength(1);
        // A second baseline (auto-repeat) must not add another snapshot:
        s = appReducer(s, { type: 'NUDGE_BASELINE' });
        expect(s.history.past).toHaveLength(1);
        // Intermediate nudges accumulate, history untouched:
        s = appReducer(s, { type: 'UPDATE_INTERMEDIATE', payload: { fields: [{ id: 1, x: 6, y: 6 }] } });
        s = appReducer(s, { type: 'UPDATE_INTERMEDIATE', payload: { fields: [{ id: 1, x: 7, y: 6 }] } });
        expect(s.history.past).toHaveLength(1);
        // Commit lands once; the first Undo returns to the pre-burst position.
        s = appReducer(s, { type: 'COMMIT_INTERMEDIATE' });
        expect(s.history.present.fields[0].x).toBe(7);
        expect(s.history.past).toHaveLength(1);
        s = appReducer(s, { type: 'UNDO' });
        expect(s.history.present.fields[0].x).toBe(5);
    });

    it('committing an unchanged intermediate adds no history entry', () => {
        let s = baseState(d);
        s = appReducer(s, { type: 'UPDATE_INTERMEDIATE', payload: { fields: [{ id: 1 }] } });
        s = appReducer(s, { type: 'COMMIT_INTERMEDIATE' });
        expect(s.history.past).toHaveLength(0);
        expect(s.history.intermediate).toBeNull();
    });
});

describe('layer z-order changes the print order, not just the list (Fase 3)', () => {
    // The generator emits one <STX>H<id> frame per text field, walking the
    // fields array in order — and the canvas paints the same array in the same
    // order. So the relative position of H1 and H2 in the stream IS the draw
    // order. A reorder that only reshuffled the panel's display would leave
    // this string untouched, which is exactly the failure this guards against.
    const fix: TextField['dataSource'] = { type: 'fixed', data: 'X' };
    const tf = (id: number): TextField => ({
        id, type: 'text', name: `T${id}`, x: 5, y: 5, rotation: 0, locked: false, visible: true,
        dataSource: fix, font: '0', fontSize: 12, h_mag: 1, w_mag: 1,
    });
    const d = designWithFields(tf(1), tf(2));
    const orderOf = async (design: Design) => (await generateIPL(design)).match(/<STX>H\d/g);

    it('BRING_TO_FRONT moves the field to the end of the stream', async () => {
        const before = await orderOf(d);
        const s = appReducer({ ...baseState(d), selectedFieldIds: [1] }, { type: 'BRING_TO_FRONT' });
        expect(s.history.present.fields.map(f => f.id)).toEqual([2, 1]);
        expect(await orderOf(s.history.present)).toEqual(['<STX>H2', '<STX>H1']);
        expect(before).toEqual(['<STX>H1', '<STX>H2']); // the reorder, not the design, did it
    });

    it('SEND_TO_BACK moves the field to the start of the stream', async () => {
        const s = appReducer({ ...baseState(d), selectedFieldIds: [2] }, { type: 'SEND_TO_BACK' });
        expect(s.history.present.fields.map(f => f.id)).toEqual([2, 1]);
        expect(await orderOf(s.history.present)).toEqual(['<STX>H2', '<STX>H1']);
    });

    it("REORDER_LAYER 'top' inserts AFTER the target (the list renders reversed)", async () => {
        // The panel shows the array backwards, so dropping above a row means
        // appearing before it visually, which is AFTER it in the array.
        const s = appReducer(baseState(d), { type: 'REORDER_LAYER', payload: { draggedId: 1, targetId: 2, position: 'top' } });
        expect(s.history.present.fields.map(f => f.id)).toEqual([2, 1]);
        expect(await orderOf(s.history.present)).toEqual(['<STX>H2', '<STX>H1']);
    });

    it("REORDER_LAYER 'bottom' inserts BEFORE the target", async () => {
        const three = designWithFields(tf(1), tf(2), tf(3));
        const s = appReducer(baseState(three), { type: 'REORDER_LAYER', payload: { draggedId: 3, targetId: 2, position: 'bottom' } });
        expect(s.history.present.fields.map(f => f.id)).toEqual([1, 3, 2]);
        expect(await orderOf(s.history.present)).toEqual(['<STX>H1', '<STX>H3', '<STX>H2']);
    });
});
