// Resident character substitution for printer languages 0-9 (PRM p.133
// "Printer Language, Select"), the counterpart to the code pages in
// codePages.ts.
//
// These are NOT code pages. A code page (n=10-20, 40) remaps the whole
// 0x80-0xFF range onto a different script; a resident language SUBSTITUTES a
// handful of ASCII positions (0x23 0x24 0x40 0x5B-0x5E 0x60 0x7B-0x7E) so
// that a national character prints where the ASCII punctuation was. Sending
// '{' with language=Germany (n=2) prints 'ä'. Source: PRM 2.70 p.228
// "Advanced Character Table", cross-checked against PRM rev008 p.212 and the
// 4400 manual p.248, which agree cell for cell.
//
// Two decisions worth knowing about, both load-bearing:
//
// 1. n=0 (USA) and n=8 (8-bit ASCII) are the IDENTITY. The Advanced table
//    shows U+00A6 (broken bar) at 0x7C for its U.S. row, but the same manual's
//    "Full ASCII Table" (p.240) defines the printer's 0x7C as "|"
//    (01111100 7C 124 %Q |), and ASCII/ISO 646 define it as "|" too. Listing
//    the printer's own charset wins over one cell of a typeset appendix, and
//    treating USA as anything but identity would rewrite every "|" in an
//    English label. Same reasoning for the U.K. row, whose 0x7C is also "|"
//    per ISO 646-GB; the manual prints the same broken-bar glyph there.
//
// 2. The letter cells are trustworthy — they agree with ISO 646 national
//    variants everywhere except the two bar/tilde cells above. The 0x7E
//    "−" (U+2212) in the U.K. and Norway/Denmark rows is kept as printed:
//    both the 2.70 and the 4400 manuals show it, and no counter-evidence
//    exists in either (the Full ASCII table does not render a glyph for 7E).

import { decodeCodePage } from './codePages';

/** Byte position -> the glyph a resident font prints there, per language. */
const RESIDENT_SUBSTITUTIONS: { [n: number]: { [byte: number]: string } } = {
    // U.K. ASCII: pound replaces '#'. 0x7C stays '|' (see note 1).
    1: { 0x23: '£', 0x7c: '|', 0x7e: '−' },
    2: {
        0x40: '§', 0x5b: 'Ä', 0x5c: 'Ö', 0x5d: 'Ü',
        0x7b: 'ä', 0x7c: 'ö', 0x7d: 'ü', 0x7e: 'ß',
    },
    3: {
        0x5b: 'Æ', 0x5c: 'Ø', 0x5d: 'Å',
        0x7b: 'æ', 0x7c: 'ø', 0x7d: 'å', 0x7e: '−',
    },
    4: {
        0x23: '£', 0x40: 'à', 0x5b: '°', 0x5c: 'ç', 0x5d: '§',
        0x7b: 'é', 0x7c: 'ù', 0x7d: 'è', 0x7e: '¨',
    },
    5: {
        0x24: '¤', 0x40: 'É', 0x5b: 'Ä', 0x5c: 'Ö', 0x5d: 'Å', 0x5e: 'Ü', 0x60: 'é',
        0x7b: 'ä', 0x7c: 'ö', 0x7d: 'å', 0x7e: 'ü',
    },
    6: {
        0x23: '£', 0x40: '§', 0x5b: '°', 0x5c: 'ç', 0x5d: 'é', 0x60: 'ù',
        0x7b: 'à', 0x7c: 'ò', 0x7d: 'è', 0x7e: 'ì',
    },
    7: {
        0x23: '£', 0x40: '§', 0x5b: '¡', 0x5c: 'Ñ', 0x5d: '¿',
        0x7b: '°', 0x7c: 'ñ', 0x7d: 'ç',
    },
    9: {
        0x40: 'à', 0x5b: '°', 0x5c: 'ç', 0x5d: 'é', 0x60: 'ù',
        0x7b: 'ä', 0x7c: 'ö', 0x7d: 'ü', 0x7e: 'è',
    },
};

/** True when `n` selects a resident language with a substitution table. */
export const hasResidentSubstitution = (n: number): boolean =>
    Object.prototype.hasOwnProperty.call(RESIDENT_SUBSTITUTIONS, n);

/**
 * Apply the resident character substitution for language `n`.
 *
 * Only the twelve documented positions can change; every other byte — and
 * every position in a language that leaves it alone — passes through, so a
 * stream that never selects a language is untouched. Characters above U+00FF
 * are already-decoded text and never substituted (a literal 'ä' the user
 * typed stays 'ä').
 */
export function applyResidentCharset(s: string, n: number): string {
    const table = RESIDENT_SUBSTITUTIONS[n];
    if (!table) return s;
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        const replacement = code <= 0xff ? table[code] : undefined;
        out += replacement ?? s.charAt(i);
    }
    return out;
}

/**
 * Decode print data under the selected printer language.
 *
 * Single entry point so the two models cannot drift: `n` selects EITHER a
 * resident substitution (0-9) OR a code page (10-20, 40), never both, and
 * callers should not have to know which.
 */
export const decodePrintData = (s: string, n: number | undefined): string => {
    if (n === undefined || n === null) return s;
    if (n >= 0 && n <= 9) return applyResidentCharset(s, n);
    return decodeCodePage(s, n);
};
