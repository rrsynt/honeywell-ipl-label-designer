// Whether a design's text survives the journey to the printer as BYTES.
//
// Every generator writes a field's characters into a stream verbatim, and every
// send path then encodes that stream as UTF-8: services/bridgeSend.ts posts it
// as `text/plain`, and tools/ipl-bridge.mjs does `Buffer.from(body, 'utf8')`.
// What the PRINTER then prints depends on the character set it has been told to
// use, and the languages do not agree:
//
//   IPL  declares `<SI>l13` — CP1252, where 0xE9 is 'é'. The bytes that arrive
//        for 'é' are 0xC3 0xA9 (UTF-8), which CP1252 reads as 'Ã©'.
//   ZPL  declares `^CI28` — UTF-8 — so it agrees with the send path.
//   EPL  and TSPL declare nothing, so the printer's own default applies.
//   DPL  has a symbol set (`ySxx`, Appendix I) that this app never sets.
//
// So a design containing anything above U+00FF is written into a stream that
// claims a single-byte code page, and nothing said so. This does not fix the
// mismatch — which encoding a given printer accepts is firmware-dependent and
// cannot be settled without one — but it stops the label being quietly wrong:
// the code panel now says which characters will not survive and why.

import type { Design, Field } from '../types';

/** True when every character is inside the range a single-byte page can hold. */
const isSingleByte = (s: string): boolean => {
    for (const ch of s) {
        if (ch.codePointAt(0)! > 0xff) return false;
    }
    return true;
};

/**
 * The literal text a field will print, for the data sources whose text is known
 * at GENERATE time.
 *
 * Table and counter links are deliberately absent: their values come from rows
 * at print time and are not in the design, so a check here would either miss
 * them or report them wrongly. Only the sources this module can read are read.
 */
const literalOf = (field: Field): string | null => {
    // Only text and barcode fields carry a data source; shapes do not.
    if (!('dataSource' in field)) return null;
    const ds = field.dataSource;
    if (ds.type === 'fixed') return ds.data;
    if (ds.type === 'variable') return ds.defaultData;
    if (ds.type === 'date' || ds.type === 'time') {
        // ASCII by construction — every format in dateTimeFormat is digits and
        // separators — so there is nothing that can exceed the range.
        return null;
    }
    if (ds.type === 'linked') return null;
    return null;
};

export interface CharsetRisk {
    /** The characters that cannot survive the declared code page. */
    characters: string[];
    /** The fields they were found in, by name, for the message. */
    fields: string[];
}

/** Every character in the design that a declared single-byte page cannot hold. */
export const charsetRisks = (design: Design): CharsetRisk => {
    const characters = new Set<string>();
    const fields = new Set<string>();
    for (const field of design.fields) {
        const text = literalOf(field);
        if (text === null || isSingleByte(text)) continue;
        let risky = false;
        for (const ch of text) {
            if (ch.codePointAt(0)! > 0xff) {
                characters.add(ch);
                risky = true;
            }
        }
        if (risky) fields.add(field.name);
    }
    return { characters: [...characters], fields: [...fields] };
};

/**
 * The warning to show beside the generated code, or null when the design is
 * safe for the language it is being generated in.
 *
 * ZPL is the one language here that declares UTF-8, so it carries the whole
 * range and gets no warning. The others declare a single-byte page — or, for
 * EPL/TSPL/DPL, nothing at all, which leaves the printer's own default — and a
 * character above U+00FF cannot be encoded in one whatever that default is.
 */
export const charsetWarning = (design: Design, language: string): string | null => {
    if (language === 'zpl') return null;
    const { characters, fields } = charsetRisks(design);
    if (characters.length === 0) return null;
    const list = characters.slice(0, 8).join(' ');
    const more = characters.length > 8 ? ` (+${characters.length - 8} more)` : '';
    const where = fields.slice(0, 3).join(', ');
    return `The stream is sent as UTF-8, but ${language.toUpperCase()} prints through a single-byte `
        + `character set, so ${list}${more} will not print as written — found in: ${where}. `
        + 'Text up to U+00FF is unaffected.';
};
