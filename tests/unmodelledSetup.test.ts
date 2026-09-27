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
