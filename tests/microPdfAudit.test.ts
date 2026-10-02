import { describe, it, expect } from 'vitest';
import { generateIPL } from '../services/iplGenerator';
import { generateZPL } from '../services/zpl/zplGenerator';
import { generateEPL } from '../services/epl/eplGenerator';
import { generateTSPL } from '../services/tspl/tsplGenerator';
import { generateDPL } from '../services/dpl/dplGenerator';
import { parseIPL } from '../services/iplParser';
import { parseTSPL } from '../services/tspl/tsplParser';
import { parseDPL } from '../services/dpl/dplParser';
import type { Design, BarcodeField } from '../types';
import type { BarcodeElement } from '../services/ipl/types';

const baseBarcode = (overrides: Partial<BarcodeField> = {}): BarcodeField => ({
    id: 1,
    name: 'BC1',
    type: 'barcode',
    x: 10,
    y: 10,
    symbology: '19',
    h_mag: 40,
    w_mag: 2,
    rotation: 0,
    humanReadable: 'none',
    dataSource: { type: 'fixed', data: 'PDF417' },
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

const PAGE = 406;

describe('Audit microColumns and microRows (c19, m1/m2) across all 5 generators', () => {
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

    describe('IPL microColumns and microRows audit', () => {
        it('emits c19 with no arguments when microColumns and microRows are default/unset', async () => {
            const d = makeDesign(baseBarcode({ symbology: '19', microColumns: undefined, microRows: undefined }));
            const ipl = await generateIPL(d);
            expect(ipl).toMatch(/c19/);
            expect(ipl).not.toMatch(/c19,/);
        });

        it('emits c19,m1,m2 and changes output when columns or rows change', async () => {
            const d1 = makeDesign(baseBarcode({ symbology: '19', microColumns: 1, microRows: 24 }));
            const d2 = makeDesign(baseBarcode({ symbology: '19', microColumns: 2, microRows: 14 }));

            const ipl1 = await generateIPL(d1);
            const ipl2 = await generateIPL(d2);
            expect(ipl1).toContain('c19,1,24');
            expect(ipl2).toContain('c19,2,14');
            expect(ipl1).not.toBe(ipl2);
        });

        it('round-trips microColumns and microRows through parseIPL', async () => {
            const d = makeDesign(baseBarcode({ symbology: '19', microColumns: 1, microRows: 24 }));
            const ipl = await generateIPL(d);
            const parsed = parseIPL(ipl, 203);
            const field = parsed.fields.find(f => f.type === 'barcode') as BarcodeField;
            expect(field).toBeDefined();
            expect(field.symbology).toBe('19');
            expect(field.microColumns).toBe(1);
            expect(field.microRows).toBe(24);
        });
    });

    describe('TSPL microColumns and microRows audit', () => {
        it('emits Cn for microColumns in TSPL MPDF417 command and changes output', () => {
            const d1 = makeDesign(baseBarcode({ symbology: '19', microColumns: 1 }));
            const d2 = makeDesign(baseBarcode({ symbology: '19', microColumns: 2 }));

            const tspl1 = generateTSPL(d1);
            const tspl2 = generateTSPL(d2);
            expect(tspl1.tspl).toMatch(/MPDF417 .*,C1,/);
            expect(tspl2.tspl).toMatch(/MPDF417 .*,C2,/);
            expect(tspl1.tspl).not.toBe(tspl2.tspl);
        });

        it('round-trips microColumns through parseTSPL', () => {
            const d = makeDesign(baseBarcode({ symbology: '19', microColumns: 3 }));
            const tspl = generateTSPL(d);
            const parsed = parseTSPL(tspl.tspl);
            const el = parsed.elements.find(e => e.kind === 'barcode') as BarcodeElement;
            expect(el).toBeDefined();
            expect(el.symbology).toBe('19');
            expect(el.microColumns).toBe('3');
        });

        it('warns when microRows is set (> 0) because TSPL computes rows automatically', () => {
            const d = makeDesign(baseBarcode({ symbology: '19', microColumns: 1, microRows: 24 }));
            const res = generateTSPL(d);
            expect(res.warnings.join(' ')).toMatch(/TSPL calculates MicroPDF417 data rows automatically/);
            expect(res.warnings.join(' ')).toContain('24');
        });

        it('does NOT warn about microRows when microRows is 0 or unset', () => {
            const d0 = makeDesign(baseBarcode({ symbology: '19', microColumns: 1, microRows: 0 }));
            const dUndef = makeDesign(baseBarcode({ symbology: '19', microColumns: 1, microRows: undefined }));
            expect(generateTSPL(d0).warnings.join(' ')).not.toMatch(/MicroPDF417 data rows/);
            expect(generateTSPL(dUndef).warnings.join(' ')).not.toMatch(/MicroPDF417 data rows/);
        });
    });

    describe('DPL microColumns and microRows audit', () => {
        it('emits h i j k 0 prefix in W1z record (Table G-6)', () => {
            const d = makeDesign(baseBarcode({ symbology: '19', microColumns: 1, microRows: 24, dataSource: { type: 'fixed', data: 'PDF417' } }));
            const res = generateDPL(d);
            const line = res.dpl.split('\r').find(l => l.includes('W1z'))!;
            expect(line).toBeDefined();
            // Table G-6: ... c d eee ffff gggg h i j k 0 data
            // For cols=1, rows=24, Table G-7 gives hi=14. With j=0, k=0, 0=0: prefix is 14000
            expect(line).toContain('000'); // eee is 000 (No effect)
            expect(line).toMatch(/W1z\d\d000\d{4}\d{4}14000PDF417/);
        });

        it('changes output when microColumns and microRows change', () => {
            const d1 = makeDesign(baseBarcode({ symbology: '19', microColumns: 1, microRows: 24 }));
            const d2 = makeDesign(baseBarcode({ symbology: '19', microColumns: 2, microRows: 14 }));

            const dpl1 = generateDPL(d1);
            const dpl2 = generateDPL(d2);
            expect(dpl1.dpl).toContain('14000');
            expect(dpl2.dpl).toContain('22000');
            expect(dpl1.dpl).not.toBe(dpl2.dpl);
        });

        it('auto-sizes (h, i) when microColumns and microRows are unset', () => {
            const d = makeDesign(baseBarcode({ symbology: '19', microColumns: undefined, microRows: undefined, dataSource: { type: 'fixed', data: 'HELLO' } }));
            const res = generateDPL(d);
            const line = res.dpl.split('\r').find(l => l.includes('W1z'))!;
            expect(line).toMatch(/W1z\d\d000\d{4}\d{4}[1-4][0-9A]000HELLO/);
        });

        it('parseDPL extracts microColumns, microRows, and clean data from W1z', () => {
            // Manual example: 1W1z000000015010014000PDF417
            // cols=1, rows=24 (hi=14), data="PDF417"
            const dplStream = '\x02L\rD11\r1W1z000000015010014000PDF417\rQ0001\rE\r';
            const parsed = parseDPL(dplStream, PAGE);
            const el = parsed.elements.find(e => e.kind === 'barcode') as BarcodeElement;
            expect(el).toBeDefined();
            expect(el.symbology).toBe('19');
            expect(el.microColumns).toBe('1');
            expect(el.microRows).toBe('24');
            expect(el.source).toEqual({ type: 'fixed', data: 'PDF417' });
        });

        it('round-trips microColumns and microRows through generateDPL and parseDPL', () => {
            const d = makeDesign(baseBarcode({
                symbology: '19',
                microColumns: 1,
                microRows: 24,
                dataSource: { type: 'fixed', data: 'MYDATA' },
            }));
            const { dpl } = generateDPL(d);
            const parsed = parseDPL(dpl, PAGE);
            const el = parsed.elements.find(e => e.kind === 'barcode') as BarcodeElement;
            expect(el).toBeDefined();
            expect(el.symbology).toBe('19');
            expect(el.microColumns).toBe('1');
            expect(el.microRows).toBe('24');
            expect(el.source).toEqual({ type: 'fixed', data: 'MYDATA' });
        });
    });

    describe('ZPL and EPL microColumns/microRows audit (unsupported symbology)', () => {
        it('ZPL warns that symbology 19 is not supported and does not draw it', () => {
            const d = makeDesign(baseBarcode({ symbology: '19', microColumns: 1, microRows: 24 }));
            const zpl = generateZPL(d);
            expect(zpl.warnings.join(' ')).toMatch(/barcode type 19, which this ZPL subset cannot draw/);
            expect(zpl.zpl).not.toContain('^B');
        });

        it('EPL warns that symbology 19 is not supported and does not draw it', () => {
            const d = makeDesign(baseBarcode({ symbology: '19', microColumns: 1, microRows: 24 }));
            const epl = generateEPL(d);
            expect(epl.warnings.join(' ')).toMatch(/barcode type 19, which this EPL subset cannot draw/);
            expect(epl.epl).not.toMatch(/^[bB]/m);
        });
    });
});
