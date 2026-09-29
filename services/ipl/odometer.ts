// Per-batch odometer simulation for the IPL viewer's multi-label preview.
//
// The printer advances <FS>/<GS>-delimited data regions by the field's
// increment/decrement step once per batch, after the batch prints
// (PRM pp.98–99, p.110). resolveLabelAtBatch() reproduces that for the
// on-screen preview of label #2, #3, … of a multi-label job.

import type { ViewerLabel, ViewerElement } from './types';

const FS = '<FS>';
const GS = '<GS>';

/**
 * The viewer keeps a raw printer capture's control BYTES as bytes (Direct
 * Graphics payloads are read byte-wise), so an <FS> region may arrive as
 * \x1c rather than the literal placeholder. Fold both spellings onto the
 * literal form so the region matcher below sees one shape; the delimiters are
 * control markers and are stripped from the display either way.
 */
const literalizeSeparators = (data: string): string =>
    data.includes('\x1c') || data.includes('\x1d')
        ? data.replace(/\x1c/g, FS).replace(/\x1d/g, GS)
        : data;

/** Numeric odometer: digits advance by n; 9→0 carries left. */
const advanceNumeric = (digits: string, step: number, sign: 1 | -1): string => {
    const width = digits.length;
    let value = parseInt(digits, 10);
    if (isNaN(value)) return digits;
    value += sign * step;
    // Wrap within the region's width (odometer semantics).
    const modulus = 10 ** width;
    value = ((value % modulus) + modulus) % modulus;
    return String(value).padStart(width, '0');
};

/**
 * Alphanumeric odometer over 0–9,A–Z (PRM p.97): the sequence runs
 * "0, 1, 2...8, 9, A, B, C...Y, Z, 0, 1...", so 9 rolls into A and Z into 0.
 *
 * Two manual rules shape the width arithmetic, and the first version broke both
 * for a region containing anything but digits and letters:
 *
 *   "The printer ignores any non-alphanumeric characters within this region."
 *   "The length of data does not change."
 *
 * Ignoring a character means its POSITION still counts but its VALUE does not:
 * in "A-1" the '-' is not part of the number, yet the region is still three
 * characters wide when it comes back. Counting the width as text.length while
 * accumulating only the valid characters made "A-1" advance to "0A2" — the
 * value shifted up a place and the field changed length, which is exactly what
 * the second rule forbids.
 *
 * So the arithmetic runs over the valid characters alone, and the result is
 * written back into the ignored positions unchanged.
 */
const advanceAlphanumeric = (text: string, step: number, sign: 1 | -1): string => {
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const base = alphabet.length;
    let value = 0;
    let width = 0;
    for (const ch of text) {
        const d = alphabet.indexOf(ch);
        if (d < 0) continue; // ignored: contributes no value AND no width
        value = value * base + d;
        width++;
    }
    if (width === 0) return text; // nothing to advance; leave it alone
    value += sign * step;
    const modulus = base ** width;
    value = ((value % modulus) + modulus) % modulus;

    // Walk the text right-to-left, substituting each valid position and leaving
    // every ignored character exactly where it was.
    const digits: string[] = new Array(width);
    for (let i = 0; i < width; i++) {
        digits[width - 1 - i] = alphabet[value % base];
        value = Math.floor(value / base);
    }
    let next = 0;
    return [...text]
        .map(ch => (alphabet.indexOf(ch) < 0 ? ch : digits[next++]))
        .join('');
};

/**
 * Returns the label as it prints on batch `batchIndex` (0-based): variable
 * fields' data has its <FS>/<GS> regions advanced by batchIndex × step.
 */
export const resolveLabelAtBatch = (
    label: ViewerLabel,
    batchIndex: number,
    dpi: number,
): ViewerLabel => {
    if (batchIndex === 0) {
        // Even at batch 0 the delimiters are control markers, not printable
        // text — show only the region contents.
        const elements = label.elements.map(el => {
            if (el.kind !== 'text' && el.kind !== 'barcode') return el;
            const src = el.source;
            if (src.type !== 'fixed' && src.type !== 'variable') return el;
            const data = literalizeSeparators(src.data);
            if (!data.includes(FS) && !data.includes(GS)) return el;
            return { ...el, source: { ...src, data: data.replace(/<(FS|GS)>/g, '') } } as ViewerElement;
        });
        return { ...label, elements };
    }
    const elements: ViewerElement[] = label.elements.map(el => {
        if (el.kind !== 'text' && el.kind !== 'barcode') return el;
        const src = el.source;
        if (src.type !== 'fixed' && src.type !== 'variable') return el;
        const data = literalizeSeparators(src.data);
        if (!data.includes(FS) && !data.includes(GS)) return el;

        // A field advances by ITS OWN step. When the field carries none, the
        // printer's documented default of 1 applies (PRM p.104 "Printer Default
        // Values for n: All n = 1") — NOT some other field's step, which is the
        // leak that used to make every field in a job move together. A step of
        // 0 is <ESC>N, whose command name is "Increment and Decrement, Disable"
        // (p.109): the field stops.
        const own = el.serialStep;
        const step = own === undefined ? 1 : Math.abs(own);
        const sign: 1 | -1 = own !== undefined && own < 0 ? -1 : 1;
        if (step === 0) return { ...el, source: { ...src, data: data.replace(/<(FS|GS)>/g, '') } } as ViewerElement;

        // Three delimiter pairs, and the manual documents two of them:
        //
        //   <FS>data<FS>  Numeric Field Separator (p.111)      -> numeric
        //   <GS>data<GS>  Alphanumeric Field Separator (p.97)  -> alphanumeric
        //   <FS>data<GS>  not documented; kept because it is the
        //                 shape two existing tests use -> alphanumeric
        //
        // The middle one was MISSING, and the omission was silent: the manual
        // is explicit ("You must enclose the data between two sets of <GS>
        // commands: <GS>data<GS>", p.97) and the command's own example is
        // "<STX><CR><ESC>I1<GS>A<GS><ETX>" — but the regex only accepted
        // `<FS>…<FS>` and `<FS>…<GS>`, so a properly-written <GS> region never
        // matched, never advanced, and then had its delimiters stripped. The
        // preview showed a constant value where the printer steps an
        // alphanumeric counter.
        //
        // Order matters: the specific pairs are tried before the mixed one, so
        // "…<FS>01<FS>x<GS>AB<GS>" advances the numeric region AND the
        // alphanumeric one rather than swallowing both into the third arm.
        const advanced = data.replace(
            /<FS>([^<]*)<FS>|<GS>([^<]*)<GS>|<FS>([^<]*)<GS>/g,
            (_m, fs1: string, gs2: string, mixed: string) => {
                const region = fs1 ?? gs2 ?? mixed;
                const isNumeric = fs1 !== undefined;
                const delta = step * batchIndex;
                return isNumeric
                    ? advanceNumeric(region, delta, sign)
                    : advanceAlphanumeric(region, delta, sign);
            },
        );
        // The <FS>/<GS> delimiters are control markers, not printable text —
        // strip them so the preview shows only the region contents.
        const display = advanced.replace(/<(FS|GS)>/g, '');
        return { ...el, source: { ...src, data: display } } as ViewerElement;
    });
    return { ...label, elements };
};

/** Total labels a job prints: batches × copies. */
export const totalLabelCount = (label: ViewerLabel): number =>
    (label.settings.quantity ?? 1) * (label.settings.batchCount ?? 1);
