// "Above Barcode" is a real choice in the inspector (FieldEditor) and the
// canvas draws it above the bars. IPL has the slot (`i2`, PRM p.191). The four
// other languages have no parameter that moves the human-readable line up —
// every one anchors it below the bars — so an "above" request prints below.
//
// EPL and TSPL already named that difference. ZPL and DPL printed below in
// silence (measured 2026-10-02: changing below->above left their streams
// byte-identical, and no warning), so the reader got a label that did not
// match the screen with no word about it. This pins all four: the request is
// named, and it is NOT named when the line is below or off.
import { describe, expect, it } from 'vitest';
import type { Design, Field } from '../types';
import { generateZPL } from '../services/zpl/zplGenerator';
import { generateEPL } from '../services/epl/eplGenerator';
import { generateTSPL } from '../services/tspl/tsplGenerator';
import { generateDPL } from '../services/dpl/dplGenerator';

const design = (fields: Field[]): Design => ({
    name: 'T',
    labelSettings: { width: 80, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'thermal-transfer', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields, dataSources: [], nextId: 9, guides: { horizontal: [], vertical: [] },
});

const bc = (hri: 'none' | 'below' | 'above'): Field => ({
    id: 2, type: 'barcode', name: 'B1', x: 5, y: 5, rotation: 0,
    dataSource: { type: 'fixed', data: '1234567890' }, symbology: '6',
    humanReadable: hri, h_mag: 50, w_mag: 2,
});

const warners = {
    ZPL: (d: Design) => generateZPL(d).warnings,
    EPL: (d: Design) => generateEPL(d).warnings,
    TSPL: (d: Design) => generateTSPL(d).warnings,
    DPL: (d: Design) => generateDPL(d).warnings,
};

describe('an "above" HRI request is named in every language that cannot honour it', () => {
    for (const [lang, warnings] of Object.entries(warners)) {
        it(`${lang}: warns for above, silent for below and none`, () => {
            expect(warnings(design([bc('above')])).some(w => /human-readable line above the bar code/.test(w))).toBe(true);
            expect(warnings(design([bc('below')])).some(w => /human-readable line above/.test(w))).toBe(false);
            expect(warnings(design([bc('none')])).some(w => /human-readable line above/.test(w))).toBe(false);
        });
    }
});