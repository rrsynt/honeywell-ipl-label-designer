import { describe, it, expect } from 'vitest';
import { generateIPL } from '../services/iplGenerator';
import { generateZPL } from '../services/zpl/zplGenerator';
import { generateEPL } from '../services/epl/eplGenerator';
import { generateTSPL } from '../services/tspl/tsplGenerator';
import { generateDPL } from '../services/dpl/dplGenerator';
import { parseIPL } from '../services/iplParser';
import { parseTSPL } from '../services/tspl/tsplParser';
import type { Design, BarcodeField } from '../types';
import type { BarcodeElement } from '../services/ipl/types';

const baseBarcode = (overrides: Partial<BarcodeField> = {}): BarcodeField => ({
    id: 1,
    name: 'BC1',
    type: 'barcode',
    x: 10,
    y: 10,
    symbology: '20',
    h_mag: 50,
    w_mag: 2,
    rotation: 0,
    humanReadable: 'none',
    dataSource: { type: 'fixed', data: '1234567890123' },
    ...overrides,
});

const makeDesign = (field: BarcodeField): Design => ({
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

describe('Audit rssSepHeight across all 5 generators', () => {
    it('Positive control: changing x changes output in ALL 5 generators', async () => {
        const d1 = makeDesign(baseBarcode({ symbology: '6', x: 10 }));
        const d2 = makeDesign(baseBarcode({ symbology: '6', x: 20 }));

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

    describe('IPL rssSepHeight audit', () => {
        it('emits rssSepHeight for stacked variants (v2, v3, v6)', async () => {
            // Version 2 (Stacked)
            const dSep2_1 = makeDesign(baseBarcode({ symbology: '20', rssVersion: 2, rssSepHeight: 1 }));
            const dSep2_2 = makeDesign(baseBarcode({ symbology: '20', rssVersion: 2, rssSepHeight: 2 }));
            const ipl2_1 = await generateIPL(dSep2_1);
            const ipl2_2 = await generateIPL(dSep2_2);
            expect(ipl2_1).toContain('c20,2,1');
            expect(ipl2_2).toContain('c20,2,2');
            expect(ipl2_1).not.toBe(ipl2_2);

            // Version 3 (Stacked Omnidirectional)
            const dSep3_1 = makeDesign(baseBarcode({ symbology: '20', rssVersion: 3, rssSepHeight: 1 }));
            const dSep3_2 = makeDesign(baseBarcode({ symbology: '20', rssVersion: 3, rssSepHeight: 2 }));
            const ipl3_1 = await generateIPL(dSep3_1);
            const ipl3_2 = await generateIPL(dSep3_2);
            expect(ipl3_1).toContain('c20,3,1');
            expect(ipl3_2).toContain('c20,3,2');
            expect(ipl3_1).not.toBe(ipl3_2);

            // Version 6 (Expanded Stacked)
            const dSep6_1 = makeDesign(baseBarcode({ symbology: '20', rssVersion: 6, rssSepHeight: 1 }));
            const dSep6_2 = makeDesign(baseBarcode({ symbology: '20', rssVersion: 6, rssSepHeight: 2 }));
            const ipl6_1 = await generateIPL(dSep6_1);
            const ipl6_2 = await generateIPL(dSep6_2);
            expect(ipl6_1).toContain('c20,6,1');
            expect(ipl6_2).toContain('c20,6,2');
            expect(ipl6_1).not.toBe(ipl6_2);
        });

        it('round-trips rssSepHeight through parseIPL', async () => {
            const dSep6 = makeDesign(baseBarcode({ symbology: '20', rssVersion: 6, rssSepHeight: 2 }));
            const ipl = await generateIPL(dSep6);
            const parsed = parseIPL(ipl, 203);
            const bc = parsed.fields.find(f => f.type === 'barcode') as BarcodeField;
            expect(bc).toBeDefined();
            expect(bc.rssVersion).toBe(6);
            expect(bc.rssSepHeight).toBe(2);
        });
    });

    describe('TSPL rssSepHeight audit', () => {
        it('locks RSSEXP (version 6): sepHt is emitted and changes output', () => {
            const dSep6_1 = makeDesign(baseBarcode({ symbology: '20', rssVersion: 6, rssSepHeight: 1 }));
            const dSep6_2 = makeDesign(baseBarcode({ symbology: '20', rssVersion: 6, rssSepHeight: 2 }));
            const tspl6_1 = generateTSPL(dSep6_1);
            const tspl6_2 = generateTSPL(dSep6_2);

            expect(tspl6_1.tspl).not.toBe(tspl6_2.tspl);
            expect(tspl6_1.tspl).toContain('RSS 80,80,"RSSEXP",0,2,1,"1234567890123"');
            expect(tspl6_2.tspl).toContain('RSS 80,80,"RSSEXP",0,2,2,"1234567890123"');

            // Neither should warn about separator height being ignored
            expect(tspl6_1.warnings.some(w => w.includes('separator height'))).toBe(false);
            expect(tspl6_2.warnings.some(w => w.includes('separator height'))).toBe(false);
        });

        it('locks RSSEXP (version 6) with rssSegments: emits both sepHt and segWidth', () => {
            const d = makeDesign(baseBarcode({ symbology: '20', rssVersion: 6, rssSepHeight: 2, rssSegments: 4 }));
            const tspl = generateTSPL(d);
            expect(tspl.tspl).toContain('RSS 80,80,"RSSEXP",0,2,2,4,"1234567890123"');

            const parsed = parseTSPL(tspl.tspl);
            const bc = parsed.elements[0] as BarcodeElement;
            expect(bc.rssSepHeight).toBe('2');
            expect(bc.rssSegments).toBe('4');
        });

        it('locks RSS14S (version 2) and RSS14SO (version 3): sepHt emitted and changes output', () => {
            // Version 2 (RSS14S)
            const dSep2_1 = makeDesign(baseBarcode({ symbology: '20', rssVersion: 2, rssSepHeight: 1 }));
            const dSep2_2 = makeDesign(baseBarcode({ symbology: '20', rssVersion: 2, rssSepHeight: 2 }));
            const tspl2_1 = generateTSPL(dSep2_1);
            const tspl2_2 = generateTSPL(dSep2_2);
            expect(tspl2_1.tspl).not.toBe(tspl2_2.tspl);
            expect(tspl2_1.tspl).toContain('RSS 80,80,"RSS14S",0,2,1,"1234567890123"');
            expect(tspl2_2.tspl).toContain('RSS 80,80,"RSS14S",0,2,2,"1234567890123"');

            // Version 3 (RSS14SO)
            const dSep3_1 = makeDesign(baseBarcode({ symbology: '20', rssVersion: 3, rssSepHeight: 1 }));
            const dSep3_2 = makeDesign(baseBarcode({ symbology: '20', rssVersion: 3, rssSepHeight: 2 }));
            const tspl3_1 = generateTSPL(dSep3_1);
            const tspl3_2 = generateTSPL(dSep3_2);
            expect(tspl3_1.tspl).not.toBe(tspl3_2.tspl);
            expect(tspl3_1.tspl).toContain('RSS 80,80,"RSS14SO",0,2,1,"1234567890123"');
            expect(tspl3_2.tspl).toContain('RSS 80,80,"RSS14SO",0,2,2,"1234567890123"');
        });

        it('locks two-way behaviour: linear variants (v0, v1, v4) ignore sepHt and WARN', () => {
            const linearVariants = [
                { version: 0, name: 'RSS14' },
                { version: 1, name: 'RSS14T' },
                { version: 4, name: 'RSSLIM' },
            ];

            for (const { version, name } of linearVariants) {
                const d1 = makeDesign(baseBarcode({ symbology: '20', rssVersion: version, rssSepHeight: 1 }));
                const d2 = makeDesign(baseBarcode({ symbology: '20', rssVersion: version, rssSepHeight: 2 }));
                const t1 = generateTSPL(d1);
                const t2 = generateTSPL(d2);

                // Output should be identical (no sepHt slot)
                expect(t1.tspl).toBe(t2.tspl);
                expect(t1.tspl).toContain(`RSS 80,80,"${name}",0,2,"1234567890123"`);

                // Warnings must name linear GS1 DataBar and ignored separator height
                expect(t1.warnings.some(w => w.includes('linear GS1 DataBar') && w.includes('separator height'))).toBe(true);
                expect(t2.warnings.some(w => w.includes('linear GS1 DataBar') && w.includes('separator height'))).toBe(true);

                // Without rssSepHeight set, no separator warning is emitted
                const dClean = makeDesign(baseBarcode({ symbology: '20', rssVersion: version, rssSepHeight: undefined }));
                const tClean = generateTSPL(dClean);
                expect(tClean.warnings.some(w => w.includes('separator height'))).toBe(false);
            }
        });

        it('warns when rssSepHeight exceeds TSPL maximum of 2 on stacked variants', () => {
            const d = makeDesign(baseBarcode({ symbology: '20', rssVersion: 6, rssSepHeight: 4 }));
            const tspl = generateTSPL(d);
            expect(tspl.tspl).toContain('RSS 80,80,"RSSEXP",0,2,2,"1234567890123"');
            expect(tspl.warnings.some(w => w.includes('separator height 4') && w.includes('clamps to 2'))).toBe(true);
        });

        it('parses 6-parameter RSS without sepHt slot without falsely setting rssSepHeight', () => {
            const code = 'RSS 10,10,"RSS14S",0,2,"1234567890123"';
            const parsed = parseTSPL(code);
            const bc = parsed.elements[0] as BarcodeElement;
            expect(bc).toBeDefined();
            expect(bc.rssSepHeight).toBeUndefined();
        });

        it('round-trips RSSEXP rssSepHeight through parseTSPL', () => {
            const dSep6 = makeDesign(baseBarcode({ symbology: '20', rssVersion: 6, rssSepHeight: 2 }));
            const tspl = generateTSPL(dSep6);
            const parsed = parseTSPL(tspl.tspl);
            const bc = parsed.elements[0] as BarcodeElement;
            expect(bc).toBeDefined();
            expect(bc.rssVersion).toBe('6');
            expect(bc.rssSepHeight).toBe('2');
        });
    });

    describe('Non-supporting languages (ZPL, EPL, DPL) audit', () => {
        it('warns in ZPL, EPL, and DPL that symbology 20 is not supported', () => {
            const d = makeDesign(baseBarcode({ symbology: '20', rssVersion: 2, rssSepHeight: 2 }));
            const zpl = generateZPL(d);
            const epl = generateEPL(d);
            const dpl = generateDPL(d);

            expect(zpl.warnings.join(' ')).toContain('barcode type 20');
            expect(epl.warnings.join(' ')).toContain('barcode type 20');
            expect(dpl.warnings.join(' ')).toContain('barcode type 20');
        });
    });
});
