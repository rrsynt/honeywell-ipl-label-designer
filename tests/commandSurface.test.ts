import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseViewerIPL } from '../services/ipl/viewerParser';

const stx = (f: string) => `<STX>${f}<ETX>`;
const stream = (...extra: string[]) => [
    stx('<ESC>P'), stx('<SI>W812'), stx('<SI>L406'), stx('E1;F1'),
    ...extra.map(e => stx(e)), stx('H0;o50,50;c25;k12;d3,0'), stx('R'), stx('<ESC>E1'),
].join('');
const codes = (ipl: string) => parseViewerIPL(ipl).issues.map(i => i.code);
const notModelled = (ipl: string) => parseViewerIPL(ipl).issues
    .filter(i => i.code === 'setup-not-modelled')
    .map(i => i.message);

/**
 * The command-surface sweep.
 *
 * The unmodelled-setup reporter used to assert its list was COMPLETE: "every
 * other unhandled <SI> setting is comms, network or media handling — it cannot
 * change the picture". Enumerating the manual's own command index against the
 * parser's dispatch found that claim false twice. These tests pin the two, and
 * the sweep that found them.
 */
describe('commands that change the image but had no decision path', () => {
    it('<SI>o0 moves Direct Graphics to the legacy 7421 origin', () => {
        // PRM 2.70 p.125: "Prints direct graphics with the same origin offset
        // as a specific legacy printer." n=0 selects the 7421's origin; n=1
        // uses the format origin, which is what this renderer already draws.
        const warned = notModelled(stream('<SI>o0'));
        expect(warned.some(m => /7421|Direct Graphics/i.test(m))).toBe(true);
    });

    it('<SI>o1 is silent, because it describes what we already draw', () => {
        expect(notModelled(stream('<SI>o1'))).toHaveLength(0);
    });

    it('<SI>z1 changes a printed glyph, so it is announced', () => {
        // PRM 2.70 p.146: "Determines if the regular zero is replaced with a
        // slashed zero." Every zero in every field prints differently.
        const warned = notModelled(stream('<SI>z1'));
        expect(warned.some(m => /slash/i.test(m))).toBe(true);
    });

    it('<SI>z0 is silent — that is the disabled state', () => {
        expect(notModelled(stream('<SI>z0'))).toHaveLength(0);
    });

    it('does not fire <SI>z on a stream that never sends it', () => {
        expect(notModelled(stream())).toHaveLength(0);
    });

    it('stays silent for the manual\'s two exclusions of <SI>z', () => {
        // "This command only works if the Printer Language, Select command
        // <SI>l is set to 0 (USA). Also, it does not apply to OCR fonts 23
        // and 24." A warning where the command cannot take effect would train
        // users to ignore the list.
        const nonUsa = [
            stx('<ESC>P'), stx('<SI>W812'), stx('<SI>L406'), stx('<SI>l13'), stx('E1;F1'),
            stx('<SI>z1'), stx('H0;o50,50;c25;k12;d3,0'), stx('R'), stx('<ESC>E1'),
        ].join('');
        expect(notModelled(nonUsa)).toHaveLength(0);

        const ocr = [
            stx('<ESC>P'), stx('<SI>W812'), stx('<SI>L406'), stx('E1;F1'),
            stx('<SI>z1'), stx('H0;o50,50;c23;k12;d3,0'), stx('R'), stx('<ESC>E1'),
        ].join('');
        expect(notModelled(ocr)).toHaveLength(0);
    });

    it('still warns for slash zero when the language is the implicit default', () => {
        // No <SI>l at all means USA, so the command does take effect.
        expect(notModelled(stream('<SI>z1'))).toHaveLength(1);
    });

    it('does not mistake a longer command for either letter', () => {
        // <SI>xc, <SI>xp, <SI>xu start with the same letter as <SI>X; <SI>O is
        // a different command from <SI>o. None of them may reach these warnings.
        for (const frame of ['<SI>xc', '<SI>xp', '<SI>xu', '<SI>O1', '<SI>on']) {
            expect(notModelled(stream(frame)), `${frame} misfired`).toHaveLength(0);
        }
    });
});

describe('the <ESC> surface, swept the same way', () => {
    // The first sweep stopped at <SI>. Every unmatched <ESC> command fell
    // through to one generic `esc-command` info, so a command that changes the
    // picture was indistinguishable from a harmless one. Sweeping the <ESC>
    // index against parseEscFrame's dispatch found three; the tests for them
    // live in unmodelledSetup.test.ts, and this pins the source they came from.

    it('the manual\'s <ESC> command index is the authority, and still lists them', () => {
        const body = readFileSync(join(
            __dirname, '..', 'docs', 'manuals', 'IPL_2.70_Programmers_Reference_Manual.txt'), 'utf8');
        // The syntax index in PRM 2.70 (Chapter 6, "Commands Listed by Syntax").
        expect(body).toContain('<ESC>c Emulation Mode, Enter');
        expect(body).toContain('<ESC>G Page, Select');
        expect(body).toContain('<ESC><SP> Start and Stop Codes (Code 39), Print');
        // The definition bodies the warnings quote, so a reworded manual is
        // noticed here rather than silently invalidating the messages.
        expect(body).toContain('Instructs the printer to operate in Emulation mode');
        expect(body).toContain('Selects a page for data entry or printing');
        expect(body).toContain('print only the start and stop');
    });

    it('the <ESC> dispatch and the index agree on which letters are spoken for', () => {
        // The sweep only means something while the dispatch is the real list of
        // handled letters: a letter handled in code but absent here would be
        // reported as unmodelled, and one handled only in the test is a fiction.
        const src = readFileSync(join(__dirname, '..', 'services', 'ipl', 'viewerParser.ts'), 'utf8');
        const dispatch = src.slice(src.indexOf('private parseEscFrame'));
        for (const letter of ["case 'P'", "case 'C'", "case 'E'", "case 'g'"]) {
            expect(dispatch, `${letter} missing from parseEscFrame`).toContain(letter);
        }
        // The <ESC>-level reporter must exist and be called, or the sweep's
        // findings have nowhere to land.
        expect(src).toContain('reportUnmodelledEsc');
        expect(src).toContain('reportPageSelect');
        expect(src).toContain('reportCode39StartStop');
    });
});

