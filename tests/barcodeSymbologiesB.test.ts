// Batch B (2026-09-21): the last IPL symbologies bwip-js can faithfully
// encode — c20 RSS/GS1 DataBar (all seven m1 variants) and c14 MaxiCode
// (modes 2-6 + auto). c15 JIS-ITF and c21 EAN.UCC Composite stay placeholder
// but now say so (info 'symbology-no-encoder').
import { describe, it, expect, beforeAll } from 'vitest';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { ensureBarcodesReady, buildBwipSpec, measureBarcode, resolveBcid } from '../services/ipl/barcodes';
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

const GTIN13 = '1234567890123';      // no check digit (printer adds it)
const GTIN14 = '(01)12345678901231'; // AI form with valid check digit

describe('buildBwipSpec — c20 RSS / GS1 DataBar', () => {
    it('maps all seven m1 versions to their databar bcids (default 2 = Stacked)', () => {
        expect(buildBwipSpec('20', GTIN13, {})!.main.bcid).toBe('databarstacked');
        expect(buildBwipSpec('20', GTIN13, { rssVersion: '0' })!.main.bcid).toBe('databaromni');
        expect(buildBwipSpec('20', GTIN13, { rssVersion: '1' })!.main.bcid).toBe('databartruncated');
        expect(buildBwipSpec('20', GTIN13, { rssVersion: '3' })!.main.bcid).toBe('databarstackedomni');
        expect(buildBwipSpec('20', GTIN13, { rssVersion: '4' })!.main.bcid).toBe('databarlimited');
        expect(buildBwipSpec('20', GTIN13, { rssVersion: '5' })!.main.bcid).toBe('databarexpanded');
        expect(buildBwipSpec('20', GTIN13, { rssVersion: '6' })!.main.bcid).toBe('databarexpandedstacked');
    });

    it('wraps a bare GTIN in the (01) AI form with the computed check digit', () => {
        // Printer semantics (PRM p.165): host sends 13 digits, the check
        // digit is computed. 1234567890123 -> check 1 (verified against
        // bwip's own check-digit verification on the 14-digit form).
        expect(buildBwipSpec('20', GTIN13, { rssVersion: '0' })!.main.text).toBe('(01)' + GTIN13 + '1');
        expect(buildBwipSpec('20', GTIN14, { rssVersion: '0' })!.main.text).toBe(GTIN14);
    });

    it('passes sepheight (m2) to the stacked versions and segments (m3) to expanded-stacked', () => {
        const stacked = buildBwipSpec('20', GTIN13, { rssVersion: '2', rssSepHeight: '2' })!;
        expect(stacked.main.opts.sepheight).toBe(2);
        // segments only mean something for m1=6 (PRM p.166)
        const expstack = buildBwipSpec('20', GTIN13, { rssVersion: '6', rssSegments: '4' })!;
        expect(expstack.main.opts.segments).toBe(4);
    });

    it('segments only apply to expanded-stacked (m1=6)', () => {
        const spec = buildBwipSpec('20', GTIN13, { rssVersion: '2', rssSegments: '4' })!;
        expect(spec.main.opts.segments).toBeUndefined();
    });

    it('stacked variants are pixs-shaped (matrix), omni/truncated/limited linear', () => {
        expect(measureBarcode('20', GTIN13, { rssVersion: '2' })!.isMatrix).toBe(true);
        expect(measureBarcode('20', GTIN13, { rssVersion: '0' })!.isMatrix).toBe(false);
        expect(measureBarcode('20', GTIN13, { rssVersion: '6' })!.isMatrix).toBe(true);
    });

    it('bad GTIN length errors through the encoder (deep validation)', () => {
        expect(measureBarcode('20', '123456', { rssVersion: '0' })).toBeNull();
        expect(measureBarcode('20', GTIN13, { rssVersion: '0' })).not.toBeNull();
    });
});

describe('buildBwipSpec — c14 MaxiCode', () => {
    const banner = '[)>\x1e01\x1d01982039280\x1d840\x1d001\x1d1Z94924221455215\x1eIntermec 6001\x04';

    it('maps to the maxicode encoder with the declared mode', () => {
        expect(buildBwipSpec('14', banner, { maxiMode: '2' })!.main.bcid).toBe('maxicode');
        expect(buildBwipSpec('14', banner, { maxiMode: '2' })!.main.opts.mode).toBe(2);
    });

    it('no mode = automatic discrimination (PRM default)', () => {
        expect(buildBwipSpec('14', banner, {})!.main.opts.mode).toBeUndefined();
    });

    it('measures fixed-size and square (h/w magnification ignored)', () => {
        const m = measureBarcode('14', banner, { maxiMode: '2' })!;
        expect(m.isMatrix).toBe(true);
        expect(m.widthModules).toBeGreaterThanOrEqual(115);
        expect(m.widthModules).toBeLessThanOrEqual(125);
    });

    it('mode 6 accepts short data (bwip pads it) and rejects overlong messages', () => {
        expect(measureBarcode('14', '0123456789012345', { maxiMode: '6' })).not.toBeNull();
        expect(measureBarcode('14', '0'.repeat(200), { maxiMode: '5' })).toBeNull();
    });
});

