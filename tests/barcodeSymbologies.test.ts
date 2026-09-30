// Batch A (2026-09-21): full IPL c-symbology coverage. Maps and deep-validates
// the symbology ids that previously rendered as placeholders — QR Code (c18),
// HIBC Code 39 (c8), HIBC Code 128 (c16), MicroPDF417 (c19), Code 16K (c9),
// Code 49 (c10), POSTNET (c11) and Planet (c22) — all backed by bwip-js.
import { describe, it, expect, beforeAll } from 'vitest';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { ensureBarcodesReady, buildBwipSpec, measureBarcode, resolveBcid, type BarcodeParams } from '../services/ipl/barcodes';
import type { BarcodeElement } from '../services/ipl/types';

beforeAll(async () => { await ensureBarcodesReady(); });

const bar = (fieldFrames: string[]) => {
    const label = parseViewerIPL([
        '<STX><ESC>C<SI>W800<ETX>',
        '<STX><ESC>P<ETX>',
        '<STX>E1;F1<ETX>',
        ...fieldFrames.map(f => `<STX>${f}<ETX>`),
        '<STX>R<ETX>',
    ].join('\n'));
    return { label, el: label.elements.filter(e => e.kind === 'barcode')[0] as BarcodeElement };
};

describe('buildBwipSpec — new symbology mappings', () => {
    it('c18 QR code, printer defaults (model 2, EC level M, auto mask)', () => {
        const spec = buildBwipSpec('18', 'HELLO WORLD', {})!;
        expect(spec.main.bcid).toBe('qrcode');
        expect(spec.main.text).toBe('HELLO WORLD');
        expect(spec.main.opts.eclevel ?? 'M').toBe('M');
    });

    it('c18,m2 selects the error-correction level (H shifts the symbol size)', () => {
        const small = buildBwipSpec('18', 'HELLO WORLD', { qrEcl: 'L' })!;
        const large = buildBwipSpec('18', 'HELLO WORLD', { qrEcl: 'H' })!;
        expect(small.main.opts.eclevel).toBe('L');
        expect(large.main.opts.eclevel).toBe('H');
    });

    it('c18,m3 translates the printer mask 0-7 to bwip 1-based, 8/auto to none', () => {
        expect(buildBwipSpec('18', 'HI', { qrMask: '0' })!.main.opts.mask).toBe(1);
        expect(buildBwipSpec('18', 'HI', { qrMask: '7' })!.main.opts.mask).toBe(8);
        expect(buildBwipSpec('18', 'HI', { qrMask: '8' })!.main.opts.mask).toBeUndefined();
        expect(buildBwipSpec('18', 'HI', {})!.main.opts.mask).toBeUndefined();
    });

    it('c19 MicroPDF417 passes columns/rows through; 0 means auto', () => {
        const spec = buildBwipSpec('19', '12345678', { microColumns: '2', microRows: '8' })!;
        expect(spec.main.bcid).toBe('micropdf417');
        expect(spec.main.opts.columns).toBe(2);
        expect(spec.main.opts.rows).toBe(8);
        const auto = buildBwipSpec('19', '1234', { microColumns: '0', microRows: '0' })!;
        expect(auto.main.opts.columns).toBeUndefined();
        expect(auto.main.opts.rows).toBeUndefined();
    });

    it('c8 / c16 map to the HIBC encoders', () => {
        expect(resolveBcid('8', '+A1234$B567')).toBe('hibccode39');
        expect(resolveBcid('16', '+A1234/9011141234567')).toBe('hibccode128');
    });

    it('c9 Code 16K and c10 Code 49 map to their encoders', () => {
        expect(resolveBcid('9', 'ABC123')).toBe('code16k');
        expect(resolveBcid('10', 'ABC123')).toBe('code49');
    });

    it('QR invalid EC level yields no spec (data itself always encodes)', () => {
        expect(buildBwipSpec('18', 'HI', { qrEcl: 'Z' })).toBeNull();
    });

    it('MicroPDF417 invalid columns x rows combo yields nothing measurable', () => {
        expect(measureBarcode('19', '1234', { microColumns: '1', microRows: '7' })).toBeNull();
    });

    it('c11 POSTNET rejects a 6-digit zip; accepts 5/9/11 (check digit added)', () => {
        expect(measureBarcode('11', '123456')).toBeNull();
        expect(measureBarcode('11', '123456789')).not.toBeNull();
    });

    it('HIBC strips the host leading "+" — bwip prepends its own flag unconditionally', () => {
        // Probed: hibccode39 encodes "+A1234$B567" 10 elements (one Code-39
        // char) LONGER than "A1234$B567" → bwip always adds the '+' flag
        // itself; passing the host '+' would double-flag and corrupt the
        // mod-43 check. The encoder text must therefore never start with '+'.
        expect(buildBwipSpec('8', '+A1234$B567')!.main.text).toBe('A1234$B567');
        expect(buildBwipSpec('8', 'A1234$B567')!.main.text).toBe('A1234$B567');
        expect(measureBarcode('8', '+A1234$B567')!.widthModules)
            .toBe(measureBarcode('8', 'A1234$B567')!.widthModules);
        expect(buildBwipSpec('16', '+A1234/9011141234567')!.main.text).toBe('A1234/9011141234567');
    });

    it('empty-string qrEcl falls back to the printer default M, not a failed spec', () => {
        expect(buildBwipSpec('18', 'HI', { qrEcl: '' })).not.toBeNull();
    });
});

