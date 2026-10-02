import { describe, it, expect } from 'vitest';
import { generateIPL } from '../services/iplGenerator';
import { generateZPL } from '../services/zpl/zplGenerator';
import { generateEPL } from '../services/epl/eplGenerator';
import { generateTSPL } from '../services/tspl/tsplGenerator';
import { generateDPL } from '../services/dpl/dplGenerator';
import { getObjectBoundingBox } from '../services/geometry';
import type { Design, TextField, BarcodeField } from '../types';

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
    dataSource: { type: 'fixed', data: 'TEST' },
    ...overrides,
});

const baseBarcode = (overrides: Partial<BarcodeField> = {}): BarcodeField => ({
    id: 2,
    name: 'B1',
    type: 'barcode',
    x: 10,
    y: 10,
    symbology: '0', // Code 39
    humanReadable: 'none',
    h_mag: 50,
    w_mag: 2,
    rotation: 0,
    dataSource: { type: 'fixed', data: '12345' },
    ...overrides,
});

const makeDesign = (field: TextField | BarcodeField): Design => ({
    name: 'TestDesign',
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
    nextId: 3,
    guides: { horizontal: [], vertical: [] },
});

describe('Audit fontSize, h_mag, and w_mag across all 5 generators', () => {
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

    describe('Bitmap font h_mag emission across all 5 generators', () => {
        it('IPL: emits h command with field.h_mag value', async () => {
            const d1 = makeDesign(baseText({ font: '0', h_mag: 1 }));
            const d2 = makeDesign(baseText({ font: '0', h_mag: 3 }));

            const ipl1 = await generateIPL(d1);
            const ipl2 = await generateIPL(d2);

            expect(ipl1).toContain(';h1;');
            expect(ipl2).toContain(';h3;');
            expect(ipl1).not.toBe(ipl2);
        });

        it('ZPL: scales ^A0 height with h_mag', () => {
            const d1 = makeDesign(baseText({ font: '0', h_mag: 1 }));
            const d2 = makeDesign(baseText({ font: '0', h_mag: 3 }));

            const zpl1 = generateZPL(d1).zpl;
            const zpl2 = generateZPL(d2).zpl;

            // font '0' baseHeight is 9
            expect(zpl1).toContain('^A0N,9,');
            expect(zpl2).toContain('^A0N,27,');
            expect(zpl1).not.toBe(zpl2);
        });

        it('EPL: sets vertical multiplier p6 in A command', () => {
            const d1 = makeDesign(baseText({ font: '0', h_mag: 1 }));
            const d2 = makeDesign(baseText({ font: '0', h_mag: 3 }));

            const epl1 = generateEPL(d1).epl;
            const epl2 = generateEPL(d2).epl;

            // A p1,p2,p3,p4,p5,p6,p7,"data" -> p5=w_mag, p6=h_mag
            expect(epl1).toMatch(/A\d+,\d+,0,\d+,1,1,N,"TEST"/);
            expect(epl2).toMatch(/A\d+,\d+,0,\d+,1,3,N,"TEST"/);
            expect(epl1).not.toBe(epl2);
        });

        it('TSPL: sets y-multiplication parameter in TEXT command', () => {
            const d1 = makeDesign(baseText({ font: '0', h_mag: 1 }));
            const d2 = makeDesign(baseText({ font: '0', h_mag: 3 }));

            const tspl1 = generateTSPL(d1).tspl;
            const tspl2 = generateTSPL(d2).tspl;

            // TEXT x,y,"font",rot,x-mul,y-mul,"data" -> x-mul=w_mag, y-mul=h_mag
            expect(tspl1).toMatch(/TEXT \d+,\d+,"1",0,1,1,"TEST"/);
            expect(tspl2).toMatch(/TEXT \d+,\d+,"1",0,1,3,"TEST"/);
            expect(tspl1).not.toBe(tspl2);
        });

        it('DPL: adjusts resident font and height multiplier', () => {
            const d1 = makeDesign(baseText({ font: '0', h_mag: 1 }));
            const d2 = makeDesign(baseText({ font: '0', h_mag: 3 }));

            const dpl1 = generateDPL(d1).dpl;
            const dpl2 = generateDPL(d2).dpl;

            expect(dpl1).not.toBe(dpl2);
        });
    });

    describe('Bitmap font w_mag emission across all 5 generators', () => {
        it('IPL: emits w command with field.w_mag value', async () => {
            const d1 = makeDesign(baseText({ font: '0', w_mag: 1 }));
            const d2 = makeDesign(baseText({ font: '0', w_mag: 4 }));

            const ipl1 = await generateIPL(d1);
            const ipl2 = await generateIPL(d2);

            expect(ipl1).toContain(';w1;');
            expect(ipl2).toContain(';w4;');
            expect(ipl1).not.toBe(ipl2);
        });

        it('ZPL: scales ^A0 width with w_mag', () => {
            const d1 = makeDesign(baseText({ font: '0', w_mag: 1 }));
            const d2 = makeDesign(baseText({ font: '0', w_mag: 4 }));

            const zpl1 = generateZPL(d1).zpl;
            const zpl2 = generateZPL(d2).zpl;

            // font '0' baseWidth is 7
            expect(zpl1).toContain(',7');
            expect(zpl2).toContain(',28');
            expect(zpl1).not.toBe(zpl2);
        });

        it('EPL: sets horizontal multiplier p5 in A command', () => {
            const d1 = makeDesign(baseText({ font: '0', w_mag: 1 }));
            const d2 = makeDesign(baseText({ font: '0', w_mag: 4 }));

            const epl1 = generateEPL(d1).epl;
            const epl2 = generateEPL(d2).epl;

            expect(epl1).toMatch(/A\d+,\d+,0,\d+,1,1,N,"TEST"/);
            expect(epl2).toMatch(/A\d+,\d+,0,\d+,4,1,N,"TEST"/);
            expect(epl1).not.toBe(epl2);
        });

        it('TSPL: sets x-multiplication parameter in TEXT command', () => {
            const d1 = makeDesign(baseText({ font: '0', w_mag: 1 }));
            const d2 = makeDesign(baseText({ font: '0', w_mag: 4 }));

            const tspl1 = generateTSPL(d1).tspl;
            const tspl2 = generateTSPL(d2).tspl;

            expect(tspl1).toMatch(/TEXT \d+,\d+,"1",0,1,1,"TEST"/);
            expect(tspl2).toMatch(/TEXT \d+,\d+,"1",0,4,1,"TEST"/);
            expect(tspl1).not.toBe(tspl2);
        });

        it('DPL: adjusts resident font and width multiplier', () => {
            const d1 = makeDesign(baseText({ font: '0', w_mag: 1 }));
            const d2 = makeDesign(baseText({ font: '0', w_mag: 4 }));

            const dpl1 = generateDPL(d1).dpl;
            const dpl2 = generateDPL(d2).dpl;

            expect(dpl1).not.toBe(dpl2);
        });
    });

    describe('Bitmap font fontSize is correctly ignored across all 5 generators', () => {
        it('changing fontSize does not affect bitmap font streams (cell mag governs)', async () => {
            const d1 = makeDesign(baseText({ font: '0', fontSize: 10 }));
            const d2 = makeDesign(baseText({ font: '0', fontSize: 36 }));

            const ipl1 = await generateIPL(d1);
            const ipl2 = await generateIPL(d2);
            expect(ipl1).toBe(ipl2);

            const zpl1 = generateZPL(d1);
            const zpl2 = generateZPL(d2);
            expect(zpl1.zpl).toBe(zpl2.zpl);

            const epl1 = generateEPL(d1);
            const epl2 = generateEPL(d2);
            expect(epl1.epl).toBe(epl2.epl);

            const tspl1 = generateTSPL(d1);
            const tspl2 = generateTSPL(d2);
            expect(tspl1.tspl).toBe(tspl2.tspl);

            const dpl1 = generateDPL(d1);
            const dpl2 = generateDPL(d2);
            expect(dpl1.dpl).toBe(dpl2.dpl);
        });
    });

    describe('Outline font fontSize emission', () => {
        it('IPL: emits k command with field.fontSize', async () => {
            const d1 = makeDesign(baseText({ font: '25', fontSize: 12 }));
            const d2 = makeDesign(baseText({ font: '25', fontSize: 24 }));

            const ipl1 = await generateIPL(d1);
            const ipl2 = await generateIPL(d2);

            expect(ipl1).toContain(';b0;k12;');
            expect(ipl2).toContain(';b0;k24;');
            expect(ipl1).not.toBe(ipl2);
        });

        it('ZPL: calculates ^A0 dot height and width from fontSize', () => {
            const d1 = makeDesign(baseText({ font: '25', fontSize: 12 }));
            const d2 = makeDesign(baseText({ font: '25', fontSize: 24 }));

            const zpl1 = generateZPL(d1).zpl;
            const zpl2 = generateZPL(d2).zpl;

            // dots = Math.round(12 * 25.4 / 72 * (203 / 25.4)) = Math.round(12 * 203 / 72) = 34
            expect(zpl1).toContain('^A0N,34,34');
            // dots = Math.round(24 * 203 / 72) = 68
            expect(zpl2).toContain('^A0N,68,68');
            expect(zpl1).not.toBe(zpl2);
        });

        it('DPL: emits scalable font 9 record with point size in A and P slots', () => {
            const d1 = makeDesign(baseText({ font: '25', fontSize: 12 }));
            const d2 = makeDesign(baseText({ font: '25', fontSize: 24 }));

            const dpl1 = generateDPL(d1).dpl;
            const dpl2 = generateDPL(d2).dpl;

            expect(dpl1).toMatch(/1911A12\d{8}P012P012TEST/);
            expect(dpl2).toMatch(/1911A24\d{8}P024P024TEST/);
            expect(dpl1).not.toBe(dpl2);
        });

        it('EPL: warns that outline font has no resident equivalent and falls back to font 1', () => {
            const d = makeDesign(baseText({ font: '25', fontSize: 24 }));
            const res = generateEPL(d);

            expect(res.warnings).toHaveLength(1);
            expect(res.warnings[0]).toContain('uses a font with no EPL equivalent. It prints with resident font 1, which is a different size and shape.');
            expect(res.epl).toMatch(/A\d+,\d+,0,1,1,1,N,"TEST"/);
        });

        it('TSPL: warns that outline font has no resident equivalent and falls back to font 2', () => {
            const d = makeDesign(baseText({ font: '25', fontSize: 24 }));
            const res = generateTSPL(d);

            expect(res.warnings).toHaveLength(1);
            expect(res.warnings[0]).toContain('uses a font with no TSPL equivalent. It prints with resident font 2, which is a different size and shape.');
            expect(res.tspl).toMatch(/TEXT \d+,\d+,"2",0,1,1,"TEST"/);
        });
    });

    describe('Outline font ignores h_mag and w_mag in IPL and ZPL', () => {
        it('IPL does not emit h or w parameters for outline fonts', async () => {
            const d1 = makeDesign(baseText({ font: '25', fontSize: 14, h_mag: 1, w_mag: 1 }));
            const d2 = makeDesign(baseText({ font: '25', fontSize: 14, h_mag: 4, w_mag: 4 }));

            const ipl1 = await generateIPL(d1);
            const ipl2 = await generateIPL(d2);

            expect(ipl1).toBe(ipl2);
            expect(ipl1).not.toContain(';h');
            expect(ipl1).not.toContain(';w');
        });

        it('ZPL does not use h_mag or w_mag for outline fonts', () => {
            const d1 = makeDesign(baseText({ font: '25', fontSize: 14, h_mag: 1, w_mag: 1 }));
            const d2 = makeDesign(baseText({ font: '25', fontSize: 14, h_mag: 4, w_mag: 4 }));

            const zpl1 = generateZPL(d1).zpl;
            const zpl2 = generateZPL(d2).zpl;

            expect(zpl1).toBe(zpl2);
        });
    });

    describe('Barcode h_mag and w_mag emission across all 5 generators', () => {
        it('IPL: emits h and w for 1D barcode', async () => {
            const d1 = makeDesign(baseBarcode({ h_mag: 50, w_mag: 2 }));
            const d2 = makeDesign(baseBarcode({ h_mag: 100, w_mag: 4 }));

            const ipl1 = await generateIPL(d1);
            const ipl2 = await generateIPL(d2);

            expect(ipl1).toContain(';h50;w2;');
            expect(ipl2).toContain(';h100;w4;');
            expect(ipl1).not.toBe(ipl2);
        });

        it('ZPL: emits ^BY with w_mag and barcode command with h_mag', () => {
            const d1 = makeDesign(baseBarcode({ h_mag: 50, w_mag: 2 }));
            const d2 = makeDesign(baseBarcode({ h_mag: 100, w_mag: 4 }));

            const zpl1 = generateZPL(d1).zpl;
            const zpl2 = generateZPL(d2).zpl;

            expect(zpl1).toContain('^BY2');
            expect(zpl1).toContain('^B3N,N,50,');
            expect(zpl2).toContain('^BY4');
            expect(zpl2).toContain('^B3N,N,100,');
            expect(zpl1).not.toBe(zpl2);
        });

        it('EPL: emits wide (w_mag) and heightDots (h_mag) in B command', () => {
            const d1 = makeDesign(baseBarcode({ h_mag: 50, w_mag: 2 }));
            const d2 = makeDesign(baseBarcode({ h_mag: 100, w_mag: 4 }));

            const epl1 = generateEPL(d1).epl;
            const epl2 = generateEPL(d2).epl;

            // B p1,p2,p3,p4,p5,p6,p7,p8,"data" -> p5=wide(w_mag), p7=height(h_mag)
            expect(epl1).toMatch(/B\d+,\d+,0,3,2,3,50,N,"12345"/);
            expect(epl2).toMatch(/B\d+,\d+,0,3,4,5,100,N,"12345"/);
            expect(epl1).not.toBe(epl2);
        });

        it('TSPL: emits heightDots (h_mag) and narrow (w_mag) in BARCODE command', () => {
            const d1 = makeDesign(baseBarcode({ h_mag: 50, w_mag: 2 }));
            const d2 = makeDesign(baseBarcode({ h_mag: 100, w_mag: 4 }));

            const tspl1 = generateTSPL(d1).tspl;
            const tspl2 = generateTSPL(d2).tspl;

            // BARCODE x,y,"type",height,hri,rot,narrow,wide,"data"
            expect(tspl1).toMatch(/BARCODE \d+,\d+,"39",50,0,0,2,3,"12345"/);
            expect(tspl2).toMatch(/BARCODE \d+,\d+,"39",100,0,0,4,5,"12345"/);
            expect(tspl1).not.toBe(tspl2);
        });

        it('DPL: emits narrow multiplier (w_mag) and height units (h_mag) in bar code record', () => {
            const d1 = makeDesign(baseBarcode({ h_mag: 50, w_mag: 2 }));
            const d2 = makeDesign(baseBarcode({ h_mag: 100, w_mag: 4 }));

            const dpl1 = generateDPL(d1).dpl;
            const dpl2 = generateDPL(d2).dpl;

            // dplMultiplier(2) = '2', heightUnits for 50 dots at 203 dpi = Math.round(50 / 203 * 100) = 25
            expect(dpl1).toMatch(/1a22025\d{8}12345/);
            // dplMultiplier(4) = '4', heightUnits for 100 dots at 203 dpi = Math.round(100 / 203 * 100) = 49
            expect(dpl2).toMatch(/1a44049\d{8}12345/);
            expect(dpl1).not.toBe(dpl2);
        });
    });

    describe('Geometry bounding box honors font sizing rules', () => {
        const dummyDesign: Design = {
            name: 'Dummy',
            labelSettings: { width: 100, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
            printerSettings: { model: 'PD43', dpi: 203, mediaSenseMode: 'gap', mediaType: 'direct-thermal', printSpeed: 2, darkness: 0, quantity: 1 },
            fields: [],
            dataSources: [],
            nextId: 1,
            guides: { horizontal: [], vertical: [] },
        };

        it('bitmap text bounding box scales with h_mag and w_mag, independent of fontSize', () => {
            const b1 = getObjectBoundingBox(baseText({ font: '0', h_mag: 1, w_mag: 1, fontSize: 10 }), dummyDesign);
            const b2 = getObjectBoundingBox(baseText({ font: '0', h_mag: 2, w_mag: 3, fontSize: 10 }), dummyDesign);
            const b3 = getObjectBoundingBox(baseText({ font: '0', h_mag: 1, w_mag: 1, fontSize: 40 }), dummyDesign);

            expect(b2.height).toBeCloseTo(b1.height * 2, 1);
            expect(b2.width).toBeGreaterThan(b1.width * 2);
            // fontSize does not change bounding box for bitmap fonts
            expect(b3.height).toBe(b1.height);
            expect(b3.width).toBe(b1.width);
        });

        it('outline text bounding box scales with fontSize, independent of h_mag and w_mag', () => {
            const b1 = getObjectBoundingBox(baseText({ font: '25', fontSize: 12, h_mag: 1, w_mag: 1 }), dummyDesign);
            const b2 = getObjectBoundingBox(baseText({ font: '25', fontSize: 24, h_mag: 1, w_mag: 1 }), dummyDesign);
            const b3 = getObjectBoundingBox(baseText({ font: '25', fontSize: 12, h_mag: 4, w_mag: 4 }), dummyDesign);

            expect(b2.height).toBeGreaterThan(b1.height * 1.5);
            // h_mag and w_mag do not change bounding box for outline fonts
            expect(b3.height).toBe(b1.height);
            expect(b3.width).toBe(b1.width);
        });

        it('barcode bounding box scales with h_mag and w_mag', () => {
            const b1 = getObjectBoundingBox(baseBarcode({ h_mag: 50, w_mag: 2 }), dummyDesign);
            const b2 = getObjectBoundingBox(baseBarcode({ h_mag: 100, w_mag: 4 }), dummyDesign);

            expect(b2.height).toBeCloseTo(b1.height * 2, 1);
            expect(b2.width).toBeCloseTo(b1.width * 2, 1);
        });
    });
});
