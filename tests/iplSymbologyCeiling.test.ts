// IPL's `c` list stops at c22 (PRM p.149, "Values for n"; the widest per-printer
// range is 0-12, 14-22). The IR's own ids 23-35 — minted for TSPL/EPL/DPL forms
// IPL never had — are therefore NOT printable on any IPL printer, but the
// designer dropdown offers them for every target and generateIPL emits them raw
// (`c27`), while the viewer parses them back with no issue at all. A preview
// that draws what the printer rejects, in silence both ways, is the exact
// failure this project exists to prevent.
//
// Two guards, matching the project's established split: the WRITE direction is
// named by designerOnlyWarnings (generateIPL has no warning channel — it
// returns a bare string), and the READ direction by the viewer parser.
import './golden/setup';
import { describe, it, expect, beforeAll } from 'vitest';
import { ensureBarcodesReady } from '../services/ipl/barcodes';
import { designerOnlyWarnings } from '../services/designerOnly';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import type { BarcodeField, Design } from '../types';

beforeAll(async () => { await ensureBarcodesReady(); });

const barcodeField = (extra: Partial<BarcodeField> = {}): BarcodeField => ({
    id: 1, type: 'barcode', name: 'B', x: 10, y: 20, rotation: 0,
    dataSource: { type: 'fixed', data: '1234567890' }, symbology: '0',
    humanReadable: 'below', h_mag: 60, w_mag: 2, ...extra,
});

const designOf = (fields: Design['fields']): Design => ({
    name: 'T',
    labelSettings: { width: 80, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields, dataSources: [], nextId: 99, guides: { horizontal: [], vertical: [] },
});

const streamWith = (cValue: string) => [
    '<STX><ESC>C<SI>W800<ETX>',
    '<STX><ESC>P<ETX>',
    '<STX>E1;F1<ETX>',
    `<STX>B1;o80,160;f0;c${cValue};h60;w2;i1;d3,1234567890<ETX>`,
    '<STX>R<ETX>',
].join('\n');

describe('write direction: designerOnlyWarnings names non-IPL symbologies for IPL', () => {
    // Every IR id above the printer's ceiling, sampled across the families that
    // minted them: 23/24 (TSPL 2D commands), 25/26 (DPL addenda), 27 (MSI),
    // 28 (Plessey UK), 29/30 (Deutsche Post), 31/33 (Telepen), 32 (ITF-14),
    // 34 (Japanese Postnet), 35 (EAN-14).
    for (const sym of ['23', '24', '25', '26', '27', '28', '29', '30', '31', '32', '33', '34', '35']) {
        it(`names symbology ${sym} for IPL`, () => {
            const w = designerOnlyWarnings('ipl', designOf([barcodeField({ symbology: sym })]));
            expect(w, `symbology ${sym} must be named for IPL`).toHaveLength(1);
            expect(w[0]).toContain('"B"');
            expect(w[0]).toContain('c22');
        });
    }

    it('stays silent for symbologies every IPL printer accepts', () => {
        for (const sym of ['0', '1', '6', '7', '12', '18', '20', '21', '22']) {
            expect(designerOnlyWarnings('ipl', designOf([barcodeField({ symbology: sym })])), `sym ${sym}`).toEqual([]);
        }
    });

    it('stays silent for the same ids on the languages that carry them', () => {
        // 27-35 are genuine TSPL/EPL/DPL forms — warning there would be wrong.
        expect(designerOnlyWarnings('tspl', designOf([barcodeField({ symbology: '27' })]))).toEqual([]);
        expect(designerOnlyWarnings('epl', designOf([barcodeField({ symbology: '34' })]))).toEqual([]);
        expect(designerOnlyWarnings('dpl', designOf([barcodeField({ symbology: '31' })]))).toEqual([]);
        expect(designerOnlyWarnings('tspl', designOf([barcodeField({ symbology: '35' })]))).toEqual([]);
    });

    it('ignores a hidden field', () => {
        expect(designerOnlyWarnings('ipl', designOf([barcodeField({ symbology: '27', visible: false })]))).toEqual([]);
    });
});

describe('read direction: the viewer names a c value no IPL printer accepts', () => {
    it('issues for c27 instead of drawing in silence', () => {
        const label = parseViewerIPL(streamWith('27'));
        expect(label.elements.find(e => e.kind === 'barcode')).toBeDefined();
        expect(label.issues.some(i => /c22|c27/.test(i.message)), 'c27 must be named').toBe(true);
    });

    it('issues for c35 (EAN-14) as well', () => {
        const label = parseViewerIPL(streamWith('35'));
        expect(label.issues.some(i => /c22|c35/.test(i.message)), 'c35 must be named').toBe(true);
    });

    it('stays silent for c0 and c22', () => {
        for (const c of ['0', '22']) {
            const label = parseViewerIPL(streamWith(c));
            expect(label.issues.filter(i => /c22|c0/.test(i.message) && /no .*printer/i.test(i.message)), `c${c}`).toEqual([]);
        }
    });
});
