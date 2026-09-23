import { describe, it, expect, beforeEach } from 'vitest';
import { getSavedDesigns, loadDesign, saveDesign, deleteDesign } from '../services/designManager';
import type { Design } from '../types';

// happy-dom provides localStorage; clear between cases.
beforeEach(() => {
    localStorage.clear();
});

const minimalDesign = (name: string): Design => ({
    name,
    labelSettings: { width: 100, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields: [{ id: 1, type: 'text', name: 'A', x: 0, y: 0, rotation: 0, dataSource: { type: 'fixed', data: 'hi' }, font: '25', fontSize: 12, h_mag: 1, w_mag: 1 }],
    dataSources: [],
    nextId: 2,
    guides: { horizontal: [], vertical: [] },
} as Design);

describe('designManager save/load round-trip', () => {
    it('saves, lists, loads and deletes by name', () => {
        const d = minimalDesign('Label A');
        saveDesign(d);
        expect(getSavedDesigns()).toEqual(['Label A']);
        const loaded = loadDesign('Label A');
        expect(loaded?.fields).toHaveLength(1);
        expect(loaded?.labelSettings.width).toBe(100);
        deleteDesign('Label A');
        expect(getSavedDesigns()).toEqual([]);
        expect(loadDesign('Label A')).toBeNull();
    });

    it('list stays sorted and duplicate saves do not double the entry', () => {
        saveDesign(minimalDesign('B'));
        saveDesign(minimalDesign('A'));
        saveDesign(minimalDesign('B'));
        expect(getSavedDesigns()).toEqual(['A', 'B']);
    });
});

describe('designManager corrupt-storage hardening (audit M: zero prior tests)', () => {
    it('non-array list JSON is rejected, not crashed on', () => {
        localStorage.setItem('ipl_designer_saved_designs', '"a string"');
        expect(getSavedDesigns()).toEqual([]);
        localStorage.setItem('ipl_designer_saved_designs', '42');
        expect(getSavedDesigns()).toEqual([]);
    });

    it('mixed-type entries are filtered to strings only', () => {
        localStorage.setItem('ipl_designer_saved_designs', '[{"x":1},"ok",null,3]');
        expect(getSavedDesigns()).toEqual(['ok']);
    });

    it('unparseable list JSON yields empty list (no throw)', () => {
        localStorage.setItem('ipl_designer_saved_designs', '{not json');
        expect(getSavedDesigns()).toEqual([]);
    });

    it('stored design without a fields array is refused with a console error', () => {
        localStorage.setItem('ipl_design_Bad', '"hello"');
        expect(loadDesign('Bad')).toBeNull();
        localStorage.setItem('ipl_design_Bad', '[1,2,3]');
        expect(loadDesign('Bad')).toBeNull();
        localStorage.setItem('ipl_design_Bad', '{"name":"no fields"}');
        expect(loadDesign('Bad')).toBeNull();
    });

    it('strips __proto__ keys from a stored design before returning it', () => {
        // JSON.parse of {"__proto__":{...}} creates an OWN key (not a prototype
        // change), which then leaks through spreads into app state.
        localStorage.setItem('ipl_design_P',
            '{"name":"P","fields":[],"dataSources":[],"nextId":1,' +
            '"guides":{"horizontal":[],"vertical":[]},' +
            '"labelSettings":{"width":10,"height":10,"columns":1,"rows":1,"unit":"mm","orientation":"portrait"},' +
            '"printerSettings":{"model":"PD43","dpi":203,"quantity":1,"mediaType":"direct-thermal","mediaSenseMode":"gap","printSpeed":6,"darkness":10},' +
            '"__proto__":{"polluted":"yes"}}');
        const loaded = loadDesign('P');
        expect(loaded).not.toBeNull();
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(Object.getOwnPropertyNames(loaded!)).not.toContain('__proto__');
    });
});
