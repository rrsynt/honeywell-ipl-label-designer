import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseViewerIPL } from '../services/ipl/viewerParser';

const stx = (f: string) => `<STX>${f}<ETX>`;
const stream = (frame: string) => [
    stx('<ESC>P'), stx('<SI>W812'), stx('<SI>L406'), stx('E1;F1'),
    stx('H0;o50,50;c25;k12;d3,0'), stx(frame), stx('R'), stx('<ESC>E1'),
].join('');
const codes = (frame: string) => parseViewerIPL(stream(frame)).issues.map(i => i.code);
const messages = (frame: string) => parseViewerIPL(stream(frame)).issues.map(i => i.message);

/**
 * The Format/Programming/RFID/Bitmap-UDF/UDC-Editing task tables (PRM 2.70
 * pp.92-95) swept against parseFieldFrame's dispatch. Every head below is a
 * REAL command that reached the generic "Unrecognized command frame ignored"
 * because no dispatch letter knew it — the same defect the bare `C` and `Qn`
 * had. The picture was right (none draws label content); the report hid that
 * the command is known and its (non-)effect is understood.
 */
describe('resource and job-level commands are named, not unknown frames', () => {
    it('names printer-resource definitions (T/J/j/t)', () => {
        // Tn: Bitmap User-Defined Font, Clear or Define (p.175). Jn: Outline
        // Font, Clear or Create (p.202). j: Outline Font, Download (p.204).
        // tn: User-Defined Font Character, Create (p.215).
        expect(codes('T3')).toContain('udf-font-define');
        expect(codes('J3')).toContain('outline-font-define');
        expect(codes('j12AB')).toContain('outline-font-download');
        expect(codes('t65')).toContain('udf-char-create');
        for (const f of ['T3', 'J3', 'j12AB', 't65']) {
            expect(codes(f), `${f} must not be an unknown frame`).not.toContain('unknown-frame');
        }
    });

    it('names the edit-session save (N) and the RFID setup pair (a/n)', () => {
        // N: Current Edit Session, Save (p.182) — "The printer remains in
        // Program mode." a: RFID Tag Field Setup (p.208). n: RFID Tag
        // Protect (p.213). Tag-write setup, not label content (the Q-field
        // analogue: the field writes to a tag and draws nothing).
        expect(codes('N')).toContain('edit-session-save');
        expect(codes('a1,1,0,8')).toContain('rfid-tag-setup');
        expect(codes('n1')).toContain('rfid-tag-protect');
        expect(messages('n1').some(m => /write-protected/.test(m))).toBe(true);
        expect(messages('n0').some(m => /not write-protected/.test(m))).toBe(true);
    });

    it('stays silent for the null command (v)', () => {
        // vn: Print Line Dot Count Limit, Set (p.208) — "This is a null
        // command and the printer ignores it." Silent, by the manual's word.
        expect(codes('v10')).not.toContain('unknown-frame');
        expect(codes('v10')).toHaveLength(0);
    });

    it('names page composition without a page (O/M standalone)', () => {
        // On: Format Offset Within a Page (p.193). Mp,n: Format Position in
        // a Page, Assign (p.194) — position is a-z, format id numeric. With
        // no S frame there is nothing to offset or assign to: no divergence,
        // but the command is recognized.
        expect(codes('O1,2')).toContain('page-offset-standalone');
        expect(codes('Ma,1')).toContain('page-assign-standalone');
        expect(codes('O0,0')).not.toContain('unknown-frame');
        // Malformed M (numeric position) is still unrecognized — the manual
        // gives no such shape.
        expect(codes('M3,4')).toContain('unknown-frame');
    });

    it('warns for nonzero UDF/graphic cell geometry (x/y)', () => {
        // xn: Bitmap Cell Width for Graphic or UDF (p.174). yn: Bitmap Cell
        // Height for Graphic or UDF (p.172). The renderer draws U graphics
        // and UDF text at resident size, so a redefined cell prints larger
        // or smaller with no warning otherwise.
        expect(codes('x5')).toContain('udf-cell-size');
        expect(codes('y5')).toContain('udf-cell-size');
        expect(codes('x0')).not.toContain('udf-cell-size');
        expect(codes('y0')).not.toContain('udf-cell-size');
    });

    it('leaves genuinely unrecognized heads as unknown frames', () => {
        // Y has no command in the manual at all. K/P/V are Test and Service
        // queries that exist ONLY after <ESC>T (pp.218-221); standalone they
        // are not commands, so the generic warning is correct for them.
        for (const f of ['Y1', 'K1', 'P1', 'V1']) {
            expect(codes(f), `${f} should stay unknown`).toContain('unknown-frame');
        }
    });

    it('reaches resource commands in chained position too', () => {
        // A chain segment in command position gets exactly the treatment it
        // would get alone — the chain is a transport detail, not a different
        // command set. The field behind the head must still parse.
        const chained = (head: string) => parseViewerIPL(
            [stx('<ESC>P'), stx('E1;F1'), stx(`${head};H1;o10,10;c0;h2;w2;d3,ABC`), stx('R')].join(''),
        );
        expect(chained('T3').issues.map(i => i.code)).toContain('udf-font-define');
        expect(chained('t65').issues.map(i => i.code)).toContain('udf-char-create');
        expect(chained('Ma,1').issues.map(i => i.code)).toContain('page-assign-standalone');
        expect(chained('T3').elements.some(e => e.kind === 'text')).toBe(true);
    });

    it('the sweep source still lists the commands decided here', () => {
        // If the manual text disappears or is replaced, the sweep loses its
        // authority and someone should notice here.
        const body = readFileSync(join(
            __dirname, '..', 'docs', 'manuals', 'IPL_2.70_Programmers_Reference_Manual.txt'), 'utf8');
        for (const title of [
            'Bitmap User-Defined Font, Clear or Define',
            'Outline Font, Clear or Create',
            'Outline Font, Download',
            'User-Defined Font Character, Create',
            'Current Edit Session, Save',
            'RFID Tag Field Setup',
            'RFID Tag Protect',
            'Print Line Dot Count Limit, Set',
            'Format Offset Within a Page, Define',
            'Format Position in a Page, Assign',
            'Bitmap Cell Width for Graphic or UDF, Define',
            'Bitmap Cell Height for Graphic or UDF, Define',
            'Character Bitmap Origin Offset, Define',
            'Font Character Width, Define',
            'Intercharacter Space for UDF, Define',
        ]) {
            expect(body, `manual no longer documents: ${title}`).toContain(title);
        }
        // And the null-command wording the silence of `v` rests on.
        expect(body).toContain('This is a null command and the printer ignores it');
    });
});

