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
 * Appendix L Table L-1: the speed a command's single character selects, in
 * inches per second.
 *
 * The letters are not incrementing all the way: A-Z step by 0.5 up to W (12.0),
 * then X, Y and Z jump by a whole inch each (13, 14, 15) and the lower case
 * a-e carry on by the same whole inch (16-20). Encoded as the table gives it
 * rather than computed, because the two runs do not share a step.
 *
 * "Applicable speed values are printer dependent. See Table L-2" — a model
 * supports a RANGE, and this is the value each character stands for.
 */
export const DPL_SPEED_IPS: Record<string, number> = {
    A: 1.0, B: 1.5, C: 2.0, D: 2.5, E: 3.0, F: 3.5, G: 4.0, H: 4.5,
    I: 5.0, J: 5.5, K: 6.0, L: 6.5, M: 7.0, N: 7.5, O: 8.0, P: 8.5,
    Q: 9.0, R: 9.5, S: 10.0, T: 10.5, U: 11.0, V: 11.5, W: 12.0,
    X: 13.0, Y: 14.0, Z: 15.0,
    a: 16.0, b: 17.0, c: 18.0, d: 19.0, e: 20.0,
};

/**
 * Table F-2: "Bar Code Default Widths and Heights", the printed height in
 * INCHES of each symbol at 203 dpi.
 *
 * Zero is not zero dots. "Unless otherwise noted all bar codes depicted here
 * were produced using the ratio/module values of 00 and height fields of 000 to
 * cause the printer to produce symbols using DEFAULT bar widths and height
 * fields" (Appendix G, p. 181) — and that is how EVERY example in that appendix
 * is written, so a stream leaving the field at zero is the common case, not the
 * edge. Reading it as zero drew each of them as a one-dot line.
 *
 * The table had to be read from the RENDERED page. Its symbol column and its
 * number columns extract as separate text runs with no x positions, so pairing
 * them from the text alone would have been a guess at the alignment — and a
 * first attempt at exactly that produced heights that contradicted the page:
 * it gave D and F 0.80 in where the table says 0.40.
 *
 * The 203 dpi column only. The other three resolutions give the same inches;
 * what changes with dpi is the ratio/module column, which is a WIDTH and is not
 * asked for here. `N/A` is a symbol with no default at that size, and is left
 * out rather than invented.
 */
export const DPL_BARCODE_DEFAULT_HEIGHT_IN: Record<string, number> = {
    A: 0.40, B: 0.80, C: 0.80, D: 0.40, E: 0.40, F: 0.80, G: 0.80,
    H: 0.40, I: 0.40, J: 0.40, K: 0.40, L: 1.30, M: 0.90, N: 0.80,
    O: 0.40, P: 0.08, Q: 1.40, R: 1.40, S: 1.40, T: 0.80,
    U: 1.00, v: 0.50,
    W1I: 0.40, W1J: 0.40, W1G: 0.50, W1R: 1.40, W1T: 0.40,
};
/** The fallback when the table lists `N/A` or the symbol is not in it at all. */
export const DPL_DEFAULT_BARCODE_HEIGHT_INCHES = 0.40;

/**
 * The printed height in dots of a bar code whose height field is 000.
 *
 * `bField` is the record's font/bar-code field, so a `Wxx` expansion is looked
 * up by its full three characters before the single letter is tried.
 */
export const dplDefaultHeightDots = (bField = '', dpi = 203): number => {
    const key = bField.slice(0, 3).toUpperCase();
    const inches = DPL_BARCODE_DEFAULT_HEIGHT_IN[bField]
        ?? DPL_BARCODE_DEFAULT_HEIGHT_IN[bField.toUpperCase()]
        ?? DPL_BARCODE_DEFAULT_HEIGHT_IN[key]
        ?? DPL_DEFAULT_BARCODE_HEIGHT_INCHES;
    return Math.round(inches * dpi);
};

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
 * The resident fonts a general text field may be matched to. Fonts 7 and 8 are
 * the OCR faces (OCR-A size I, OCR-B size III) — they are only correct for a
 * field that is actually OCR, so a size fit must not pick them: matching a
 * plain field whose height happens to land near 41 or 47 dots to an OCR face
 * would silently change every glyph. They are reached only through an explicit
 * design-font match (see DESIGN_OCR_FONT).
 */
