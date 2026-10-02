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

describe('Audit rssSegments across all 5 generators', () => {
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

    describe('IPL rssSegments audit', () => {
        it('emits rssSegments for version 6 (RSSEXP) and changes output', async () => {
            const dSeg4 = makeDesign(baseBarcode({ symbology: '20', rssVersion: 6, rssSepHeight: 1, rssSegments: 4 }));
            const dSeg6 = makeDesign(baseBarcode({ symbology: '20', rssVersion: 6, rssSepHeight: 1, rssSegments: 6 }));
            const ipl4 = await generateIPL(dSeg4);
            const ipl6 = await generateIPL(dSeg6);

            expect(ipl4).toContain('c20,6,1,4');
            expect(ipl6).toContain('c20,6,1,6');
            expect(ipl4).not.toBe(ipl6);
        });

        it('round-trips rssSegments through parseIPL', async () => {
            const d = makeDesign(baseBarcode({ symbology: '20', rssVersion: 6, rssSepHeight: 1, rssSegments: 4 }));
            const ipl = await generateIPL(d);
            const parsed = parseIPL(ipl, 203);
            const bc = parsed.fields.find(f => f.type === 'barcode') as BarcodeField;
            expect(bc).toBeDefined();
            expect(bc.rssVersion).toBe(6);
            expect(bc.rssSegments).toBe(4);
        });
    });

    describe('TSPL rssSegments audit', () => {
        it('emits segWidth on RSSEXP (version 6) and changes output between different even values', () => {
            const dSeg2 = makeDesign(baseBarcode({ symbology: '20', rssVersion: 6, rssSepHeight: 1, rssSegments: 2 }));
            const dSeg4 = makeDesign(baseBarcode({ symbology: '20', rssVersion: 6, rssSepHeight: 1, rssSegments: 4 }));
            const tspl2 = generateTSPL(dSeg2);
            const tspl4 = generateTSPL(dSeg4);

            expect(tspl2.tspl).not.toBe(tspl4.tspl);
            expect(tspl2.tspl).toContain('RSS 80,80,"RSSEXP",0,2,1,2,"1234567890123"');
            expect(tspl4.tspl).toContain('RSS 80,80,"RSSEXP",0,2,1,4,"1234567890123"');
        });

        it('round-trips RSSEXP rssSegments through parseTSPL', () => {
            const d = makeDesign(baseBarcode({ symbology: '20', rssVersion: 6, rssSepHeight: 1, rssSegments: 4 }));
            const tspl = generateTSPL(d);
            expect(tspl.tspl).toContain('RSS 80,80,"RSSEXP",0,2,1,4,"1234567890123"');

            const parsed = parseTSPL(tspl.tspl);
            const bc = parsed.elements[0] as BarcodeElement;
            expect(bc).toBeDefined();
            expect(bc.rssVersion).toBe('6');
            expect(bc.rssSegments).toBe('4');
        });

        it('two-way test: non-RSSEXP variants (RSS14, RSS14T, RSS14S, RSS14SO, RSSLIM) ignore rssSegments and warn', () => {
            const nonExpVariants = [
                { version: 0, name: 'RSS14' },
                { version: 1, name: 'RSS14T' },
                { version: 2, name: 'RSS14S' },
                { version: 3, name: 'RSS14SO' },
                { version: 4, name: 'RSSLIM' },
            ];

            for (const { version, name } of nonExpVariants) {
                const d1 = makeDesign(baseBarcode({ symbology: '20', rssVersion: version, rssSegments: 4 }));
                const d2 = makeDesign(baseBarcode({ symbology: '20', rssVersion: version, rssSegments: 6 }));
                const t1 = generateTSPL(d1);
                const t2 = generateTSPL(d2);

                // Output should be identical (no segWidth slot)
                expect(t1.tspl).toBe(t2.tspl);
                expect(t1.tspl).not.toContain(',4,');
                expect(t1.tspl).not.toContain(',6,');

                // Warning stating segments per row applies only to expanded stacked (RSSEXP)
                expect(t1.warnings.some(w =>
                    (w.includes('segments per row') || w.includes('segments')) && (w.includes('expanded stacked') || w.includes('RSSEXP'))
                )).toBe(true);
                expect(t2.warnings.some(w =>
                    (w.includes('segments per row') || w.includes('segments')) && (w.includes('expanded stacked') || w.includes('RSSEXP'))
                )).toBe(true);

                // Without rssSegments set, no segments warning is emitted
                const dClean = makeDesign(baseBarcode({ symbology: '20', rssVersion: version, rssSegments: undefined }));
                const tClean = generateTSPL(dClean);
                expect(tClean.warnings.some(w => w.includes('segments per row') || w.includes('segments'))).toBe(false);
            }
        });

        it('validation: odd rssSegments or out-of-range (< 2 or > 22) must NOT emit segWidth and must warn', () => {
            const invalidValues = [1, 3, 5, 0, -2, 23, 24];
            for (const segVal of invalidValues) {
                const d = makeDesign(baseBarcode({ symbology: '20', rssVersion: 6, rssSepHeight: 1, rssSegments: segVal }));
                const tspl = generateTSPL(d);

                // Must NOT emit segWidth in the command
                expect(tspl.tspl).toContain('RSS 80,80,"RSSEXP",0,2,1,"1234567890123"');
                // Must emit a warning stating it is not an even number from 2 to 22
                expect(tspl.warnings.some(w =>
                    (w.includes('segments per row') || w.includes('segments') || w.includes('segWidth'))
                    && w.includes('even') && w.includes('2') && w.includes('22')
                )).toBe(true);
            }
        });

        it('TSPL parser: odd segWidth in TSPL stream (e.g. 3) must NOT be parsed into rssSegments (must remain undefined)', () => {
            const oddCode = 'RSS 10,10,"RSSEXP",0,2,1,3,"1234567890123"';
            const parsedOdd = parseTSPL(oddCode);
            const bcOdd = parsedOdd.elements[0] as BarcodeElement;
            expect(bcOdd).toBeDefined();
            expect(bcOdd.rssSegments).toBeUndefined();

            const oddCode5 = 'RSS 10,10,"RSSEXP",0,2,1,5,"1234567890123"';
            const parsedOdd5 = parseTSPL(oddCode5);
            const bcOdd5 = parsedOdd5.elements[0] as BarcodeElement;
            expect(bcOdd5).toBeDefined();
            expect(bcOdd5.rssSegments).toBeUndefined();

            const outOfRangeCode = 'RSS 10,10,"RSSEXP",0,2,1,24,"1234567890123"';
            const parsedOutOfRange = parseTSPL(outOfRangeCode);
            const bcOutOfRange = parsedOutOfRange.elements[0] as BarcodeElement;
            expect(bcOutOfRange).toBeDefined();
            expect(bcOutOfRange.rssSegments).toBeUndefined();

            const validCode = 'RSS 10,10,"RSSEXP",0,2,1,4,"1234567890123"';
            const parsedValid = parseTSPL(validCode);
            const bcValid = parsedValid.elements[0] as BarcodeElement;
            expect(bcValid).toBeDefined();
            expect(bcValid.rssSegments).toBe('4');
        });
    });

    describe('Non-supporting languages (ZPL, EPL, DPL) audit', () => {
        it('warns in ZPL, EPL, and DPL that symbology 20 is unsupported', () => {
            const d = makeDesign(baseBarcode({ symbology: '20', rssVersion: 6, rssSegments: 4 }));
            const zpl = generateZPL(d);
            const epl = generateEPL(d);
            const dpl = generateDPL(d);

            expect(zpl.warnings.join(' ')).toContain('barcode type 20');
            expect(epl.warnings.join(' ')).toContain('barcode type 20');
            expect(dpl.warnings.join(' ')).toContain('barcode type 20');
        });
    });
});
