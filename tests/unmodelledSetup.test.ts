// Setup commands that move or transform the PRINTED image but that this
// renderer does not model. They must say so instead of vanishing.
//
// Why this file exists: `parseSetupFrame` matches W/L/T/g/S/d/l by regex and
// ignores everything else in an <SI> frame. For comms and network settings
// that is right -- they cannot change the picture. But three of them can:
//
//   <SI>X m1[,m2]  Label Origin, X-Y Adjust  -- moves the imaged position
//                  (K10 937-028-003 "Label Origin, X-Y Adjust"; absent from
//                  PRM rev 008, added with the K10/P10 firmware line)
//   <SI>F n        Top of Form, Set          -- the start print point
//                  ("left margin or start print point", PRM p.139)
//   <SI>h n[,m]    Printhead Loading Mode    -- n=1 mirror printing,
//                  ,m=1 inverse printing: "affects how the whole image
//                  prints on the label" (PRM p.135)
//
// These are not academic. IPL_Migration_Considerations_PM43_PC43_TechBrief.pdf
// tells integrators of exactly this printer family to use "system X margin
// (IPL y axis) or start/stop (IPL x axis) adjust" to compensate the fixed 3 mm
// printhead offset -- so real streams from a PM43/PC43 may carry them, and in
// silence the preview would sit ~24 dots away from the print with nothing on
// screen to say why. That is the failure mode this project exists to prevent.
//
// They are WARNED about, not modelled, on purpose: the magnitudes and signs
// are hardware behaviour (5-mil increments, +/-30 dot ranges, and <SI>X's own
// "IPL uses the system configuration for this setting"), and this project's
// rule is that such a table is measured, never guessed -- EPL's barcode
// letters and TSPL's type names both proved what guessing costs.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { bytesToByteString } from '../services/ipl/fileBytes';

const stream = (...frames: string[]): string =>
    ['<STX><ESC>C<SI>W400<ETX>', '<STX><ESC>P<ETX>', '<STX>E1;F1<ETX>',
     '<STX>L1;o10,10;l100;w2<ETX>', ...frames.map(f => `<STX>${f}<ETX>`), '<STX>R<ETX>'].join('\n');

const warned = (code: string, ...frames: string[]): boolean =>
    parseViewerIPL(stream(...frames)).issues.some(i => i.code === code && i.level === 'warning');

const NOT_MODELLED = 'setup-not-modelled';

describe('setup commands that change the image but are not modelled', () => {
    it('warns for a non-zero <SI>X origin adjust', () => {
        expect(warned(NOT_MODELLED, '<SI>X5,3')).toBe(true);
        expect(warned(NOT_MODELLED, '<SI>X-12')).toBe(true);
        // Both parameters are bracketed in the syntax, so either may be omitted
        // independently. "<SI>X,3" was silent until a boundary sweep caught it —
        // a leading-digit-only regex reads the omitted m1 as "no command here".
        expect(warned(NOT_MODELLED, '<SI>X,3')).toBe(true);
        expect(warned(NOT_MODELLED, '<SI>X0,-3')).toBe(true);
    });

    it('does not confuse <SI>X with the lowercase <SI>xc / <SI>x settings', () => {
        // "Ignore a list of configuration commands" (<SI>xc) and the <SI>x
        // family are comms settings, not the origin adjust.
        expect(warned(NOT_MODELLED, '<SI>xc')).toBe(false);
        expect(warned(NOT_MODELLED, '<SI>x1')).toBe(false);
    });

    it('stays quiet for <SI>X at its default (nothing moves)', () => {
        expect(warned(NOT_MODELLED, '<SI>X0,0')).toBe(false);
        expect(warned(NOT_MODELLED, '<SI>X0')).toBe(false);
    });

    it('warns for <SI>F at anything other than its documented default of 20', () => {
        expect(warned(NOT_MODELLED, '<SI>F100')).toBe(true);
        expect(warned(NOT_MODELLED, '<SI>F0')).toBe(true);
        expect(warned(NOT_MODELLED, '<SI>F20')).toBe(false);
    });

    it('warns for <SI>h mirror or inverse printing', () => {
        expect(warned(NOT_MODELLED, '<SI>h1')).toBe(true);      // mirror
        expect(warned(NOT_MODELLED, '<SI>h0,1')).toBe(true);    // inverse
        expect(warned(NOT_MODELLED, '<SI>h1,1')).toBe(true);    // both
    });

    it('stays quiet for <SI>h normal printing, including the bare form the samples carry', () => {
        expect(warned(NOT_MODELLED, '<SI>h0')).toBe(false);
        expect(warned(NOT_MODELLED, '<SI>h0,0')).toBe(false);
        // Both parameters are mandatory in the syntax (<SI>hn[,m]), so a bare
        // "<SI>h" selects nothing. samples/box-date.ipl, external.ipl and
        // product.ipl all carry it inside their <ESC>C setup frame, so warning
        // here would be a false alarm on our own fixtures.
        expect(warned(NOT_MODELLED, '<ESC>C<SI>W640<SI>h')).toBe(false);
    });

    it('warns when the command rides inside an <ESC>C setup frame', () => {
        expect(warned(NOT_MODELLED, '<ESC>C<SI>W640<SI>X4')).toBe(true);
    });

    it('does not warn for comms, network or media-handling settings', () => {
        // Not an exhaustive list -- these are the neighbours most likely to be
        // swept in by a loose regex.
        for (const f of ['<SI>xc', '<SI>ws,NETWORK NAME', '<SI>e0', '<SI>r200', '<SI>R1', '<SI>f5', '<SI>Z1']) {
            expect(warned(NOT_MODELLED, f), `${f} should not warn`).toBe(false);
        }
    });

    it('adds no warning to any shipped sample', () => {
        const dir = path.resolve(__dirname, '../samples');
        for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.ipl'))) {
            const label = parseViewerIPL(bytesToByteString(fs.readFileSync(path.join(dir, file))));
            const hits = label.issues.filter(i => i.code === NOT_MODELLED);
            expect(hits, `${file}: ${hits.map(h => h.message).join('; ')}`).toHaveLength(0);
        }
    });
});

