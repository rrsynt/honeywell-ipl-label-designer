// EPL (Eltron Programming Language): the parser, the generator, and the places
// the language reaches into the rest of the app.
//
// Every table here is pinned to the **EPL2 Programmer's Manual (Zebra P/N
// 980352-001 Rev. D)**. That is not ceremony: a first implementation written
// from memory had the barcode type letters completely wrong (`1`=Code 39,
// `3`=Code 128), which would have printed every barcode as the wrong
// symbology. The tests below are the ones that would have caught it.
//
// The generator is checked against the parser (round trip) AND, in
// tools/epl-crosscheck.mjs, against an INDEPENDENT engine — because a parser
// and a generator that agree with each other can still both misread the spec.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseEPL, tokenizeEpl, unescapeEpl, EPL_FONT_SIZES } from '../services/epl/eplParser';
import { generateEPL, escapeEplData } from '../services/epl/eplGenerator';
import { jobSendabilityError, renderJobChunk, type PrintJob } from '../services/printQueue';
import { validateTarget } from '../services/printTargets';
import type { Design } from '../types';

// --- tokenizer --------------------------------------------------------------------

describe('EPL tokenizer', () => {
    it('does NOT split a parameter on a comma inside the quoted data', () => {
        // The manual's own example: those address commas are DATA, not separators.
        const [cmd] = tokenizeEpl('A674,033,1,1,1,1,N,"UNIT 7, SAMPLE PARK, EXAMPLE LANE"');
        expect(cmd.name).toBe('A');
        expect(cmd.params).toBe('674,033,1,1,1,1,N');
        expect(cmd.data).toBe('UNIT 7, SAMPLE PARK, EXAMPLE LANE');
        expect(cmd.params.split(',')).toHaveLength(7);
    });

    it('uses BACKSLASH escapes, not doubled quotes (manual p. 3-5)', () => {
        // EPL is not ZPL: \" prints a quote and \\ prints one backslash.
        expect(unescapeEpl('a\\"b')).toBe('a"b');
        expect(unescapeEpl('a\\\\b')).toBe('a\\b');
        expect(tokenizeEpl('A10,10,0,2,1,1,N,"say \\"hi\\""')[0].data).toBe('say "hi"');
    });

    it('does not mistake an escaped quote for the start of the payload', () => {
        // indexOf('"') would stop at the escaped quote and mis-split the params.
        const [cmd] = tokenizeEpl('A10,10,0,2,1,1,N,"a\\"b"');
        expect(cmd.params).toBe('10,10,0,2,1,1,N');
        expect(cmd.data).toBe('a"b');
    });

    it('reads a command name as LETTERS only, so A10,... is not "A10"', () => {
        // Letting the name swallow digits dropped every field in the first draft.
        const [cmd] = tokenizeEpl('A50,50,0,2,1,1,N,"X"');
        expect(cmd.name).toBe('A');
        expect(cmd.params).toBe('50,50,0,2,1,1,N');
    });

    it('collects variable, counter and clock tokens from an UNQUOTED field', () => {
        // Manual p. 3-4: A50,50,0,2,1,1,N,V01 — no quotes anywhere.
        expect(tokenizeEpl('A50,50,0,2,1,1,N,V01')[0].tokens).toEqual(['V01']);
        expect(tokenizeEpl('A50,100,0,3,1,1,N,C1+2')[0].tokens).toEqual(['C1+2']);
        expect(tokenizeEpl('A50,150,0,4,1,1,N,TT')[0].tokens).toEqual(['TT']);
        expect(tokenizeEpl('A50,200,0,5,1,1,N,TD')[0].tokens).toEqual(['TD']);
    });

    it('reads a bare N, ignores blank lines, and tolerates CRLF', () => {
        const cmds = tokenizeEpl('N\r\n\r\nA10,10,0,2,1,1,N,"X"\r\nP1\r\n');
        expect(cmds.map(c => c.name)).toEqual(['N', 'A', 'P']);
        expect(cmds[2].params).toBe('1'); // P takes the copy count as a parameter
    });
});