describe('the interface tables (Appendix D) are swept too', () => {
    // PRM 2.70 Appendix D lists three tables the host can REDEFINE: t=0 print
    // commands, t=1 the <ESC> command table, t=2 the <SI> shift table. Sweeping
    // t=1 against parseEscFrame's dispatch was mostly a re-check of the <ESC>
    // sweep above — most of its letters are already handled — with one real
    // find: the bare "C" command that loads a table in the first place.

    it('the manual still documents the tables and their reset scoping', () => {
        const body = readFileSync(join(
            __dirname, '..', 'docs', 'manuals', 'IPL_2.70_Programmers_Reference_Manual.txt'), 'utf8');
        expect(body).toContain('Escape Print Commands (t=1)');
        expect(body).toContain('Shift Print Commands (t = 2)');
        // The sentence that decides the whole feature: a loaded table cannot
        // affect the stream that loads it, so the renderer must not try.
        expect(body).toContain('New commands become effective after you reset the printer');
        // And the t=1 table's own distinctive entries, so a reworded appendix
        // is noticed rather than silently emptying this sweep.
        expect(body).toContain('Set Field Increment');
        expect(body).toContain('Disable Increment/Decrement');
    });

    it('Command Tables, Load is reported by name, not as an unknown frame', () => {
        // It used to fall to the /^[A-Z]/ catch-all and be reported as an
        // unrecognized frame, hiding that it is a named command whose effect is
        // known and (per the manual) deliberately out of scope for this stream.
        const stx = (f: string) => `<STX>${f}<ETX>`;
        const codes = (frame: string) => parseViewerIPL(
            [stx('<ESC>P'), stx('E1;F1;'), stx('H1;o20,20;c25;k14'), stx(frame), stx('R'), stx('<ESC>E1')].join(''),
        ).issues.map(i => i.code);
        for (const frame of ['C', 'C1,16,20,43', 'C0,00,01', 'C2,41,43']) {
            const got = codes(frame);
            expect(got, `${frame} should be a named command`).toContain('command-table-load');
            expect(got, `${frame} must not be an unknown frame`).not.toContain('unknown-frame');
        }
        // <ESC>C is a DIFFERENT command (Select Advanced Mode) and must not be
        // caught by the new rule; the same for field frames starting with C.
        expect(codes('<ESC>C'), '<ESC>C is Advanced Mode').not.toContain('command-table-load');
    });
});

describe('the sweep that found them is reproducible', () => {
    it('the manual\'s command index is still the authority for the list', () => {
        // The two commands above were found by enumerating this file. If it
        // disappears or is replaced, the sweep loses its source and someone
        // should notice here rather than silently losing coverage.
        const index = readFileSync(join(
            __dirname, '..', 'docs', 'manuals', 'IPL_Command_Reference_K10_937-028-003',
            'Main_Level_Commands_Listed_by_Name.htm'), 'utf8');
        // The entries that mattered for this change.
        expect(index).toContain('Slash Zero, Enable or Disable');
        expect(index).toContain('Direct Graphics Emulation Mode, Enable or Disable');
        // And the three that were already handled, so the sweep's baseline is
        // anchored to the same source rather than to a copied list.
        expect(index).toContain('Label Origin, X-Y Adjust');
        expect(index).toContain('Top of Form, Set');
        expect(index).toContain('Printhead Loading Mode');
    });

    it('the reporter no longer presents its list as exhaustive', () => {
        // The comment used to say the three-command list was exhaustive: "Every
        // other unhandled <SI> setting ... cannot change the picture". A sweep
        // disproved it, so the claim must not come back — restating it would
        // recreate the same blind spot.
        //
        // Checked by looking for the claim as an ASSERTION, not as a substring:
        // the current comment QUOTES the old wording to explain why it went,
        // and a naive substring search cannot tell a quote from a claim.
        const src = readFileSync(join(__dirname, '..', 'services', 'ipl', 'viewerParser.ts'), 'utf8');
        const at = src.indexOf('private reportUnmodelledSetup');
        const header = src.slice(src.lastIndexOf('/**', at), at);
        // Any surviving claim must be inside quotes, marking it as history.
        const claimLines = header.split(/\r?\n/).filter(l => /every other unhandled/i.test(l));
        for (const line of claimLines) {
            expect(line, `unquoted completeness claim: ${line.trim()}`).toMatch(/["“].*every other unhandled/i);
        }
        // And it should point a reader at the sweep that keeps it honest.
        expect(header).toContain('commandSurface');
    });
});
