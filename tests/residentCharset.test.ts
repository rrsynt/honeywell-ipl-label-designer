// Resident character substitution for printer languages 0-9 (PRM p.133).
// Distinct from code pages: a resident language substitutes a handful of ASCII
// positions so a national character prints where the punctuation was, rather
// than remapping the whole 0x80-0xFF range.
//
// The expected rows below are the manual's "Advanced Character Table" read in
// header order (23 24 40 5B 5C 5D 5E 60 7B 7C 7D 7E), extracted from the PDF
// text layer with per-character coordinates rather than from the plain-text
// dumps — those dumps reflow the table and drop glyphs (0x7C comes out as a
// broken bar even for the U.S. row).
import { describe, it, expect } from 'vitest';
import {
    applyResidentCharset,
    decodePrintData,
    hasResidentSubstitution,
} from '../services/ipl/residentCharset';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import type { TextElement } from '../services/ipl/types';

const stx = (f: string) => `<STX>${f}<ETX>`;
const bytes = (...v: number[]) => String.fromCharCode(...v);

const textEl = (label: ReturnType<typeof parseViewerIPL>): TextElement =>
    label.elements.filter(e => e.kind === 'text')[0] as TextElement;

const COLS = [0x23, 0x24, 0x40, 0x5b, 0x5c, 0x5d, 0x5e, 0x60, 0x7b, 0x7c, 0x7d, 0x7e];

/** Manual rows. US/UK 0x7C read as '|' — see the dedicated describe below. */
const MANUAL_ROWS: { [n: number]: string } = {
    0: '# $ @ [ \\ ] ^ ` { | } ~',
    1: '£ $ @ [ \\ ] ^ ` { | } −',
    2: '# $ § Ä Ö Ü ^ ` ä ö ü ß',
    3: '# $ @ Æ Ø Å ^ ` æ ø å −',
    4: '£ $ à ° ç § ^ ` é ù è ¨',
    5: '# ¤ É Ä Ö Å Ü é ä ö å ü',
    6: '£ $ § ° ç é ^ ù à ò è ì',
    7: '£ $ § ¡ Ñ ¿ ^ ` ° ñ ç ~',
    9: '# $ à ° ç é ^ ù ä ö ü è',
};

describe('applyResidentCharset', () => {
    it('is the identity for languages with no substitution', () => {
        for (const n of [0, 8]) {
            expect(hasResidentSubstitution(n), `n=${n}`).toBe(false);
            expect(applyResidentCharset('{|}~#$@[]\\^`', n)).toBe('{|}~#$@[]\\^`');
        }
    });

    it('reproduces the manual row for every documented language', () => {
        // Drive each row position by position: feed the twelve header bytes as
        // ASCII and demand exactly the manual's twelve glyphs back.
        for (const [n, row] of Object.entries(MANUAL_ROWS)) {
            const lang = Number(n);
            const want = row.split(' ');
            expect(want.length, `row ${lang} must have 12 cells`).toBe(12);
            const input = String.fromCharCode(...COLS);
            expect(applyResidentCharset(input, lang), `language ${lang}`).toBe(want.join(''));
        }
    });

    it('leaves every position the language does not remap', () => {
        // Germany touches 0x40/5B/5C/5D/7B/7C/7D/7E only — '$' and '^' survive.
        expect(applyResidentCharset('$^', 2)).toBe('$^');
        // UK changes '#' and '~' (the two documented non-identity cells).
        expect(applyResidentCharset('$@[]^`{}', 1)).toBe('$@[]^`{}');
        expect(applyResidentCharset('#~', 1)).toBe('£−');
        // Letters, digits and lowercase are never substituted anywhere.
        for (const lang of Object.keys(MANUAL_ROWS).map(Number)) {
            expect(applyResidentCharset('ABC 123 xyz', lang), `n=${lang}`).toBe('ABC 123 xyz');
        }
    });

    it('agrees with ISO 646 national variants on the letter cells', () => {
        // Derived from MANUAL_ROWS rather than hand-written: transcribing the
        // expected string by hand put the cells in HEADER order instead of
        // input order twice, which is exactly the mistake this avoids.
        const expectFor = (input: string, lang: number) => {
            const row = MANUAL_ROWS[lang].split(' ');
            return [...input]
                .map(ch => row[COLS.indexOf(ch.charCodeAt(0))])
                .join('');
        };
        for (const input of ['[]\\{}|', '@[]{}|~', '#$~']) {
            for (const lang of [1, 2, 3, 4, 5, 6, 7, 9]) {
                expect(applyResidentCharset(input, lang), `${input} @ n=${lang}`)
                    .toBe(expectFor(input, lang));
            }
        }
    });

    it('never rewrites characters that are already decoded text', () => {
        // A literal 'ä' the user typed must survive: only the byte position it
        // maps FROM (0x7B) is substituted, and U+00E4 is not a byte here.
        expect(applyResidentCharset('ä', 2)).toBe('ä');
        expect(applyResidentCharset('Grüße', 2)).toBe('Grüße');
        expect(applyResidentCharset('€', 1)).toBe('€');
    });
});

