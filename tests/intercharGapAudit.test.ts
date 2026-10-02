import { describe, it, expect } from 'vitest';
import { generateIPL } from '../services/iplGenerator';
import { generateZPL } from '../services/zpl/zplGenerator';
import { generateEPL } from '../services/epl/eplGenerator';
import { generateTSPL } from '../services/tspl/tsplGenerator';
import { generateDPL } from '../services/dpl/dplGenerator';
import { parseIPL } from '../services/iplParser';
import { designerOnlyWarnings } from '../services/designerOnly';
import { getObjectBoundingBox, shiftForTextAlign } from '../services/geometry';
import type { Design, TextField } from '../types';

const baseText = (overrides: Partial<TextField> = {}): TextField => ({
    id: 1,
    name: 'T1',
    type: 'text',
    x: 10,
    y: 10,
    font: '0',
    fontSize: 12,
    h_mag: 1,
    w_mag: 1,
    rotation: 0,
    dataSource: { type: 'fixed', data: 'HELLO' },
    ...overrides,
});

const makeDesign = (field: TextField): Design => ({
    name: 'T',
    labelSettings: {
        width: 100,
        height: 50,
        columns: 1,
        rows: 1,
        unit: 'mm',
        orientation: 'portrait',
    },
    printerSettings: {
        model: 'PD43',
        dpi: 203,
        mediaSenseMode: 'gap',
        mediaType: 'direct-thermal',
        printSpeed: 2,
        darkness: 0,
        quantity: 1,
    },
    fields: [field],
    dataSources: [],
    nextId: 2,
    guides: { horizontal: [], vertical: [] },
});

