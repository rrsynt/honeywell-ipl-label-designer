// TSPL (TSC Printer Language): the parser, the generator, and the places the
// language reaches into the rest of the app.
//
// Every table here is pinned to the **TSPL/TSPL2 Programming Manual** (TSC
// Auto ID, Copyright 2014). That matters more for TSPL than for the others:
// its barcode types are NAMES ("128", "EAN13", "CODA"), not the numbers EPL
// uses, so a table written from memory would put the wrong symbology on every
// barcode — exactly the mistake EPL's first pass made.
//
// Two TSPL-specific hazards this pins down:
//   * Rotation is CLOCKWISE (manual p. 77) while the IR quadrant is
//     counter-clockwise, so the value is negated in BOTH directions. 0 and 180
//     are their own inverses, which is why a one-case test would miss it.
//   * The escape is neither ZPL's doubling nor EPL's backslash-quote: a quote
//     and a backslash are each written as a backslash with a bracket (p. 77),
//     and a backslash with two digits is a DECIMAL ASCII code.
//
// There is NO independent oracle for TSPL — see tools/tspl-crosscheck.mjs.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTSPL, tokenizeTspl, unescapeTspl, TSPL_FONT_SIZES } from '../services/tspl/tsplParser';
import { generateTSPL, escapeTsplData } from '../services/tspl/tsplGenerator';
import { jobSendabilityError, renderJobChunk, type PrintJob } from '../services/printQueue';
import { validateTarget } from '../services/printTargets';
import type { Design } from '../types';

/** A single backslash. Writing these in a TS literal is how three attempts at
 *  the escape tests got the runtime string wrong, so they are built explicitly. */
const BS = String.fromCharCode(92);
type Rotation = 0 | 90 | 180 | 270;

// --- tokenizer --------------------------------------------------------------------

describe('TSPL tokenizer', () => {
    it('does not split a parameter on a comma inside the quoted payload', () => {
        const [cmd] = tokenizeTspl('TEXT 10,10,"2",0,1,1,"SMITH, JOHN"');
        expect(cmd.name).toBe('TEXT');
        expect(cmd.quoted).toEqual(['2', 'SMITH, JOHN']);
    });

    it('keeps an escaped quote inside the payload', () => {
        // A quote in the data is written \<bracket>, so BOTH quote marks need
        // one. An earlier version unescaped while still hunting for the closing
        // quote, which turned the escape back into a real delimiter and
        // truncated the field.
        const [cmd] = tokenizeTspl(`TEXT 10,10,"2",0,1,1,"say ${BS}[hi${BS}["`);
        expect(cmd.quoted).toEqual(['2', 'say "hi"']);
    });

    it('reads the quoted code type of a BARCODE', () => {
        const [cmd] = tokenizeTspl('BARCODE 10,50,"128",100,1,0,2,2,"12345"');
        expect(cmd.quoted).toEqual(['128', '12345']);
    });

    it('ignores a comment after the command', () => {
        const cmds = tokenizeTspl('CLS ; clear the buffer\nPRINT 1,1');
        expect(cmds.map(c => c.name)).toEqual(['CLS', 'PRINT']);
    });
});

describe('TSPL escapes', () => {
    it('prints a quote and a backslash from their bracket escapes', () => {
        // Manual p. 77: to print a double quote enter <bs>[ , for a backslash <bs>]
        expect(unescapeTspl(`say ${BS}[hi${BS}[`)).toBe('say "hi"');
        expect(unescapeTspl(`back${BS}]slash`)).toBe(`back${BS}slash`);
    });

    it('reads a backslash with two digits as a DECIMAL ASCII code', () => {
        expect(unescapeTspl(`${BS}65${BS}66`)).toBe('AB'); // 65=A, 66=B
    });
});

// --- the parser -------------------------------------------------------------------