describe('US/UK 0x7C stays a pipe (pinned against a tempting misreading)', () => {
    it('U.S. ASCII keeps the pipe', () => {
        // The Advanced table prints U+00A6 at 0x7C for its U.S. row, but the
        // same manual's Full ASCII Table (p.240) defines the printer's 0x7C as
        // "|" (01111100 7C 124 %Q |), and ASCII/ISO 646 agree. It is a
        // typeface gap — the printed glyph is indistinguishable from the one
        // used for 0xA6 elsewhere — not printer behaviour. Following it
        // literally would rewrite every pipe in an English label:
        // bartender-auto.ipl carries 171 of them.
        expect(applyResidentCharset('|', 0)).toBe('|');
        expect(applyResidentCharset('A|B|C', 0)).toBe('A|B|C');
    });

    it('U.K. ASCII keeps the pipe too', () => {
        expect(applyResidentCharset('|', 1)).toBe('|');
        // Its documented differences still apply.
        expect(applyResidentCharset('#', 1)).toBe('£');
        expect(applyResidentCharset('~', 1)).toBe('−');
    });
});

describe('decodePrintData dispatches to the right model', () => {
    it('routes 0-9 to the resident substitution', () => {
        expect(decodePrintData('{', 2)).toBe('ä');
    });

    it('routes 10-20 to the code page table', () => {
        // 0x84 is 'ä' in cp850 (n=10); no resident row touches that byte.
        expect(decodePrintData(bytes(0x84), 10)).toBe('ä');
    });

    it('routes 40 to UTF-8', () => {
        expect(decodePrintData(bytes(0xc3, 0xa4), 40)).toBe('ä');
    });

    it('is the identity when no language is selected', () => {
        expect(decodePrintData('{}|~', undefined)).toBe('{}|~');
    });

    it('leaves an unknown language alone', () => {
        expect(decodePrintData('{}|~', 99)).toBe('{}|~');
    });
});

describe('<SI>l applies resident substitution to print data', () => {
    it('substitutes fixed d3 data', () => {
        const label = parseViewerIPL([
            stx('<ESC>P'), stx('<SI>l2'), stx('E1;F1'),
            stx('H0;o10,10;c0;d3,@{'), stx('R'), stx('<ESC>E1'),
        ].join(''));
        expect(textEl(label).source).toEqual({ type: 'fixed', data: '§ä' });
    });

    it('substitutes print-block variable data', () => {
        const label = parseViewerIPL([
            stx('<ESC>P'), stx('<SI>l2'), stx('E1;F1'), stx('H0;o10,10;c0;d1'), stx('R'),
            stx('<ESC>E1<CAN><ESC>F0<NUL>@{[<ETB><FF>'),
        ].join(''));
        expect(textEl(label).source).toEqual({ type: 'variable', data: '§äÄ' });
    });

    it('leaves data untouched when the stream selects U.S. ASCII', () => {
        const frames = [stx('E1;F1'), stx('H0;o10,10;c0;d3,@{|~'), stx('R'), stx('<ESC>E1')];
        const withUs = parseViewerIPL([stx('<ESC>P'), stx('<SI>l0'), ...frames].join(''));
        const without = parseViewerIPL([stx('<ESC>P'), ...frames].join(''));
        expect(textEl(withUs).source).toEqual(textEl(without).source);
        expect(textEl(withUs).source).toEqual({ type: 'fixed', data: '@{|~' });
    });

    it('a later language does not retroactively rewrite an earlier block', () => {
        const code = [
            stx('<ESC>P'), stx('E1;F1'), stx('H0;o10,10;c0;d1'), stx('R'),
            stx('<SI>l2'),
            stx('<ESC>E1<CAN><ESC>F0<NUL>{<ETB><FF>'),
            stx('<SI>l0'),
        ].join('');
        const label = parseViewerIPL(code);
        expect(label.settings.codePage).toBe(0);
        expect(textEl(label).source).toEqual({ type: 'variable', data: 'ä' });
    });
});