describe('Audit intercharGapDots (c n,m) across all 5 generators', () => {
    it('Positive control: changing x changes output in ALL 5 generators', async () => {
        const d1 = makeDesign(baseText({ x: 10 }));
        const d2 = makeDesign(baseText({ x: 20 }));

        const ipl1 = await generateIPL(d1);
        const ipl2 = await generateIPL(d2);
        expect(ipl1).not.toBe(ipl2);

        const zpl1 = generateZPL(d1);
        const zpl2 = generateZPL(d2);
        expect(zpl1.zpl).not.toBe(zpl2.zpl);

        const epl1 = generateEPL(d1);
        const epl2 = generateEPL(d2);
        expect(epl1.epl).not.toBe(epl2.epl);

        const tspl1 = generateTSPL(d1);
        const tspl2 = generateTSPL(d2);
        expect(tspl1.tspl).not.toBe(tspl2.tspl);

        const dpl1 = generateDPL(d1);
        const dpl2 = generateDPL(d2);
        expect(dpl1.dpl).not.toBe(dpl2.dpl);
    });

    describe('IPL intercharGapDots audit', () => {
        it('emits c n with no comma when intercharGapDots is unset', async () => {
            const d = makeDesign(baseText({ font: '0', intercharGapDots: undefined }));
            const ipl = await generateIPL(d);
            expect(ipl).toMatch(/c0(?![,\d])/);
        });

        it('emits c n,m and changes output when intercharGapDots is set', async () => {
            const d1 = makeDesign(baseText({ font: '0', intercharGapDots: 5 }));
            const d2 = makeDesign(baseText({ font: '0', intercharGapDots: 10 }));

            const ipl1 = await generateIPL(d1);
            const ipl2 = await generateIPL(d2);
            expect(ipl1).toContain('c0,5');
            expect(ipl2).toContain('c0,10');
            expect(ipl1).not.toBe(ipl2);
        });

        it('supports negative intercharGapDots for overlapping characters', async () => {
            const d = makeDesign(baseText({ font: '0', intercharGapDots: -2 }));
            const ipl = await generateIPL(d);
            expect(ipl).toContain('c0,-2');
        });

        it('supports outline fonts with intercharGapDots (c21,m)', async () => {
            const d = makeDesign(baseText({ font: '21', intercharGapDots: 8 }));
            const ipl = await generateIPL(d);
            expect(ipl).toContain('c21,8');
        });

        it('round-trips intercharGapDots through parseIPL', async () => {
            const d = makeDesign(baseText({ font: '0', intercharGapDots: 6 }));
            const ipl = await generateIPL(d);
            const parsed = parseIPL(ipl, 203);
            const field = parsed.fields.find(f => f.type === 'text') as TextField;
            expect(field).toBeDefined();
            expect(field.intercharGapDots).toBe(6);
        });
    });

    describe('Non-IPL generators ignore intercharGapDots (measured byte-identical)', () => {
        it('ZPL stream is byte-identical when intercharGapDots changes', () => {
            const d0 = makeDesign(baseText({ intercharGapDots: undefined }));
            const d1 = makeDesign(baseText({ intercharGapDots: 5 }));
            expect(generateZPL(d0).zpl).toBe(generateZPL(d1).zpl);
        });

        it('EPL stream is byte-identical when intercharGapDots changes', () => {
            const d0 = makeDesign(baseText({ intercharGapDots: undefined }));
            const d1 = makeDesign(baseText({ intercharGapDots: 5 }));
            expect(generateEPL(d0).epl).toBe(generateEPL(d1).epl);
        });

        it('TSPL stream is byte-identical when intercharGapDots changes', () => {
            const d0 = makeDesign(baseText({ intercharGapDots: undefined }));
            const d1 = makeDesign(baseText({ intercharGapDots: 5 }));
            expect(generateTSPL(d0).tspl).toBe(generateTSPL(d1).tspl);
        });

        it('DPL stream is byte-identical when intercharGapDots changes', () => {
            const d0 = makeDesign(baseText({ intercharGapDots: undefined }));
            const d1 = makeDesign(baseText({ intercharGapDots: 5 }));
            expect(generateDPL(d0).dpl).toBe(generateDPL(d1).dpl);
        });
    });

    describe('designerOnlyWarnings reports intercharGapDots on non-IPL languages', () => {
        it('warns on ZPL, EPL, TSPL, and DPL when intercharGapDots is set', () => {
            const d = makeDesign(baseText({ intercharGapDots: 4 }));
            for (const lang of ['zpl', 'epl', 'tspl', 'dpl'] as const) {
                const w = designerOnlyWarnings(lang, d);
                expect(w, lang).toHaveLength(1);
                expect(w[0]).toContain('"T1"');
                expect(w[0]).toMatch(/intercharacter gap/i);
                expect(w[0]).toContain('IPL');
            }
        });

        it('stays silent for IPL because IPL carries c n,m', () => {
            const d = makeDesign(baseText({ intercharGapDots: 4 }));
            expect(designerOnlyWarnings('ipl', d)).toEqual([]);
        });

        it('stays silent when intercharGapDots is undefined', () => {
            const d = makeDesign(baseText({ intercharGapDots: undefined }));
            for (const lang of ['ipl', 'zpl', 'epl', 'tspl', 'dpl'] as const) {
                expect(designerOnlyWarnings(lang, d), lang).toEqual([]);
            }
        });

        it('stays silent when the text field is hidden (visible: false)', () => {
            const d = makeDesign(baseText({ intercharGapDots: 4, visible: false }));
            for (const lang of ['zpl', 'epl', 'tspl', 'dpl'] as const) {
                expect(designerOnlyWarnings(lang, d), lang).toEqual([]);
            }
        });
    });

    describe('Bounding box and text-align shift honour intercharGapDots', () => {
        it('getObjectBoundingBox expands bitmap text width with positive intercharGapDots', () => {
            const dDefault = makeDesign(baseText({ font: '0', intercharGapDots: undefined, dataSource: { type: 'fixed', data: 'ABCDE' } }));
            const dGapped = makeDesign(baseText({ font: '0', intercharGapDots: 5, dataSource: { type: 'fixed', data: 'ABCDE' } }));

            const boxDefault = getObjectBoundingBox(dDefault.fields[0], dDefault);
            const boxGapped = getObjectBoundingBox(dGapped.fields[0], dGapped);
            expect(boxGapped.width).toBeGreaterThan(boxDefault.width);
            // 5 chars has 4 gaps; difference in dots is 4 * (5 - 1) = 16 dots (font 0 default gap is 1)
            const dpi = 203;
            const diffDots = Math.round((boxGapped.width - boxDefault.width) / (25.4 / dpi));
            expect(diffDots).toBe(16);
        });

        it('getObjectBoundingBox expands outline text width with intercharGapDots', () => {
            const dDefault = makeDesign(baseText({ font: '20', fontSize: 12, intercharGapDots: undefined, dataSource: { type: 'fixed', data: 'ABCDE' } }));
            const dGapped = makeDesign(baseText({ font: '20', fontSize: 12, intercharGapDots: 4, dataSource: { type: 'fixed', data: 'ABCDE' } }));

            const boxDefault = getObjectBoundingBox(dDefault.fields[0], dDefault);
            const boxGapped = getObjectBoundingBox(dGapped.fields[0], dGapped);
            expect(boxGapped.width).toBeGreaterThan(boxDefault.width);
            const dpi = 203;
            const diffDots = Math.round((boxGapped.width - boxDefault.width) / (25.4 / dpi));
            // 5 chars has 4 gaps => 4 * 4 = 16 dots
            expect(diffDots).toBe(16);
        });

        it('shiftForTextAlign with right alignment shifts further when intercharGapDots widens text', () => {
            const dDefault = makeDesign(baseText({ font: '0', align: 'right', intercharGapDots: undefined, dataSource: { type: 'fixed', data: 'ABCDE' } }));
            const dGapped = makeDesign(baseText({ font: '0', align: 'right', intercharGapDots: 5, dataSource: { type: 'fixed', data: 'ABCDE' } }));

            const boxDefault = getObjectBoundingBox(dDefault.fields[0], dDefault);
            const boxGapped = getObjectBoundingBox(dGapped.fields[0], dGapped);

            const shiftDefault = shiftForTextAlign({ x: 10, y: 10 }, dDefault.fields[0], boxDefault.width / (25.4 / 203));
            const shiftGapped = shiftForTextAlign({ x: 10, y: 10 }, dGapped.fields[0], boxGapped.width / (25.4 / 203));

            // Right-aligned text shifts left (-x), so shiftGapped.x should be smaller (further left)
            expect(shiftGapped.x).toBeLessThan(shiftDefault.x);
        });
    });
});