describe('bitmap font metrics (X/Z/z) are decided, not unknown', () => {
    it('warns for X nonzero, silent for the X0 default', () => {
        // Xn: Character Bitmap Origin Offset, Define (p.177) — shifts every
        // bitmap glyph right by n columns. Default 0, so X0 describes what
        // we already draw (the <SI>o0/o1 pattern).
        expect(codes('X5')).toContain('font-metrics-not-modelled');
        expect(messages('X5').some(m => /shifted 5 column/.test(m))).toBe(true);
        expect(codes('X0')).not.toContain('font-metrics-not-modelled');
        expect(codes('X0')).not.toContain('unknown-frame');
    });

    it('always warns for Zn, and says what the preview uses', () => {
        // Zn: Font Character Width, Define (p.187) — origin-to-origin
        // advance, bitmap only. No recognizable "default" spelling exists
        // (the printer default is bitmap width minus Xn plus zn, per font),
        // so any Zn warns, honestly naming the resident advance instead.
        expect(codes('Z10')).toContain('font-metrics-not-modelled');
        expect(messages('Z10').some(m => /resident advance/.test(m))).toBe(true);
    });

    it('warns for zn except the z2 default, and names the Zn interaction', () => {
        // zn: Intercharacter Space for UDF, Define (p.199) — adds n dots to
        // the gap, default 2, ignored when Zn is set.
        expect(codes('z0')).toContain('font-metrics-not-modelled');
        expect(codes('z2')).not.toContain('font-metrics-not-modelled');
        expect(codes('z2')).not.toContain('unknown-frame');
        expect(messages('z0').some(m => /ignor.*font character width \(Z\)/i.test(m))).toBe(true);
    });

    it('does not mistake longer commands for these letters', () => {
        // x122 is the graphic-cell-width PARAM inside a G definition, not
        // the Xn command; xc/xp/xu and X-prefixed setup are different
        // commands (same guard as the <SI>o/<SI>X test in commandSurface).
        const graphic = parseViewerIPL(
            [stx('<ESC>P'), stx('E1;F1'), stx('G1;x122;y64;u1,@A'), stx('U1;o10,10;f0;h1;w1;c1'), stx('R')].join(''),
        );
        expect(graphic.issues.map(i => i.code)).not.toContain('font-metrics-not-modelled');
        expect(graphic.issues.map(i => i.code)).not.toContain('udf-cell-size');
    });

    it('keeps the field behind a metrics head in a chain', () => {
        // The original Z40 example from the frame-head fix: the field must
        // survive AND the head must now be named (it used to be the generic
        // warning, which is what the old test pinned).
        const r = parseViewerIPL(
            [stx('<ESC>P'), stx('E1;F1'), stx('Z40;H1;o10,10;c0;h2;w2;d3,ABC'), stx('R')].join(''),
        );
        expect(r.elements.some(e => e.kind === 'text')).toBe(true);
        expect(r.issues.map(i => i.code)).toContain('font-metrics-not-modelled');
        expect(r.issues.map(i => i.code)).not.toContain('unknown-frame');
    });
});