describe('parseBarcodeField — new symbology plumbing', () => {
    it('captures QR parameters from c18[,m1][,m2][,m3]', () => {
        const { el, label } = bar(['B1;o10,10;c18,2,Q,3;h50;w2;i0;d3,HELLO']);
        expect(el.symbology).toBe('18');
        expect(el.qrModel).toBe('2');
        expect(el.qrEcl).toBe('Q');
        expect(el.qrMask).toBe('3');
        expect(label.issues.filter(i => i.level === 'error')).toHaveLength(0);
    });

    it('warns that QR model 1 has no encoder and renders model 2', () => {
        const { el, label } = bar(['B1;o10,10;c18,1,M,8;h50;w2;d3,HELLO']);
        expect(el.qrModel).toBe('1');
        const warn = label.issues.find(i => i.code === 'qr-model-unsupported');
        expect(warn?.level).toBe('warning');
    });

    it('rejects out-of-domain QR EC level with a warning, defaults to M', () => {
        const { el, label } = bar(['B1;o10,10;c18,2,X,0;h50;w2;d3,HELLO']);
        expect(label.issues.find(i => i.code === 'qr-ecl-invalid')?.level).toBe('warning');
        expect(el.qrEcl).toBeUndefined(); // defaulted (undefined = encoder default)
    });

    it('captures MicroPDF417 m1/m2', () => {
        const { el } = bar(['B1;o10,10;c19,2,8;h50;w2;d3,12345678']);
        expect(el.microColumns).toBe('2');
        expect(el.microRows).toBe('8');
    });

    it('issues an info for HIBC secondary formats (needs two paired fields)', () => {
        const { el, label } = bar(['B1;o10,10;c8,2,7;h50;w2;d3,+A1234$B567']);
        expect(el.symbology).toBe('8');
        expect(el.hibcMode).toBe('2');
        expect(label.issues.find(i => i.code === 'hibc-secondary-unsupported')).toBeTruthy();
    });

    it('primary HIBC format raises no secondary info', () => {
        const { label } = bar(['B1;o10,10;c8,0;h50;w2;d3,+A1234$B567']);
        expect(label.issues.find(i => i.code === 'hibc-secondary-unsupported')).toBeFalsy();
    });

    it('deep-validates QR/MicroPDF/Code16K fixed data instead of skipping', () => {
        // MicroPDF417 with an illegal columns-x-rows combo → error.
        const bad = bar(['B1;o10,10;c19,1,7;h50;w2;d3,1234']);
        expect(bad.label.issues.find(i => i.code === 'barcode-data-invalid')).toBeTruthy();
        // A legal 2x8 combo fits a short numeric payload.
        const ok = bar(['B2;o10,10;c19,2,8;h50;w2;d3,12345678']);
        expect(ok.label.issues.find(i => i.code === 'barcode-data-invalid')).toBeFalsy();
    });

    it('QR data beyond the model-2 capacity errors instead of silently passing', () => {
        const huge = 'X'.repeat(4200); // PRM: max 3550 chars
        const { label } = bar([`B1;o10,10;c18;h50;w2;d3,${huge}`]);
        expect(label.issues.find(i => i.code === 'barcode-data-invalid')).toBeTruthy();
    });

    it('JIS-ITF (c15) still skips deep validation — it has no encoder', () => {
        const { label } = bar(['B1;o10,10;c15;h50;w2;d3,12345!@#invalid-for-any']);
        expect(label.issues.find(i => i.code === 'barcode-data-invalid')).toBeFalsy();
    });

    it('composite c21 IS validated now that bwip ships composite encoders', () => {
        // c21 used to skip deep validation alongside c15, because this suite
        // believed bwip had no composite encoder. It has twelve, so c21 is
        // judged like any other symbology.
        const HT = String.fromCharCode(9);
        const good = bar([`B1;o10,10;c21,2;h50;w2;d3,9520123456788${HT}(99)1234-abcd`]);
        expect(good.label.issues.find(i => i.code === 'barcode-data-invalid')).toBeFalsy();
        const bad = bar(['B2;o10,10;c21,2;h50;w2;d3,12345"']);
        expect(bad.label.issues.find(i => i.code === 'barcode-data-invalid')).toBeTruthy();
    });

    it('Batch B wired c20 in: garbage data now errors (was skipped)', () => {
        const { label } = bar(['B1;o10,10;c20;h50;w2;d3,12345!@#invalid-for-any']);
        expect(label.issues.find(i => i.code === 'barcode-data-invalid')).toBeTruthy();
    });

    it('rendered QR measure is matrix-square and finite', () => {
        const m = measureBarcode('18', 'HELLO WORLD', { qrEcl: 'Q' } as BarcodeParams);
        expect(m).not.toBeNull();
        expect(m!.isMatrix).toBe(true);
        expect(m!.widthModules).toBeGreaterThan(20);
    });

    it('Code 16K/49 keep square modules (pixs shape); POSTNET/Planet stay linear', () => {
        expect(measureBarcode('9', 'ABC123')!.isMatrix).toBe(true);
        expect(measureBarcode('10', 'ABC123')!.isMatrix).toBe(true);
        expect(measureBarcode('11', '12345')!.isMatrix).toBe(false);
        expect(measureBarcode('22', '12345678901')!.isMatrix).toBe(false);
    });

    it('POSTNET measures at bwip natural cells (parser folds magnification into w)', () => {
        // bwip's scale-1 raster is the USPS-spec size (printer default 2x2),
        // so ZIP5 measures ~104 natural cells; the parser maps the PRM
        // magnification h/w (dots) onto them at half rate.
        const m = measureBarcode('11', '12345', { narrowDots: 2, ratio: 1 })!;
        expect(m).not.toBeNull();
        expect(m.widthModules).toBeGreaterThanOrEqual(100);
        expect(m.widthModules).toBeLessThanOrEqual(108);
    });

    it('parser: POSTNET h/w magnify the base cell; default 2x2 = USPS spec (PRM p.156)', () => {
        // Base cell 13 dots tall; bwip's scale-1 raster already IS the spec
        // symbol, so default → 26 dots tall, width stretch 1 per natural px.
        const def = bar(['B1;o10,10;c11;d3,12345']);
        expect(def.el.moduleDots).toBe(1);
        expect(def.el.heightDots).toBe(26);
        const big = bar(['B2;o10,10;c11;h4;w4;d3,12345']);
        expect(big.el.moduleDots).toBe(2);
        expect(big.el.heightDots).toBe(52);
    });

    it('parser: Planet is fixed-size — h/w are ignored with an info (PRM p.171)', () => {
        const { el, label } = bar(['B1;o10,10;c22;h99;w7;d3,12345678901']);
        expect(el.symbology).toBe('22');
        expect(el.moduleDots).toBe(1);   // natural spec size — not the w7
        expect(el.heightDots).toBe(26);  // and not the h99
        expect(label.issues.find(i => i.code === 'planet-fixed-size')).toBeTruthy();
    });

    it('POSTNET magnification clamps to 1-10 with a warning (h50 leak from designer)', () => {
        // The designer always emits h in DOTS (e.g. h50); read as a POSTNET
        // magnification that would be 650 dots tall. Clamp to the sane
        // printer range with a warning instead.
        const { el, label } = bar(['B1;o10,10;c11;h50;w2;d3,12345']);
        expect(el.heightDots).toBe(130); // 13 x clamped 10
        expect(label.issues.find(i => i.code === 'postnet-magnification-out-of-range')).toBeTruthy();
        const neg = bar(['B2;o10,10;c11;h-2;w-5;d3,12345']);
        expect(neg.el.heightDots).toBe(13); // clamped to 1 — never negative
        expect(neg.el.moduleDots).toBe(1);
    });

    it('QR model: 1 warns unsupported, 0/garbage warns invalid, 2 silent', () => {
        expect(bar(['B1;o10,10;c18,1;h50;w2;d3,HI']).label.issues.find(i => i.code === 'qr-model-unsupported')).toBeTruthy();
        expect(bar(['B2;o10,10;c18,0;h50;w2;d3,HI']).label.issues.find(i => i.code === 'qr-model-invalid')).toBeTruthy();
        expect(bar(['B3;o10,10;c18,5;h50;w2;d3,HI']).label.issues.find(i => i.code === 'qr-model-invalid')).toBeTruthy();
        const ok = bar(['B4;o10,10;c18,2;h50;w2;d3,HI']);
        expect(ok.label.issues.find(i => i.code === 'qr-model-invalid' || i.code === 'qr-model-unsupported')).toBeFalsy();
    });

    it('MicroPDF417 rows outside 0-44 warns and falls back to auto (no false data error)', () => {
        const { label } = bar(['B1;o10,10;c19,2,999;h50;w2;d3,12345678']);
        expect(label.issues.find(i => i.code === 'micro-rows-invalid')).toBeTruthy();
        expect(label.issues.find(i => i.code === 'barcode-data-invalid')).toBeFalsy();
    });
});

