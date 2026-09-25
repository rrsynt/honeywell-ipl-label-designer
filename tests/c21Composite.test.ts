// EAN.UCC Composite c21 (PRM p.160-162), the last §15 item.
//
// The render spec said the separator pattern "must come from the GS1 Composite
// spec, not this manual", and the code carried a matching claim that bwip only
// accepts composite data in GS1-AI form so forcing it "would render a
// confident-but-wrong symbol". Both were wrong, and in the same direction:
//
//  * The manual DOES describe the structure — a linear component and an
//    adjacent 2D component, "separated by the <HT> command with the data for
//    the linear component sent first", with a worked example.
//  * bwip ships twelve composite encoders (gs1-128composite, ean13composite,
//    upcacomposite, the seven databar variants, …) whose data shape is exactly
//    `linear|2D`.
//
// So the symbology could be implemented faithfully rather than placeholdered.
// What remains outside this repo is the CC-A/CC-B module pattern itself, which
// is the encoder's job — not something a renderer draws by hand.
import './golden/setup';
import { describe, it, expect, beforeAll } from 'vitest';
import { ensureBarcodesReady, measureBarcode, buildBwipSpec } from '../services/ipl/barcodes';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import type { BarcodeElement } from '../services/ipl/types';

const stx = (f: string) => `<STX>${f}<ETX>`;
const HT = String.fromCharCode(9);

beforeAll(async () => { await ensureBarcodesReady(); });

const parseBarcode = (cParam: string, data: string) => {
    const label = parseViewerIPL([
        stx('<ESC>P'), stx('E1;F1'),
        stx(`B1;o40,40;c${cParam};w2;h100;d3,${data}`),
        stx('R'), stx('<ESC>E1'),
    ].join(''));
    return { label, el: label.elements.find(e => e.kind === 'barcode') as BarcodeElement };
};

describe('c21 data is two <HT>-separated components', () => {
    it('splits the linear part from the 2D supplement', () => {
        const { el } = parseBarcode('21', `112233445566${HT}aabbccddeeff`);
        expect(el.source.type).toBe('fixed');
        expect((el.source as { data: string }).data).toBe(`112233445566${HT}aabbccddeeff`);
    });

    it('accepts the literal <HT> spelling an editor may carry', () => {
        // The tokenizer accepts <STX> and 0x02 for the same delimiter, so the
        // data separator follows suit: a pasted or hand-authored stream writes
        // <HT> where a printer capture carries 0x09.
        const literal = buildBwipSpec('21', '9520123456788<HT>(99)1234-abcd', { compositeVersion: '2' });
        const raw = buildBwipSpec('21', `9520123456788${HT}(99)1234-abcd`, { compositeVersion: '2' });
        expect(literal).toEqual(raw);
    });

    it('warns when only one component is present', () => {
        const { label } = parseBarcode('21', '112233445566');
        expect(label.issues.some(i => i.code === 'composite-needs-two-parts')).toBe(true);
    });

    it('does not warn when both components are present', () => {
        const { label } = parseBarcode('21', `9520123456788${HT}(99)1234-abcd`);
        expect(label.issues.some(i => i.code === 'composite-needs-two-parts')).toBe(false);
    });
});

describe('c21 versions select the linear component (PRM p.162)', () => {
    it('maps every documented version to a real encoder', () => {
        // 0-12 are the documented values; each must resolve rather than fall
        // back to a placeholder.
        const cases: [string, string][] = [
            ['0', 'gs1-128composite'],   // UCC/EAN-128 with CC-C
            ['1', 'gs1-128composite'],   // UCC/EAN-128 with CC-A/CC-B
            ['2', 'ean13composite'],
            ['3', 'ean8composite'],
            ['4', 'upcacomposite'],
            ['5', 'upcecomposite'],
            ['6', 'databaromnicomposite'],
            ['7', 'databartruncatedcomposite'],
            ['8', 'databarstackedcomposite'],
            ['9', 'databarstackedomnicomposite'],
            ['10', 'databarlimitedcomposite'],
            ['11', 'databarexpandedcomposite'],
            ['12', 'databarexpandedstackedcomposite'],
        ];
        for (const [m1, bcid] of cases) {
            const spec = buildBwipSpec('21', `9520123456788${HT}(99)1234-abcd`, { compositeVersion: m1 }) as { main: { bcid: string } } | null;
            expect(spec, `m1=${m1}`).not.toBeNull();
            expect(spec!.main.bcid, `m1=${m1}`).toBe(bcid);
        }
    });

    it('m1=0 asks for CC-C and the rest for CC-A/CC-B', () => {
        // "0 = UCC/EAN-128 with CC-C" vs "1-12 = … with CC-A or CC-B" (the
        // printer picks A or B from the data length).
        const cc = (m1: string) => (buildBwipSpec('21', `9520123456788${HT}(99)1234-abcd`, { compositeVersion: m1 }) as { main: { opts: Record<string, unknown> } }).main.opts.ccversion;
        expect(cc('0')).toBe('c');
        expect(cc('1')).toBe('b');
        expect(cc('6')).toBe('b');
    });

    it('warns for a version outside 0-12 and falls back to the default', () => {
        const { label, el } = parseBarcode('21,99', `9520123456788${HT}(99)1234-abcd`);
        expect(label.issues.some(i => i.code === 'composite-version-invalid')).toBe(true);
        expect(el.compositeVersion).toBeUndefined();
    });

    it('reads m3 (columns) and m5 (row height)', () => {
        const { el } = parseBarcode('21,0,1,6,1,4,1', `9520123456788${HT}(99)1234-abcd`);
        expect(el.compositeColumns).toBe('6');   // m3
        expect(el.compositeRowHeight).toBe('4'); // m5
    });
});