// --- the parser -------------------------------------------------------------------

describe('EPL parser', () => {
    const sample = ['N', 'A40,20,0,3,2,2,N,"HELLO EPL"', 'B40,70,0,3,2,4,70,B,"12345"', 'LO50,200,400,20', 'X40,220,4,340,300', 'P1'].join('\n');

    it('parses a whole label into the IR', () => {
        const label = parseEPL(sample);
        expect(label.elements.map(e => e.kind)).toEqual(['text', 'barcode', 'line', 'box']);
        expect(label.issues.filter(i => i.level === 'error')).toHaveLength(0);
    });

    it('maps barcode type 3 to Code 39 — NOT type 1, which is Code 128', () => {
        // Manual Table 2-1, p. 3-12. This is the assertion that matters most.
        const bc = parseEPL('N\nB10,10,0,3,2,2,60,B,"12345"').elements[0] as any;
        expect(bc.symbology).toBe('0'); // IR id 0 = code39
        expect(bc.hri).toBe(1);          // 'B' = human-readable below
    });

    it('maps the rest of the EPL type letters', () => {
        const symbolOf = (type: string, data = '12345') =>
            (parseEPL(`N\nB10,10,0,${type},2,2,60,B,"${data}"`).elements[0] as any)?.symbology;
        expect(symbolOf('1')).toBe('6');   // Code 128 auto
        expect(symbolOf('1A')).toBe('6');  // forced subset A
        expect(symbolOf('0')).toBe('6');   // UCC/SSCC
        expect(symbolOf('1E')).toBe('6');  // UCC/EAN 128
        expect(symbolOf('2')).toBe('2');   // ITF
        expect(symbolOf('2C')).toBe('2');  // ITF + mod10
        expect(symbolOf('E30', '1234567890128')).toBe('7');
        expect(symbolOf('UA0', '012345678905')).toBe('7');
    });

    it('carries the EAN/UPC variant the letter names', () => {
        const versionOf = (type: string, data: string) =>
            (parseEPL(`N\nB10,10,0,${type},2,2,60,B,"${data}"`).elements[0] as any)?.eanUpcVersion;
        expect(versionOf('E30', '1234567890128')).toBe(2); // ean13
        expect(versionOf('E80', '12345670')).toBe(1);      // ean8
        expect(versionOf('UA0', '012345678905')).toBe(3);  // upca
        expect(versionOf('UE0', '1234567')).toBe(4);       // upce
    });

    it('marks 3C as Code 39 whose check digit the host supplies', () => {
        expect((parseEPL('N\nB10,10,0,3C,2,2,60,B,"12345"').elements[0] as any).code39Mode).toBe('2');
    });

    it('names a known-but-unencodable type instead of saying "unknown"', () => {
        const named = (type: string) => parseEPL(`N\nB10,10,0,${type},2,2,60,B,"12345"`).issues.find(i => i.code === 'epl-barcode-unencoded')?.message;
        expect(named('9')).toMatch(/Code 93/);
        expect(named('K')).toMatch(/Codabar/);
        expect(named('PL')).toMatch(/Planet/);
        expect(named('M')).toMatch(/MSI-3/);
        // And such a field draws nothing rather than something wrong.
        expect(parseEPL('N\nB10,10,0,9,2,2,60,B,"12345"').elements).toHaveLength(0);
    });

    it('R offsets every element that follows it (manual p. 3-96)', () => {
        const t = parseEPL('N\nR100,50\nA10,10,0,2,1,1,N,"X"').elements[0] as any;
        expect(t.ox).toBe(110);
        expect(t.oy).toBe(60);
    });

    it('reads X as a box between two CORNERS, in either order', () => {
        const box = parseEPL('N\nX300,220,4,40,300').elements[0] as any;
        expect(box.kind).toBe('box');
        expect(box.widthDots).toBe(260);
        expect(box.heightDots).toBe(80);
        expect(box.ox).toBe(40);
        expect(box.oy).toBe(220);
        const flipped = parseEPL('N\nX40,300,4,300,220').elements[0] as any;
        expect([flipped.ox, flipped.oy, flipped.widthDots, flipped.heightDots]).toEqual([40, 220, 260, 80]);
    });

    it('reads LO as x,y,horizontal,vertical — the manual\'s own example', () => {
        // Manual p. 3-69: LO50,200,400,20 is 400 long and 20 thick.
        const h = parseEPL('N\nLO50,200,400,20').elements[0] as any;
        expect([h.lengthDots, h.thicknessDots, h.f]).toEqual([400, 20, 0]);
        const v = parseEPL('N\nLO200,50,20,400').elements[0] as any;
        expect([v.lengthDots, v.thicknessDots, v.f]).toEqual([400, 20, 1]);
    });

    it('pins the resident font sizes from the manual, and knows there is no font 0', () => {
        expect(EPL_FONT_SIZES[1]).toEqual({ width: 8, height: 12 });
        expect(EPL_FONT_SIZES[2]).toEqual({ width: 10, height: 16 });
        expect(EPL_FONT_SIZES[3]).toEqual({ width: 12, height: 20 });
        expect(EPL_FONT_SIZES[4]).toEqual({ width: 14, height: 24 });
        expect(EPL_FONT_SIZES[5]).toEqual({ width: 32, height: 48 });
        expect(EPL_FONT_SIZES[0]).toBeUndefined();
    });

    it('falls back for a soft font with a warning, said once for the whole label', () => {
        const label = parseEPL('N\nA10,10,0,A,1,1,N,"one"\nA10,50,0,A,1,1,N,"two"');
        expect(label.elements).toHaveLength(2);
        expect(label.issues.filter(i => i.code === 'epl-soft-font')).toHaveLength(1);
    });

    it('reports a variable field as a variable rather than inventing a value', () => {
        const t = parseEPL('N\nA50,50,0,2,1,1,N,V01').elements[0] as any;
        expect(t.source.type).toBe('variable');
        expect(t.source.data).toBe('');
    });

    it('carries the font multipliers into IR magnification', () => {
        const t = parseEPL('N\nA10,10,0,2,3,2,N,"BIG"').elements[0] as any;
        expect([t.hMag, t.wMag]).toEqual([3, 2]);
    });

    it('carries reverse printing through', () => {
        expect((parseEPL('N\nA10,10,0,2,1,1,R,"INV"').elements[0] as any).reverse).toBe(true);
    });

    it('draws the three 2D symbols EPL2 defines, by their type letter', () => {
        // Manual pp. 3-20 / 3-25 / 3-29: p3 is D=Data Matrix, M=MaxiCode,
        // P=PDF417. There is NO QR in EPL2 — not an omission here but a fact of
        // the language, whose contents list only those three.
        const byLetter = (letter: string) =>
            (parseEPL(`N
b10,20,${letter},"DATA"`).elements[0] as any)?.symbology;
        expect(byLetter('D')).toBe('17');
        expect(byLetter('M')).toBe('14');
        expect(byLetter('P')).toBe('12');
    });

    it('reads the letter-prefixed optional parameters of a 2D symbol', () => {
        // p4-p7 carry their own prefix (c columns, r rows, h module size,
        // v inverse) rather than being positional.
        expect((parseEPL('N\nb10,20,D,h7,"DATA"').elements[0] as any).moduleDots).toBe(7);
    });

    it('names an unknown 2D type, and says EPL has no QR at all', () => {
        const label = parseEPL('N\nb10,20,Z,"DATA"');
        expect(label.elements).toHaveLength(0);
        expect(label.issues.find(i => i.code === 'epl-2d-unsupported')?.message).toMatch(/no QR code/i);
    });

    it('reports the commands outside the subset by name', () => {
        const label = parseEPL('N\nGW10,10,20,5\nb10,10,Q,"x"\nLS50,200,20,400');
        expect(label.issues.some(i => i.code === 'epl-gw-unsupported')).toBe(true);
        expect(label.issues.some(i => i.code === 'epl-2d-unsupported')).toBe(true);
        expect(label.issues.some(i => i.code === 'epl-ls-unsupported')).toBe(true);
    });

    it('says nothing about ordinary printer settings', () => {
        expect(parseEPL('N\nQ203,25\nq400\nS4\nD8\nP1\nV01').issues).toHaveLength(0);
    });

    it('notes that LW erases rather than draws', () => {
        expect(parseEPL('N\nLW10,10,100,8').issues.some(i => i.code === 'epl-lw-erase')).toBe(true);
    });
});