describe('TSPL parser', () => {
    // The manual's own worked example (p. 47) — the closest thing to ground
    // truth this language has here.
    const manualSample = [
        'SIZE 50 mm,25 mm',
        'GAP 3 mm,0',
        'DIRECTION 1',
        'CLS',
        'BOX 60,60,610,210,4',
        'PRINT 1,1',
    ].join('\n');

    it('parses the manual example and takes the label size from SIZE', () => {
        const label = parseTSPL(manualSample);
        expect(label.widthDots).toBe(400);  // 50mm at 203dpi (8 dots/mm)
        expect(label.heightDots).toBe(200); // 25mm
        expect(label.elements.map(e => e.kind)).toEqual(['box']);
        expect(label.issues.filter(i => i.level === 'error')).toHaveLength(0);
    });

    it('reads BOX as two corners, in either order', () => {
        const box = parseTSPL('CLS\nBOX 60,60,610,210,4').elements[0] as any;
        expect([box.kind, box.ox, box.oy, box.widthDots, box.heightDots, box.thicknessDots]).toEqual(['box', 60, 60, 550, 150, 4]);
        const flipped = parseTSPL('CLS\nBOX 610,210,60,60,4').elements[0] as any;
        expect([flipped.ox, flipped.oy, flipped.widthDots, flipped.heightDots]).toEqual([60, 60, 550, 150]);
    });

    it('reads the BOX corner radius when given', () => {
        expect((parseTSPL('CLS\nBOX 10,10,110,110,2,20').elements[0] as any).radiusDots).toBe(20);
    });

    it('reads BAR as a line, oriented by which side is longer', () => {
        const h = parseTSPL('CLS\nBAR 250,20,100,5').elements[0] as any;
        expect([h.kind, h.lengthDots, h.thicknessDots, h.f]).toEqual(['line', 100, 5, 0]);
        const v = parseTSPL('CLS\nBAR 250,20,5,100').elements[0] as any;
        expect([v.lengthDots, v.thicknessDots, v.f]).toEqual([100, 5, 1]);
    });

    it('NEGATES the rotation, because TSPL turns CLOCKWISE and the IR does not', () => {
        // Manual p. 77: "90: degrees, in clockwise direction". The IR's f1 is
        // counter-clockwise, so 90 clockwise is f3. Carrying the value across
        // unchanged would mirror every rotated field — and 0/180 look identical
        // either way, which is what makes this easy to ship broken.
        const at = (deg: number) => (parseTSPL(`CLS\nTEXT 10,10,"2",${deg},1,1,"X"`).elements[0] as any).f;
        expect(at(0)).toBe(0);
        expect(at(90)).toBe(3);   // NOT 1
        expect(at(180)).toBe(2);
        expect(at(270)).toBe(1);  // NOT 3
    });

    it('pins the resident font table from the manual', () => {
        expect(TSPL_FONT_SIZES['1']).toEqual({ width: 8, height: 12 });
        expect(TSPL_FONT_SIZES['2']).toEqual({ width: 12, height: 20 });
        expect(TSPL_FONT_SIZES['3']).toEqual({ width: 16, height: 24 });
        expect(TSPL_FONT_SIZES['4']).toEqual({ width: 24, height: 32 });
        expect(TSPL_FONT_SIZES['5']).toEqual({ width: 32, height: 48 });
        expect(TSPL_FONT_SIZES['8']).toEqual({ width: 14, height: 25 });
    });

    it('warns about a downloaded font rather than guessing at it', () => {
        const label = parseTSPL('CLS\nTEXT 10,10,"ROMAN.TTF",0,1,1,"X"');
        expect(label.elements).toHaveLength(1);
        expect(label.issues.some(i => i.code === 'tspl-font-download')).toBe(true);
    });

    it('reads the TEXT content as the LAST parameter, alignment or not', () => {
        // TEXT x,y,"font",rotation,x-mult,y-mult,[alignment,]"content" — the
        // alignment is optional, and the parser read a fixed p[6]. So a stream
        // WITH an alignment printed the alignment and lost the text:
        // TEXT 10,10,"2",0,1,1,1,"HELLO" drew "1", silently.
        //
        // The convention was already settled in this file: BARCODE, QRCODE and
        // PDF417 all read `p[p.length - 1]`. The control is the same label
        // without the alignment — if that ever stops yielding HELLO, this test
        // is not measuring what it claims.
        const textOf = (src: string) => (parseTSPL(src).elements[0] as any)?.source?.data;
        expect(textOf('CLS\nTEXT 10,10,"2",0,1,1,"HELLO"')).toBe('HELLO');
        expect(textOf('CLS\nTEXT 10,10,"2",0,1,1,1,"HELLO"')).toBe('HELLO');
        expect(textOf('CLS\nTEXT 10,10,"2",0,1,1,2,"HELLO"')).toBe('HELLO');
        // A comma inside a quoted payload must still not split anything.
        expect(textOf('CLS\nTEXT 10,10,"2",0,1,1,1,"SMITH, JOHN"')).toBe('SMITH, JOHN');
    });

    it('names a TEXT alignment it does not draw instead of dropping it', () => {
        // Alignment 0 is the left edge, which is where this renderer draws, so
        // it is genuinely nothing to report.
        expect(parseTSPL('CLS\nTEXT 10,10,"2",0,1,1,0,"X"').issues.map(i => i.code))
            .not.toContain('tspl-text-align');
        for (const align of [1, 2]) {
            const label = parseTSPL(`CLS\nTEXT 10,10,"2",0,1,1,${align},"X"`);
            expect(label.elements, `alignment ${align} must still draw the text`).toHaveLength(1);
            expect(label.issues.map(i => i.code), `alignment ${align}`).toContain('tspl-text-align');
        }
    });

    it('names a human-readable alignment it cannot draw, and stays quiet on left', () => {
        // BARCODE ... ,<hri>,<rotation>,<narrow>,<wide> — p4 is 0 none / 1 left
        // / 2 centre / 3 right. The IR carries only none/below/above, so 2 and
        // 3 collapsed to 1 and the digits drew from the symbol's left edge
        // silently. Left is genuinely what this draws, so it must NOT report —
        // that is the control: a warning fired on every mode would be noise.
        const codesOf = (hri: number) =>
            parseTSPL(`CLS\nBARCODE 10,50,"128",100,${hri},0,2,2,"12345"`).issues.map(i => i.code);
        expect(codesOf(0)).not.toContain('tspl-hri-align');
        expect(codesOf(1), 'left is what this preview draws').not.toContain('tspl-hri-align');
        for (const hri of [2, 3]) {
            expect(codesOf(hri), `hri ${hri} is not reproduced`).toContain('tspl-hri-align');
        }
    });

    it('names a QR manual-mode request instead of silently re-encoding', () => {
        // p4 A = automatic, M = manual. The encoder here always chooses the
        // encoding, so an M stream can produce a different module pattern (and
        // any mask the user asked for is not applied). A is the default and is
        // exactly what this does, so it stays silent.
        const codesOf = (mode: string) =>
            parseTSPL(`CLS\nQRCODE 10,10,M,4,${mode},0,"DATA"`).issues.map(i => i.code);
        expect(codesOf('A')).not.toContain('tspl-qr-manual-mode');
        expect(codesOf('M')).toContain('tspl-qr-manual-mode');
        // Either way the symbol is drawn — the warning is about how it encodes.
        expect(parseTSPL('CLS\nQRCODE 10,10,M,4,M,0,"DATA"').elements).toHaveLength(1);
    });

    it('maps the barcode TYPES BY NAME, which is what TSPL uses', () => {
        // Not numbers like EPL. A from-memory table would be wrong here.
        const symOf = (type: string, data = '12345') =>
            (parseTSPL(`CLS\nBARCODE 10,50,"${type}",100,1,0,2,2,"${data}"`).elements[0] as any)?.symbology;
        expect(symOf('128')).toBe('6');
        expect(symOf('128M')).toBe('6');
        expect(symOf('EAN128')).toBe('6');
        expect(symOf('25')).toBe('2');
        expect(symOf('25S')).toBe('3');
        expect(symOf('39')).toBe('0');
        expect(symOf('93')).toBe('1');
        expect(symOf('CODA')).toBe('4');
        expect(symOf('11')).toBe('5');
        expect(symOf('POST')).toBe('11');
    });

    it('carries the EAN/UPC variant the type names', () => {
        const verOf = (type: string, data: string) =>
            (parseTSPL(`CLS\nBARCODE 10,50,"${type}",100,1,0,2,2,"${data}"`).elements[0] as any)?.eanUpcVersion;
        expect(verOf('EAN13', '1234567890128')).toBe(2);
        expect(verOf('EAN8', '12345670')).toBe(1);
        expect(verOf('UPCA', '012345678905')).toBe(3);
        expect(verOf('UPCE', '1234567')).toBe(4);
    });

    it('marks 39C as Code 39 with a host check digit', () => {
        expect((parseTSPL('CLS\nBARCODE 10,50,"39C",100,1,0,2,2,"12345"').elements[0] as any).code39Mode).toBe('2');
    });

    it('reads the human-readable flag as below-or-nothing', () => {
        // TSPL: 0 none, 1 left, 2 center, 3 right — all BELOW the bar.
        const hriOf = (v: number) => (parseTSPL(`CLS\nBARCODE 10,50,"128",100,${v},0,2,2,"12345"`).elements[0] as any).hri;
        expect(hriOf(0)).toBe(0);
        expect(hriOf(1)).toBe(1);
        expect(hriOf(2)).toBe(1);
        expect(hriOf(3)).toBe(1);
    });

    it('names a known-but-unencodable type', () => {
        const label = parseTSPL('CLS\nBARCODE 10,50,"MSI",100,1,0,2,2,"12345"');
        expect(label.elements).toHaveLength(0);
        expect(label.issues.find(i => i.code === 'tspl-barcode-unencoded')?.message).toMatch(/MSI/);
    });

    it('notes that an add-on variant draws only the main symbol', () => {
        const label = parseTSPL('CLS\nBARCODE 10,50,"EAN13+5",100,1,0,2,2,"1234567890128"');
        expect(label.elements).toHaveLength(1);
        expect(label.issues.some(i => i.code === 'tspl-addon-ignored')).toBe(true);
    });

    it('draws QRCODE and PDF417, and reports the 2D it still cannot', () => {
        const qr = parseTSPL('CLS\nQRCODE 10,10,L,4,A,0,"x"');
        expect(qr.elements).toHaveLength(1);
        expect((qr.elements[0] as any).symbology).toBe('18');
        expect(qr.issues.filter(i => i.level === 'error')).toHaveLength(0);

        const pdf = parseTSPL('CLS\nPDF417 10,10,200,100,0,"x"');
        expect((pdf.elements[0] as any).symbology).toBe('12');

        // MAXICODE and AZTEC are in the language but not in this viewer yet,
        // and a bitmap is still a bitmap.
        const rest = parseTSPL('CLS\nMAXICODE 110,100,2,300,840,06810,7317,"x"\nAZTEC 10,10,3,"x"\nPUTBMP 10,10,"a.bmp"');
        expect(rest.issues.some(i => i.code === 'tspl-maxicode-unsupported')).toBe(true);
        expect(rest.issues.some(i => i.code === 'tspl-aztec-unsupported')).toBe(true);
        expect(rest.issues.some(i => i.code === 'tspl-bitmap-unsupported')).toBe(true);
    });

    it('says nothing about ordinary printer settings', () => {
        expect(parseTSPL('SIZE 50 mm,25 mm\nGAP 3 mm,0\nSPEED 4\nDENSITY 8\nCLS\nPRINT 1,1').issues).toHaveLength(0);
    });

    it('reads the print count into the settings', () => {
        expect(parseTSPL('CLS\nPRINT 3,1').settings.quantity).toBe(3);
    });

    it('warns that DIRECTION turns the whole label', () => {
        expect(parseTSPL('DIRECTION 1\nCLS').issues.some(i => i.code === 'tspl-direction')).toBe(true);
    });
});

