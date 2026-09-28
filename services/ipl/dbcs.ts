// Double-byte (CJK) code page decoding for printer languages 30-33.
//
// The tables live in codePagesCjkData.ts, which services/ipl/codePages.ts
// imports dynamically so their ~190 KB stays out of the main chunk. This module
// is the decoder: small, hand-written, and the thing tests/codePageCjk.test.ts
// replays whole byte sequences through.
//
// The algorithm is the WHATWG Encoding Standard's decoder for each label, and
// its shape is driven by three rules that are easy to get subtly wrong:
//
//  1. A byte is tried as a STANDALONE character first (ASCII below 0x80, plus
//     the few high bytes a page maps alone, like CP932's halfwidth katakana).
//     Only if that fails is it a lead byte.
//
//  2. On a bad or unmapped trail, the decoder emits ONE error and then, in the
//     standard's words, "if byte is an ASCII byte, restore byte to ioQueue" —
//     so an ASCII trail is reprocessed as its own character ('A' stays 'A'),
//     while a non-ASCII trail is consumed with the lead. Getting this backwards
//     turns one U+FFFD into two, or swallows a letter.
//
//  3. A lead byte at the end of the data is one error, not a dropped byte.
//
// One deliberate divergence from the browsers, recorded rather than hidden:
// the WHATWG "gbk" label is gb18030's decoder, which also implements FOUR-byte
// sequences, so Chromium reads `81 30` as the start of one and consumes it.
// The printer's code page 936 is GB 2312-80 — a two-byte page — so this decoder
// stops at two and treats `81 30` as an error plus the ASCII '0'. A stream that
// really carried GB18030 four-byte data would decode differently here; no such
// stream exists in this project's corpus, and the printer would not read it
// either. tests/codePageCjk.test.ts pins both this case and the four Big5 slots
// where Chromium disagrees with its own specification.

/** A decoded table, as produced from the raw base64 by `decodeCjkTable`. */
export interface DbcsTable {
    /** The WHATWG label this table reproduces, for diagnostics and tests. */
    whatwg: string;
    /** Accepted lead-byte ranges, in row order. */
    leads: readonly (readonly [number, number])[];
    /** Accepted trail-byte ranges. A trail outside these is not consumed. */
    trails: readonly (readonly [number, number])[];
    /** One slot per (lead, trail) pair, row-major. `UNMAPPED`/`SPECIAL` markers. */
    flat: Uint16Array;
    /** Standalone mappings for bytes 0x80-0xFF, indexed from 0x80. */
    singles: Uint16Array;
    /** Slots per lead row: trails 0x40-0x7E then 0x80-0xFE. */
    slotCount: number;
    /** `[slot, cp1, cp2, ...]` for `SPECIAL` slots; cp2 is 0 for astral singles. */
    special: Uint32Array;
}

/** Raw base64 table data, the shape codePagesCjkData.ts exports. */
export interface DbcsRawTable {
    whatwg: string;
    leads: readonly (readonly [number, number])[];
    flat: string;
    singles: string;
    special?: string;
}

/** A slot with no mapping. */
export const UNMAPPED = 0xffff;
/** A slot whose value is in the `special` list instead. */
export const SPECIAL = 0xfffe;
/** Slots in a lead row: 0x40-0x7E (63) plus 0x80-0xFE (127). */
export const SLOT_COUNT = 190;
/** Every page in the standard accepts these trails. */
export const SLOT_TRAILS: readonly (readonly [number, number])[] = [[0x40, 0x7e], [0x80, 0xfe]];

const decodeU16 = (b64: string): Uint16Array => {
    const bin = atob(b64);
    const out = new Uint16Array(bin.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
    }
    return out;
};

const decodeU32 = (b64: string): Uint32Array => {
    const bin = atob(b64);
    const out = new Uint32Array(bin.length / 4);
    for (let i = 0; i < out.length; i++) {
        out[i] = (bin.charCodeAt(i * 4)
            | (bin.charCodeAt(i * 4 + 1) << 8)
            | (bin.charCodeAt(i * 4 + 2) << 16)
            | (bin.charCodeAt(i * 4 + 3) << 24)) >>> 0;
    }
    return out;
};

