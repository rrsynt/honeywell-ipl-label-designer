import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseViewerIPL } from '../services/ipl/viewerParser';

const stx = (f: string) => `<STX>${f}<ETX>`;
const stream = (esc: string) => [
    stx('<ESC>P'), stx('<SI>W812'), stx('<SI>L406'), stx('E1;F1'),
    stx('H1;o10,10;c0;h2;w2;d3,ABC'), stx(esc), stx('R'), stx('<ESC>E1'),
].join('');

/**
 * The `<ESC>` surface, swept against the manual's own syntax index (PRM 2.70
 * "Commands Listed by Syntax", 28 entries).
 *
 * This closes the surface the `<ESC>` sweep of 2026-09-29 opened. That pass
 * found three commands that change the picture and had no decision path
 * (<ESC>c emulation, <ESC>G page select, <ESC><SP> Code 39 start/stop); this
 * one asks whether anything else on the surface is still undecided.
 *
 * The answer is no, and the reason is structural: every `<ESC>` command that
 * can change the printed image has a handler, and the remainder are one of two
 * kinds that cannot.
 *
 *   Picture-changing, all handled:
 *     <ESC>C  Advanced Mode, Select          (p.96)  — retimes the engine
 *     <ESC>c  Emulation Mode, Enter          (p.102) — reported
 *     <ESC>E  Format, Select                 (p.106) — closes/opens the format
 *     <ESC>F  Field, Select                  (p.102) — data goes to another field
 *     <ESC>g  Direct Graphics Mode, Select   (p.101) — decoded
 *     <ESC>G  Page, Select                   (p.113) — reported when it differs
 *     <ESC>P  Program Mode, Enter            (p.114)
 *     <ESC>T  Test and Service Mode, Enter   (p.117) — reported
 *     <ESC><SP> Start and Stop Codes         (p.117) — reported
 *
 *   Cannot change the picture:
 *     Transmit/query — the printer sends a value to the HOST and prints
 *     nothing: <ESC>H L M O Q Z m p u v x y  (a bare <ESC>J, RFID Tag Read,
 *     is the same shape: it reads a tag and answers the host).
 *
 * These tests hold that split, so a new `<ESC>` command cannot join the
 * surface without someone deciding which side it is on.
 */
describe('the ESC surface is fully decided', () => {
    const TRANSMIT = ['H', 'L', 'M', 'O', 'Q', 'Z', 'm', 'p', 'u', 'v', 'x', 'y'];

    it('reads one code per Transmit command: the generic ack is correct', () => {
        // These are not warnings and must not become them: the preview is
        // RIGHT to draw nothing, so a warning would train users to ignore it.
        // The generic `esc-command` info is the honest answer.
        for (const ch of TRANSMIT) {
            expect(parseViewerIPL(stream(`<ESC>${ch}`)).issues.map(i => i.code), `<ESC>${ch}`)
                .toEqual(['esc-command']);
        }
    });

    it('does not leave a picture-changing command on the generic ack', () => {
        const at = (esc: string) => parseViewerIPL(
            [stx('<ESC>P'), stx('E1;F1'), stx('H1;o10,10;c0;h2;w2;d3,A'), stx('R'), stx(esc)].join(''),
        ).issues.map(i => i.code);

        // BOTH values retime the engine — 10 mil and 15 mil — and neither is
        // the Advanced-mode geometry this preview draws, so both must warn.
        // (<ESC>c has no "off" spelling: the manual gives the command two
        // arguments and no default value.) The generic ack would tell the user
        // nothing about the geometry differing.
        expect(at('<ESC>c0'), '<ESC>c0').toContain('setup-not-modelled');
        expect(at('<ESC>c1'), '<ESC>c1').toContain('setup-not-modelled');

        // <ESC>G only diverges when it selects a page other than the one drawn.
        // A stream that defines and then selects page 3 is NOT a divergence
        // (that is what the viewer composes), so it stays silent; one that
        // selects page 2 while only 3 was defined IS.
        const withPage3 = (sel: string) => [
            stx('<ESC>P'), stx('E1;F1'), stx('H1;o10,10;c0;h2;w2;d3,A'),
            stx('S3;Ma,1'), stx('R'), stx(sel),
        ].join('');
        const g3 = parseViewerIPL(withPage3('<ESC>G3')).issues.map(i => i.code);
        const g2 = parseViewerIPL(withPage3('<ESC>G2')).issues.map(i => i.code);
        expect(g3, '<ESC>G3 selects the drawn page').not.toContain('setup-not-modelled');
        expect(g2, '<ESC>G2 selects a page that was never defined').toContain('setup-not-modelled');
    });

    it('keeps the Transmit list out of the ESC dispatch, read from source', () => {
        // The generic ack is reached by EXACTLY the letters that cannot change
        // the picture. Read the letters parseEscFrame itself switches on, so
        // this cannot go stale the way a hand-kept list would.
        const src = readFileSync(join(process.cwd(), 'services', 'ipl', 'viewerParser.ts'), 'utf8');
        const escBody = src.slice(
            src.indexOf('private parseEscFrame('),
            src.indexOf('private parseSetupFrame('),
        );
        const handled = new Set([...escBody.matchAll(/case '([A-Za-z])':/g)].map(m => m[1]));

        // None of the Transmit commands is switched on here — they all fall to
        // the default arm, which is the honest answer for a query.
        for (const ch of TRANSMIT) {
            expect(handled.has(ch), `<ESC>${ch} unexpectedly has its own case`).toBe(false);
        }
        // Positive controls: every picture-changing command has its own arm.
        // <ESC>c and <ESC>G are decided in reportUnmodelledEsc (called before
        // the switch) rather than as cases, so they are asserted there instead.
        for (const ch of ['P', 'C', 'E', 'F', 'g', 'T']) {
            expect(handled.has(ch), `<ESC>${ch} lost its case`).toBe(true);
        }
        // <ESC>c and <ESC>G are decided in reportUnmodelledEsc, which runs
        // BEFORE the switch — so they are not cases here, and their decisions
        // live just above parseEscFrame rather than inside it.
        // reportUnmodelledEsc is DECLARED after parseEscFrame (it is called
        // from inside it), so slice to the next member rather than assuming
        // the order.
        const reporterStart = src.indexOf('private reportUnmodelledEsc(');
        const reporterBody = src.slice(reporterStart, src.indexOf('private reportCode39StartStop(', reporterStart));
        for (const ch of ['c', 'G']) {
            expect(reporterBody.includes(`cmd === '${ch}'`), `<ESC>${ch} lost its decision`).toBe(true);
        }
    });
});
