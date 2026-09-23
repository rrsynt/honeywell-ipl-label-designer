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

/** Fallback advance for codepoints outside printable ASCII (non-Latin text,
 *  control chars): the family's average, so widths stay plausible instead of
 *  collapsing to 0. */
const SANS_DEFAULT = 524;
const SERIF_DEFAULT = 478;

const tableFor = (family: string | undefined): { t: readonly number[] | null; perMille: number; dflt: number } => {
    if (family === 'sans-serif') return { t: SANS, perMille: 0, dflt: SANS_DEFAULT };
    if (family === 'serif') return { t: SERIF, perMille: 0, dflt: SERIF_DEFAULT };
    return { t: null, perMille: MONO_PER_MILLE, dflt: MONO_PER_MILLE };
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
    if (!t) return line.length * hDots * perMille / 1000;
    let sumPerMille = 0;
    for (let i = 0; i < line.length; i++) {
        const code = line.charCodeAt(i);
        sumPerMille += code >= 32 && code <= 126 ? t[code - 32] : dflt;
    }
    return sumPerMille * hDots / 1000;
};

/** Widest line of a multi-line block. */
export const outlineTextBlockWidthDots = (
    lines: string[],
    hDots: number,
    family: string | undefined,
): number => Math.max(0, ...lines.map(l => outlineTextWidthDots(l, hDots, family)));