// ---------------------------------------------------------------------------
// The <ESC> surface — the sweep that found these is tests/commandSurface.test.ts
// ---------------------------------------------------------------------------
describe('<ESC> commands that change the image but are not modelled', () => {
    // These arrived the same way the <SI> ones did: the manual's command index
    // swept against the parser's dispatch. Every unmatched <ESC> command used
    // to fall through to one generic `esc-command` info, so a command that
    // changes the picture looked exactly like one that does not.
    const escStream = (...frames: string[]): string =>
        ['<STX><ESC>P<ETX>', '<STX>E1;F1;<ETX>', ...frames.map(f => `<STX>${f}<ETX>`),
         '<STX>B1;o10,10;c3;h40;w2;d3,123<ETX>', '<STX>R<ETX>'].join('\n');
    const escWarned = (...frames: string[]): boolean =>
        parseViewerIPL(escStream(...frames)).issues.some(
            i => i.code === NOT_MODELLED && i.level === 'warning');

    it('warns for Emulation Mode (<ESC>c), which retimes the engine', () => {
        // PRM 2.70 p.102: n=0 -> 10 mil dots, n=1 -> 15 mil for bar codes.
        // The preview draws Advanced-mode geometry, so either value diverges.
        expect(escWarned('<ESC>c0')).toBe(true);
        expect(escWarned('<ESC>c1')).toBe(true);
    });

    it('warns for Page Select (<ESC>G) only when it targets a different page', () => {
        // The viewer composes the LAST page defined. Selecting that same page
        // is what it already draws, so only a mismatch is a divergence —
        // bartender-auto.ipl defines page 3 and selects page 3, and warning
        // there was a false positive the shipped-sample guard caught.
        const twoPages = ['S1;Ma,1;O0,0', 'S2;Ma,2;O0,0'];
        expect(escWarned(...twoPages, '<ESC>G1'), 'page 1 vs last-defined 2').toBe(true);
        expect(escWarned(...twoPages, '<ESC>G2'), 'the page we already draw').toBe(false);
        // No page defined at all: nothing to compose either way.
        expect(escWarned('<ESC>G3')).toBe(false);
    });

    it('warns for Code 39 start/stop only (<ESC><SP>), in every notation', () => {
        // PRM p.117: "print only the start and stop characters" — a printed
        // field's content changes. The command IS a trailing space, which
        // tokenizeFrames trims, so a standalone literal frame loses it; the
        // raw scan is what makes all three spellings detectable.
        expect(escWarned('<ESC> '), 'literal standalone').toBe(true);
        expect(escWarned('<ESC> <ESC>F1<NUL>X'), 'literal mid-frame').toBe(true);
        const raw = '\x02\x1bP\x03\x02E1;F1;\x03\x02\x1b \x03\x02R\x03';
        expect(parseViewerIPL(raw).issues.some(i => i.code === NOT_MODELLED), 'raw bytes').toBe(true);
    });

    it('stays silent for the <ESC> commands that cannot change the picture', () => {
        // Neighbours a loose matcher would sweep in. <ESC>C1 and <ESC>E1 carry
        // bare digits exactly like <ESC>c1 / <ESC>G1; <ESC>T enters Test and
        // Service mode (the printer finishes the job first, so the label on
        // screen still prints); <ESC>N clears an odometer flag this viewer
        // models per field; <ESC>I5 attaches to its field.
        for (const f of ['<ESC>C1', '<ESC>E1', '<ESC>E4', '<ESC>P', '<ESC>F1', '<ESC>g1',
                         '<ESC>I5', '<ESC>y2', '<ESC>O1', '<ESC>T', '<ESC>N']) {
            expect(escWarned(f), `${f} should not warn`).toBe(false);
        }
        // A bare <ESC> (no space) is not the Code 39 command.
        expect(escWarned('<ESC>'), 'bare ESC').toBe(false);
    });
});

