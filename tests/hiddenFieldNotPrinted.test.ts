// `visible: false` means "hidden on the canvas AND not printed". The designer
// draws nothing for such a field, the IPL generator filters it out, and
// csvJob's export path skips it — but ZPL, EPL, TSPL and DPL iterated
// `design.fields` directly, so a field the user had hidden still reached their
// streams. The CODE tab showed it gone (IPL) while a ZPL/EPL/TSPL/DPL export
// printed it: the screen and the export disagreed, and the export lost it too.
import './golden/setup';
import { describe, it, expect } from 'vitest';
import { generateIPL } from '../services/iplGenerator';
import { generateZPL } from '../services/zpl/zplGenerator';
import { generateEPL } from '../services/epl/eplGenerator';
import { generateTSPL } from '../services/tspl/tsplGenerator';
import { generateDPL } from '../services/dpl/dplGenerator';
import { printableFields } from '../services/geometry';
import type { Design } from '../types';

const design = (visible?: boolean): Design => ({
    name: 'hidden', labelSettings: { width: 60, height: 40, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10, language: 'ipl' },
    fields: [
        { id: 1, type: 'text', name: 'T', x: 10, y: 10, rotation: 0, dataSource: { type: 'fixed', data: 'SHOWN' }, font: '0', fontSize: 12, h_mag: 1, w_mag: 1, visible: true },
        { id: 2, type: 'text', name: 'H', x: 10, y: 20, rotation: 0, dataSource: { type: 'fixed', data: 'HIDDENFIELD' }, font: '0', fontSize: 12, h_mag: 1, w_mag: 1, ...(visible === undefined ? {} : { visible }) },
    ],
    dataSources: [], nextId: 9, guides: { horizontal: [], vertical: [] },
} as unknown as Design);

const LANGS = ['ipl', 'zpl', 'epl', 'tspl', 'dpl'] as const;
const emit = async (lang: string, d: Design): Promise<string> => {
    switch (lang) {
        case 'ipl': return await generateIPL(d);
        case 'zpl': return generateZPL(d).zpl;
        case 'epl': return generateEPL(d).epl;
        case 'tspl': return generateTSPL(d).tspl;
        default: return generateDPL(d).dpl;
    }
};

describe('a hidden field is not printed by any language', () => {
    it('excludes a visible:false field, on every language', async () => {
        for (const lang of LANGS) {
            const code = await emit(lang, design(false));
            expect(code, `${lang} must still print the visible field`).toContain('SHOWN');
            expect(code, `${lang} must NOT print the hidden field`).not.toContain('HIDDENFIELD');
        }
    });

    it('treats absent `visible` as shown (the default)', async () => {
        for (const lang of LANGS) {
            const code = await emit(lang, design(undefined));
            expect(code, `${lang} default keeps the field`).toContain('HIDDENFIELD');
        }
    });

    it('printableFields drops exactly the hidden ones', () => {
        expect(printableFields(design(false)).map(f => f.name)).toEqual(['T']);
        expect(printableFields(design(undefined)).map(f => f.name)).toEqual(['T', 'H']);
    });
});