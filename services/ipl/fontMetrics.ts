// Batch U (2026-09-24): per-glyph advance calibration for the OUTLINE font
// families, replacing the flat 0.6-em estimate in the viewer's layout math.
//
// Why a table and not ctx.measureText: estimateElementSize is a pure
// function (no canvas) used by computeLabelExtent, anchors and the
// template-fit tests — it must run identically in Node (golden harness)
// and browser. The tables below are the printable-ASCII advances of the
// vendored Liberation fonts (public/fonts), measured once via @napi-rs/canvas
// at 100px; the ratios are scale-invariant (verified at 20px/40px/100px),
// so one table per family serves every point size.
//
// Liberation Mono is uniform 600/1000 em — the old 0.6 flat estimate was
// EXACT for the monospace family (which is why the c25-heavy goldens never
// caught this). The divergence is proportional: Swiss 721 (c61 → sans) and
// Dutch Roman (c28 → serif) measured every narrow string 10–25% too wide
// and every 'WWW'-style string up to 57% too narrow.
//
// If the vendored fonts ever change, regenerate with the snippet in
// tests/fontMetrics.test.ts (it pins this table against live measureText).

import type { FontFamily } from '../../constants';

/** Advances in per-mille of em, ASCII 32 (space) through 126 (~). */
const SANS: readonly number[] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const SERIF: readonly number[] = [
    250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278,
    500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444,
    921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722,
    556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500,
    333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500,
    500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541,
];

const MONO_PER_MILLE = 600;

/** Century Schoolbook (IPL id c67), measured from TeX Gyre Schola — the
 *  GUST-licensed face that IS metrically identical to the printer's Monotype
 *  original (0 per-mille difference across ASCII 32–126; the real face is
 *  commercial and cannot be vendored). Previously c67 resolved to the `serif`
 *  table, which is Times-compatible and metered its fields ~10–13% too narrow.
 *
 *  Monospace's 600 cannot stand in for this family: the tables differ by up to
 *  406 per-mille, which is exactly the defect this table exists to fix. */
const SCHOOLBOOK: readonly number[] = [
    278, 296, 389, 556, 556, 833, 815, 204, 333, 333, 500, 606, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 606, 606, 606, 444,
    737, 722, 722, 722, 778, 722, 667, 778, 833, 407, 556, 778, 667, 944, 815, 778,
    667, 778, 722, 630, 667, 815, 722, 981, 704, 704, 611, 333, 606, 333, 606, 500,
    333, 556, 556, 444, 574, 500, 333, 537, 611, 315, 296, 593, 315, 889, 611, 500,
    574, 556, 444, 463, 389, 611, 537, 778, 537, 537, 481, 333, 606, 333, 606,
];

/** Fallback advance for codepoints outside printable ASCII (non-Latin text,
 *  control chars): the family's average, so widths stay plausible instead of
 *  collapsing to 0. */
const SANS_DEFAULT = 524;
const SERIF_DEFAULT = 478;
const SCHOOLBOOK_DEFAULT = 558;

/**
 * Fase 3: a user-uploaded font. The screen renders it by its real face (the
 * browser and the golden harness both register the bytes under `cssFamily`),
 * but the viewer's layout math is pure and cannot call measureText, so it reads
 * `advances` — the same per-mille-of-em table the Liberation families use.
 * `family` is which resident IPL family it is closest to, which is what the
 * generator actually emits; the screen and the printer therefore differ by a
 * known amount, and that amount is reported rather than hidden.
 */
export interface UploadedFontMetrics {
    /** CSS family name the face was registered under. */
    cssFamily: string;
    /** Nearest resident family, by average advance. */
    family: FontFamily;
    /** Per-mille advances, ASCII 32 through 126, measured at one size. */
    advances: number[];
    /** Average of `advances`, used for codepoints the table does not cover. */
    dflt: number;
}

const uploadedFonts = new Map<string, UploadedFontMetrics>();

/** Register (or replace) one uploaded font's metrics. Idempotent. */
export const registerUploadedFontMetrics = (name: string, metrics: UploadedFontMetrics): void => {
    uploadedFonts.set(name, metrics);
};

/** Drop one, or every uploaded font. Tests reset between cases with this. */
export const clearUploadedFontMetrics = (name?: string): void => {
    if (name === undefined) uploadedFonts.clear();
    else uploadedFonts.delete(name);
};

export const getUploadedFontMetrics = (name: string): UploadedFontMetrics | undefined => uploadedFonts.get(name);