// --- the generator ----------------------------------------------------------------

const design = (fields: Design['fields'], over: Partial<Design> = {}): Design => ({
    ...over,
    name: 'EPL test',
    labelSettings: { width: 100, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 2, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields,
    dataSources: over.dataSources ?? [],
    nextId: 99,
    guides: { horizontal: [], vertical: [] },
} as unknown as Design);

/** Rotation is a quarter-turn literal union on Field, so the helper must be typed. */
type Rotation = 0 | 90 | 180 | 270;

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
const withFields = (fields: unknown[]) => design(fields as unknown as Design["fields"]);
const eplLines = (fields: unknown[]) => generateEPL(withFields(fields)).epl.split('\n');

describe('EPL generator', () => {
    it('wraps the label with N ... P<copies> and the size commands', () => {
        const lines = eplLines([textField()]);
        expect(lines[0]).toBe('N');
        expect(lines.some(l => l.startsWith('q'))).toBe(true);
        expect(lines.some(l => l.startsWith('Q'))).toBe(true);
        expect(lines[lines.length - 1]).toBe('P2');
    });

    it('emits A for text, with the EPL font for the design font', () => {
        const a = eplLines([textField()]).find(l => l.startsWith('A'))!;
        expect(a).toContain('"HELLO"');
        expect(a.split(',')[3]).toBe('1');
    });

    it('emits B with type 3 for Code 39 — the inverse of the parser table', () => {
        expect(eplLines([barcodeField()]).find(l => l.startsWith('B'))!.split(',')[3]).toBe('3');
    });

    it('resolves the EAN/UPC letter from the DATA LENGTH', () => {
        const typeOf = (data: string) => eplLines([barcodeField({ symbology: '7', dataSource: { type: 'fixed', data } })])
            .find(l => l.startsWith('B'))!.split(',')[3];
        expect(typeOf('1234567890128')).toBe('E30');
        expect(typeOf('012345678905')).toBe('UA0');
        expect(typeOf('12345670')).toBe('E80');
        expect(typeOf('1234567')).toBe('UE0');
    });

    it('skips an EAN/UPC whose length EPL does not know, and says which', () => {
        const { epl, warnings } = generateEPL(withFields([barcodeField({ symbology: '7', dataSource: { type: 'fixed', data: '123' } })]));
        expect(epl.split('\n').some(l => l.startsWith('B'))).toBe(false);
        expect(warnings.some(w => /digits/.test(w))).toBe(true);
    });

    it('prints HRI below with a warning when ABOVE was asked for', () => {
        // EPL has no "above". Dropping the line would lose the digits, which is
        // worse than moving it — so it prints below and the move is announced.
        const { epl, warnings } = generateEPL(withFields([barcodeField({ humanReadable: 'above' })]));
        expect(epl.split('\n').find(l => l.startsWith('B'))!.split(',')[7]).toBe('B');
        expect(warnings.some(w => /above/.test(w) && /below/.test(w))).toBe(true);
    });

    it('emits no HRI when none was asked for', () => {
        expect(eplLines([barcodeField({ humanReadable: 'none' })]).find(l => l.startsWith('B'))!.split(',')[7]).toBe('N');
    });

    it('emits X with the FAR CORNER, not a width and height', () => {
        const p = eplLines([{ id: 3, type: 'box', name: 'X', x: 5, y: 5, rotation: 0, width: 20, height: 10, thickness: 0.5 }])
            .find(l => l.startsWith('X'))!.slice(1).split(',').map(Number);
        expect(p[3] - p[0]).toBe(160); // 20mm at 203dpi
        expect(p[4] - p[1]).toBe(80);  // 10mm
    });

    it('warns about rounded corners, which EPL boxes cannot draw', () => {
        expect(generateEPL(withFields([{ id: 3, type: 'box', name: 'X', x: 5, y: 5, rotation: 0, width: 20, height: 10, thickness: 0.5, cornerRadius: 3 }]))
            .warnings.some(w => /rounded/.test(w))).toBe(true);
    });

    it('emits LO with the length on the axis the line runs along', () => {
        const line = (rot: number) => ({ id: 4, type: 'line', name: 'L', x: 5, y: 40, rotation: rot, length: 40, thickness: 0.5 });
        const h = eplLines([line(0)]).find(l => l.startsWith('LO'))!.slice(2).split(',').map(Number);
        expect(h[2]).toBeGreaterThan(h[3]);
        const v = eplLines([line(90)]).find(l => l.startsWith('LO'))!.slice(2).split(',').map(Number);
        expect(v[3]).toBeGreaterThan(v[2]);
    });

    it('emits the b command for the 2D symbols EPL has', () => {
        const twoD = (symbology: string) => generateEPL(withFields([
            barcodeField({ symbology, name: 'C', dataSource: { type: 'fixed', data: 'DATA' } }),
        ])).epl.split('\n').find(l => l.startsWith('b'))!;
        expect(twoD('17').split(',')[2]).toBe('D');   // Data Matrix
        expect(twoD('14').split(',')[2]).toBe('M');   // MaxiCode
        expect(twoD('12').split(',')[2]).toBe('P');   // PDF417
        expect(twoD('17')).toContain('"DATA"');
    });

    it('refuses a QR code BY NAME, because EPL2 has none', () => {
        const { epl, warnings } = generateEPL(withFields([barcodeField({ symbology: '18', name: 'QR' })]));
        expect(epl.split('\n').some(l => l.startsWith('b'))).toBe(false);
        expect(warnings.some(w => /QR/.test(w) && /does not have/.test(w))).toBe(true);
    });

    it('names an unsupported field type instead of dropping it silently', () => {
        const { epl, warnings } = generateEPL(withFields([{ id: 5, type: 'image', name: 'Logo', x: 1, y: 1, rotation: 0, width: 10, height: 10, data: '' }]));
        expect(warnings.some(w => /Logo/.test(w) && /image/.test(w))).toBe(true);
        expect(epl).toContain('P2'); // the rest of the label still prints
    });

    it('names an unsupported symbology', () => {
        expect(generateEPL(withFields([barcodeField({ symbology: '18', name: 'QR' })])).warnings.some(w => /QR/.test(w))).toBe(true);
    });

    it('ROUND TRIP: what it emits, the parser reads back as the same elements', () => {
        const { epl } = generateEPL(withFields([
            textField(), barcodeField(),
            { id: 3, type: 'box', name: 'X', x: 5, y: 5, rotation: 0, width: 20, height: 10, thickness: 0.5 },
            { id: 4, type: 'line', name: 'L', x: 5, y: 40, rotation: 0, length: 40, thickness: 0.5 },
        ]));
        const label = parseEPL(epl);
        expect(label.issues.filter(i => i.level === 'error')).toHaveLength(0);
        expect(label.elements.map(e => e.kind)).toEqual(['text', 'barcode', 'box', 'line']);
        expect((label.elements[1] as any).symbology).toBe('0');
        expect((label.elements[1] as any).hri).toBe(1);
    });

    it('escapes quotes and backslashes the EPL way, and the parser undoes it', () => {
        expect(escapeEplData('say "hi"')).toBe('say \\"hi\\"');
        expect(escapeEplData('back\\slash')).toBe('back\\\\slash');
        const { epl } = generateEPL(withFields([textField({ dataSource: { type: 'fixed', data: 'a"b\\c' } })]));
        expect((parseEPL(epl).elements[0] as any).source.data).toBe('a"b\\c');
    });
});

// --- where EPL reaches into the rest of the app ------------------------------------

describe('EPL as a printer language', () => {
    it('is accepted by the printer-target form', () => {
        const { target, error } = validateTarget({ name: 'Line 1', host: '10.0.0.5', port: '9100', language: 'epl' as never, dpi: 203 });
        expect(error).toBeNull();
        expect(target?.language).toBe('epl');
    });

    it('still refuses a language it does not speak', () => {
        // The message names every language the app does speak, so it grows as
        // languages are added — matching the prefix keeps this about the
        // REFUSAL rather than the list.
        expect(validateTarget({ name: 'x', host: 'h', port: '9100', language: 'dpl' as never, dpi: 203 }).error).toMatch(/^Language must be IPL/);
    });

    it('REFUSES a record range, exactly as ZPL does', () => {
        // generateEPL emits one label per stream with the copies in `P`, so a
        // table-backed design would print one record and drop the rest.
        //
        // The design needs a field LINKED to the table AND mapped to one of its
        // columns: planDesignTableJob returns null when nothing maps, and an
        // unmapped table is not a job at all — so there would be no records to
        // refuse. The field is named after the column, which is how autoMapFields
        // finds it.
        const tableDesign = design([{ ...textField({ name: 'SKU', dataSource: { type: 'linked', sourceId: 's1' } }) } as never], {
            dataSources: [{
                id: 's1', name: 'Table', type: 'table', columns: ['SKU'],
                rows: [{ SKU: 'A' }, { SKU: 'B' }], query: { filters: [], combine: 'and' },
            } as never],
        });
        expect(jobSendabilityError(tableDesign, { language: 'epl' })).toMatch(/EPL.*record range/i);
        expect(jobSendabilityError(tableDesign, { language: 'ipl' })).toBeNull();
        // A single-record design is fine on EPL.
        expect(jobSendabilityError(design([textField()]), { language: 'epl' })).toBeNull();
    });

    it('renders EPL for an EPL target — NOT IPL', () => {
        // The silent hazard: renderJobChunk fell through to generateIPL for
        // anything that was not 'zpl', so an EPL target would have printed IPL.
        const job = {
            id: 'j1', createdAt: 1, updatedAt: 1, designName: 'D', designChecksum: 'x',
            design: design([textField()]),
            recordFrom: 1, recordTo: 1, copies: 3, collation: 'collated',
            target: { id: 't', name: 'E', host: 'h', port: '9100', language: 'epl', dpi: 203 },
            labels: 3, chunkCount: 1, sentChunks: 0, status: 'queued',
        } as unknown as PrintJob;

        return renderJobChunk(job, 0).then(stream => {
            expect(stream.startsWith('N\n')).toBe(true);   // EPL starts with N
            expect(stream).toContain('A');                  // an EPL text field
            expect(stream).not.toContain('<STX>');          // definitely not IPL
            expect(stream.split('\n').pop()).toBe('P3');    // the job's copies reached it
        });
    });
});

// --- the sample file ----------------------------------------------------------------

describe('the checked-in EPL sample', () => {
    it('parses cleanly, so the sample and the parser cannot drift apart', () => {
        const file = path.join(process.cwd(), 'samples', 'product.epl');
        expect(fs.existsSync(file), 'samples/product.epl is missing').toBe(true);
        const label = parseEPL(fs.readFileSync(file, 'utf8'));
        expect(label.elements.length).toBeGreaterThan(0);
        expect(label.issues.filter(i => i.level === 'error')).toHaveLength(0);
    });
});