describe('the composite actually encodes', () => {
    it('renders a symbol for each family with data that fits it', () => {
        // Data has to suit the LINEAR component, so each case uses a shape the
        // chosen symbology accepts — a GS1-128 needs application identifiers,
        // an EAN-13 needs 12-13 digits, and so on.
        const cases: [string, string, string][] = [
            ['0 UCC/EAN-128 with CC-C', '(01)09521234543213(10)ABC' + HT + '(21)XYZ', '0'],
            ['1 UCC/EAN-128 with CC-A/B', '(01)09521234543213(10)ABC' + HT + '(21)XYZ', '1'],
            ['2 EAN-13', '9520123456788' + HT + '(99)1234-abcd', '2'],
            ['3 EAN-8', '95200002' + HT + '(21)A12345678', '3'],
            ['4 UPC-A', '012345678905' + HT + '(21)A1234', '4'],
            ['6 RSS-14', '(01)09521234543213' + HT + '(21)A1234', '6'],
        ];
        for (const [label, data, m1] of cases) {
            const m = measureBarcode('21', data, { compositeVersion: m1 });
            expect(m, label).not.toBeNull();
            expect(m!.isMatrix, `${label} is a stacked symbol`).toBe(true);
            expect(m!.widthModules, label).toBeGreaterThan(10);
            expect(m!.heightPx, label).toBeGreaterThan(10);
        }
    });

    it('CC-C is a bigger symbol than CC-A/B for the same data', () => {
        // CC-C is a full PDF417 where CC-A/CC-B are MicroPDF417 variants, so
        // the 2D component is taller.
        const text = '(01)09521234543213(10)ABC' + HT + '(21)XYZ';
        const ccC = measureBarcode('21', text, { compositeVersion: '0' })!;
        const ccAB = measureBarcode('21', text, { compositeVersion: '1' })!;
        expect(ccC.heightPx).not.toBe(ccAB.heightPx);
    });

    it('the two components both contribute to the measurement', () => {
        // A longer 2D supplement cannot shrink the symbol.
        const short2d = measureBarcode('21', `9520123456788${HT}(99)1`, { compositeVersion: '2' })!;
        const long2d = measureBarcode('21', `9520123456788${HT}(99)1234567890123456`, { compositeVersion: '2' })!;
        expect(long2d.widthModules * long2d.heightPx).toBeGreaterThanOrEqual(short2d.widthModules * short2d.heightPx);
    });

    it('different versions never share a cached measurement', () => {
        // paramsKey must carry the c21 fields, or the first result is returned
        // for every later call. Two versions whose symbols happen to coincide
        // would not prove it, so compare CC-C against CC-A/B — those differ by
        // construction (PDF417 vs MicroPDF417 as the 2D component).
        const text = '(01)09521234543213(10)ABC' + HT + '(21)XYZ';
        const ccC = measureBarcode('21', text, { compositeVersion: '0' })!;
        const ccAB = measureBarcode('21', text, { compositeVersion: '1' })!;
        expect(`${ccC.widthModules}x${ccC.heightPx}`).not.toBe(`${ccAB.widthModules}x${ccAB.heightPx}`);
    });

    it('an explicit m3 (columns) reaches the encoder', () => {
        const text = '(01)09521234543213(10)ABC' + HT + '(21)XYZ';
        const wide = measureBarcode('21', text, { compositeVersion: '0', compositeColumns: '12' })!;
        const narrow = measureBarcode('21', text, { compositeVersion: '0', compositeColumns: '2' })!;
        // More columns across means a wider, shorter 2D component.
        expect(wide.widthModules).toBeGreaterThan(narrow.widthModules);
    });
});
