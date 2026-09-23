// Batch C (2026-09-21): symbology modifier round-trip through the DESIGNER
// model. Batches A/B made the VIEWER encode c8/c14/c16/c18/c19/c20 with their
// PRM modifiers, but parseIPL dropped them and generateIPL re-emitted bare
// `c18` — importing a QR-with-EC-Q label into the designer silently changed
// what would print. These tests pin the Design model fields (types.ts),
// the IPL->Design parser (iplParser.ts) and the Design->IPL generator
// (iplGenerator.ts), plus minimal positional emission per PRM c-syntax.
import { describe, it, expect } from 'vitest';
import { generateIPL } from '../services/iplGenerator';
import { parseIPL } from '../services/iplParser';
import type { Design, BarcodeField } from '../types';

const DPI = 203 as const;

const designOf = (fields: BarcodeField[]): Design => ({
    name: 'T',
    labelSettings: { width: 80, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: DPI, quantity: 1, mediaType: 'thermal-transfer', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields,
    dataSources: [],
    nextId: 2,
    guides: { horizontal: [], vertical: [] },
});

const bc = (extra: Partial<BarcodeField>): BarcodeField => ({
    id: 1, type: 'barcode', name: 'B', x: 5, y: 5, rotation: 0,
    dataSource: { type: 'fixed', data: 'X' }, symbology: '18', humanReadable: 'none',
    h_mag: 50, w_mag: 2, ...extra,
});

/** Extract the c-parameter the generator emitted for field 1. */
const cParamOf = (ipl: string): string => {
    const m = /<STX>B1;[^<]*?;c([^;<]+)(?:;|<)/.exec(ipl);
    return m ? m[1] : '';
};

describe('parseIPL captures symbology modifiers into the Design model', () => {
    const parseBc = (cParam: string, data = 'X'): BarcodeField => {
        const ipl = [
            '<STX><ESC>C<SI>W812<ETX>', '<STX><ESC>P<ETX>', '<STX>E1;F1<ETX>',
            `<STX>B1;o40,40;c${cParam};h50;w2;d3,${data}<ETX>`, '<STX>R<ETX>',
        ].join('\n');
        return parseIPL(ipl, DPI).fields[0] as BarcodeField;
    };

    it('c18,2,Q,3 → qrModel/qrEcl/qrMask', () => {
        const f = parseBc('18,2,Q,3');
        expect(f.qrModel).toBe(2);
        expect(f.qrEcl).toBe('Q');
        expect(f.qrMask).toBe(3);
    });

    it('c18 lowercase ecl is normalized; out-of-domain parts ignored', () => {
        const f = parseBc('18,1,h,9');
        expect(f.qrModel).toBe(1);
        expect(f.qrEcl).toBe('H');
        expect(f.qrMask).toBeUndefined(); // 9 is outside 0-8
    });

    it('c19,2,8 → microColumns/microRows', () => {
        const f = parseBc('19,2,8', '12345678');
        expect(f.microColumns).toBe(2);
        expect(f.microRows).toBe(8);
    });

    it('c20,6,1,4 → rssVersion/rssSepHeight/rssSegments', () => {
        const f = parseBc('20,6,1,4');
        expect(f.rssVersion).toBe(6);
        expect(f.rssSepHeight).toBe(1);
        expect(f.rssSegments).toBe(4);
    });

    it('c14,2 → maxiMode; c8,1 → hibcMode; c16 → hibcMode undefined', () => {
        expect(parseBc('14,2', 'HELLO').maxiMode).toBe(2);
        expect(parseBc('8,1', '+A1234$B567').hibcMode).toBe(1);
        expect(parseBc('16', '+A1234$B567').hibcMode).toBeUndefined();
    });

    it('bare c18 keeps all params undefined (defaults live in the encoder)', () => {
        const f = parseBc('18');
        expect(f.qrModel).toBeUndefined();
        expect(f.qrEcl).toBeUndefined();
        expect(f.qrMask).toBeUndefined();
    });
});

describe('generateIPL emits modifiers positionally (PRM c-syntax)', () => {
    it('emits only what is set, filling positional gaps with defaults', async () => {
        // ecl alone still needs the model slot: c18,2,Q
        expect(cParamOf(await generateIPL(designOf([bc({ qrEcl: 'H' })])))).toBe('18,2,H');
        // mask alone → model + ecl defaults
        expect(cParamOf(await generateIPL(designOf([bc({ qrMask: 8 })])))).toBe('18,2,M,8');
        // all three
        expect(cParamOf(await generateIPL(designOf([bc({ qrModel: 1, qrEcl: 'Q', qrMask: 2 })])))).toBe('18,1,Q,2');
        // nothing set → bare id (no churn for old designs)
        expect(cParamOf(await generateIPL(designOf([bc({})])))).toBe('18');
    });

    it('c19 rows imply the columns slot; c20 segments imply version + sepheight', async () => {
        expect(cParamOf(await generateIPL(designOf([bc({ symbology: '19', microRows: 8 })])))).toBe('19,0,8');
        expect(cParamOf(await generateIPL(designOf([bc({ symbology: '19', microColumns: 2, microRows: 8 })])))).toBe('19,2,8');
        expect(cParamOf(await generateIPL(designOf([bc({ symbology: '20', rssSegments: 4 })])))).toBe('20,2,1,4');
        expect(cParamOf(await generateIPL(designOf([bc({ symbology: '20', rssVersion: 5 })])))).toBe('20,5');
    });

    it('c14 mode and c8/c16 hibc mode ride along', async () => {
        expect(cParamOf(await generateIPL(designOf([bc({ symbology: '14', maxiMode: 4 })])))).toBe('14,4');
        expect(cParamOf(await generateIPL(designOf([bc({ symbology: '8', hibcMode: 3 })])))).toBe('8,3');
    });
});

describe('full designer round trip preserves symbology semantics', () => {
    const rt = async (field: BarcodeField): Promise<BarcodeField> => {
        const ipl = await generateIPL(designOf([field]));
        return parseIPL(ipl, DPI).fields[0] as BarcodeField;
    };

    it('QR model+ecl+mask survives generate -> parse', async () => {
        const back = await rt(bc({ qrModel: 2, qrEcl: 'Q', qrMask: 3 }));
        expect(back.qrModel).toBe(2);
        expect(back.qrEcl).toBe('Q');
        expect(back.qrMask).toBe(3);
    });

    it('MicroPDF417 columns+rows survive', async () => {
        const back = await rt(bc({ symbology: '19', dataSource: { type: 'fixed', data: '12345678' }, microColumns: 2, microRows: 8 }));
        expect(back.microColumns).toBe(2);
        expect(back.microRows).toBe(8);
    });

    it('RSS version+segments survive; defaults normalize (undefined model stays undefined)', async () => {
        const back = await rt(bc({ symbology: '20', dataSource: { type: 'fixed', data: '1234567890123' }, rssVersion: 6, rssSegments: 4 }));
        expect(back.rssVersion).toBe(6);
        expect(back.rssSegments).toBe(4);
        expect(back.rssSepHeight).toBe(1); // positionally implied default
    });

    it('MaxiCode mode survives and h/w stay omitted (fixed-size)', async () => {
        const ipl = await generateIPL(designOf([bc({ symbology: '14', dataSource: { type: 'fixed', data: 'HELLO' }, maxiMode: 5 })]));
        const bFrame = ipl.split('\n').find(l => l.includes('c14'))!;
        expect(bFrame).toContain('c14,5');
        expect(bFrame).not.toMatch(/;[hw]\d/);
        const back = parseIPL(ipl, DPI).fields[0] as BarcodeField;
        expect(back.maxiMode).toBe(5);
    });

    it('HIBC mode survives on both c8 and c16', async () => {
        const b8 = await rt(bc({ symbology: '8', dataSource: { type: 'fixed', data: '+A1234$B567' }, hibcMode: 2 }));
        expect(b8.hibcMode).toBe(2);
        const b16 = await rt(bc({ symbology: '16', dataSource: { type: 'fixed', data: '+A1234/9011141234567' }, hibcMode: 4 }));
        expect(b16.hibcMode).toBe(4);
    });

    it('POSTNET w is clamped to the PRM 1-10 magnification band too', async () => {
        // A designer field carrying w_mag 20 (from a linear-barcode preset)
        // must not regenerate as c11;...;w20 — the viewer would warn.
        const ipl = await generateIPL(designOf([bc({ symbology: '11', h_mag: 26, w_mag: 20, dataSource: { type: 'fixed', data: '12345' } })]));
        const frame = ipl.split('\n').find(l => l.includes('c11'))!;
        expect(frame).toMatch(/;w10;/);
        expect(frame).not.toMatch(/w20/);
    });

    it('old designs without params are untouched (byte-stable c command)', async () => {
        const ipl = await generateIPL(designOf([bc({ symbology: '6', dataSource: { type: 'fixed', data: 'AB12' } })]));
        expect(cParamOf(ipl)).toBe('6,0,0,0'); // existing subset behavior, unchanged
    });
});