const DPL_FITTABLE_FONTS = ['0', '1', '2', '3', '4', '5', '6'] as const;

/** A design OCR font id -> the DPL OCR face that IS that font. */
export const DESIGN_OCR_FONT: Record<string, string> = { '23': '7', '24': '8' };

export interface DplBitmapFit {
    /** DPL `b`: the resident font id. */
    font: string;
    /** DPL `c`: the integer width multiplier. */
    widthMul: number;
    /** DPL `d`: the integer height multiplier. */
    heightMul: number;
    /** |achieved - requested| / requested, for the height. */
    heightError: number;
    widthError: number;
}

/**
 * Match a design text cell to a DPL resident font + integer multipliers.
 *
 * The design's cell is in DOTS (the designer draws `baseHeight * h_mag`); DPL
 * sizes a text field as `font height * multiplier`, and the multiplier is an
 * INTEGER 1-61. So the height is matched first — the axis both tables can agree
 * on, the same rule the EPL table uses — and the width multiplier is then fit
 * on the SAME font, because a DPL record names one font for both axes.
 *
 * The returned errors are RELATIVE, so the caller can report how far off DPL
 * forces it to be: DPL's smallest resident font is 10 dots, so a design cell
 * below that (c7 is 7) has no exact match at all and must be flagged rather
 * than shipped as if it were the right size.
 */
export const fitDplBitmapFont = (widthDots: number, heightDots: number): DplBitmapFit => {
    const wantH = Math.max(1, heightDots);
    const wantW = Math.max(1, widthDots);
    const clampMul = clampDplMultiplier;
    const relErr = (got: number, want: number) => Math.abs(got - want) / want;
    let best: DplBitmapFit | null = null;
    for (const id of DPL_FITTABLE_FONTS) {
        const m = DPL_FONTS[id];
        const hMul = clampMul(wantH / m.height);
        const wMul = clampMul(wantW / m.width);
        const heightError = relErr(m.height * hMul, wantH);
        const widthError = relErr(m.width * wMul, wantW);
        // ONE font serves both axes, so the choice is scored on the WORSE of the
        // two — picking on height alone chose a font 43% too wide whenever a
        // taller narrow cell met a short wide face.
        const score = Math.max(heightError, widthError);
        if (!best || score < Math.max(best.heightError, best.widthError)) {
            best = { font: id, widthMul: wMul, heightMul: hMul, heightError, widthError };
        }
    }
    return best!;
};

/**
 * The multiplier alphabet (manual p. 134): "Values 1-9, A-Z, and a-z represent
 * multiplication factors from 1 - 61". 1-9 are themselves, then A-Z are 10-35
 * and a-z are 36-61.
 */
export const dplMultiplier = (value: number): string => {
    const n = clampDplMultiplier(value);
    if (n <= 9) return String(n);
    if (n <= 35) return String.fromCharCode(65 + (n - 10));   // A-Z
    return String.fromCharCode(97 + (n - 36));                // a-z
};

/** The multiplier alphabet's range: "values 1-61" (manual p. 134). */
export const clampDplMultiplier = (value: number): number =>
    Math.max(1, Math.min(61, Math.round(value)));

export const dplMultiplierValue = (ch: string): number => {
    const c = ch.charCodeAt(0);
    if (c >= 49 && c <= 57) return c - 48;            // 1-9
    if (c >= 65 && c <= 90) return c - 65 + 10;       // A-Z
    if (c >= 97 && c <= 122) return c - 97 + 36;      // a-z
    return 1;
};