describe('designer <-> viewer conversions for POSTNET/Planet (review 2026-09-21)', () => {
    it('generator: POSTNET emits magnifications, Planet omits h/w entirely', async () => {
        const { generateIPL } = await import('../services/iplGenerator');
        const design = {
            name: 'T', labelSettings: { width: 80, height: 50, columns: 1, rows: 1, unit: 'mm' as const, orientation: 'portrait' as const },
            printerSettings: { model: 'PD43', dpi: 203 as const, quantity: 1, mediaType: 'thermal-transfer' as const, mediaSenseMode: 'gap' as const, printSpeed: 6, darkness: 10 },
            fields: [
                { id: 1, type: 'barcode' as const, name: 'pn', x: 5, y: 5, rotation: 0 as const, dataSource: { type: 'fixed' as const, data: '12345' }, symbology: '11', humanReadable: 'none' as const, h_mag: 50, w_mag: 2 },
                { id: 2, type: 'barcode' as const, name: 'pl', x: 5, y: 20, rotation: 0 as const, dataSource: { type: 'fixed' as const, data: '12345678901' }, symbology: '22', humanReadable: 'none' as const, h_mag: 50, w_mag: 2 },
            ],
            dataSources: [], nextId: 3, guides: { horizontal: [], vertical: [] },
        };
        const ipl = await generateIPL(design);
        const pn = ipl.split('\n').find(l => l.includes('c11'))!;
        const pl = ipl.split('\n').find(l => l.includes('c22'))!;
        expect(pn).toMatch(/;h4;w2;/);      // 50 dots → magnification 4 (13*4 = 52), w passthrough
        expect(pn).not.toMatch(/h50/);
        expect(pl).not.toMatch(/;[hw]\d/);  // fixed-size: no h/w at all
    });

    it('designer import: POSTNET magnifications convert back to dot height', async () => {
        const { parseIPL } = await import('../services/iplParser');
        const ipl = [
            '<STX><ESC>C<SI>W812<ETX>', '<STX><ESC>P<ETX>', '<STX>E1;F1<ETX>',
            '<STX>B1;o40,40;c11;h4;w2;d3,12345<ETX>', '<STX>R<ETX>',
        ].join('\n');
        const design = parseIPL(ipl, 203);
        const f = design.fields.find(x => x.type === 'barcode') as { h_mag: number; w_mag: number };
        expect(f.h_mag).toBe(52); // 13 dots x mag 4
        expect(f.w_mag).toBe(2);
    });

    it('designer import: the Code 39 check digit survives the charset groups', async () => {
        // PRM p.150: c0's m repeats its check-digit meaning in each charset
        // group — 0/1/2 8646, 3/4/5 full ASCII, 6/7/8 43-character. The reverse
        // map had only 1 and 2, so 4/5/7/8 (a check digit in another group)
        // imported as 'none' and the digit was dropped.
        const { parseIPL } = await import('../services/iplParser');
        const ck = async (m: string) => {
            const design = parseIPL([
                '<STX><ESC>C<SI>W812<ETX>', '<STX><ESC>P<ETX>', '<STX>E1;F1<ETX>',
                `<STX>B1;o40,40;c0,${m};d3,12345<ETX>`, '<STX>R<ETX>',
            ].join('\n'), 203);
            return (design.fields.find(x => x.type === 'barcode') as { code39_checkDigit?: string }).code39_checkDigit;
        };
        expect(await ck('1')).toBe('printer-generated');
        expect(await ck('4'), 'full ASCII printer check digit').toBe('printer-generated');
        expect(await ck('7'), '43-char printer check digit').toBe('printer-generated');
        expect(await ck('2')).toBe('host-verifies');
        expect(await ck('5'), 'full ASCII host check digit').toBe('host-verifies');
        expect(await ck('8'), '43-char host check digit').toBe('host-verifies');
        // The controls: 0/3/6 carry no check digit.
        expect(await ck('0')).toBe('none');
        expect(await ck('3')).toBe('none');
        expect(await ck('6')).toBe('none');
    });

    it('designer import: names the Code 39 charset it cannot carry', async () => {
        // The designer models the check digit but not the CHARSET, so full ASCII
        // (3-5) and 43-character (6-8) regenerate as 8646 — identical for A-Z0-9
        // but not for the lowercase and symbols those sets exist for.
        const { parseIPL } = await import('../services/iplParser');
        const notices = (m: string) => {
            const out: string[] = [];
            parseIPL([
                '<STX><ESC>C<SI>W812<ETX>', '<STX><ESC>P<ETX>', '<STX>E1;F1<ETX>',
                `<STX>B1;o40,40;c0,${m};d3,12345<ETX>`, '<STX>R<ETX>',
            ].join('\n'), 203, (n: { message: string }) => out.push(n.message));
            return out.join(' ');
        };
        expect(notices('4')).toMatch(/full ASCII/);
        expect(notices('7')).toMatch(/43-character/);
        // The controls: the 8646 group is what the generator emits, so nothing.
        expect(notices('1')).toBe('');
        expect(notices('0')).toBe('');
    });
});