const tableFor = (family: string | undefined): { t: readonly number[] | null; perMille: number; dflt: number } => {
    // An uploaded font is addressed by its own name, which is never one of the
    // resident families, so this lookup cannot shadow them.
    const uploaded = family ? uploadedFonts.get(family) : undefined;
    if (uploaded) return { t: uploaded.advances, perMille: 0, dflt: uploaded.dflt };
    if (family === 'sans-serif') return { t: SANS, perMille: 0, dflt: SANS_DEFAULT };
    if (family === 'serif') return { t: SERIF, perMille: 0, dflt: SERIF_DEFAULT };
    if (family === 'schoolbook') return { t: SCHOOLBOOK, perMille: 0, dflt: SCHOOLBOOK_DEFAULT };
    // Monospace is the fallthrough, so an unknown family lands on 600. Every
    // FontFamily member must be named explicitly above: a new family that
    // reached this line would be measured as monospace, which for schoolbook
    // would under-measure by ~7% and (unlike a missing font) do it silently.
    return { t: null, perMille: MONO_PER_MILLE, dflt: MONO_PER_MILLE };
};

/**
 * Codepoints that occupy a full em — UAX #11 East Asian Wide/Fullwidth, the
 * standard property for exactly this question. Kanji, Kana, Hangul, the
 * fullwidth forms, CJK punctuation and the CJK planes.
 *
 * They matter because the fallback below is the family's AVERAGE, which is
 * tuned for punctuation and accented Latin: charging 524 for a kanji measured
 * its box ~48% narrow, and a c50 (Kanji outline) field drew 97 dots of ink
 * inside a 53-dot box. Measured in the browser, every one of these is exactly
 * 1000 per-mille in both the sans and mono stacks, so this is a fact about the
 * glyphs rather than a fudge factor.
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
    [0x1100, 0x115F],  // Hangul Jamo
    [0x2E80, 0x303E],  // CJK radicals, Kangxi, CJK punctuation
    [0x3041, 0x33FF],  // Hiragana, Katakana, Bopomofo, Hangul Compat, CJK Compat
    [0x3400, 0x4DBF],  // CJK Extension A
    [0x4E00, 0x9FFF],  // CJK Unified Ideographs
    [0xA000, 0xA4CF],  // Yi
    [0xAC00, 0xD7A3],  // Hangul syllables
    [0xF900, 0xFAFF],  // CJK Compatibility Ideographs
    [0xFE10, 0xFE19],  // Vertical forms
    [0xFE30, 0xFE6F],  // CJK Compatibility Forms, Small Form Variants
    [0xFF00, 0xFF60],  // Fullwidth forms
    [0xFFE0, 0xFFE6],  // Fullwidth signs
    [0x1F300, 0x1F64F], [0x1F900, 0x1F9FF], // emoji that render double-wide
    [0x20000, 0x2FFFD], [0x30000, 0x3FFFD], // CJK Extension B and beyond
];
const WIDE_PER_MILLE = 1000;

const isWideCodePoint = (cp: number): boolean => {
    for (const [lo, hi] of WIDE_RANGES) if (cp >= lo && cp <= hi) return true;
    return false;
};

/**
 * Width in dots of one text line drawn at cap-height `hDots` (the renderer's
 * outline convention: glyph box height in printer dots) in the given family.
 * Monospace collapses to length × 0.6h — identical to the old estimate, so
 * every existing golden stays byte-stable.
 */
export const outlineTextWidthDots = (
    line: string,
    hDots: number,
    family: string | undefined,
): number => {
    const { t, perMille, dflt } = tableFor(family);
    let sumPerMille = 0;
    for (const ch of line) {
        const cp = ch.codePointAt(0)!;
        // Wide codepoints are checked BEFORE the per-family table, because the
        // monospace family has no table and would otherwise take the fast path
        // below: c51 is the Kanji MONOSPACE outline id, so its kanji must not
        // inherit the uniform 600 that suits its Latin glyphs.
        if (isWideCodePoint(cp)) {
            sumPerMille += WIDE_PER_MILLE;
        } else if (!t) {
            sumPerMille += perMille;
        } else if (cp >= 32 && cp <= 126) {
            sumPerMille += t[cp - 32];
        } else {
            sumPerMille += dflt;
        }
    }
    return sumPerMille * hDots / 1000;
};

/** Widest line of a multi-line block. */
export const outlineTextBlockWidthDots = (
    lines: string[],
    hDots: number,
    family: string | undefined,
): number => Math.max(0, ...lines.map(l => outlineTextWidthDots(l, hDots, family)));