describe('parseBarcodeField — c20/c14 plumbing', () => {
    it('captures RSS m1/m2/m3 and applies the PRM default height rule (33*w for m1=0)', () => {
        const { el, label } = bar(['B1;o10,10;c20,0;w2;d3,' + GTIN13]);
        expect(el.rssVersion).toBe('0');
        // PRM p.166: no h sent → default height = 33*w for RSS-14.
        expect(el.heightDots).toBe(66);
        expect(label.issues.filter(i => i.level === 'error')).toHaveLength(0);
    });

    it('explicit h wins over the RSS default', () => {
        const { el } = bar(['B1;o10,10;c20,2;h40;w2;d3,' + GTIN13]);
        expect(el.heightDots).toBe(40);
    });

    it('RSS version outside 0-6 warns and defaults to 2 (stacked)', () => {
        const { el, label } = bar(['B1;o10,10;c20,9;h50;w2;d3,' + GTIN13]);
        expect(label.issues.find(i => i.code === 'rss-version-invalid')).toBeTruthy();
        expect(el.rssVersion).toBeUndefined();
    });

    it('odd or out-of-range segments warns and falls back to auto', () => {
        const { label } = bar(['B1;o10,10;c20,6,1,5;h50;w2;d3,' + GTIN14]);
        expect(label.issues.find(i => i.code === 'rss-segments-invalid')).toBeTruthy();
        const ok = bar(['B2;o10,10;c20,6,1,4;h50;w2;d3,' + GTIN14]);
        expect(ok.label.issues.find(i => i.code === 'rss-segments-invalid')).toBeFalsy();
        expect(ok.el.rssSegments).toBe('4');
    });

    it('buildBwipSpec refuses odd segments even when a caller bypasses the parser', () => {
        // PRM p.166: even 2-22 only — an odd value must not reach bwip
        // (it would throw mid-encode) and must not silently change the symbol.
        const odd = buildBwipSpec('20', GTIN14, { rssVersion: '6', rssSegments: '5' })!;
        expect(odd.main.opts.segments).toBeUndefined();
        const even = buildBwipSpec('20', GTIN14, { rssVersion: '6', rssSegments: '6' })!;
        expect(even.main.opts.segments).toBe(6);
    });

    it('deep-validates RSS fixed data (bad GTIN errors)', () => {
        const { label } = bar(['B1;o10,10;c20,0;h50;w2;d3,123456']);
        expect(label.issues.find(i => i.code === 'barcode-data-invalid')).toBeTruthy();
    });

    it('MaxiCode is fixed-size: h/w ignored with an info, natural dimensions pinned', () => {
        const { el, label } = bar(['B1;o10,10;c14,2;h99;w7;d3,HELLO']);
        expect(el.symbology).toBe('14');
        expect(el.maxiMode).toBe('2');
        expect(el.moduleDots).toBe(1);
        expect(el.heightDots).toBe(101); // bwip natural height in dots
        expect(label.issues.find(i => i.code === 'maxicode-fixed-size')).toBeTruthy();
    });

    it('MaxiCode mode outside 2-6 warns and defaults to auto', () => {
        const { el, label } = bar(['B1;o10,10;c14,9;h50;w2;d3,HELLO']);
        expect(label.issues.find(i => i.code === 'maxi-mode-invalid')).toBeTruthy();
        expect(el.maxiMode).toBeUndefined();
    });

    it('raw RS/GS/EOT banner bytes survive the parser into MaxiCode data', () => {
        const banner = '[)>\x1e01\x1d01982039280\x1d840\x1d001\x1d1Z94924221455215\x1eaddr\x04';
        const { el, label } = bar([`B1;o10,10;c14,2;d3,${banner}`]);
        const data = (el.source as { data: string }).data;
        expect(data).toContain('\x1e');
        expect(data).toContain('\x1d');
        expect(data).toContain('\x04');
        expect(label.issues.find(i => i.code === 'barcode-data-invalid')).toBeFalsy();
    });

    it('JIS-ITF (c15) and Composite (c21) say they have no encoder (info, not silence)', () => {
        const c15 = bar(['B1;o10,10;c15;h50;w2;d3,12345678901234']);
        expect(c15.label.issues.find(i => i.code === 'symbology-no-encoder')).toBeTruthy();
        const c21 = bar(['B2;o10,10;c21,0;h50;w2;d3,5901234123457|21123456']);
        expect(c21.label.issues.find(i => i.code === 'symbology-no-encoder')).toBeTruthy();
        // and they still skip deep validation (placeholder, no false error)
        expect(c21.label.issues.find(i => i.code === 'barcode-data-invalid')).toBeFalsy();
    });
});
