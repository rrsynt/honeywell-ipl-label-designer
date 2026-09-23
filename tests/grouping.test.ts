// Batch O: field grouping. groupId lives on BaseField (designer-only, ignored
// by the IPL generator); selection expands to whole groups via dragMath's
// shared helper (same call the Workspace drag path uses), clones re-key their
// groups so a duplicate never silently merges into its source, and deletes
// dissolve groups that dropped below two members so no phantom groupId can
// later collide with a newly-issued field id.
import { describe, it, expect } from 'vitest';
import { appReducer } from '../App';
import { expandIdsWithGroups } from '../services/dragMath';
import type { AppState, Design, TextField } from '../types';

const textField = (id: number, extra: Partial<TextField> = {}): TextField => ({
    id, type: 'text', name: `F${id}`, x: id * 10, y: 0, rotation: 0,
    dataSource: { type: 'fixed', data: 'hi' }, font: '25', fontSize: 12, h_mag: 1, w_mag: 1,
    ...extra,
});
const designOf = (fields: TextField[], nextId = 100): Design => ({
    name: 'T',
    labelSettings: { width: 100, height: 65, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields, dataSources: [], nextId, guides: { horizontal: [], vertical: [] },
});
const stateOf = (design: Design, selected: number[] = []): AppState => ({
    history: { past: [], present: design, future: [], intermediate: null, baseline: design },
    selectedFieldIds: selected, savedDesigns: [], clipboard: null, originalDesignName: null, contextMenu: null,
});
const gid = (f: { groupId?: number }) => f.groupId;

describe('GROUP_SELECTED_FIELDS', () => {
    it('groups 2+ selected unlocked fields under one fresh id from nextId', () => {
        const d = designOf([textField(1), textField(2), textField(3)], 42);
        const s = appReducer(stateOf(d, [1, 2]), { type: 'GROUP_SELECTED_FIELDS' });
        expect(gid(s.history.present.fields.find(f => f.id === 1)!)).toBe(42);
        expect(gid(s.history.present.fields.find(f => f.id === 2)!)).toBe(42);
        expect(s.history.present.fields.find(f => f.id === 3)!.groupId).toBeUndefined();
        expect(s.history.present.nextId).toBe(43);
    });

    it('is a no-op below 2 fields (same reducer guard as distribute uses)', () => {
        const s0 = stateOf(designOf([textField(1), textField(2)]), [1]);
        expect(appReducer(s0, { type: 'GROUP_SELECTED_FIELDS' })).toBe(s0);
    });

    it('excludes locked fields — they keep their old (absent) group', () => {
        const d = designOf([textField(1), textField(2, { locked: true }), textField(3)], 10);
        const s = appReducer(stateOf(d, [1, 2, 3]), { type: 'GROUP_SELECTED_FIELDS' });
        expect(gid(s.history.present.fields.find(f => f.id === 1)!)).toBe(10);
        expect(gid(s.history.present.fields.find(f => f.id === 3)!)).toBe(10);
        expect(s.history.present.fields.find(f => f.id === 2)!.groupId).toBeUndefined();
    });

    it('re-grouping overrides previous membership (Figma semantics)', () => {
        const d = designOf([textField(1, { groupId: 7 }), textField(2, { groupId: 7 }), textField(3)], 20);
        const s = appReducer(stateOf(d, [2, 3]), { type: 'GROUP_SELECTED_FIELDS' });
        expect(gid(s.history.present.fields.find(f => f.id === 2)!)).toBe(20);
        expect(gid(s.history.present.fields.find(f => f.id === 3)!)).toBe(20);
        // Member 1 was left alone in the old group — pruning dissolves it to
        // an ungrouped field, so no phantom singleton chip lingers.
        expect(s.history.present.fields.find(f => f.id === 1)!.groupId).toBeUndefined();
    });

    it('commits an in-flight nudge without double-pushing history (M1 pattern)', () => {
        const d = designOf([textField(1), textField(2)], 10);
        let s = appReducer(stateOf(d), { type: 'NUDGE_BASELINE' });
        s = appReducer(s, { type: 'UPDATE_INTERMEDIATE', payload: { fields: [{ id: 1, x: 44 }] } });
        s = { ...s, selectedFieldIds: [1, 2] };
        const g = appReducer(s, { type: 'GROUP_SELECTED_FIELDS' });
        expect(g.history.past).toHaveLength(1);          // not two entries for one present
        expect(g.history.past[0]).toBe(d);
        expect(g.history.intermediate).toBeNull();
        expect(g.history.present.fields.find(f => f.id === 1)!.x).toBe(44); // nudge preserved
    });
});

describe('UNGROUP_SELECTED_FIELDS', () => {
    it('dissolves every group touched by the selection — one member is enough', () => {
        const d = designOf([textField(1, { groupId: 7 }), textField(2, { groupId: 7 }), textField(3, { groupId: 8 }), textField(4, { groupId: 8 })]);
        const s = appReducer(stateOf(d, [2, 3]), { type: 'UNGROUP_SELECTED_FIELDS' });
        for (const f of s.history.present.fields) expect(f.groupId).toBeUndefined();
    });

    it('drops the key entirely (saved JSON stays clean, not groupId:undefined)', () => {
        const d = designOf([textField(1, { groupId: 7 }), textField(2, { groupId: 7 })]);
        const s = appReducer(stateOf(d, [1]), { type: 'UNGROUP_SELECTED_FIELDS' });
        expect('groupId' in s.history.present.fields[0]).toBe(false);
    });

    it('is a no-op when nothing selected is grouped (no history entry)', () => {
        const s0 = stateOf(designOf([textField(1), textField(2)]), [1]);
        expect(appReducer(s0, { type: 'UNGROUP_SELECTED_FIELDS' })).toBe(s0);
    });
});

describe('click selection expands to whole groups', () => {
    const grouped = designOf([textField(1, { groupId: 7 }), textField(2, { groupId: 7 }), textField(3)]);
    it('plain click on a member selects the whole group', () => {
        const s = appReducer(stateOf(grouped), { type: 'SELECT_FIELD', payload: { id: 2, shiftKey: false } });
        expect(s.selectedFieldIds.sort()).toEqual([1, 2]);
    });
    it('plain click collapses an unrelated multi-selection to just this group', () => {
        const s = appReducer(stateOf(grouped, [3]), { type: 'SELECT_FIELD', payload: { id: 1, shiftKey: false } });
        expect(s.selectedFieldIds.sort()).toEqual([1, 2]);
    });
    it('shift-click on a fully-selected member removes the whole group (no phantoms)', () => {
        const s = appReducer(stateOf(grouped, [1, 2, 3]), { type: 'SELECT_FIELD', payload: { id: 1, shiftKey: true } });
        expect(s.selectedFieldIds).toEqual([3]);
    });
    it('shift-click on a partially-selected member adds the whole group', () => {
        const s = appReducer(stateOf(grouped, [1]), { type: 'SELECT_FIELD', payload: { id: 2, shiftKey: true } });
        expect(s.selectedFieldIds.sort()).toEqual([1, 2]);
    });
    it('ungrouped fields behave exactly as before', () => {
        const plain = designOf([textField(1), textField(2)]);
        expect(appReducer(stateOf(plain), { type: 'SELECT_FIELD', payload: { id: 1, shiftKey: false } }).selectedFieldIds).toEqual([1]);
        expect(appReducer(stateOf(plain, [1]), { type: 'SELECT_FIELD', payload: { id: 2, shiftKey: true } }).selectedFieldIds).toEqual([1, 2]);
    });
});

describe('clones get their own group (never merge into the source)', () => {
    const groupedSel = () => designOf([textField(1, { groupId: 7 }), textField(2, { groupId: 7 })], 10);

    it('duplicating the whole group yields a NEW group of the clones only', () => {
        const s = appReducer(stateOf(groupedSel(), [1, 2]), { type: 'DUPLICATE_SELECTED_FIELDS' });
        const [a, b, c, d] = s.history.present.fields;
        expect([gid(a), gid(b)]).toEqual([7, 7]);
        expect(c.id).toBe(10); expect(d.id).toBe(11);
        expect([gid(c!), gid(d!)]).toEqual([12, 12]);      // fresh ids above the field ids
        expect(s.history.present.nextId).toBe(13);          // counter advanced past the groupId
        expect(s.selectedFieldIds).toEqual([10, 11]);
    });

    it('duplicating ONE member yields an ungrouped copy (no singleton group)', () => {
        const s = appReducer(stateOf(groupedSel(), [1]), { type: 'DUPLICATE_SELECTED_FIELDS' });
        const clone = s.history.present.fields.find(f => f.id === 10)!;
        expect(clone.groupId).toBeUndefined();
        expect(s.history.present.nextId).toBe(11);
    });

    it('single-field DUPLICATE_FIELD (layer panel) also drops the inherited group', () => {
        const s = appReducer(stateOf(groupedSel()), { type: 'DUPLICATE_FIELD', payload: { id: 1 } });
        expect(s.history.present.fields.find(f => f.id === 10)!.groupId).toBeUndefined();
    });

    it('paste re-keys like duplicate', () => {
        const base = stateOf(groupedSel(), [1, 2]);
        const copied = appReducer(base, { type: 'COPY_FIELD' });
        const s = appReducer(copied, { type: 'PASTE_FIELD' });
        const pasted = s.history.present.fields.filter(f => f.name.endsWith(' Copy'));
        expect(pasted).toHaveLength(2);
        expect(gid(pasted[0])).toBe(gid(pasted[1]));
        expect(gid(pasted[0])).toBeGreaterThan(9);
        // and pasting AGAIN gets yet another fresh group — no merge with the first paste
        const s2 = appReducer({ ...s, selectedFieldIds: [] }, { type: 'PASTE_FIELD' });
        const second = s2.history.present.fields.filter(f => f.groupId !== undefined && f.groupId > 12);
        expect(second).toHaveLength(2);
    });
});

describe('deletes dissolve orphaned groups', () => {
    const three = () => designOf([textField(1, { groupId: 7 }), textField(2, { groupId: 7 }), textField(3, { groupId: 7 }), textField(4)]);

    it('deleting one of three leaves the pair grouped', () => {
        const s = appReducer(stateOf(three(), [1]), { type: 'DELETE_SELECTED_FIELDS' });
        expect(gid(s.history.present.fields.find(f => f.id === 2)!)).toBe(7);
        expect(gid(s.history.present.fields.find(f => f.id === 3)!)).toBe(7);
    });

    it('deleting down to a single member strips the key', () => {
        const pair = designOf([textField(1, { groupId: 7 }), textField(2, { groupId: 7 }), textField(3)]);
        const s = appReducer(stateOf(pair, [1]), { type: 'DELETE_SELECTED_FIELDS' });
        expect(s.history.present.fields.find(f => f.id === 2)!.groupId).toBeUndefined();
    });

    it('layer-panel DELETE_FIELD and CUT prune too', () => {
        const cut = appReducer(stateOf(designOf([textField(1, { groupId: 7 }), textField(2, { groupId: 7 })], 10), [1]), { type: 'CUT_FIELD' });
        expect(cut.history.present.fields[0].groupId).toBeUndefined();
        const del = appReducer(stateOf(designOf([textField(1, { groupId: 7 }), textField(2, { groupId: 7 })])), { type: 'DELETE_FIELD', payload: { id: 2 } });
        expect(del.history.present.fields[0].groupId).toBeUndefined();
    });

    it('CUT of a group whose member is LOCKED protects the locked field (review H2)', () => {
        const d = designOf([textField(1, { groupId: 7 }), textField(2, { groupId: 7, locked: true })], 10);
        const s = appReducer(stateOf(d, [1, 2]), { type: 'CUT_FIELD' });
        expect(s.history.present.fields).toHaveLength(1);
        expect(s.history.present.fields[0].id).toBe(2);          // locked stays
        expect(s.history.present.fields[0].groupId).toBeUndefined(); // its orphan group dissolved
        expect(s.selectedFieldIds).toEqual([2]);                 // locked stays selected on canvas
        expect(s.clipboard).toHaveLength(1);
        expect(s.clipboard![0].id).toBe(1);                      // only the unlocked member was cut
    });

    it('deleting a locked member still prunes the survivors (locked is not deleted)', () => {
        const pair = designOf([textField(1, { groupId: 7 }), textField(2, { groupId: 7, locked: true })]);
        const s = appReducer(stateOf(pair, [1]), { type: 'DELETE_SELECTED_FIELDS' });
        expect(s.history.present.fields.find(f => f.id === 2)!.groupId).toBeUndefined();
    });
});

describe('SET_DESIGN migration sanitizes groupId', () => {
    const load = (field: any) => appReducer(stateOf(designOf([])), { type: 'SET_DESIGN', payload: { design: designOf([field]) } });
    it('keeps a finite numeric groupId', () => {
        expect(gid(load({ ...textField(1), groupId: 7 }).history.present.fields[0])).toBe(7);
    });
    it('drops string / NaN / Infinity garbage', () => {
        for (const junk of ['7', NaN, Infinity]) {
            const f = load({ ...textField(1), groupId: junk }).history.present.fields[0];
            expect(f.groupId).toBeUndefined();
            expect('groupId' in f).toBe(false); // stripped, not merely undefined
        }
    });
    it('keeps groupId on image fields (spread branch) too', () => {
        const img = { id: 1, type: 'image', name: 'I', x: 0, y: 0, rotation: 0, bitmap: ['0'], width: 5, height: 5, threshold: 128, groupId: 9 };
        expect(gid(load(img).history.present.fields[0])).toBe(9);
    });
});

describe('expandIdsWithGroups (shared selection/drag helper)', () => {
    const fields = [{ id: 1, groupId: 7 }, { id: 2, groupId: 7 }, { id: 3, groupId: 8 }, { id: 4 }];
    it('returns the input array untouched when no group members are involved', () => {
        expect(expandIdsWithGroups(fields, [])).toEqual([]);
        const ids = [4];
        expect(expandIdsWithGroups(fields, ids)).toBe(ids); // same reference — no churn
    });
    it('unions whole groups across multiple touched groups', () => {
        expect(expandIdsWithGroups(fields, [1, 3, 4]).sort()).toEqual([1, 2, 3, 4]);
    });
});

describe('groupId never leaks into generated IPL', () => {
    it('generateIPL output is byte-identical grouped vs ungrouped', async () => {
        const { generateIPL } = await import('../services/iplGenerator');
        const plain = designOf([textField(1), textField(2)]);
        const grouped = designOf([textField(1, { groupId: 7 }), textField(2, { groupId: 7 })]);
        expect(await generateIPL(grouped)).toBe(await generateIPL(plain));
    });
});

describe('grouping interacts with session safety and lock', () => {
    it('group/ungroup mark the design dirty and UNDO of a group is clean again', () => {
        const d = designOf([textField(1), textField(2)], 10);
        const s0 = stateOf(d);
        const g = appReducer(s0, { type: 'GROUP_SELECTED_FIELDS' }); // no selection yet…
        expect(g).toBe(s0); // guard: <2 selected is a no-op, stays clean
        const sel = { ...s0, selectedFieldIds: [1, 2] };
        const grouped = appReducer(sel, { type: 'GROUP_SELECTED_FIELDS' });
        expect(grouped.history.present).not.toBe(grouped.history.baseline);
        const back = appReducer(grouped, { type: 'UNDO' });
        expect(back.history.present).toBe(back.history.baseline);
    });
});
