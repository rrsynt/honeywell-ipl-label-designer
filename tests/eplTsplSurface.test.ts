import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEPL } from '../services/epl/eplParser';
import { parseTSPL } from '../services/tspl/tsplParser';
import { parseZPL } from '../services/zpl/zplParser';

/**
 * The EPL and TSPL command surfaces.
 *
 * Both split unknown commands three ways: a named "not supported" issue, a
 * silence list for printer settings, and — the failure this project fights —
 * nothing at all. So the question is not whether they warn. It is whether
 * anything that DRAWS sits in a silence list, or vanishes with no word.
 *
 * They do not, and these tests hold that. The first case is the control that
 * makes the rest meaningful: a probe that cannot see a drawing command cannot
 * tell "nothing is silenced" from "nothing is being looked at".
 */
describe('the EPL and TSPL surfaces do not silence anything that draws', () => {
    it('has a working control — the drawing commands really do draw', () => {
        for (const [name, body] of [
            ['text', 'A10,10,0,1,1,1,N,"HELLO"'],
            ['1D barcode', 'B10,10,0,1,2,3,50,B,"123456"'],
            ['line', 'LO10,10,100,3'],
            ['box', 'X10,10,100,50,3'],
            ['Data Matrix', 'b10,10,D,h5,"DATA"'],
        ] as Array<[string, string]>) {
            expect(parseEPL(`N\n${body}\nP1\n`).elements, name).toHaveLength(1);
        }
    });

    it('keeps every printer-setting command out of the picture', () => {
        // The silence list, read from source rather than restated, so it cannot
        // drift the way the IPL trailing-parameter regex did.
        const src = readFileSync(join(process.cwd(), 'services', 'epl', 'eplParser.ts'), 'utf8');
        const block = src.slice(src.indexOf('const PRINTER_SETTINGS = new Set(['));
        // Strip comments first: the list carries a note NAMING a removed entry
        // ("'a' used to be here"), and reading quotes out of prose would test
        // the comment as if it were a command.
        const body = block.slice(0, block.indexOf(']')).replace(/\/\/[^\n]*/g, '');
        const settings = [...body.matchAll(/'([^']+)'/g)].map(m => m[1]);
        expect(settings.length).toBeGreaterThan(40);
        // The removed entry must stay removed — a lowercase 'a' is not the
        // text command ('A' is), so silencing it hid an unrecognized command.
        expect(settings).not.toContain('a');

        for (const cmd of settings) {
            // Give a drawing command coordinates, so silence cannot be an
            // accident of missing parameters.
            const r = parseEPL(`N\n${cmd}10,10,0,1,1,1,1,"X"\nP1\n`);
            expect(r.elements, `${cmd} draws but is in the silence list`).toHaveLength(0);
        }
    });

    it('names the EPL 2D types it does not know', () => {
        for (const kind of ['D', 'M', 'P', 'd', 'm', 'p']) {
            expect(parseEPL(`N\nb10,10,${kind},h5,"DATA"\nP1\n`).elements, kind).toHaveLength(1);
        }
        for (const kind of ['Q', 'Z', 'X']) {
            const r = parseEPL(`N\nb10,10,${kind},h5,"DATA"\nP1\n`);
            expect(r.elements, kind).toHaveLength(0);
            expect(r.issues.map(i => i.code), kind).toContain('epl-2d-unsupported');
        }
    });

    it('leaves no EPL 1D type both undrawn and unexplained', () => {
        const TYPES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C',
            'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'N', 'O', 'R', 'S', 'T', 'U', 'V', 'Z'];
        for (const t of TYPES) {
            const r = parseEPL(`N\nB10,10,0,${t},2,3,50,B,"1234"\nP1\n`);
            if (r.elements.length === 0) {
                expect(r.issues.length, `type ${t} drew nothing and said nothing`).toBeGreaterThan(0);
            }
        }
    });

    it('names an unrecognized TSPL command instead of ignoring it', () => {
        for (const cmd of ['ZZZZ 1,2,3', 'FOOBAR whatever']) {
            const r = parseTSPL(`${cmd}\nPRINT 1,1\n`);
            expect(r.issues.map(i => i.code), cmd).toContain('tspl-unsupported');
        }
    });

    it('warns when a TSPL command moves or reflects the whole image', () => {
        // SHIFT, REFERENCE, OFFSET and MIRROR were in the silence list, so a
        // stream using them drew its fields at their own coordinates under no
        // message at all — a label the printer would not produce, shown as if
        // nothing were wrong. ZPL's ^LH/^LT/^LS had the identical defect and
        // the identical answer; this is the same contract for TSPL.
        //
        // The drawing assertion is the control: a probe that cannot see the
        // field cannot tell "reported correctly" from "not looked at".
        for (const [src, command] of [
            ['SHIFT 20,20', 'SHIFT'],
            ['REFERENCE 100,100', 'REFERENCE'],
            ['OFFSET 30', 'OFFSET'],
            ['MIRROR 1', 'MIRROR'],
        ] as Array<[string, string]>) {
            const label = parseTSPL(`SIZE 40 mm,30 mm\n${src}\nTEXT 10,10,"2",0,1,1,"A"\nPRINT 1,1\n`);
            // The field still DRAWS — the warning is about where, not whether.
            expect(label.elements, command).toHaveLength(1);
            const hit = label.issues.find(i => i.code === 'tspl-image-shifted' && i.command === command);
            expect(hit, `${command} moved the image and said nothing`).toBeDefined();
            expect(hit!.level, command).toBe('warning');
        }
    });

    it('stays silent when a TSPL shift is at its no-op value', () => {
        // SHIFT 0,0 is where the image already is, and MIRROR 0 is not mirrored.
        for (const src of ['SHIFT 0,0', 'REFERENCE 0,0', 'OFFSET 0', 'MIRROR 0']) {
            const label = parseTSPL(`SIZE 40 mm,30 mm\n${src}\nTEXT 10,10,"2",0,1,1,"A"\nPRINT 1,1\n`);
            expect(label.issues.map(i => i.code), src).not.toContain('tspl-image-shifted');
        }
    });

    it('draws the TSPL commands it does support', () => {
        expect(parseTSPL('SIZE 100 mm,50 mm\nCLS\nTEXT 10,10,"1",0,1,1,"HI"\nPRINT 1,1\n').elements).toHaveLength(1);
        expect(parseTSPL('SIZE 100 mm,50 mm\nCLS\nBARCODE 10,50,"128",50,1,0,2,2,"123"\nPRINT 1,1\n').elements).toHaveLength(1);
    });
});