// ---------------------------------------------------------------------------
// The t=2 Shift table sweep (Appendix D) — <SI>i is IBM translation
// ---------------------------------------------------------------------------
//
// Sweeping every letter of PRM 2.70's Shift Commands table against the parser.
// 25 of the 27 change nothing about the picture (comms, hardware, media,
// storage) and stay silent as they should; <SI>F and <SI>h were already
// reported. One was missing: <SI>i, IBM Language Translation.
describe('<SI>i — IBM language translation (t=2 sweep)', () => {
    const stx = (f: string) => `<STX>${f}<ETX>`;
    const warned = (frame: string): boolean => parseViewerIPL(
        [stx('<ESC>P'), stx('E1;F1;'), stx('H1;o10,10;c0;d3,X'), stx('R'), stx(frame)].join(''),
    ).issues.some(i => i.code === 'setup-not-modelled');

    it('reports <SI>i1, which replaces printed glyphs', () => {
        // PRM 2.70 p.128: "allows IBM compatible characters to REPLACE standard
        // ASCII characters based on the current printer language." The same
        // class as <SI>z1, which is already reported.
        expect(warned('<SI>i1')).toBe(true);
    });

    it('stays silent for <SI>i0, the documented disabled state', () => {
        expect(warned('<SI>i0')).toBe(false);
    });

    it('does NOT fire on <SI>I — that is Number of Image Bands', () => {
        // The two commands differ only by case, and the manual's own
        // emulation-mode table (p.128) prints "<SI>I" for IBM, which is a typo
        // there. Its two other indexes agree on the split: the by-syntax list
        // reads "i 69 IBM Language Translation" and "I 49 Set Number of Image
        // Bands". Matching case-insensitively would shadow a real command.
        expect(warned('<SI>I8')).toBe(false);
        expect(warned('<SI>I')).toBe(false);
    });

    it('does not match inside a longer argument', () => {
        expect(warned('<SI>i12')).toBe(false);
        expect(warned('<SI>i1,2')).toBe(false);
    });

    it('still fires when the command rides inside a combined setup frame', () => {
        // The shape BarTender and hand-authored streams use.
        expect(warned('<SI>l13;<SI>i1')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// <SI>K — the text printed on a label whose RFID tag failed
// ---------------------------------------------------------------------------
//
// Sweeping the manual's own Configuration Commands list (PRM 2.70 p.96) found
// this one still silent. "Defines the text that is printed on labels that have
// bad RFID tags… When the RFID module cannot communicate with the tag on the
// label, this text will be printed at the start of the label" — default "VOID",
// font 26, printed in the down direction.
//
// Reported for the same reason as <SI>z1 and <SI>i1: it is text that can appear
// on the label and this preview cannot draw it. Nothing here models RFID, so a
// failing tag would print VOID on the stock and show nothing on screen.
describe('<SI>K — RFID tag void text (2026-09-29)', () => {
    const stx = (f: string) => `<STX>${f}<ETX>`;
    const warned = (setup: string): boolean => parseViewerIPL(
        [stx('<ESC>C<SI>W812'), stx(setup), stx('<ESC>P'), stx('E1;F1'), stx('H1;o10,10;d3,X'), stx('R')].join(''),
    ).issues.some(i => i.code === 'setup-not-modelled');

    it('reports a configured void text', () => {
        expect(warned('<SI>KVOID')).toBe(true);
        expect(warned('<SI>KVOID,BAD')).toBe(true);
        expect(warned('<SI>K1')).toBe(true);
    });

    it('stays silent when the argument is blank, which DISABLES the command', () => {
        // "If n is blank, this command is disabled" (p.144) — nothing to print,
        // so there is no divergence to report.
        expect(warned('<SI>K')).toBe(false);
        expect(warned('<SI>K;')).toBe(false);
    });

    it('does not fire on its neighbours', () => {
        // K is uppercase and sits between the <SI>J and <SI>L entries in the
        // manual's list; both are handled elsewhere and neither prints text.
        expect(warned('<SI>L406')).toBe(false);
        expect(warned('<SI>J1')).toBe(false);
    });
});