/** Decode a raw table's base64 into the arrays the decoder reads. */
export const decodeCjkTable = (raw: DbcsRawTable): DbcsTable => ({
    whatwg: raw.whatwg,
    leads: raw.leads,
    trails: SLOT_TRAILS,
    flat: decodeU16(raw.flat),
    singles: decodeU16(raw.singles),
    slotCount: SLOT_COUNT,
    special: raw.special ? decodeU32(raw.special) : new Uint32Array(0),
});

const inRanges = (v: number, ranges: readonly (readonly [number, number])[]): boolean => {
    for (const [lo, hi] of ranges) if (v >= lo && v <= hi) return true;
    return false;
};

/** Row index of a lead byte, or -1 when it is not a lead for this page. */
const leadRow = (lead: number, ranges: readonly (readonly [number, number])[]): number => {
    let row = 0;
    for (const [lo, hi] of ranges) {
        if (lead >= lo && lead <= hi) return row + (lead - lo);
        row += hi - lo + 1;
    }
    return -1;
};

/**
 * Slot index of a trail byte within its row. 0x40-0x7E keep their offset and
 * 0x80 and up shift down by one, because 0x7F is not a trail anywhere.
 */
const trailSlot = (trail: number): number => trail - 0x40 - (trail > 0x7f ? 1 : 0);

/** `[cp1, cp2]` for a `special` slot; cp2 is 0 when the value is one astral char. */
const specialAt = (table: DbcsTable, slot: number): readonly [number, number] | undefined => {
    const s = table.special;
    for (let i = 0; i < s.length; i += 3) {
        if (s[i] === slot) return [s[i + 1], s[i + 2]];
    }
    return undefined;
};

const REPLACEMENT = 0xfffd;

/**
 * Decode a byte-string under one double-byte page.
 *
 * The input is the pipeline's byte-string: one char per byte, so every char at
 * or below U+00FF is a byte and anything above it is real text that passes
 * through untouched.
 */
export function decodeDbcs(s: string, table: DbcsTable): string {
    let out = '';
    let i = 0;
    while (i < s.length) {
        const code = s.charCodeAt(i);

        if (code > 0xff || code < 0x80) {
            out += s.charAt(i);
            i++;
            continue;
        }

        const single = table.singles[code - 0x80];
        if (single !== UNMAPPED) {
            out += String.fromCodePoint(single);
            i++;
            continue;
        }

        const row = leadRow(code, table.leads);
        if (row < 0) {
            out += String.fromCodePoint(REPLACEMENT);
            i++;
            continue;
        }

        const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
        // A char above U+00FF is REAL TEXT, not a byte. It can never be a
        // trail, and it must not be consumed either — consuming it would drop
        // a character the user actually typed. Only a byte the decoder can
        // legitimately claim (in U+0000-U+00FF, not ASCII) goes with the lead.
        const nextIsByte = next >= 0 && next <= 0xff;
        const nextIsData = nextIsByte && !inRanges(next, table.trails);

        if (next < 0 || !nextIsByte || !inRanges(next, table.trails)) {
            out += String.fromCodePoint(REPLACEMENT);
            // Spec: "if byte is an ASCII byte, restore byte to ioQueue" — an
            // ASCII or non-byte follower is read again as its own character;
            // only a non-ASCII BYTE is consumed with the lead.
            i += nextIsData && next >= 0x80 ? 2 : 1;
            continue;
        }

        const slot = row * table.slotCount + trailSlot(next);
        const value = table.flat[slot];
        if (value === UNMAPPED) {
            out += String.fromCodePoint(REPLACEMENT);
            // A valid trail was already established, so this one really is
            // claimed by the lead unless it is ASCII (which is restored).
            i += next >= 0x80 ? 2 : 1;
            continue;
        }
        if (value === SPECIAL) {
            const pair = specialAt(table, slot);
            if (!pair) out += String.fromCodePoint(REPLACEMENT);
            else {
                out += String.fromCodePoint(pair[0]);
                if (pair[1] !== 0) out += String.fromCodePoint(pair[1]);
            }
        } else {
            out += String.fromCodePoint(value);
        }
        i += 2;
    }
    return out;
}
