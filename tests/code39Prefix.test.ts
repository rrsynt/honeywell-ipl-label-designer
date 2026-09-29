import { describe, it, expect, beforeAll } from 'vitest';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { parseIPL } from '../services/iplParser';
import { measureBarcode, ensureBarcodesReady } from '../services/ipl/barcodes';
import type { BarcodeElement } from '../services/ipl/types';

const stx = (f: string) => `<STX>${f}<ETX>`;
const stream = (ims: string) => [
    stx('<ESC>P'), stx('<SI>W812'), stx('<SI>L406'), stx('E1;F1'),
    stx(ims), stx('R'), stx('<ESC>E1'),
].join('');

const barcode = (ims: string): BarcodeElement => {
    const el = parseViewerIPL(stream(ims)).elements.find(e => e.kind === 'barcode');
    if (!el) throw new Error(`no barcode element for "${ims}"`);
    return el as BarcodeElement;
};
const codes = (ims: string) => parseViewerIPL(stream(ims)).issues.map(i => i.code);
const widthOf = (el: BarcodeElement, data: string) => measureBarcode(el.symbology, data, {
    code39Mode: el.code39Mode, code39Prefix: el.code39Prefix,
    ratio: el.ratio, narrowDots: el.moduleDots,
})?.widthModules;

/**
 * Code 39 Prefix Character, Define — `p` (PRM 2.70 p.181).
 *
 * Found by sweeping the manual's own per-field-type command tables (pp.92-95,
 * "Commands Listed by Task") against the parser instead of against the manual's
 * alphabetical index the earlier sweeps used. Those tables are the binding
 * list: "Bar Code Field Editing Commands" is exactly c d f h I o p r w, and a
 * differential probe over all of them showed `p` was the only one the parser
 * dropped without a word — every other parameter changed the produced element.
 *
 * Two defects, both silent:
 *   before d3:  "c0,3;pABC4;d3,123" — the prefix vanished; bars differ.
 *   after  d3:  "c0,3;d3,123;pABC4" — the prefix PRINTED as text, "123;pABC4".
 *
 * Modelled rather than warned, because unlike an emulation mode or a printer
 * origin this one is fully determined by the stream: the manual names the exact
 * character set, the exact maximum length, and the '@' clear spelling.
 */
describe('Code 39 prefix (p) — a printed character with no decision path', () => {
    beforeAll(async () => { await ensureBarcodesReady(); });

    it('carries the prefix on the element, before or after the data', () => {
        // The manual's own spelling: "enter c0,3;pABC4; rather than pABC4;c0,3;".
        expect(barcode('B1;o10,10;c0,3;pABC4;d3,123').code39Prefix).toBe('ABC4');
        // After d3 is the shape the trailing-parameter rule exists for.
        const after = barcode('B1;o10,10;c0,3;d3,123;pABC4');
        expect(after.code39Prefix).toBe('ABC4');
        expect(after.source).toEqual({ type: 'fixed', data: '123' });
    });

    it('does not print the prefix as part of the fixed text', () => {
        // The bug this pins: the field drew "123;pABC4" on the label.
        for (const ims of ['B1;o10,10;c0,3;pABC4;d3,123', 'B1;o10,10;c0,3;d3,123;pABC4']) {
            const el = barcode(ims);
            expect((el.source as { data: string }).data).toBe('123');
        }
    });

    it('makes the encoder draw the extra characters (the symbol really changes)', () => {
        // Measured: one prefix character is worth exactly one Code 39
        // character's worth of modules at the 3:1 default (80 → 96).
        const plain = barcode('B1;o10,10;c0,3;d3,123');
        const prefixed = barcode('B1;o10,10;c0,3;pABC4;d3,123');
        const wPlain = widthOf(plain, '123')!;
        const wPrefixed = widthOf(prefixed, '123')!;
        expect(wPrefixed).toBeGreaterThan(wPlain);
        expect(wPrefixed - wPlain).toBe(4 * 16);
    });

    it("treats a leading '@' as the documented clear, not as a character", () => {
        // "When you enter the @ character as n1, it clears all prefixes."
        const el = barcode('B1;o10,10;c0,3;p@;d3,123');
        expect(el.code39Prefix).toBeUndefined();
        expect(widthOf(el, '123')).toBe(widthOf(barcode('B1;o10,10;c0,3;d3,123'), '123'));
    });

    it('is not applied to a non-Code-39 field, and says nothing', () => {
        // "The prefix is only valid for Code 39 fields" — the printer ignores
        // it, so drawing no prefix is CORRECT, not a divergence to warn about.
        const el = barcode('B1;o10,10;c6;pABC4;d3,12345678');
        expect(el.code39Prefix).toBeUndefined();
        expect(codes('B1;o10,10;c6;pABC4;d3,12345678')).not.toContain('code39-prefix-invalid');
    });

    it('rejects characters outside the documented set, without going silent', () => {
        const el = barcode('B1;o10,10;c0,3;pab-4;d3,123');
        expect(el.code39Prefix).toBe('4'); // lowercase and '-' are not in A-Z0-9
        expect(codes('B1;o10,10;c0,3;pab-4;d3,123')).toContain('code39-prefix-invalid');
    });

    it('rejects an over-long prefix, keeping the four the syntax allows', () => {
        // Syntax is p[n1][n2][n3][n4] — five characters is malformed input.
        const el = barcode('B1;o10,10;c0,3;pABCDE;d3,123');
        expect(el.code39Prefix).toBe('ABCD');
        expect(codes('B1;o10,10;c0,3;pABCDE;d3,123')).toContain('code39-prefix-invalid');
    });

    it('leaves ordinary text that ends in ";p" alone', () => {
        // The trailing-rule is narrow on purpose: this must stay printed text.
        const el = barcode('B1;o10,10;c0,3;d3,tail;p');
        expect(el.code39Prefix).toBeUndefined();
        expect((el.source as { data: string }).data).toBe('tail;p');
    });
});

describe('importer parity for the Code 39 prefix', () => {
    // services/iplParser.ts promises "viewer parity" and has to keep it: the
    // importer had the same data-boundary defect, and additionally dropped the
    // prefix with no notice at all.
    const importNotices = (ims: string): string[] => {
        const notices: string[] = [];
        parseIPL(stream(ims), 203, n => notices.push(n.command));
        return notices;
    };
    const importedData = (ims: string): string => {
        const design = parseIPL(stream(ims), 203);
        const bc = design.fields.find(f => f.type === 'barcode') as { dataSource: { data: string } };
        return bc.dataSource.data;
    };

    it('does not glue a trailing prefix onto the imported text', () => {
        expect(importedData('B1;o10,10;c0,3;d3,123;pABC4')).toBe('123');
    });

    it('reports the prefix it cannot represent, in either position', () => {
        expect(importNotices('B1;o10,10;c0,3;pABC4;d3,123')).toContain('pABC4');
        expect(importNotices('B1;o10,10;c0,3;d3,123;pABC4')).toContain('pABC4');
    });

    it('says nothing for a non-Code-39 field, where the printer ignores it', () => {
        expect(importNotices('B1;o10,10;c6;pABC4;d3,12345678')).not.toContain('pABC4');
    });
});
