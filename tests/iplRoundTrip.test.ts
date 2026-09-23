import { describe, it, expect } from 'vitest';
import { generateIPL } from '../services/iplGenerator';
import { parseIPL } from '../services/iplParser';
import type { Design, Field, TextField, BarcodeField } from '../types';

const DPI = 203 as const;
const DOT_MM = 1 / 8; // 203 dpi -> 8 dots/mm
const r3 = (v: number) => Math.round(v * 1000) / 1000;

const basePrinter = {
    model: 'PD43',
    dpi: DPI,
    quantity: 1,
    mediaType: 'thermal-transfer' as const,
    mediaSenseMode: 'gap' as const,
    printSpeed: 6,
    darkness: 10,
};

const makeDesign = (fields: Field[], overrides: Partial<Design['printerSettings']> = {}): Design => ({
    name: 'Test Label',
    labelSettings: { width: 80, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { ...basePrinter, ...overrides },
    fields,
    dataSources: [],
    nextId: Math.max(0, ...fields.map(f => f.id)) + 1,
    guides: { horizontal: [], vertical: [] },
});

const text = (id: number, x: number, y: number, data: string, extra: Partial<TextField> = {}): TextField => ({
    id, type: 'text', name: `Text ${id}`, x, y, rotation: 0,
    dataSource: { type: 'fixed', data }, font: '25', fontSize: 12, h_mag: 1, w_mag: 1, ...extra,
});

const barcode = (id: number, x: number, y: number, data: string, extra: Partial<BarcodeField> = {}): BarcodeField => ({
    id, type: 'barcode', name: `Barcode ${id}`, x, y, rotation: 0,
    dataSource: { type: 'fixed', data }, symbology: '6', humanReadable: 'none',
    h_mag: 80, w_mag: 2, ...extra,
});

/** Projection of the properties that must survive a generate -> parse round trip. */
const normalizeField = (f: Field): Record<string, unknown> => {
    const base: Record<string, unknown> = {
        id: f.id,
        type: f.type,
        rotation: f.rotation,
        visible: f.visible !== false,
    };
    switch (f.type) {
        case 'text': {
            base.font = f.font;
            base.fontSize = f.fontSize;
            base.h_mag = f.h_mag;
            base.w_mag = f.w_mag;
            break;
        }
        case 'barcode': {
            base.symbology = f.symbology.split(',')[0];
            base.humanReadable = f.humanReadable;
            // Generator emits the I-command with these defaults when HRI is on but font unset
            base.hriFont = !f.hriFont || (f.hriFont === '21' && (f.hriFontSize ?? 10) === 10) ? null : f.hriFont;
            base.code39_checkDigit = !f.code39_checkDigit || f.code39_checkDigit === 'none' ? null : f.code39_checkDigit;
            base.code128_subset = !f.code128_subset || f.code128_subset === 'auto' ? null : f.code128_subset;
            break;
        }
        case 'line':
            base.length = r3(f.length);
            base.thickness = r3(f.thickness);
            break;
        case 'box':
            base.width = r3(f.width);
            base.height = r3(f.height);
            base.thickness = r3(f.thickness);
            break;
    }
    return base;
};

describe('IPL generator -> parser round trip', () => {

    it('parses its own generated output (regression: <STX>D0<ETX> no longer required)', async () => {
        const design = makeDesign([
            text(1, 5, 5, 'HELLO'),
            barcode(2, 5, 20, '123456', { dataSource: { type: 'variable', defaultData: '123456' } }),
        ]);
        const ipl = await generateIPL(design);
        expect(ipl).not.toContain('<STX>D0<ETX>');

        const parsed = parseIPL(ipl, DPI);
        expect(parsed.fields).toHaveLength(2);
        expect(parsed.fields.map(f => f.type)).toEqual(['text', 'barcode']);
    });

    it('round-trips field geometry, fonts and static data at rotation 0', async () => {
        const design = makeDesign([
            text(1, 5.25, 4, 'Cat.'),
            { ...text(2, 30, 10, 'ABC'), font: '0', h_mag: 2, w_mag: 2 },
            barcode(3, 5, 15, 'HELLO39', { symbology: '0' }),
            barcode(4, 5, 35, '12345678'),
            { ...barcode(5, 40, 15, ''), humanReadable: 'above', hriFont: '22', hriFontSize: 14 },
            { id: 6, type: 'line', name: 'Line 6', x: 2, y: 45, rotation: 0, length: 70.125, thickness: 0.375 },
            { id: 7, type: 'box', name: 'Box 7', x: 55, y: 4, rotation: 0, width: 20.25, height: 12.5, thickness: 0.25 },
        ]);

        const parsed = parseIPL(await generateIPL(design), DPI);

        expect(parsed.fields).toHaveLength(7);
        const tol = DOT_MM * 1.01; // one-dot rounding granularity
        for (const original of design.fields) {
            const roundTripped = parsed.fields.find(f => f.id === original.id)!;
            expect(roundTripped).toBeDefined();
            expect(roundTripped.type).toBe(original.type);
            expect(roundTripped.rotation).toBe(0);
            // Origin compensation is exact for unrotated fields
            expect(Math.abs(roundTripped.x - original.x)).toBeLessThanOrEqual(tol);
            expect(Math.abs(roundTripped.y - original.y)).toBeLessThanOrEqual(tol);

            expect(normalizeField(roundTripped), `field ${original.id} mismatch`)
                .toEqual(normalizeField(original));
        }

        // Data sources survive
        const t1 = parsed.fields[0] as TextField;
        expect(t1.dataSource).toEqual({ type: 'fixed', data: 'Cat.' });
        const b3 = parsed.fields[2] as BarcodeField;
        expect(b3.symbology).toBe('0');
        expect(b3.dataSource).toEqual({ type: 'fixed', data: 'HELLO39' });
    });

    it('restores variable-field data from the print block', async () => {
        const design = makeDesign([
            text(1, 5, 5, 'x', { dataSource: { type: 'variable', defaultData: 'ORDER-1001' } }),
            barcode(2, 5, 20, '', { dataSource: { type: 'variable', defaultData: '99887766' } }),
        ]);
        const parsed = parseIPL(await generateIPL(design), DPI);

        const t1 = parsed.fields.find(f => f.id === 1) as TextField;
        const b2 = parsed.fields.find(f => f.id === 2) as BarcodeField;
        expect(t1.dataSource).toMatchObject({ type: 'variable', defaultData: 'ORDER-1001' });
        expect(b2.dataSource).toMatchObject({ type: 'variable', defaultData: '99887766' });
    });

    it('round-trips date and time data sources', async () => {
        const design = makeDesign([
            text(1, 5, 5, '', { dataSource: { type: 'date', format: 'DD/MM/YYYY' } }),
            text(2, 5, 15, '', { dataSource: { type: 'time', format: 'HH:MM am/pm' } }),
        ]);
        const parsed = parseIPL(await generateIPL(design), DPI);

        expect((parsed.fields[0] as TextField).dataSource).toEqual({ type: 'date', format: 'DD/MM/YYYY' });
        expect((parsed.fields[1] as TextField).dataSource).toEqual({ type: 'time', format: 'HH:MM am/pm' });
    });

    it('round-trips code128 subset, code39 check digit and multi-line text', async () => {
        const design = makeDesign([
            barcode(1, 5, 5, '', { code128_subset: 'b' }),
            barcode(2, 5, 40, '', { symbology: '0', code39_checkDigit: 'printer-generated' }),
            text(3, 5, 30, 'LINE ONE\nLINE TWO'),
        ]);
        const parsed = parseIPL(await generateIPL(design), DPI);

        const b1 = parsed.fields[0] as BarcodeField;
        expect(b1.code128_subset).toBe('b');
        const b2 = parsed.fields[1] as BarcodeField;
        expect(b2.code39_checkDigit).toBe('printer-generated');
        const t3 = parsed.fields[2] as TextField;
        expect(t3.dataSource).toEqual({ type: 'fixed', data: 'LINE ONE\nLINE TWO' });
    });

    it('round-trips printer settings and label dimensions', async () => {
        const design = makeDesign(
            [text(1, 5, 5, 'A')],
            { quantity: 5, printSpeed: 5, darkness: 12, mediaType: 'direct-thermal', mediaSenseMode: 'continuous' },
        );
        const parsed = parseIPL(await generateIPL(design), DPI);

        expect(parsed.printerSettings.quantity).toBe(5);
        expect(parsed.printerSettings.printSpeed).toBe(5);
        expect(parsed.printerSettings.darkness).toBe(12);
        expect(parsed.printerSettings.mediaType).toBe('direct-thermal');
        expect(parsed.printerSettings.mediaSenseMode).toBe('continuous');

        const tol = DOT_MM * 1.01;
        expect(Math.abs(parsed.labelSettings.width - 80)).toBeLessThanOrEqual(tol);
        expect(Math.abs(parsed.labelSettings.height - 50)).toBeLessThanOrEqual(tol);
    });

    it('keeps rotated fields present with correct type and rotation', async () => {
        const design = makeDesign([
            { ...text(1, 10, 10, 'ROT'), rotation: 90 as 90 },
            { ...barcode(2, 10, 30, '123'), rotation: 270 as 270 },
        ]);
        const parsed = parseIPL(await generateIPL(design), DPI);

        expect(parsed.fields).toHaveLength(2);
        expect(parsed.fields.find(f => f.id === 1)!.rotation).toBe(90);
        expect(parsed.fields.find(f => f.id === 2)!.rotation).toBe(270);
    });
});

describe('parseIPL robustness', () => {
    it('accepts third-party IPL without a print block or D terminator', () => {
        const external = [
            '<STX><ESC>C<SI>W791<SI>h<ETX>',
            '<STX><ESC>P<ETX>',
            '<STX>E5;F5;<ETX>',
            '<STX>H0;o35,40;c25;k12;d3,Cat.;<ETX>',
            '<STX>B1;o35,120;c6,0,0,1;h80;w2;i1;d0,255<ETX>',
            '<STX>R<ETX>',
        ].join('\n');
        const parsed = parseIPL(external, DPI);

        expect(parsed.fields).toHaveLength(2);
        expect(parsed.fields[0]).toMatchObject({ type: 'text', font: '25', fontSize: 12 });
        expect((parsed.fields[0] as TextField).dataSource).toEqual({ type: 'fixed', data: 'Cat.' });
        const b = parsed.fields[1] as BarcodeField;
        expect(b).toMatchObject({ type: 'barcode', symbology: '6', code128_subset: 'a', humanReadable: 'below' });
        expect(b.dataSource.type).toBe('variable');
    });

    it('returns an empty design gracefully on garbage input', () => {
        const parsed = parseIPL('this is not IPL at all <<<>>>', DPI);
        expect(parsed.fields).toHaveLength(0);
    });

    it('returns an empty design on empty input', () => {
        expect(parseIPL('', DPI).fields).toHaveLength(0);
    });
});
