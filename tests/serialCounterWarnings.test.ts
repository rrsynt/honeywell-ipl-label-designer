// NOW-4 (2026-10-06, audit FUN-01): a serial (printer-side odometer) counter
// linked to a field must never export as a frozen start value in silence. Only
// IPL carries <ESC>I/D — ZPL/EPL/TSPL/DPL bake the padded start on every label.
// The honest form is a NAMED warning on those four languages (the same channel
// hriAlign/hriFontSize/intercharGap already use), not a fake ^SN/SETCOUNTER.
import { describe, it, expect } from 'vitest';
import { designerOnlyWarnings } from '../services/designerOnly';
import { generateZPL } from '../services/zpl/zplGenerator';
import { generateEPL } from '../services/epl/eplGenerator';
import { generateTSPL } from '../services/tspl/tsplGenerator';
import { generateDPL } from '../services/dpl/dplGenerator';
import type { CounterDataSource, Design, Field, PrinterLanguage } from '../types';

const designOf = (fields: Field[], sources: Design['dataSources'] = []): Design => ({
    name: 'T',
    labelSettings: { width: 100, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'thermal-transfer', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields, dataSources: sources, nextId: 99, guides: { horizontal: [], vertical: [] },
});

const serial = (): CounterDataSource =>
    ({ id: 'lot', name: 'LotNo', type: 'counter', start: 1, step: 1, padding: 4, serial: true });

const plain = (): CounterDataSource =>
    ({ id: 'lot', name: 'LotNo', type: 'counter', start: 1, step: 1, padding: 4 });

const linked = (): Field => ({
    id: 1, type: 'text', name: 'LotNo', x: 5, y: 5, rotation: 0,
    dataSource: { type: 'linked', sourceId: 'lot' }, font: '0', fontSize: 12, h_mag: 1, w_mag: 1,
} as Field);

const LANGS: PrinterLanguage[] = ['zpl', 'epl', 'tspl', 'dpl'];

describe('serial counters are named on the four languages that freeze them', () => {
    for (const lang of LANGS) {
        it(`${lang}: warns and names the field`, () => {
            const w = designerOnlyWarnings(lang, designOf([linked()], [serial()]));
            expect(w).toHaveLength(1);
            expect(w[0]).toMatch(/"LotNo"/);
            expect(w[0].toLowerCase()).toMatch(/start value/);
        });
    }

    it('ipl stays silent — it carries the odometer', () => {
        expect(designerOnlyWarnings('ipl', designOf([linked()], [serial()]))).toEqual([]);
    });

    it('a non-serial counter stays silent everywhere — start-each-time is identical', () => {
        for (const lang of [...LANGS, 'ipl' as const]) {
            expect(designerOnlyWarnings(lang, designOf([linked()], [plain()])), lang).toEqual([]);
        }
    });

    it('a serial counter with step 0 stays silent — it never advances', () => {
        const dead = { ...serial(), step: 0 };
        for (const lang of [...LANGS, 'ipl' as const]) {
            expect(designerOnlyWarnings(lang, designOf([linked()], [dead])), lang).toEqual([]);
        }
    });

    it('an ordinary design stays silent everywhere', () => {
        const d = designOf([linked()], [{ id: 'v', name: 'V', type: 'variable', sampleData: 'x' }]);
        for (const lang of [...LANGS, 'ipl' as const]) {
            expect(designerOnlyWarnings(lang, d), lang).toEqual([]);
        }
    });
});

describe('the frozen value is the padded start, identically, on all four', () => {
    // Pins WHAT the warning describes: not a guess about these languages'
    // counter commands, but the measured fact that every label gets '0001'.
    for (const lang of LANGS) {
        it(`${lang}: every label prints the start value`, () => {
            const d = designOf([linked()], [serial()]);
            const stream =
                lang === 'zpl' ? generateZPL(d).zpl :
                lang === 'epl' ? generateEPL(d).epl :
                lang === 'tspl' ? generateTSPL(d).tspl :
                generateDPL(d).dpl;
            expect(stream).toContain('0001');
        });
    }
});
