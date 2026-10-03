import { describe, expect, it } from 'vitest';
import './golden/setup';
import { parseZPL, unescapeFd } from '../services/zpl/zplParser';
import { generateZPL } from '../services/zpl/zplGenerator';
import { resolveLabelAtBatch } from '../services/ipl/odometer';
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
        expect(el.symbology).toBe('6'); // IR id for Code 128, not the bcid name
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
        expect(b3.symbology).toBe('0');  // IR id for Code 39
        expect(b3.hri).toBe(0);
        expect(bq.symbology).toBe('18'); // QR Code
        expect(bx.symbology).toBe('17'); // DataMatrix
    });

    it('emits NUMERIC IR ids, which the shared encoder actually paints', async () => {
        // The table held bcid NAMES ('code128'), and buildBwipSpec switches on
        // the numeric ids — so every ZPL barcode drew ZERO ink with no issue.
        // Measured: the same Code 128 gave 4320 ink pixels from IPL (c6) and 0
        // from ZPL. This guards the FORM of the value, not just that a field
        // exists, because a field whose symbology the encoder cannot resolve is
        // drawn as nothing — the silent failure this suite exists to catch.
        const { buildBwipSpec } = await import('../services/ipl/barcodes');
        for (const stream of ['^XA^FO0,0^BCN,60,N,N,N^FD123456^FS^XZ', '^XA^FO0,0^B3N,N,60,N,N^FD12345^FS^XZ']) {
            const el = parseZPL(stream).elements[0] as BarcodeElement;
            expect(buildBwipSpec(el.symbology, '123456'), `symbology "${el.symbology}" must resolve`).not.toBeNull();
        }
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

    it('draws ^GC, ^GE and ^GD — and the oracle pins WHICH parameter is which', () => {
        // No ZPL manual is in this repo, so the parameter meanings were settled
        // by PROBING Labelary (the real ZPL printer) and measuring the ink box:
        //   ^GC 100,4  -> 100x100      ^GC 200,4  -> 200x200   (p1 = DIAMETER)
        //   ^GC 100,20 -> 100x100                              (p2 changes nothing)
        //   ^GE 200,100,4 -> 200x100   ^GE 100,200,4 -> 100x200 (p1,p2 = AXES)
        //   ^GD 200,100,4 -> 202x100   ^GD 200,100,20 -> 218x100
        // The last pair is the evidence ^GD is a DIAGONAL and not a box: its
        // thickness EXPANDS the ink, where ^GB's border does not.
        const el = (zpl: string) => parseZPL(`^XA^FO50,50${zpl}^FS^XZ`).elements[0] as any;

        const gc = el('^GC100,4');
        expect(gc.kind).toBe('ellipse');
        expect([gc.widthDots, gc.heightDots], 'a circle is equal axes').toEqual([100, 100]);
        expect(gc.thicknessDots).toBe(4);
        const gc2 = el('^GC200,4');
        expect(gc2.widthDots, 'the first value IS the diameter').toBe(200);

        const ge = el('^GE200,100,4');
        expect(ge.kind).toBe('ellipse');
        expect([ge.widthDots, ge.heightDots], 'the axes are read in order').toEqual([200, 100]);
        const ge2 = el('^GE100,200,4');
        expect([ge2.widthDots, ge2.heightDots]).toEqual([100, 200]);

        const gd = el('^GD200,100,4');
        expect(gd.kind).toBe('diagonal');
        expect(gd.thicknessDots).toBe(4);
        // The line runs corner to corner of the w x h box.
        expect(Math.abs(gd.ex - gd.ox)).toBe(200);
        expect(Math.abs(gd.ey - gd.oy)).toBe(100);

        // A shape with no ^FO has nowhere to go, and says so.
        const lost = parseZPL('^XA^GC100,4^FS^XZ');
        expect(lost.elements).toHaveLength(0);
        expect(lost.issues.map(i => i.code)).toContain('zpl-shape-no-origin');
    });

    it('^SN advances the counter per label instead of drawing a static number', () => {
        // ^SN data,startIncrement,addLeadingZeros[,thenAddToYear] makes the
        // PRINTER serialise the field. The oracle confirms the first label
        // prints the data as given: ^SN001,1,Y and a plain ^FD001 rendered
        // identically (39x23, 486 ink), while ^SN001,1,N came out narrower
        // because it does not pad back to the data's width.
        //
        // The IR already models a printer-side counter: serialStep is the
        // per-field odometer step and resolveLabelAtBatch advances a field whose
        // data carries an <FS>/<GS> region. So the field's data is wrapped in
        // one — what the printer does to it — and the preview then steps it.
        const label = parseZPL('^XA^PW400^LL200^FO20,20^A0N,30,30^SN001,1,Y^FS^XZ');
        const el = label.elements[0] as TextElement;
        expect(el.kind).toBe('text');
        expect(el.serialStep, 'the step rides on the element').toBe(1);

        // The whole point: batch N shows N steps on, not a constant.
        const at = (batch: number) =>
            resolveLabelAtBatch(label, batch, DPI).elements[0] as TextElement;
        const shown = (batch: number) => (at(batch).source as { data: string }).data;
        expect(shown(0)).toBe('001');
        expect(shown(1)).toBe('002');
        expect(shown(2)).toBe('003');
        expect(label.issues.map(i => i.code), 'nothing to complain about').toEqual([]);

        // A plain ^FD field must NOT serialise — the step is ^SN's alone.
        const plain = parseZPL('^XA^FO20,20^A0N,30,30^FD001^FS^XZ');
        expect((plain.elements[0] as TextElement).serialStep).toBeUndefined();
        expect((resolveLabelAtBatch(plain, 2, DPI).elements[0] as TextElement).source)
            .toEqual({ type: 'fixed', data: '001' });

        // The year parameter is named rather than silently ignored.
        const year = parseZPL('^XA^FO20,20^A0N,30,30^SN001,1,Y,1^FS^XZ');
        expect(year.issues.map(i => i.code)).toContain('zpl-sn-year');
    });

    it('draws ^GF, and the oracle pins the field order and the bit order', () => {
        // No ZPL manual is in this repo, so ^GFa,totalBytes,bytesTotal,
        // bytesPerRow,<data> was settled by PROBING the oracle:
        //   ^GFA,16,16,2, FFx16 -> 16x8   |  ^GFA,16,2,2, FFx16 -> 16x1
        //     so p2 CAPS how much is drawn and p3 (bytesPerRow) fixes the shape
        //     — 16 bytes over 2 per row is 8 rows of 16 dots;
        //   ^GFA,999,16,2, FFx16 -> 16x8, so p1 is ignored;
        //   ^GFA,8,8,0, FFx8 -> 8x16, so a ZERO p3 flows bytes down instead;
        //   ^GFA,8,8,1,80… put its dot at the LEFT edge and 01… at the right,
        //     so dots run from the HIGH bit.
        // Our render of the diagonal 8040201008040201 was then identical to the
        // oracle's, pixel for pixel.
        const gf = (body: string) => parseZPL(`^XA^FO20,20${body}^FS^XZ`).elements[0] as any;

        const solid = gf('^GFA,8,8,1,FFFFFFFFFFFFFFFF');
        expect(solid.kind).toBe('graphic');
        expect([solid.widthDots, solid.heightDots], 'one byte per row is 8 dots wide').toEqual([8, 8]);
        expect(solid.rows, 'the first byte run is the TOP row').toHaveLength(8);

        // p3 sets the shape: 16 bytes at 2 per row is 8 rows of 16 dots.
        const wide = gf('^GFA,16,16,2,' + 'FF'.repeat(16));
        expect([wide.widthDots, wide.heightDots]).toEqual([16, 8]);

        // p2 CAPS the data: only p2 bytes are drawn.
        const capped = gf('^GFA,16,2,2,' + 'FF'.repeat(16));
        expect(capped.heightDots, 'p2 bytes over 2 per row is 1 row').toBe(1);

        // p1 is ignored — the printer sizes from p3, not from the total.
        expect(gf('^GFA,999,16,2,' + 'FF'.repeat(16)).heightDots).toBe(8);

        // A zero p3 is not "no shape": each byte becomes a row of 8.
        const flowed = gf('^GFA,8,8,0,FFFFFFFFFFFFFFFF');
        expect([flowed.widthDots, flowed.heightDots]).toEqual([8, 8]);

        // The bit order is what makes the picture right rather than mirrored.
        // 0x80 is the LEFT dot and 0x01 the right one, so bit 7 comes first.
        const leftCol = gf('^GFA,8,8,1,8080808080808080');
        const rightCol = gf('^GFA,8,8,1,0101010101010101');
        expect(leftCol.rows[0].charCodeAt(0), 'the first dot is the high bit').toBe(0x80);
        expect(rightCol.rows[0].charCodeAt(0)).toBe(0x01);

        // A rotated field still has somewhere to go; a missing ^FO does not.
        const lost = parseZPL('^XA^GFA,8,8,1,FFFFFFFFFFFFFFFF^FS^XZ');
        expect(lost.elements).toHaveLength(0);
        expect(lost.issues.map(i => i.code)).toContain('zpl-gf-no-origin');

        // A compressed form is named rather than drawn as garbage.
        const comp = parseZPL('^XA^FO20,20^GFZ,8,8,1,abc^FS^XZ');
        expect(comp.issues.map(i => i.code)).toContain('zpl-gf-compressed');
        expect(comp.elements).toHaveLength(0);
    });

    it('draws ^FB as a wrapped paragraph, with every parameter oracle-checked', () => {
        // No ZPL manual is in this repo, so each parameter of
        // ^FB width,maxLines,lineSpacing,align was settled by PROBING the
        // oracle and measuring the ink:
        //   ^FB300,3,4,L -> 2 lines, extent 284 | ^FB150,3,4,L -> 3 lines, 131
        //     so p1 is the BOX WIDTH in dots — narrower wraps sooner;
        //   ^FB150,n for n = 1..4 drew exactly n lines (5 at n=6, where the
        //   text ran out), so p2 is a CAP that CUTS the continuation;
        //   spacing 0/2/10/30 -> ink height 39/41/49/69, so p3 is dots ADDED
        //   to the line pitch, not a replacement;
        //   L/C/R left the lines at x104/109/113 and J widened to the box edge,
        //   so p4 is per-line alignment.
        const para = (fb: string) =>
            parseZPL(`^XA^FO100,30${fb}^A0N,20,20^FDthe quick brown fox jumps over the lazy dog^FS^XZ`)
                .elements[0] as any;

        const wrapped = para('^FB300,3,4,L');
        expect(wrapped.wrapDots, 'p1 is the wrap width').toBe(300);
        expect(wrapped.maxLines).toBe(3);
        expect(wrapped.spaceDots, 'p3 is extra leading').toBe(4);
        expect(wrapped.align, 'p4 L is left, so it stays unset').toBeUndefined();

        // A paragraph's size IS its box: without this it would measure one
        // long line running off the label.
        expect(estimateElementSize(wrapped, DPI).lengthDots).toBe(300);

        // Alignment is carried as a NAME, because TSPL's BLOCK numbers it
        // 0/1 left, 2 centre, 3 right while its own TEXT uses 0 left, 1 centre,
        // 2 right — the same digit means different things across the commands.
        expect(para('^FB300,3,4,C').align).toBe('center');
        expect(para('^FB300,3,4,R').align).toBe('right');
        expect(para('^FB300,3,4,J').align).toBe('justify');
        expect(para('^FB300,3,4,L').align).toBeUndefined();

        // The line cap CUTS: the layout must not reserve height for lines that
        // are never drawn.
        const two = para('^FB150,2,4,L');
        const six = para('^FB150,6,4,L');
        expect(estimateElementSize(two, DPI).crossDots)
            .toBeLessThan(estimateElementSize(six, DPI).crossDots);

        // A field with no ^FB is NOT a paragraph and must never wrap.
        const plain = parseZPL('^XA^FO100,30^A0N,20,20^FDthe quick brown fox^FS^XZ').elements[0] as any;
        expect(plain.wrapDots).toBeUndefined();
        expect(plain.maxLines).toBeUndefined();

        // The hanging indent is named rather than silently dropped.
        const indented = parseZPL('^XA^FO100,30^FB300,3,4,L,20^A0N,20,20^FDtext^FS^XZ');
        expect(indented.issues.map(i => i.code)).toContain('zpl-fb-indent');
    });

    it('reads a matrix barcode\'s magnification from its own parameter, not ^BY', () => {
        // ^BY does not apply to the matrix commands at all; each states its
        // magnification in its own slot. Measured pixel-exact against Labelary
        // (8 dpmm), varying one slot at a time:
        //   ^BXN,2,200 -> 24px and ^BXN,6,200 -> 72px (12 modules) => ^BX p[1].
        //   ^BQN,2,5 -> 105px, ^BQN,2,6 -> 126px (21 modules) => ^BQ p[2], see
        //   the dedicated ^BQ test below — ^BQ's p[1] is its MODEL, not a size.
        const modOf = (zpl: string) => (parseZPL(zpl).elements[0] as BarcodeElement)?.moduleDots;
        for (const [mag, px] of [[2, 24], [6, 72]]) {
            expect(modOf(`^XA^FO0,0^BXN,${mag},200^FDHI^FS^XZ`), `^BX mag ${mag} (Labelary ${px}px = 12 modules)`)
                .toBe(mag);
        }
        // ^BY must not change either one — that is the whole correction.
        expect(modOf('^XA^FO0,0^BY4^BXN,2,200^FDHI^FS^XZ')).toBe(2);
        // The control: ^BY IS what sizes a 1D barcode, so it must still apply.
        expect(modOf('^XA^FO0,0^BY4^BCN,Y,Y,N,N^FD123^FS^XZ')).toBe(4);
    });

    it('^BQ is o,MODEL,MAGNIFICATION — a different layout from ^BX', () => {
        // Pixel-exact against Labelary, one slot varied at a time:
        //   ^BQN,2,5 -> 105px  ^BQN,2,6 -> 126px   ^BQN,2,9 -> 189px (21 modules each)
        //   ^BQN,6,5 -> 105px  ^BQN,5,6 -> 126px   -> the size follows p[2], NOT p[1]
        //   ^BQN,1,5 -> NO INK ^BQN,2,5 -> renders -> p[1] is the MODEL
        // Reading p[1] for both commands (the old code) sized a QR by its model
        // number, so ^BQN,2,6 and ^BQN,2,10 both read back magnification 2.
        const qr = (p: string) => parseZPL(`^XA^FO0,0^BQ${p}^FD1234567890^FS^XZ`).elements[0] as BarcodeElement;

        for (const [px, mag] of [[105, 5], [126, 6], [189, 9]] as const) {
            expect(qr(`N,2,${mag}`).moduleDots, `^BQN,2,${mag} (Labelary ${px}px = 21 modules)`).toBe(mag);
        }
        // p[1] is the model and must not be mistaken for a size: holding the
        // magnification at 5 while the model changes keeps the size at 5.
        for (const model of [1, 2, 3, 6]) {
            expect(qr(`N,${model},5`).moduleDots, `model ${model} must not resize`).toBe(5);
        }
        // ...and the model is carried, so the design round-trips.
        expect(qr('N,1,5').qrModel).toBe('1');
        expect(qr('N,2,5').qrModel).toBe('2');
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

    it('DRAWS a reversed field instead of only naming it', () => {
        // ^FR ("Field Reverse Print") lays a black box behind the field and
        // knocks the glyphs out white — a reversal of the field's own box,
        // which the IR expresses. This used to be reported as a thing the
        // preview could not do.
        const label = parseZPL('^XA^FO0,0^FR^A0N,20,20^FDHi^FS^XZ');
        expect((label.elements[0] as TextElement).kind, 'the field still draws').toBe('text');
        const rev = label.elements[1] as { kind: string; widthDots: number; heightDots: number };
        expect(rev.kind, 'and an inversion follows it').toBe('reverse');
        expect(rev.widthDots).toBeGreaterThan(0);
        expect(rev.heightDots).toBeGreaterThan(0);
        expect(label.issues.map(i => i.code), 'nothing to complain about').not.toContain('zpl-field-reverse');
        expect(label.issues.map(i => i.code)).not.toContain('zpl-unsupported');

        // The control: without ^FR there is no inversion at all.
        const plain = parseZPL('^XA^FO0,0^A0N,20,20^FDHi^FS^XZ');
        expect(plain.elements.map(e => e.kind)).toEqual(['text']);
    });

    it('a ^FR field that draws NOTHING must not invert the field before it', () => {
        // commitField bails when there is no data or no origin. Inverting
        // "the last element" unconditionally would then reach back and reverse
        // whatever was drawn before — which a field that prints nothing cannot do.
        const label = parseZPL('^XA^FO10,10^GB100,50,3^FS^FO99,99^FR^FD^FS^XZ');
        expect(label.elements.map(e => e.kind), 'the box survives un-inverted').toEqual(['box']);
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



// The 1D barcode commands do NOT share a parameter order. There is no ZPL
// manual in docs/manuals, so these were settled against LABELARY — the only
// independent ZPL renderer available here — by putting a large value in one
// position at a time and measuring the rendered symbol. Positions below are
// p[] INDICES (p[0] is the orientation):
//
//   ^B2 [1] -> height grows  ([2] only moves the HRI row)
//   ^BC [1] -> height grows  ([2] only moves the HRI row)
//   ^B3 [1] -> the CHECK DIGIT flag (changes the symbol; not the height)
//   ^B3 [2] -> height grows
//
// ^BC and ^B2 are therefore o,h,f,g while ^B3 is o,e,h,f,g. Reading all three
// alike took ^BC's and ^B2's HEIGHT for a human-readable flag.
describe('1D barcode slots differ per command, measured (2026-09-30)', () => {
    const el = (b: string) => parseZPL(`^XA^FO10,10^${b}^FD12345678^FS^XZ`).elements[0] as {
        heightDots: number; hri: number; code39Mode?: string;
    };

    it('reads ^B2 and ^BC height from p[1]', () => {
        for (const cmd of ['B2', 'BC']) {
            expect(el(`${cmd}N,150,N,N,N`).heightDots, `${cmd} p[1] IS the height`).toBe(150);
            // The control: p[2] is not, it only grows the HRI row.
            expect(el(`${cmd}N,N,150,N,N`).heightDots, `${cmd} p[2] is not`).toBe(10);
        }
    });

    it('reads ^B3 height from p[2], and its p[1] as the check digit', () => {
        expect(el('B3N,N,150,N,N').heightDots, 'p[2] IS the height').toBe(150);
        expect(el('B3N,150,N,N,N').heightDots, 'p[1] is the check digit').toBe(10);
        // The HRI flag is p[3] for ^B3, so p[1] must not be read as one.
        expect(el('B3N,150,N,N,N').hri, 'the check digit is not an HRI flag').toBe(0);
    });

    it('carries ^B3 e=Y as the Code 39 printer check digit', () => {
        // Labelary draws ^B3N,N,... and ^B3N,Y,... differently — e=Y adds the
        // mod-43 check character to the symbol — so it cannot be dropped. The
        // earlier "slot 2 changes nothing" note was measured with a NUMBER in
        // the slot, which a Y/N flag cannot take and which proved nothing.
        expect(el('B3N,Y,150,N,N').code39Mode, 'e=Y is the printer check digit').toBe('1');
        // The control: e=N adds nothing.
        expect(el('B3N,N,150,N,N').code39Mode).toBeUndefined();
        // And it is Code 39 only — ^BC's p[1] is a height, never a check mode.
        expect(el('BCN,150,N,N,N').code39Mode).toBeUndefined();
    });

    it('reads ^B2 at all, which it did not before', () => {
        // The generator has written ^B2 for the IR's '2' since it was written,
        // while this parser had no entry for it — so an Interleaved 2 of 5
        // design that went out as ZPL and came back lost its field, with only
        // "a barcode this viewer does not draw yet" to say so.
        const label = parseZPL('^XA^FO10,10^B2N,Y,N,N,N^FD12345678^FS^XZ');
        expect(label.elements, '^B2 must draw').toHaveLength(1);
        expect((label.elements[0] as { symbology: string }).symbology).toBe('2');
        expect(label.issues.map(i => i.code)).not.toContain('zpl-barcode-unsupported');
    });
});

describe('^GS — the symbol comes from the DATA, not a parameter', () => {
    // Probed against Labelary with ONE LETTER PER REQUEST (a 1.1 s gap for its
    // rate limit): A-E draw, and every letter from F to Z returned the flat
    // 793-byte empty label — so the set is exactly five. An earlier reading took
    // the first PARAMETER for a symbol selector, which is only the orientation
    // (N/R/I/B, like every other ZPL field), and concluded from that the shapes
    // could not be predicted. They can; they are selected by ^FD.
    const gs = (fd: string, params = 'N,80,80') =>
        parseZPL(`^XA^FO50,50^GS${params}^FD${fd}^FS^XZ`);

    it('draws the three that are ordinary Unicode characters', () => {
        // ®, © and ™ are in every font, so they are drawn as text rather than
        // approximated — which is what makes them worth doing at all.
        const cases: Array<[string, string]> = [['A', '®'], ['B', '©'], ['C', '™']];
        for (const [letter, glyph] of cases) {
            const lab = gs(letter);
            const text = lab.elements.find(e => e.kind === 'text') as TextElement | undefined;
            expect(text, `^${letter}`).toBeDefined();
            expect((text!.source as { data: string }).data, `^${letter}`).toBe(glyph);
        }
    });

    it('draws nothing for the two certification marks, and says why', () => {
        // D and E are the UL and CSA marks — third parties' logos held in the
        // printer's firmware, in no font this app ships. Approximating a
        // certification mark is worse than omitting it, so the difference is
        // named rather than filled in.
        for (const [letter, name] of [['D', 'UL'], ['E', 'CSA']] as const) {
            const lab = gs(letter);
            expect(lab.elements.filter(e => e.kind === 'text'), `^${letter}`).toHaveLength(0);
            const issue = lab.issues.find(i => i.code === 'zpl-gs-certification');
            expect(issue, `^${letter}`).toBeDefined();
            expect(issue!.message).toContain(name);
        }
    });

    it('ignores a letter the printer does not offer', () => {
        const lab = gs('F');
        expect(lab.elements.filter(e => e.kind === 'text')).toHaveLength(0);
        expect(lab.issues.map(i => i.code)).toContain('zpl-gs-unsupported');
        // and the message lists the real set rather than leaving it a mystery
        expect(lab.issues.find(i => i.code === 'zpl-gs-unsupported')!.message).toContain('A (®)');
    });

    it('reads the first PARAMETER as the orientation, which it is', () => {
        // The mistake this command's earlier reading made in reverse: taking a
        // parameter for something other than what it says.
        const r = gs('A', 'R,80,80');
        const text = r.elements.find(e => e.kind === 'text') as TextElement;
        expect(text.f, 'R rotates the field').toBe(1);
        const i = gs('A', 'I,80,80').elements.find(e => e.kind === 'text') as TextElement;
        expect(i.f).toBe(2);
    });

    it('sizes the glyph from the height parameter', () => {
        const small = gs('A', 'N,24,24').elements.find(e => e.kind === 'text') as TextElement;
        const big = gs('A', 'N,160,160').elements.find(e => e.kind === 'text') as TextElement;
        expect(big.pointSize!).toBeGreaterThan(small.pointSize!);
    });
});

// A ZPL size is in DOTS, and the preview renders at the resolution the reader
// picked. The parser converts that dot height to an IR point size, and the
// renderer turns the point size BACK into dots as `pointSize / 72 * dpi` — so
// the conversion and the render must use the SAME dpi, or the two disagree.
// Before this, the parser divided by a hardcoded 203: a `^A0N,50,50` (50 dots)
// was read as 18pt and DREW 75 dots at 300 dpi — every ZPL text field sized for
// a 203 dpi machine whatever the reader selected, while the same stream's
// barcode (sized straight in dots) stayed put. The class is the DPL parser's
// hardcoded-203 defect (see ipl-dpl-inline-stx-special-commands). The invariant:
// the SIZE A FIELD DRAWS IS THE SIZE THE STREAM DECLARED, at every dpi.
describe('a ZPL field draws the dot size the stream declared, at any dpi', () => {
    const drawnCrossDots = (code: string, dpi: number): number => {
        const el = parseZPL(code, dpi).elements[0];
        return estimateElementSize(el, dpi).crossDots;
    };

    it('keeps ^A0 outline text at its declared height across dpi', () => {
        // 50 dots tall, declared once; the rendered height must not grow with dpi.
        const code = '^XA^PW800^LL520^FO50,50^A0N,50,50^FDtext^FS^XZ';
        const at203 = drawnCrossDots(code, 203);
        const at300 = drawnCrossDots(code, 300);
        const at406 = drawnCrossDots(code, 406);
        for (const [dpi, h] of [[203, at203], [300, at300], [406, at406]] as const) {
            // 50 dots + line-height leading (~1.15 to 1.35), never 1.5x.
            expect(h, `at ${dpi} dpi`).toBeGreaterThanOrEqual(50);
            expect(h, `at ${dpi} dpi`).toBeLessThanOrEqual(70);
        }
        // The old code grew this ~1.5x per resolution step (50 -> 75 -> 102).
        expect(at300).toBeLessThan(at203 * 1.25);
    });

    it('reads the same dot height as the same point size at 203 dpi', () => {
        // The reference case the default argument protects: 30 dots == 11pt.
        const el = parseZPL('^XA^FO50,50^A0N,30,30^FDHello^FS^XZ').elements[0] as TextElement;
        expect(el.pointSize).toBe(Math.round(30 * 72 / 203));
    });

    it('scales the point size inversely with dpi, so the dots stay fixed', () => {
        const code = '^XA^PW800^LL520^FO50,50^A0N,50,50^FDtext^FS^XZ';
        const p203 = (parseZPL(code, 203).elements[0] as TextElement).pointSize!;
        const p300 = (parseZPL(code, 300).elements[0] as TextElement).pointSize!;
        const p406 = (parseZPL(code, 406).elements[0] as TextElement).pointSize!;
        expect(p203).toBeGreaterThan(p300);
        expect(p300).toBeGreaterThan(p406);
        // And each names the same physical size: pt/72*dpi == 50 dots.
        for (const [dpi, pt] of [[203, p203], [300, p300], [406, p406]] as const) {
            expect(Math.round((pt / 72) * dpi), `at ${dpi} dpi`).toBeGreaterThanOrEqual(45);
        }
    });

    it('leaves the barcode height alone, since it was already in dots', () => {
        // The control: a field sized directly in dots must be identical at every
        // dpi, which is what makes the text case a real asymmetry rather than a
        // general "sizes scale with dpi" behaviour.
        const code = '^XA^PW800^LL520^FO50,50^BY2^BCN,60,Y,N,N^FD123456^FS^XZ';
        expect(drawnCrossDots(code, 203)).toBe(drawnCrossDots(code, 300));
        expect(drawnCrossDots(code, 300)).toBe(drawnCrossDots(code, 406));
    });
});

// The other half of the QR error-correction prefix: a stream's `^FDH,<data>`
// must not have the prefix read as payload — it would print as literal text and
// be ENCODED into the symbol. Stripped into the IR's `qrEcl` instead.
describe('a QR ^FD error-correction prefix is read as a level, not as data', () => {
    const qr = (fd: string) => parseZPL(`^XA^FO20,20^BQN,2,5^FD${fd}^FS^XZ`).elements[0] as BarcodeElement;

    it('strips the prefix and carries the level', () => {
        for (const [fd, ecl] of [['H,1234567890', 'H'], ['L,1234567890', 'L'], ['Q,x', 'Q'], ['M,x', 'M']] as const) {
            const el = qr(fd);
            expect(el.qrEcl, fd).toBe(ecl);
            expect(el.source.type === 'fixed' && el.source.data, fd).toBe(fd.slice(2));
        }
    });

    it('leaves ordinary QR data alone', () => {
        const el = qr('1234567890');
        expect(el.qrEcl).toBeUndefined();
        expect(el.source.type === 'fixed' && el.source.data).toBe('1234567890');
        // and a lowercase business payload that merely starts with a letter
        const el2 = qr('Hello, world');
        expect(el2.qrEcl, 'only H/L/M/Q + comma counts').toBeUndefined();
        expect(el2.source.type === 'fixed' && el2.source.data).toBe('Hello, world');
    });

    it('does not touch a non-QR symbol whose data starts that way', () => {
        const el = parseZPL('^XA^FO20,20^BCN,60,Y,N,N^FDH,123^FS^XZ').elements[0] as BarcodeElement;
        expect(el.qrEcl).toBeUndefined();
        expect(el.source.type === 'fixed' && el.source.data).toBe('H,123');
    });

    it('ROUND TRIP: emit then parse keeps the level and the data apart', () => {
        const { zpl } = generateZPL({
            name: 'z', labelSettings: { width: 60, height: 40, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
            printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10, language: 'zpl' },
            fields: [{ id: 1, type: 'barcode', name: 'Q', x: 10, y: 10, rotation: 0, dataSource: { type: 'fixed', data: '9876543210' }, symbology: '18', humanReadable: 'none', h_mag: 40, w_mag: 2, qrEcl: 'H' }],
            dataSources: [], nextId: 9, guides: { horizontal: [], vertical: [] },
        } as never);
        const el = parseZPL(zpl, 203).elements[0] as BarcodeElement;
        expect(el.qrEcl).toBe('H');
        expect(el.source.type === 'fixed' && el.source.data).toBe('9876543210');
    });
});
