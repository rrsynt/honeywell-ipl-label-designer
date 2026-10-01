// DPL's resident font metrics, from the Datamax *Class Series Programmer's
// Manual* (88-2316-01 Rev H, Appendix C, Tables C-2/C-3/C-4).
//
// This table is why the manual mattered. The one secondary source in the repo
// (docs/manuals/DPL_Reference_Sources/nokka_dpl.py, described as transcribed
// from the M-Class manual) lists Font 0 as 7 high x 5 wide. The manual's own
// Appendix C says 10 x 7 at 203 dpi — the secondary source is a different
// measurement, and a font table taken from it would size every text field
// wrong. Two official manuals agree with each other and disagree with it.

export interface DplFontMetric {
    /** Cell height in dots at 203 dpi. */
    height: number;
    /** Cell width in dots at 203 dpi. */
    width: number;
    /** Intercharacter spacing in dots. */
    spacing: number;
    /** Nominal point size, for the outline path. */
    points: number;
    description: string;
}

/**
 * Fonts 0-8 are the internal bitmapped faces; the values are the 203 dpi
 * column of Appendix C, and the other resolutions scale linearly with dpi
 * (300 dpi is 1.48x, 406 is 2.0x — see the same tables).
 */
export const DPL_FONTS: Record<string, DplFontMetric> = {
    '0': { height: 10, width: 7, spacing: 1, points: 2.4, description: 'Standard, upper and lower' },
    '1': { height: 19, width: 10, spacing: 3, points: 4.6, description: 'With descenders' },
    '2': { height: 27, width: 15, spacing: 3, points: 6.5, description: 'Standard' },
    '3': { height: 40, width: 21, spacing: 3, points: 9.6, description: 'Uppercase' },
    '4': { height: 53, width: 27, spacing: 4, points: 12.7, description: 'Uppercase' },
    '5': { height: 77, width: 27, spacing: 4, points: 18.5, description: 'Uppercase' },
    '6': { height: 95, width: 47, spacing: 6, points: 22.8, description: 'Uppercase' },
    '7': { height: 47, width: 22, spacing: 7, points: 11.3, description: 'OCR-A, size I' },
    '8': { height: 41, width: 22, spacing: 7, points: 9.8, description: 'OCR-B, size III' },
};

/** Font 9 is the CG Triumvirate smooth font, sized through the eee field. */
export const DPL_SMOOTH_FONT = '9';

/**
 * The printed height of a bar code whose `eee` field is 0.
 *
 * Zero is not zero dots. "Unless otherwise noted all bar codes depicted here
 * were produced using the ratio/module values of 00 and height fields of 000 to
 * cause the printer to produce symbols using DEFAULT bar widths and height
 * fields" (Appendix G, p. 181) — and that is how EVERY example in that appendix
 * is written, so a stream leaving the field at zero is the common case, not the
 * edge. Reading it as zero drew each of them as a one-dot line.
 *
 * Table F-2 gives a default per symbol, and they are NOT all one value — the
 * page shows 0.40 in for most symbols but 0.80, 0.90, 1.30 and 1.40 for others.
 * That table cannot be read reliably from this PDF: its symbol labels and its
 * numbers extract as separate text runs, and the numbers carry no x position,
 * so the columns cannot be paired with confidence. Rather than ship a per-symbol
 * table assembled from a guess at the alignment, one documented default is used
 * and the limitation is stated here.
 *
 * 0.40 in is the value the table shows against the most symbols, including
 * Code 39, Code 128 and UPC/EAN. A stream that needs an exact height states it
 * in `eee`, which is the field the manual provides for it.
 */
export const DPL_DEFAULT_BARCODE_HEIGHT_INCHES = 0.40;

/** The printed height in dots of a bar code whose height field is 000. */
export const dplDefaultHeightDots = (dpi = 203): number =>
    Math.round(DPL_DEFAULT_BARCODE_HEIGHT_INCHES * dpi);

/**
 * Appendix C Table C-6: the smooth font's fixed sizes, expressed as the `Axx`
 * specifier the eee field takes. Points, not dots — the manual is explicit
 * that points keep a stream portable between printers of different dpi.
 */
export const DPL_SMOOTH_SIZES = [4, 6, 8, 10, 12, 14, 18, 24, 30, 36, 48, 60, 72];

/** Nearest documented smooth-font point size to an arbitrary request. */
export const nearestSmoothPoint = (points: number): number =>
    DPL_SMOOTH_SIZES.reduce((best, p) =>
        Math.abs(p - points) < Math.abs(best - points) ? p : best, DPL_SMOOTH_SIZES[0]);

/**
 * The multiplier alphabet (manual p. 134): "Values 1-9, A-Z, and a-z represent
 * multiplication factors from 1 - 61". 1-9 are themselves, then A-Z are 10-35
 * and a-z are 36-61.
 */
export const dplMultiplier = (value: number): string => {
    const n = Math.max(1, Math.min(61, Math.round(value)));
    if (n <= 9) return String(n);
    if (n <= 35) return String.fromCharCode(65 + (n - 10));   // A-Z
    return String.fromCharCode(97 + (n - 36));                // a-z
};

export const dplMultiplierValue = (ch: string): number => {
    const c = ch.charCodeAt(0);
    if (c >= 49 && c <= 57) return c - 48;            // 1-9
    if (c >= 65 && c <= 90) return c - 65 + 10;       // A-Z
    if (c >= 97 && c <= 122) return c - 97 + 36;      // a-z
    return 1;
};
