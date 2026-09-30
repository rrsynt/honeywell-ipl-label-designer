import { describe, expect, it } from 'vitest';
import { parseZPL, unescapeFd } from '../services/zpl/zplParser';
import { elementVisualBox, estimateElementSize } from '../services/ipl/renderer';
import type { TextElement, BarcodeElement, BoxElement, LineElement } from '../services/ipl/types';

const DPI = 203;

/** The visual top-left the renderer will actually draw at. */
const topLeft = (el: Parameters<typeof elementVisualBox>[0]) => {
    const b = elementVisualBox(el, DPI);
    return [b.x, b.y];
};

describe('unescapeFd', () => {
    it('turns \\& into a newline and leaves ordinary text alone', () => {
        expect(unescapeFd('a\\&b')).toBe('a\nb');
        expect(unescapeFd('plain')).toBe('plain');
    });

    it('decodes the hex byte form and the literal escapes', () => {
        expect(unescapeFd('\\_41\\_42')).toBe('AB');
        expect(unescapeFd('\\^ \\\\ \\~')).toBe('^ \\ ~');
    });
});

describe('parseZPL', () => {
    it('rejects input that is not a label', () => {
        const label = parseZPL('hello');
        expect(label.elements).toHaveLength(0);
        expect(label.issues.some(i => i.level === 'error' && i.code === 'zpl-no-label')).toBe(true);
    });

    it('reads the label size from ^PW and ^LL', () => {
        const label = parseZPL('^XA^PW800^LL520^XZ');
        expect(label.widthDots).toBe(800);
        expect(label.heightDots).toBe(520);
    });

    it('places an unrotated text field with its origin at the ^FO point', () => {
        const label = parseZPL('^XA^FO50,50^A0N,30,30^FDHello^FS^XZ');
        const el = label.elements[0] as TextElement;
        expect(el.kind).toBe('text');
        expect(el.source).toEqual({ type: 'fixed', data: 'Hello' });
        expect(el.f).toBe(0);
        expect(topLeft(el)).toEqual([50, 50]);
        // 30 dots tall at 203 dpi is 30 * 72/203 = 11pt, rounded.
        expect(el.pointSize).toBe(Math.round(30 * 72 / 203));
    });

    it('turns \\& inside ^FD into a second line', () => {
        const label = parseZPL('^XA^FO0,0^A0N,20,20^FDOne\\&Two^FS^XZ');
        const el = label.elements[0] as TextElement;
        expect(el.source.type === 'fixed' && el.source.data).toBe('One\nTwo');
    });

    it('keeps a ^ inside field data as data instead of reading it as a command', () => {
        const label = parseZPL('^XA^FO0,0^A0N,20,20^FD2^3=8^FS^XZ');
        const el = label.elements[0] as TextElement;
        expect(el.source.type === 'fixed' && el.source.data).toBe('2^3=8');
        expect(label.elements).toHaveLength(1);
    });

    it('stores a 90° field so the renderer draws its top-left at the ^FO point', () => {
        // ^FR would be the wrong command; ZPL rotates a field with ^A0R or ^FWR.
        const label = parseZPL('^XA^FO100,20^A0R,40,40^FDAB^FS^XZ');
        const el = label.elements[0] as TextElement;
        expect(el.f).toBe(1);
        expect(topLeft(el)).toEqual([100, 20]);
        // And the anchor is NOT the top-left: IPL quadrant 1 anchors at the
        // bottom of the rotated run, which is what makes the round trip work.
        expect(el.oy).toBeGreaterThan(20);
    });

    it('lets ^FW set the default orientation for a field that names none', () => {
        const label = parseZPL('^XA^FWR^FO10,10^A0,25,25^FDX^FS^XZ');
        expect((label.elements[0] as TextElement).f).toBe(1);
    });

    it('maps ^BC to Code 128 and honours the print-interpretation line flag', () => {
        const label = parseZPL('^XA^FO30,30^BY2,3,60^BCN,60,Y,N,N^FD123456^FS^XZ');
        const el = label.elements[0] as BarcodeElement;
        expect(el.kind).toBe('barcode');
        expect(el.symbology).toBe('code128');
        expect(el.heightDots).toBe(60);
        expect(el.moduleDots).toBe(2);
        expect(el.hri).toBe(1);
        expect(el.source).toEqual({ type: 'fixed', data: '123456' });
        expect(topLeft(el)).toEqual([30, 30]);
    });

    it('maps ^B3, ^BQ and ^BX onto the symbologies the renderer already paints', () => {
        const zpl = '^XA^FO0,0^B3N,N,50,N,N^FDABC^FS^FO0,80^BQN,2,4^FDMM,TEST^FS^FO0,160^BXN,5,200^FDXYZ^FS^XZ';
        const label = parseZPL(zpl);
        const [b3, bq, bx] = label.elements as BarcodeElement[];
        expect(b3.symbology).toBe('code39');
        expect(b3.hri).toBe(0);
        expect(bq.symbology).toBe('qrcode');
        expect(bx.symbology).toBe('datamatrix');
    });

    it('draws ^GB as a box, and as a line when one side is no thicker than the stroke', () => {
        const label = parseZPL('^XA^FO10,10^GB200,100,3^FS^FO10,130^GB200,3,3^FS^XZ');
        const box = label.elements[0] as BoxElement;
        expect(box.kind).toBe('box');
        expect(box.widthDots).toBe(200);
        expect(box.heightDots).toBe(100);
        expect(box.thicknessDots).toBe(3);
        expect(topLeft(box)).toEqual([10, 10]);
        const line = label.elements[1] as LineElement;
        expect(line.kind).toBe('line');
        expect(line.lengthDots).toBe(200);
        expect(line.thicknessDots).toBe(3);
    });

    it('carries ^GB rounding through as a corner radius', () => {
        const label = parseZPL('^XA^FO0,0^GB80,80,2,,4^FS^XZ');
        const box = label.elements[0] as BoxElement;
        expect(box.radiusDots).toBe(Math.round(40 * (4 / 8)));
    });

    it('reads a matrix barcode\'s magnification from its own parameter, not ^BY', () => {
        // ^BQ and ^BX put the MAGNIFICATION where the 1D commands put the
        // human-readable flag, and ^BY does not apply to them at all. Measured
        // against Labelary (8 dpmm): ^BQN,2,2 -> 42px, ^BQN,2,6 -> 126px,
        // ^BQN,2,10 -> 210px, all exactly 21 modules across, so the value moves
        // the MODULE and not the symbol; ^BXN,2 -> 24px and ^BXN,6 -> 72px, 12
        // modules. The old code took p[1] as an HRI flag and used ^BY's module
        // for both, so every size read back as ^BY's — and for ^BX, whose p[1]
        // is the only place its size is stated, that ignored it outright.
        const modOf = (zpl: string) => (parseZPL(zpl).elements[0] as BarcodeElement)?.moduleDots;
        for (const [mag, px] of [[2, 42], [6, 126], [10, 210]]) {
            expect(modOf(`^XA^FO0,0^BQN,${mag},5^FDQA,HI^FS^XZ`), `^BQ mag ${mag} (Labelary ${px}px = 21 modules)`)
                .toBe(mag);
        }
        for (const [mag, px] of [[2, 24], [6, 72]]) {
            expect(modOf(`^XA^FO0,0^BXN,${mag},200^FDHI^FS^XZ`), `^BX mag ${mag} (Labelary ${px}px = 12 modules)`)
                .toBe(mag);
        }
        // ^BY must not change either one — that is the whole correction.
        expect(modOf('^XA^FO0,0^BY4^BQN,2,5^FDQA,HI^FS^XZ')).toBe(2);
        expect(modOf('^XA^FO0,0^BY4^BXN,2,200^FDHI^FS^XZ')).toBe(2);
        // The control: ^BY IS what sizes a 1D barcode, so it must still apply.
        expect(modOf('^XA^FO0,0^BY4^BCN,Y,Y,N,N^FD123^FS^XZ')).toBe(4);
    });

    it('warns about a barcode it cannot draw instead of dropping it quietly', () => {
        const label = parseZPL('^XA^FO0,0^BEN,50,Y,N^FD123456789012^FS^XZ');
        expect(label.elements).toHaveLength(0);
        const issue = label.issues.find(i => i.code === 'zpl-barcode-unsupported');
        expect(issue?.level).toBe('warning');
        expect(issue?.command).toBe('^BE');
    });

    it('notes commands outside the supported subset and still renders the rest', () => {
        // ^MD is darkness — a printer setting that genuinely cannot change what
        // is drawn, so the generic "no effect here" line is the honest answer.
        // (^LH used to be this test's subject; it MOVES the image, so it now has
        // its own warning — see the shift test below.)
        const label = parseZPL('^XA^MD15^FO0,0^A0N,20,20^FDHi^FS^XZ');
        expect(label.elements).toHaveLength(1);
        expect(label.issues.some(i => i.code === 'zpl-unsupported' && i.command === '^MD')).toBe(true);
    });

    it('warns when a command shifts the whole image, and says by how much', () => {
        // ^LH ^LT ^LS offset every field on the media. Drawing them at their
        // ^FO coordinates regardless showed a label the printer would not
        // produce, under a message that implied nothing was wrong.
        for (const [ipl, code, command] of [
            ['^XA^LH20,20^FO0,0^A0N,20,20^FDHi^FS^XZ', 'zpl-image-shifted', '^LH'],
            ['^XA^LT10^FO0,0^A0N,20,20^FDHi^FS^XZ', 'zpl-image-shifted', '^LT'],
            ['^XA^LS25^FO0,0^A0N,20,20^FDHi^FS^XZ', 'zpl-image-shifted', '^LS'],
        ] as Array<[string, string, string]>) {
            const label = parseZPL(ipl);
            expect(label.elements, command).toHaveLength(1);
            const hit = label.issues.find(i => i.code === code && i.command === command);
            expect(hit, command).toBeDefined();
            expect(hit!.level, command).toBe('warning');
            expect(hit!.message, command).toMatch(/dot/);
        }
    });

    it('stays silent when a shift command is at its no-op value', () => {
        // ^LH0,0 is where the image already is, so there is nothing to report.
        const label = parseZPL('^XA^LH0,0^FO0,0^A0N,20,20^FDHi^FS^XZ');
        expect(label.issues.map(i => i.code)).not.toContain('zpl-image-shifted');
    });

    it('names a reversed field rather than sharing the harmless message', () => {
        const label = parseZPL('^XA^FO0,0^FR^A0N,20,20^FDHi^FS^XZ');
        expect(label.issues.map(i => i.code)).toContain('zpl-field-reverse');
        expect(label.issues.map(i => i.code)).not.toContain('zpl-unsupported');
    });

    it('parses only the first label of a multi-label stream and says so', () => {
        const label = parseZPL('^XA^FO0,0^A0N,20,20^FDOne^FS^XZ^XA^FO0,0^A0N,20,20^FDTwo^FS^XZ');
        expect(label.elements).toHaveLength(1);
        expect((label.elements[0] as TextElement).source).toEqual({ type: 'fixed', data: 'One' });
        expect(label.issues.some(i => i.code === 'zpl-extra-labels')).toBe(true);
    });

    it('still draws a field whose ^FS is missing, and warns about it', () => {
        const label = parseZPL('^XA^FO0,0^A0N,20,20^FDTail');
        expect(label.elements).toHaveLength(1);
        expect(label.issues.some(i => i.code === 'zpl-field-unclosed')).toBe(true);
        expect(label.issues.some(i => i.code === 'zpl-unterminated')).toBe(true);
    });

    it('measures a rotated field the same way it measures an unrotated one', () => {
        // The whole point of converting ^FO into the IR anchor: size must not
        // depend on which way the field points.
        const a = parseZPL('^XA^FO0,0^A0N,30,30^FDHello^FS^XZ').elements[0];
        const b = parseZPL('^XA^FO0,0^A0R,30,30^FDHello^FS^XZ').elements[0];
        expect(estimateElementSize(a, DPI)).toEqual(estimateElementSize(b, DPI));
    });
});
