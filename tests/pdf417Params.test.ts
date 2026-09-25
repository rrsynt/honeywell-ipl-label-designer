// PDF417 c12[[,m1][,m2][,m3]] (PRM p.149), §15 item 10.
//
// The spec called the auto-aspect rule "unpublished" and suggested a
// near-square heuristic. The manual states it plainly once you read the c12
// section rather than the table: "m1 is the number of columns of data
// characters. The range for m1 is 0 to 30 and the default is 0. If you select
// zero, the printer provides the number of columns needed to create a symbol
// that is as close to a square as possible." with a note that the auto case
// uses a height magnification three times the width magnification.
//
// That is exactly what bwip's encoder already does by default — its `rowmult`
// is 3 and its `columns` default is 0 — so the DEFAULT shape was always right.
// What was missing was every EXPLICIT parameter: c12,m1/m2/m3 were captured
// nowhere, so a stream asking for 6 columns or EC level 8 silently got the
// defaults instead. This file pins both halves.
import './golden/setup';
import { describe, it, expect, beforeAll } from 'vitest';
import { ensureBarcodesReady, measureBarcode, buildBwipSpec } from '../services/ipl/barcodes';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import type { BarcodeElement } from '../services/ipl/types';

const stx = (f: string) => `<STX>${f}<ETX>`;

beforeAll(async () => { await ensureBarcodesReady(); });

/** Long enough that column choices actually differ. */
const DATA = 'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG 0123456789';

const parseBarcode = (cParam: string): BarcodeElement => {
    const label = parseViewerIPL([
        stx('<ESC>P'), stx('E1;F1'),
        stx(`B1;o40,40;c${cParam};w2;h100;d3,${DATA}`),
        stx('R'), stx('<ESC>E1'),
    ].join(''));
    return label.elements.find(e => e.kind === 'barcode') as BarcodeElement;
};
const issuesOf = (cParam: string) => parseViewerIPL([
    stx('<ESC>P'), stx('E1;F1'),
    stx(`B1;o40,40;c${cParam};w2;h100;d3,${DATA}`),
    stx('R'), stx('<ESC>E1'),
].join('')).issues;

describe('c12 parameters are captured', () => {
    it('reads m1, m2 and m3 onto the element', () => {
        const el = parseBarcode('12,6,8,1');
        expect(el.pdfColumns).toBe('6');
        expect(el.pdfEcLevel).toBe('8');
        expect(el.pdfTruncate).toBe('1');
    });

    it('leaves them unset when c12 carries no modifiers', () => {
        const el = parseBarcode('12');
        expect(el.pdfColumns).toBeUndefined();
        expect(el.pdfEcLevel).toBeUndefined();
        expect(el.pdfTruncate).toBeUndefined();
    });

    it('warns for an out-of-range column count and falls back to auto', () => {
        // Documented range is 0-30 (PRM p.149).
        const label = parseViewerIPL([
            stx('<ESC>P'), stx('E1;F1'),
            stx(`B1;o40,40;c12,31;w2;h100;d3,${DATA}`),
            stx('R'), stx('<ESC>E1'),
        ].join(''));
        expect(label.issues.some(i => i.code === 'pdf417-columns-invalid')).toBe(true);
        expect((label.elements.find(e => e.kind === 'barcode') as BarcodeElement).pdfColumns).toBeUndefined();
    });

    it('warns for an error-correction level outside 0-9', () => {
        // 0-8 are explicit levels, 9 means auto (PRM p.149).
        expect(issuesOf('12,0,10').some(i => i.code === 'pdf417-ec-invalid')).toBe(true);
        expect(issuesOf('12,0,9').some(i => i.code === 'pdf417-ec-invalid')).toBe(false);
    });

    it('warns for a truncate flag that is not 0 or 1', () => {
        expect(issuesOf('12,0,9,7').some(i => i.code === 'pdf417-truncate-invalid')).toBe(true);
        expect(issuesOf('12,0,9,1').some(i => i.code === 'pdf417-truncate-invalid')).toBe(false);
    });
});

describe('the parameters change the encoded symbol', () => {
    it('more columns make a shorter, wider symbol', () => {
        const two = measureBarcode('12', DATA, { pdfColumns: '2' })!;
        const six = measureBarcode('12', DATA, { pdfColumns: '6' })!;
        expect(six.widthModules, 'more columns is wider').toBeGreaterThan(two.widthModules);
        expect(six.heightPx, 'more columns is shorter').toBeLessThan(two.heightPx);
    });

    it('a higher error-correction level makes the symbol bigger', () => {
        const low = measureBarcode('12', DATA, { pdfEcLevel: '1' })!;
        const high = measureBarcode('12', DATA, { pdfEcLevel: '8' })!;
        expect(high.widthModules * high.heightPx).toBeGreaterThan(low.widthModules * low.heightPx);
    });

    it('truncation drops the right row indicators', () => {
        const full = measureBarcode('12', DATA, {})!;
        const cut = measureBarcode('12', DATA, { pdfTruncate: '1' })!;
        expect(cut.widthModules, 'truncated is narrower').toBeLessThan(full.widthModules);
    });

    it('the default is the encoder auto case, and it stays that way', () => {
        // m1=0 is the printer default: near-square, height 3x width.
        const auto = measureBarcode('12', DATA, {})!;
        const explicitZero = measureBarcode('12', DATA, { pdfColumns: '0' })!;
        expect(explicitZero).toEqual(auto);
    });

    it('every distinct parameter set gets its own measurement (cache key)', () => {
        // A cache that ignores these would return the first result for every
        // later call — which is exactly the bug this caught: the params were
        // added to buildBwipSpec but not to paramsKey, so all six probe cases
        // returned an identical measure.
        const a = measureBarcode('12', DATA, { pdfColumns: '2' })!;
        const b = measureBarcode('12', DATA, { pdfColumns: '6' })!;
        const c = measureBarcode('12', DATA, { pdfEcLevel: '8' })!;
        expect(new Set([`${a.widthModules}x${a.heightPx}`, `${b.widthModules}x${b.heightPx}`, `${c.widthModules}x${c.heightPx}`]).size).toBe(3);
    });
});

describe('the built spec carries the options through', () => {
    it('maps m1/m2/m3 onto bwip option names', () => {
        const spec = buildBwipSpec('12', DATA, { pdfColumns: '6', pdfEcLevel: '3', pdfTruncate: '1' }) as { main: { opts: Record<string, unknown> } };
        expect(spec.main.opts.columns).toBe(6);
        expect(spec.main.opts.eclevel).toBe(3);
        expect(spec.main.opts.compact).toBe(true);
    });

    it('omits what the printer would auto-select', () => {
        const spec = buildBwipSpec('12', DATA, {}) as { main: { opts: Record<string, unknown> } };
        expect(spec.main.opts).toEqual({});
    });

    it('rejects a column count the printer does not accept', () => {
        expect(buildBwipSpec('12', DATA, { pdfColumns: '31' })).toBeNull();
    });
});
