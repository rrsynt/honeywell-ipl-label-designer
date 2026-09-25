// Fase 4: GS1 Application Identifier builder.
//
// A GS1 symbol is a sequence of (AI, value) pairs. The hard part is not the
// data, it is the separator: an AI with a fixed length needs none, and an AI
// with a variable length needs an FNC1 after it — except the last one, which
// ends the symbol. Getting that wrong encodes a value into the next AI and the
// scanner reads a different number than the one on the label.
//
// Two spellings, because the encoders disagree. Code 128 (symbology 6) takes
// bwip's '^FNC1' under parsefnc, which is its only FNC1 syntax. DataMatrix and
// QR take the parenthesised GS1 form and insert the separators themselves.
// Both come from the same pairs, so they cannot drift apart.

export interface Gs1Pair {
    /** The Application Identifier, digits only, e.g. "01". */
    ai: string;
    /** The value, as typed. Parentheses and spaces are stripped on build. */
    value: string;
}

/**
 * The AIs this builder knows, with the length their value must have. `null`
 * means variable length (1 up to `max`), which is what forces an FNC1 after
 * the field. The list is the small set a label actually uses — GTIN, batch,
 * dates, serial — not the whole GS1 catalogue. An AI outside it is reported,
 * not guessed: guessing the length is exactly the bug the separator exists to
 * prevent.
 */
export const GS1_AIS: { [ai: string]: { name: string; length: number | null; max: number; numeric: boolean } } = {
    '00': { name: 'SSCC', length: 18, max: 18, numeric: true },
    '01': { name: 'GTIN', length: 14, max: 14, numeric: true },
    '10': { name: 'Batch or lot number', length: null, max: 20, numeric: false },
    '11': { name: 'Production date', length: 6, max: 6, numeric: true },
    '15': { name: 'Best-before date', length: 6, max: 6, numeric: true },
    '17': { name: 'Expiration date', length: 6, max: 6, numeric: true },
    '21': { name: 'Serial number', length: null, max: 20, numeric: false },
    '30': { name: 'Variable count', length: null, max: 8, numeric: true },
};

export interface Gs1Problem { ai: string; message: string; }

/**
 * GS1 mod-10 over a digit string, the check digit GTIN and SSCC carry in their
 * last position. Weights alternate 3,1 from the right.
 */
export const gs1CheckDigit = (digits: string): number => {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
        const weight = ((digits.length - i) % 2 === 0) ? 1 : 3;
        sum += Number(digits[i]) * weight;
    }
    return (10 - (sum % 10)) % 10;
};

/** What is wrong with one pair, or null when it is encodable. */
export const gs1PairProblem = (pair: Gs1Pair): Gs1Problem | null => {
    const spec = GS1_AIS[pair.ai];
    if (!spec) return { ai: pair.ai, message: `AI ${pair.ai || '(blank)'} is not one this builder knows.` };
    const value = pair.value.replace(/[() ]/g, '');
    if (value.length === 0) return { ai: pair.ai, message: `AI ${pair.ai} (${spec.name}) has no value.` };
    if (spec.numeric && !/^\d+$/.test(value)) return { ai: pair.ai, message: `AI ${pair.ai} (${spec.name}) must be digits.` };
    if (spec.length !== null && value.length !== spec.length) {
        return { ai: pair.ai, message: `AI ${pair.ai} (${spec.name}) must be exactly ${spec.length} characters, not ${value.length}.` };
    }
    if (value.length > spec.max) return { ai: pair.ai, message: `AI ${pair.ai} (${spec.name}) is longer than ${spec.max} characters.` };
    if ((pair.ai === '01' || pair.ai === '00') && gs1CheckDigit(value.slice(0, -1)) !== Number(value.slice(-1))) {
        return { ai: pair.ai, message: `AI ${pair.ai} (${spec.name}) has a wrong check digit.` };
    }
    return null;
};

export interface Gs1Built {
    /**
     * '(01)0031…(17)251231(10)ABC' — the one spelling every GS1 encoder in
     * bwip-js accepts. The encoders insert the FNC1 separators themselves; a
     * '^FNC1' spelling is rejected by them ("AIs must start with '('"), so it
     * is not produced.
     */
    data: string;
    problems: Gs1Problem[];
}

/**
 * Build both spellings from the same pairs. Pairs with a problem are omitted
 * from the output rather than encoded wrong, and named in `problems`, so a
 * half-filled form never produces a symbol that scans as something else.
 */
export const buildGs1 = (pairs: Gs1Pair[]): Gs1Built => {
    const problems: Gs1Problem[] = [];
    const good: { ai: string; value: string }[] = [];
    for (const pair of pairs) {
        const problem = gs1PairProblem(pair);
        if (problem) { problems.push(problem); continue; }
        const spec = GS1_AIS[pair.ai];
        good.push({ ai: pair.ai, value: pair.value.replace(/[() ]/g, '') });
    }
    // The parentheses ARE the separators: the encoder reads each '(AI)' as a
    // field boundary and emits the FNC1 a variable-length field requires. A
    // fixed-length field needs none, and the encoder knows which is which, so
    // the builder's only job is to hand it well-formed pairs in order.
    const data = good.map(g => `(${g.ai})${g.value}`).join('');
    return { data, problems };
};