// CODEPAGE (TSPL p. 17), I (EPL p. 3-63) and ^CI (ZPL) all select the character
// set. The viewer assumes a Latin-1-compatible page, so a stream using another
// page draws the same byte as a different glyph — silent until now.
describe('character-set commands are named, not silently assumed (2026-10-01)', () => {
    it('TSPL CODEPAGE is named for a non-Latin-1 page', () => {
        const codes = (n: string) => parseTSPL(`SIZE 50 mm,25 mm\nCODEPAGE ${n}\nCLS\nTEXT 10,10,"2",0,1,1,"x"`).issues.map(i => i.code);
        expect(codes('850')).toContain('tspl-codepage');
        // The control: 1252 and the empty command are the Latin-1 default.
        expect(codes('1252')).not.toContain('tspl-codepage');
    });

    it('EPL I is named for a non-Latin-1 code page', () => {
        const codes = (p2: string) => parseEPL(`N\nI8,${p2}\nA10,10,0,2,1,1,N,"x"\nP1\n`).issues.map(i => i.code);
        expect(codes('0')).toContain('epl-charset');   // DOS 437
        expect(codes('A')).not.toContain('epl-charset'); // Windows Latin 1 (the default)
    });

    it('ZPL ^CI is named for a non-UTF-8 encoding', () => {
        const codes = (n: string) => parseZPL(`^XA^CI${n}^FO10,10^A0N,20,20^FDx^FS^XZ`).issues.map(i => i.code);
        expect(codes('0')).toContain('zpl-charset');
        expect(codes('14')).toContain('zpl-charset');
        expect(codes('28')).not.toContain('zpl-charset'); // UTF-8, what we assume
    });
});