// --- the generator ----------------------------------------------------------------

const design = (fields: unknown[], over: Partial<Design> = {}): Design => ({
    ...over,
    name: 'TSPL test',
    labelSettings: { width: 100, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'TTP-244', dpi: 203, quantity: 2, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields: fields as Design['fields'],
    dataSources: over.dataSources ?? [],
    nextId: 99,
    guides: { horizontal: [], vertical: [] },
} as unknown as Design);

const textField = (over: Record<string, unknown> = {}) => ({
    id: 1, type: 'text' as const, name: 'T', x: 10, y: 10, rotation: 0 as Rotation,
    dataSource: { type: 'fixed' as const, data: 'HELLO' },
    font: '0', fontSize: 12, h_mag: 1, w_mag: 1, ...over,
});
const barcodeField = (over: Record<string, unknown> = {}) => ({
    id: 2, type: 'barcode' as const, name: 'B', x: 10, y: 30, rotation: 0 as Rotation,
    dataSource: { type: 'fixed' as const, data: '12345' },
    symbology: '0', humanReadable: 'below', h_mag: 60, w_mag: 2, ...over,
});
const lines = (fields: unknown[]) => generateTSPL(design(fields)).tspl.split('\n');

describe('TSPL generator', () => {
    it('opens with SIZE/GAP/CLS and closes with PRINT <copies>', () => {
        const out = lines([textField()]);
        expect(out[0]).toMatch(/^SIZE /);
        expect(out[1]).toBe('GAP 3 mm,0');
        expect(out[2]).toBe('CLS');
        expect(out[out.length - 1]).toBe('PRINT 2,1');
    });

    it('emits TEXT with the TSPL font for the design font', () => {
        const t = lines([textField()]).find(l => l.startsWith('TEXT'))!;
        expect(t).toContain('"HELLO"');
        expect(t.split(',')[2]).toBe('"1"'); // design font '0' -> TSPL font 1
    });

    it('emits BARCODE with the type NAME, not a number', () => {
        const b = lines([barcodeField()]).find(l => l.startsWith('BARCODE'))!;
        expect(b.split(',')[2]).toBe('"39"');
        expect(b).toContain('"12345"');
    });

    it('picks the EAN/UPC name from the DATA LENGTH', () => {
        const typeOf = (data: string) => lines([barcodeField({ symbology: '7', dataSource: { type: 'fixed', data } })])
            .find(l => l.startsWith('BARCODE'))!.split(',')[2];
        expect(typeOf('1234567890128')).toBe('"EAN13"');
        expect(typeOf('12345670')).toBe('"EAN8"');
        expect(typeOf('012345678905')).toBe('"UPCA"');
        expect(typeOf('1234567')).toBe('"UPCE"');
    });

    it('skips an EAN/UPC of a length TSPL does not know, and says which', () => {
        const { tspl, warnings } = generateTSPL(design([barcodeField({ symbology: '7', dataSource: { type: 'fixed', data: '123' } })]));
        expect(tspl.split('\n').some(l => l.startsWith('BARCODE'))).toBe(false);
        expect(warnings.some(w => /digits/.test(w))).toBe(true);
    });

    it('NEGATES the rotation on the way out, the inverse of the parser', () => {
        const rotOf = (r: Rotation) => Number(lines([textField({ rotation: r })]).find(l => l.startsWith('TEXT'))!.split(',')[3]);
        expect(rotOf(0)).toBe(0);
        expect(rotOf(90)).toBe(270);
        expect(rotOf(180)).toBe(180);
        expect(rotOf(270)).toBe(90);
    });

    it('warns that "above" HRI prints below, and still prints it', () => {
        const { tspl, warnings } = generateTSPL(design([barcodeField({ humanReadable: 'above' })]));
        // TSPL's non-zero human-readable values are all below-the-bar alignments,
        // so emitting 0 would DROP the line — moving it is the lesser evil.
        expect(Number(tspl.split('\n').find(l => l.startsWith('BARCODE'))!.split(',')[4])).toBe(1);
        expect(warnings.some(w => /above/.test(w) && /below/.test(w))).toBe(true);
    });

    it('emits no HRI when none was asked for', () => {
        expect(lines([barcodeField({ humanReadable: 'none' })]).find(l => l.startsWith('BARCODE'))!.split(',')[4]).toBe('0');
    });

    it('emits BOX with the FAR CORNER', () => {
        const p = lines([{ id: 3, type: 'box', name: 'X', x: 5, y: 5, rotation: 0 as Rotation, width: 20, height: 10, thickness: 0.5 }])
            .find(l => l.startsWith('BOX'))!.slice(4).split(',').map(Number);
        expect(p[2] - p[0]).toBe(160); // 20mm at 203dpi
        expect(p[3] - p[1]).toBe(80);
    });

    it('KEEPS the corner radius, which TSPL boxes support', () => {
        // Unlike EPL, where a rounded box has to be warned about instead.
        const box = lines([{ id: 3, type: 'box', name: 'X', x: 5, y: 5, rotation: 0 as Rotation, width: 20, height: 10, thickness: 0.5, cornerRadius: 3 }])
            .find(l => l.startsWith('BOX'))!;
        expect(box.split(',')).toHaveLength(6);
        expect(Number(box.split(',')[5])).toBeGreaterThan(0);
    });

    it('emits BAR with the length on the axis the line runs along', () => {
        const lineField = (rot: Rotation) => ({ id: 4, type: 'line', name: 'L', x: 5, y: 40, rotation: rot, length: 40, thickness: 0.5 });
        const h = lines([lineField(0)]).find(l => l.startsWith('BAR'))!.slice(4).split(',').map(Number);
        expect(h[2]).toBeGreaterThan(h[3]);
        const v = lines([lineField(90)]).find(l => l.startsWith('BAR'))!.slice(4).split(',').map(Number);
        expect(v[3]).toBeGreaterThan(v[2]);
    });

    it('names an unsupported field type instead of dropping it silently', () => {
        const { tspl, warnings } = generateTSPL(design([{ id: 5, type: 'image', name: 'Logo', x: 1, y: 1, rotation: 0 as Rotation, width: 10, height: 10, data: '' }]));
        expect(warnings.some(w => /Logo/.test(w))).toBe(true);
        expect(tspl).toContain('PRINT 2,1'); // the rest of the label still prints
    });

    it('emits QRCODE and PDF417 for the 2D symbols TSPL has', () => {
        const qr = lines([barcodeField({ symbology: '18', name: 'QR', qrEcl: 'Q', w_mag: 4 })])
            .find(l => l.startsWith('QRCODE'))!;
        expect(qr.split(',')[2]).toBe('Q');   // the error-correction level reached it
        expect(qr).toContain(',4,');   // and the cell width
        expect(qr).toContain('"12345"');
        const pdf = lines([barcodeField({ symbology: '12', name: 'PDF', h_mag: 100 })])
            .find(l => l.startsWith('PDF417'))!;
        expect(pdf).toContain('"12345"');
    });

    it('names a 2D symbol TSPL does NOT have, rather than dropping it', () => {
        // TSPL has QRCODE, PDF417, MAXICODE and AZTEC — no DataMatrix.
        const { tspl, warnings } = generateTSPL(design([barcodeField({ symbology: '17', name: 'DM' })]));
        expect(tspl.split('\n').some(l => l.startsWith('BARCODE') || l.startsWith('QRCODE'))).toBe(false);
        expect(warnings.some(w => /Data Matrix/.test(w))).toBe(true);
    });

    it('escapes a quote and a backslash the TSPL way, and the parser undoes it', () => {
        expect(escapeTsplData('say "hi"')).toBe(`say ${BS}[hi${BS}[`);
        expect(escapeTsplData(`back${BS}slash`)).toBe(`back${BS}]slash`);
        const { tspl } = generateTSPL(design([textField({ dataSource: { type: 'fixed', data: `a"b${BS}c` } })]));
        expect((parseTSPL(tspl).elements[0] as any).source.data).toBe(`a"b${BS}c`);
    });

    it('ROUND TRIP: what it emits, the parser reads back as the same elements', () => {
        const { tspl } = generateTSPL(design([
            textField(), barcodeField(),
            { id: 3, type: 'box', name: 'X', x: 5, y: 5, rotation: 0 as Rotation, width: 20, height: 10, thickness: 0.5 },
            { id: 4, type: 'line', name: 'L', x: 5, y: 40, rotation: 0 as Rotation, length: 40, thickness: 0.5 },
        ]));
        const label = parseTSPL(tspl);
        expect(label.issues.filter(i => i.level === 'error')).toHaveLength(0);
        expect(label.elements.map(e => e.kind)).toEqual(['text', 'barcode', 'box', 'line']);
        expect((label.elements[1] as any).symbology).toBe('0'); // Code 39, back again
        expect(label.widthDots).toBeGreaterThan(0);             // SIZE reached the label
    });
});

// --- where TSPL reaches into the rest of the app -----------------------------------

describe('TSPL as a printer language', () => {
    it('is accepted by the printer-target form', () => {
        const { target, error } = validateTarget({ name: 'Line 1', host: '10.0.0.5', port: '9100', language: 'tspl' as never, dpi: 203 });
        expect(error).toBeNull();
        expect(target?.language).toBe('tspl');
    });

    it('REFUSES a record range, exactly as ZPL and EPL do', () => {
        // PRINT carries the copies, so a table-backed design would send one
        // record and drop the rest. The design needs a field LINKED to the
        // table AND named after a column: an unmapped table is not a job, and
        // a job with no records has nothing to refuse.
        const tableDesign = design([{
            ...textField({ name: 'SKU', dataSource: { type: 'linked', sourceId: 's1' } }),
        }], {
            dataSources: [{
                id: 's1', name: 'Table', type: 'table', columns: ['SKU'],
                rows: [{ SKU: 'A' }, { SKU: 'B' }], query: { filters: [], combine: 'and' },
            }],
        } as unknown as Partial<Design>);
        expect(jobSendabilityError(tableDesign, { language: 'tspl' })).toMatch(/TSPL.*record range/i);
        expect(jobSendabilityError(tableDesign, { language: 'ipl' })).toBeNull();
        expect(jobSendabilityError(design([textField()]), { language: 'tspl' })).toBeNull();
    });

    it('renders TSPL for a TSPL target — NOT IPL', () => {
        // The silent hazard: a branch that falls through to generateIPL would
        // send IPL commands to a TSC printer.
        const job = {
            id: 'j1', createdAt: 1, updatedAt: 1, designName: 'D', designChecksum: 'x',
            design: design([textField()]),
            recordFrom: 1, recordTo: 1, copies: 3, collation: 'collated',
            target: { id: 't', name: 'T', host: 'h', port: '9100', language: 'tspl', dpi: 203 },
            labels: 3, chunkCount: 1, sentChunks: 0, status: 'queued',
        } as unknown as PrintJob;

        return renderJobChunk(job, 0).then(stream => {
            expect(stream.startsWith('SIZE ')).toBe(true);   // TSPL opens with SIZE
            expect(stream).toContain('TEXT ');
            expect(stream).not.toContain('<STX>');            // definitely not IPL
            expect(stream).not.toContain('^XA');              // and not ZPL
            expect(stream.split('\n').pop()).toBe('PRINT 3,1');
        });
    });
});

// ---------------------------------------------------------------------------
// PRINTER_SETTINGS must be reachable by the tokenizer
// ---------------------------------------------------------------------------
//
// The list says which commands to ignore silently, because they are printer
// settings or jobs and put nothing on the label. A name in it that the
// tokenizer REJECTS is worse than useless: the command falls through to the
// "not a command this parser recognizes" warning instead, so a stream using it
// gets told off for something the parser meant to accept.
//
// SETPARTIAL_CUTTER was in exactly that state — the tokenizer's name rule was
// /^[A-Za-z][A-Za-z0-9]*$/, which has no underscore, so the name never reached
// the list that names it.
describe('every PRINTER_SETTINGS entry is reachable (2026-09-29)', () => {
    // Read the list out of the source so a new entry is covered automatically
    // rather than needing this test to be updated by hand.
    const settingsSet = (() => {
        const src = readFileSync(join(__dirname, '..', 'services', 'tspl', 'tsplParser.ts'), 'utf8');
        const body = src.slice(src.indexOf('const PRINTER_SETTINGS'), src.indexOf(']);', src.indexOf('const PRINTER_SETTINGS')));
        const names = [...body.matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)].map(m => m[1]);
        // 'BEep'.toUpperCase() is written as an expression, not a literal.
        if (body.includes("'BEep'.toUpperCase()")) names.push('BEEP');
        return [...new Set(names.map(n => n.toUpperCase()))];
    })();

    it('finds a plausible list to check', () => {
        expect(settingsSet.length).toBeGreaterThan(40);
        expect(settingsSet).toContain('SETPARTIAL_CUTTER');
        expect(settingsSet).toContain('BEEP');
    });

    it('recognizes every entry as a command (so none is called unreadable)', () => {
        const rejected: string[] = [];
        for (const name of settingsSet) {
            const cmd = tokenizeTspl(`${name} 1\n`)[0];
            if (!cmd || cmd.name === '') rejected.push(name);
        }
        expect(rejected, 'in PRINTER_SETTINGS but the tokenizer rejects them').toEqual([]);
    });

    it('still rejects a name that is not a command at all', () => {
        // The underscore allowance must not turn the rule into "accept anything".
        expect(tokenizeTspl('1X 5\n')[0].name).toBe('');
        expect(tokenizeTspl(' 5\n')[0].name).toBe('');
    });
});

