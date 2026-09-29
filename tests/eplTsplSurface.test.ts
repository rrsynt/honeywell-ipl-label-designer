import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEPL } from '../services/epl/eplParser';
import { parseTSPL } from '../services/tspl/tsplParser';

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

    it('draws the TSPL commands it does support', () => {
        expect(parseTSPL('SIZE 100 mm,50 mm\nCLS\nTEXT 10,10,"1",0,1,1,"HI"\nPRINT 1,1\n').elements).toHaveLength(1);
        expect(parseTSPL('SIZE 100 mm,50 mm\nCLS\nBARCODE 10,50,"128",50,1,0,2,2,"123"\nPRINT 1,1\n').elements).toHaveLength(1);
    });
});
