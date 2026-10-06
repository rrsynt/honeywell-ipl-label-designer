import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { parseIPL } from '../services/iplParser';
import type { TextElement } from '../services/ipl/types';

const stx = (f: string) => `<STX>${f}<ETX>`;
const stream = (frame: string) => [
    stx('<ESC>P'), stx('<SI>W812'), stx('<SI>L406'), stx('E1;F1'),
    stx(frame), stx('R'), stx('<ESC>E1'),
].join('');
const textOf = (frame: string): TextElement => {
    const el = parseViewerIPL(stream(frame)).elements.find(e => e.kind === 'text');
    if (!el) throw new Error(`no text element for "${frame}"`);
    return el as TextElement;
};

/**
 * The trailing-parameter rule decides where fixed text ends and parameters
 * begin. Its regex and the set of parameters the parser ACTUALLY consumes are
 * two different lists, and they drifted apart: `g` (Pitch Size, Set) is in the
 * manual's own Human-Readable task table (PRM pp.92-95, "Syntax: gn") and is
 * read by parseTextField, but the regex refused it — so a pitch written after
 * the data printed as text:
 *
 *   <STX>H1;o10,10;c0;h2;w2;d3,AB;g10<ETX>   drew the literal "AB;g10"
 *
 * These tests hold the two lists together, and pin the cases that must keep
 * reading as text so the rule cannot simply be widened.
 */
describe('the trailing-parameter rule covers every parameter the parser reads', () => {
    it('applies a pitch written AFTER the data, rather than printing it', () => {
        const t = textOf('H1;o10,10;c0;h2;w2;d3,AB;g10');
        expect((t.source as { data: string }).data).toBe('AB');
        expect(t.pitchAdvanceDots).toBeGreaterThan(0);
    });

    it('agrees with the pitch written BEFORE the data', () => {
        const after = textOf('H1;o10,10;c0;h2;w2;d3,AB;g10');
        const before = textOf('H1;o10,10;c0;h2;w2;g10;d3,AB');
        expect(after.pitchAdvanceDots).toBe(before.pitchAdvanceDots);
        expect((after.source as { data: string }).data).toBe((before.source as { data: string }).data);
    });

    it('keeps the documented text cases as text', () => {
        // The greedy behaviour exists for these: an upper-case key, or letters
        // inside the value, is never a parameter.
        for (const [field, want] of [
            ['H0;o10,10;c0;d3,A;B;', 'A;B'],
            ['H0;o10,10;c0;d3,LOT;ROLLS;', 'LOT;ROLLS'],
            ['H0;o10,10;c0;d3,X;B2;Y;', 'X;B2;Y'],
            ['H0;o10,10;c0;d3,BASIS WT. 39-4838;', 'BASIS WT. 39-4838'],
        ] as Array<[string, string]>) {
            expect((textOf(field).source as { data: string }).data, field).toBe(want);
        }
    });

    it('does not split a parameter-shaped segment in the MIDDLE of the data', () => {
        expect((textOf('H0;o10,10;c0;d3,A;k12;B;').source as { data: string }).data).toBe('A;k12;B');
    });

    it('holds the regex and the consumed-parameter set together', () => {
        // Read BOTH from source so the test cannot go stale the way the regex
        // did: any letter the parser consumes for a field that also takes d3
        // must be accepted here.
        const dir = join(process.cwd(), 'services');
        // The viewer half of the rule moved to viewerFrames.ts in the prologue
        // split (behaviour identical); the importer half never moved. The
        // consumption check below still reads the class file, where
        // parseTextField lives.
        const viewer = readFileSync(join(dir, 'ipl', 'viewerFrames.ts'), 'utf8');
        const viewerClass = readFileSync(join(dir, 'ipl', 'viewerParser.ts'), 'utf8');
        const importer = readFileSync(join(dir, 'iplParser.ts'), 'utf8');

        const parseSet = (src: string): Set<string> => {
            const m = /const FIELD_PARAM_AFTER_DATA = \/\^\[([a-z]+)\]/ .exec(src);
            if (!m) throw new Error('FIELD_PARAM_AFTER_DATA not found');
            return new Set([...m[1]]);
        };
        const viewerSet = parseSet(viewer);
        const importerSet = parseSet(importer);

        // The two parsers must agree on where fixed text ends.
        expect([...viewerSet].sort()).toEqual([...importerSet].sort());

        // 'g' is the parameter this sweep added; it is what parseTextField reads
        // for pitch, so it must be admitted.
        expect(viewerSet.has('g')).toBe(true);
        expect(/params\.find\(p => p\.key === 'g'\)/.test(viewerClass)).toBe(true);

        // 'd' must stay out: a second d segment is malformed, and reading it as
        // a param would be a guess.
        expect(viewerSet.has('d')).toBe(false);
    });

    it("keeps origin (o) out — the manual never places it after the data", () => {
        // `o` is a real parameter of both field types that take d3, which makes
        // it look like an omission. It is not: of the 26 field commands in
        // PRM 2.70 that carry d3, every one writes `o` BEFORE the data and none
        // writes it after. `o` opens a field.
        //
        // Admitting it would also cost correctness on real text:
        // "d3,REF;o9" is a part number, and splitting there truncates it.
        // Both halves are pinned here so the class is not "completed" later.
        const src = readFileSync(join(process.cwd(), 'services', 'ipl', 'viewerFrames.ts'), 'utf8');
        const m = /const FIELD_PARAM_AFTER_DATA = \/\^\[([a-z]+)\]/.exec(src);
        expect(m).not.toBeNull();
        expect(m![1]).not.toContain('o');
        expect(m![1]).not.toContain('d');

        const text = (frame: string): string => {
            const el = parseViewerIPL(stream(frame)).elements.find(e => e.kind === 'text') as TextElement;
            return (el.source as { data: string }).data;
        };
        expect(text('H1;o10,10;c0;h2;w2;d3,REF;o9')).toBe('REF;o9');
        expect(text('H1;c0;h2;w2;d3,AB;o100,200')).toBe('AB;o100,200');
    });
});

describe('importer parity for a trailing pitch', () => {
    it('does not glue a trailing pitch onto the imported text', () => {
        const design = parseIPL(stream('H1;o10,10;c0;h2;w2;d3,AB;g10'), 203);
        const t = design.fields.find(f => f.type === 'text') as { dataSource: { data: string } };
        expect(t.dataSource.data).toBe('AB');
    });
});