// TSPL's 2D commands, checked against the guide's OWN command list.
//
// The manual is now in the repo as docs/manuals/TSPL_Programming_Guide_
// P1139068-01EN_outline.txt (the PDF's document outline, extracted because the
// page text is subset-font encoded). It names MPDF417 among the supported
// commands, which matters because this app has encoded the IR's '19' as
// micropdf417 for every other language all along — so the symbol was drawable
// and TSPL simply refused it, under a warning that named its IPL id.
describe('MicroPDF417 works in TSPL (2026-09-30)', () => {
    const design = (sym: string): Design => ({
        name: 'T',
        labelSettings: { width: 80, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
        printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'thermal-transfer', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
        fields: [{
            id: 1, type: 'barcode', name: 'BC', x: 10, y: 10, rotation: 0,
            dataSource: { type: 'fixed', data: '12345' }, symbology: sym,
            humanReadable: 'none', h_mag: 60, w_mag: 3,
        }],
        dataSources: [], nextId: 2, guides: { horizontal: [], vertical: [] },
    } as unknown as Design);

    it('names MPDF417 in the guide, so the parser must read it', () => {
        const guide = readFileSync(join(
            process.cwd(), 'docs', 'manuals',
            'TSPL_Programming_Guide_P1139068-01EN_outline.txt'), 'utf8');
        expect(guide, 'the guide the parser is checked against').toContain('MPDF417');

        const el = parseTSPL('CLS\nMPDF417 10,10,100,50,0,"DATA"').elements[0] as { symbology: string };
        expect(el?.symbology, "the IR's MicroPDF417 id").toBe('19');
    });

    it('reads MPDF417 by the manual syntax, not the PDF417 box', () => {
        // TSC manual: MPDF417 x,y,rotate,[Wn,][Hn,][Cn,]content. There is no
        // positional width or height — W and H are the module's dimensions,
        // letter-prefixed and optional (defaults 1 and 10).
        //
        // Reading it as PDF417 put the width where the rotation belongs:
        // MPDF417 10,10,100,50,0,DATA came out rotated 100 quadrants. The
        // round trip did not catch it because the generator wrote the same
        // wrong shape back, so both sides agreed on a reading the manual does
        // not support. The control is PDF417, which really does take the box.
        const read = (line: string) => parseTSPL(
            'SIZE 40 mm,30 mm' + '\n' + 'CLS' + '\n' + line + '\n' + 'PRINT 1,1' + '\n',
        ).elements[0] as { f: number; moduleDots: number; heightDots: number };

        const bare = read('MPDF417 10,10,0,"DATA"');
        expect(bare.f, 'the third parameter IS the rotation').toBe(0);
        expect(bare.moduleDots, 'Wn default').toBe(1);
        expect(bare.heightDots, 'Hn default').toBe(10);

        const dims = read('MPDF417 10,10,90,W3,H12,"DATA"');
        expect(dims.f, '90 degrees clockwise -> quadrant 3').toBe(3);
        expect(dims.moduleDots).toBe(3);
        expect(dims.heightDots).toBe(12);

        const pdf = read('PDF417 10,10,100,50,0,"DATA"');
        expect(pdf.f, 'PDF417 keeps its own shape: x,y,w,h,rotate').toBe(0);
        expect(pdf.heightDots).toBe(50);
    });

    it('generates MPDF417 and reads its own stream back', () => {
        const out = generateTSPL(design('19'));
        expect(out.warnings, 'it is drawable now, so nothing to warn about').toEqual([]);
        expect(out.tspl).toContain('MPDF417 ');
        // The round trip is the real claim: what we write, we can read.
        const back = parseTSPL(out.tspl);
        expect(back.issues.map(i => i.code), 'no unsupported-command noise').not.toContain('tspl-unsupported');
        expect((back.elements[0] as { symbology: string }).symbology).toBe('19');

        // And the SHAPE it writes is the manual's, not PDF417's. Without this
        // the round trip passes on a generator writing the wrong shape, because
        // only one side is being checked for it — which is exactly how the
        // wrong shape survived the first time.
        const line = out.tspl.split('\n').find(l => l.startsWith('MPDF417 '))!;
        const params = line.slice('MPDF417 '.length, line.indexOf(',"'));
        expect(params.split(',').length,
            `MPDF417 x,y,rotate,[Wn,][Hn,] — got "${params}"`).toBeLessThanOrEqual(5);
        // The third parameter is the rotation, so it must be one of the four
        // quadrants and never a dot width.
        const third = Number(params.split(',')[2]);
        expect([0, 90, 180, 270], `third parameter must be a rotation, got ${third}`)
            .toContain(third);
        // Any module words present must be letter-prefixed, as the manual writes
        // them (Wn / Hn / Cn), not positional numbers.
        for (const w of params.split(',').slice(3)) {
            expect(w, `"${w}" must be a W/H/C parameter, not a positional size`)
                .toMatch(/^[WHC]\d+$/);
        }
    });

    it('does not tell the user MaxiCode is absent while listing it as present', () => {
        // The old message said "...the language defines QRCODE, PDF417,
        // MAXICODE and AZTEC, and this one is not among them", and it fired
        // for MAXICODE. MaxiCode IS in TSPL — so the list was right and the
        // "not among them" was the lie. The fix is that the one symbol the
        // message handles, MaxiCode, must never reach this warning at all:
        // TSPL has it, so it belongs with the drawable ones or with an
        // explicit "not drawn yet", never with "the language does not have it".
        const warn = generateTSPL(design('14')).warnings[0];
        expect(warn, 'MaxiCode must not be reported as absent from TSPL')
            .not.toMatch(/does not have/);
        // The control, so this cannot pass by the warning simply disappearing:
        // a symbol TSPL really lacks still gets the absent wording.
        const dm = generateTSPL(design('17')).warnings[0];
        expect(dm, 'Data Matrix IS absent from TSPL').toMatch(/TSPL does not have/);
        // And MaxiCode says the OTHER reason, so the two cannot be confused.
        expect(warn, 'and MaxiCode must say the command exists').toMatch(/TSPL has the command/);
    });
});

// The guide's own spelling of each command must be the one the parser reads.
// A silence-list entry that can NEVER match is worse than a missing one: it
// silences nothing and the real command is reported as unrecognized, so the
// list looks like it covers a name it does not.
describe('every guide command name is READ by the parser (2026-09-30)', () => {
    const guide = readFileSync(join(process.cwd(), 'docs', 'manuals',
        'TSPL_Programming_Guide_P1139068-01EN_outline.txt'), 'utf8')
        .split('\n').map(s => s.trim()).filter(Boolean);
    const from = guide.indexOf('Supported Commands');
    // The outline mixes headings into this run; keep the ones shaped like a
    // command name (no spaces, no lowercase prose).
    const official = guide.slice(from + 1)
        .filter(c => c && c !== 'TSPL Programming Guide' && /^[A-Z@~<][A-Za-z0-9_$()!?~<>\.@-]*$/.test(c))
        .filter(c => !/^(Contents|Introduction|Overview|Enable|Configuring|Supported|TSPL)/.test(c));

    it('finds the guide list to check against — positive control', () => {
        // Without this, a filter that matched nothing would make the rest
        // vacuous. These are commands the guide definitely names.
        expect(official.length, 'the guide list must be readable').toBeGreaterThan(30);
        for (const known of ['TEXT', 'BARCODE', 'BOX', 'ERASE', 'BLINEDETECT', 'GAP']) {
            expect(official, `the guide must name ${known}`).toContain(known);
        }
    });

    it('spells BLINEDETECT the guide\'s way, so the real command is silenced', () => {
        // The list carried BLINDDETECT — two D's — which cannot ever match the
        // guide's BLINEDETECT. The tokenizer takes names verbatim, so the real
        // command was reported unrecognized while the misspelling silenced
        // nothing at all.
        expect(tokenizeTspl('BLINEDETECT 1\n')[0].name).toBe('BLINEDETECT');
        expect(parseTSPL('SIZE 40 mm,30 mm\nBLINEDETECT\nPRINT 1,1\n').issues)
            .toHaveLength(0);
    });

    it('reports ERASE instead of letting it clear the image in silence', () => {
        // ERASE clears a rectangle of the image — the same family as IPL's LE
        // and EPL's LW, both already reported. In the silence list it produced
        // no element AND no issue, so a label whose overprint had been erased
        // previewed with the overprint still on it.
        const r = parseTSPL('SIZE 40 mm,30 mm\nCLS\nBOX 10,10,100,60,3\nERASE 10,10,50,30\nPRINT 1,1\n');
        const hit = r.issues.find(i => i.code === 'tspl-erase-clears');
        expect(hit, 'ERASE changes the image and must say so').toBeDefined();
        expect(hit!.level).toBe('warning');
        expect(hit!.message).toContain('50x30');
        expect(hit!.message).toContain('10,10');
        // The control: the BOX it would have erased is still drawn, which is
        // exactly why the message is needed.
        expect(r.elements.length, 'the box is still there — nothing was erased').toBe(1);
    });
});

// The remaining guide commands have no dedicated handling, and that is
// deliberate: each is a PRINTER ACTION — self-test, detect media, initialise,
// end-of-print — that puts nothing on the label, so "not part of the supported
// subset, so it has no effect here" is the honest sentence for them.
//
// They are pinned because the failure this file keeps meeting is the opposite:
// a command that DOES draw sitting in a silence list, so it produces no element
// and no issue. These must stay NAMED; if one is ever added to
// PRINTER_SETTINGS it stops saying anything, and this test is what notices.
describe('printer-action commands stay named, not silenced (2026-09-30)', () => {
    const stx = (f: string) => `${f}\n`;
    for (const name of ['INITIALPRINTER', 'SELFTEST', 'AUTODETECT', 'EOP']) {
        it(`reports ${name} rather than dropping it`, () => {
            const r = parseTSPL(`SIZE 40 mm,30 mm\n${stx(name)}PRINT 1,1\n`);
            expect(r.elements, `${name} draws nothing`).toHaveLength(0);
            expect(r.issues.map(i => i.code),
                `${name} is a printer action and must say so, not vanish`).toContain('tspl-unsupported');
        });
    }

    it('the control: a command that DOES draw is not merely named', () => {
        // Without a drawing case
        // the suite above would pass on a parser that reported EVERYTHING, so
        // this proves the distinction the batch rests on.
        const drawn = parseTSPL('SIZE 40 mm,30 mm\nCLS\nBOX 10,10,100,60,3\nPRINT 1,1\n');
        expect(drawn.elements, 'BOX really draws').toHaveLength(1);
        expect(drawn.issues, 'and draws without complaint').toHaveLength(0);
    });
});

// The TSPL PDF417 option block, from the TSC manual p. 56: P compression,
// E error correction, M centre pattern, Ux,y,c human-readable position,
// W module width 2-9, H bar height 4-99, R/C maximum rows/columns,
// T truncation, Lm expression length.
//
// All of them were read past. Measured before the fix: E3, W4, H80, T1, C5 and
// every option together produced byte-identical elements to the bare command,
// under no message — including W and H, which are the symbol's physical size.
describe('TSPL PDF417 reads its option block (2026-09-30)', () => {
    const el = (opts: string) => parseTSPL(
        `SIZE 80 mm,50 mm\nCLS\nPDF417 10,10,400,200,0${opts},"DATA"\nPRINT 1,1\n`,
    ).elements[0] as { heightDots: number; moduleDots: number; pdfEcLevel?: string; pdfTruncate?: string };
    const codes = (opts: string) => parseTSPL(
        `SIZE 80 mm,50 mm\nCLS\nPDF417 10,10,400,200,0${opts},"DATA"\nPRINT 1,1\n`,
    ).issues.map(i => i.code);

    it('takes the module width from W and the bar height from H', () => {
        expect(el(',W4').moduleDots, 'W is the module width').toBe(4);
        expect(el(',H80').heightDots, 'H is the bar height').toBe(80);
        // The control: with neither, the positional height is used unchanged.
        expect(el('').heightDots).toBe(200);
    });

    it('carries the error-correction level and truncation to the encoder', () => {
        expect(el(',E3').pdfEcLevel).toBe('3');
        expect(el(',T1').pdfTruncate).toBe('1');
    });

    it('names the options it cannot reproduce instead of dropping them', () => {
        // P, M, U, R and L have no IR slot. Silence about them is what let the
        // whole block go unnoticed in the first place.
        const c = codes(',P1,M1,U10,20,5,R30,L5');
        expect(c, 'the unapplied options must be named').toContain('tspl-pdf417-options');
        // The control: a stream with none of them says nothing extra.
        expect(codes(',E3,W3')).not.toContain('tspl-pdf417-options');
    });

    it('bounds W and H to the ranges the manual gives', () => {
        // W 2-9 and H 4-99; a stream outside that is clamped rather than
        // producing a symbol of zero or negative size.
        expect(el(',W0').moduleDots, 'W floor is 2').toBe(2);
        expect(el(',W99').moduleDots, 'W ceiling is 9').toBe(9);
        expect(el(',H0').heightDots, 'H floor is 4').toBe(4);
    });
});

// The TSPL QRCODE option tail, from the TSC guide p. 65:
//   QRCODE x,y,ECC,cell width,mode,rotation,[justification,][model,][mask,][area,]"content"
//   [model]  M1 original, M2 enhanced   — DIFFERENT SYMBOL
//   [mask]   S0-S8, default S7          — DIFFERENT PATTERN
//   [justification] J1-J9 and [area] Xn are placement only
//
// M1/M2 and S0-S8 change what is encoded and none of it was read: measured,
// M2, S3, J5, X100 and all of them together produced byte-identical elements to
// the bare command.
describe('TSPL QRCODE reads its option tail (2026-09-30)', () => {
    const el = (opts: string) => parseTSPL(
        `SIZE 80 mm,50 mm\nCLS\nQRCODE 10,10,M,4,A,0${opts},"DATA"\nPRINT 1,1\n`,
    ).elements[0] as { qrModel?: string; qrMask?: string };
    const codes = (opts: string) => parseTSPL(
        `SIZE 80 mm,50 mm\nCLS\nQRCODE 10,10,M,4,A,0${opts},"DATA"\nPRINT 1,1\n`,
    ).issues.map(i => i.code);

    it('carries the model and the mask into the encoder', () => {
        expect(el(',M2').qrModel).toBe('2');
        expect(el(',S3').qrMask, 'Sn maps straight through').toBe('3');
        // The control: with neither, both stay absent and nothing is said.
        expect(el('').qrModel).toBeUndefined();
        expect(el('').qrMask).toBeUndefined();
        expect(codes('')).toEqual([]);
    });

    it('says M1 has no encoder instead of drawing it as M2 silently', () => {
        // Only model 2 has an encoder here — the same limitation IPL's c18,m1
        // documents — so a stream asking for M1 must be told.
        expect(codes(',M1')).toContain('tspl-qr-model1');
        expect(el(',M1').qrModel, 'M2 is what gets drawn').toBe('1');
    });

    it('names a mask outside S0-S8 rather than passing it on', () => {
        expect(codes(',S9')).toContain('tspl-qr-mask');
        expect(el(',S9').qrMask).toBeUndefined();
    });

    it('names the placement options it cannot apply', () => {
        // J and X place the symbol within a box; this preview draws from the
        // field's own origin. Naming them is what keeps a silent drop from
        // looking like agreement.
        expect(codes(',J5')).toContain('tspl-qr-placement');
        expect(codes(',X100')).toContain('tspl-qr-placement');
        // The control: neither present means no placement message.
        expect(codes(',M2,S3')).not.toContain('tspl-qr-placement');
    });
});

// MPDF417's option block is Wn/Hn/Cn — the module width, module height and
// COLUMN COUNT. Cn was the last of the three still unread: measured, C2 and C4
// produced an auto-sized symbol identical to the bare command, so a stream that
// fixed the column count got whatever the printer chose.
//
// Cn's domain is the same as IPL's c19,m1 — 0-4, with 0 meaning automatic
// ("0: Automode. 1: Column is 1... 4: Column is 4").
describe('TSPL MPDF417 reads Cn, the column count (2026-09-30)', () => {
    const el = (opts: string) => parseTSPL(
        `SIZE 80 mm,50 mm\nCLS\nMPDF417 10,10,0${opts},"DATA"\nPRINT 1,1\n`,
    ).elements[0] as { microColumns?: string };
    const codes = (opts: string) => parseTSPL(
        `SIZE 80 mm,50 mm\nCLS\nMPDF417 10,10,0${opts},"DATA"\nPRINT 1,1\n`,
    ).issues.map(i => i.code);

    it('carries the column count to the encoder', () => {
        expect(el(',C2').microColumns).toBe('2');
        expect(el(',C4').microColumns).toBe('4');
        // The control: no Cn means the printer chooses, which is what Cn=0
        // says too — so neither may report anything.
        expect(el('').microColumns).toBeUndefined();
        expect(codes('')).toEqual([]);
    });

    it('names a column count outside 0-4 instead of passing it on', () => {
        expect(codes(',C5')).toContain('tspl-mpdf417-columns');
        expect(el(',C5').microColumns, 'an out-of-domain value is not a column count').toBeUndefined();
    });

    it('reads all three options together', () => {
        // W/H were wired earlier; this is the case that proves the third did
        // not get lost between them.
        const e = parseTSPL('SIZE 80 mm,50 mm\nCLS\nMPDF417 10,10,0,W3,H12,C2,"DATA"\nPRINT 1,1\n')
            .elements[0] as { microColumns?: string; moduleDots: number; heightDots: number };
        expect(e.microColumns).toBe('2');
        expect(e.moduleDots, 'W3').toBe(3);
        expect(e.heightDots, 'H12').toBe(12);
    });
});
