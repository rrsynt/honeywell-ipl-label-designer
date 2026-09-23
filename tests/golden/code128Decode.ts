// Decode a bwip-js raw() Code 128 symbol back to its codeword numbers.
// Parity tests must assert the ENCODED SYMBOL (codewords), never just the
// text string handed to the encoder — a wrong escape syntax still produces
// a string and a plausible width, which is exactly how the '\f1' FNC1 bug
// passed its original tests.
//
// The pattern table is read from the installed bwip-js itself, so it cannot
// drift from the encoder under test.
import { readFileSync } from 'node:fs';
import path from 'node:path';

let table: Map<string, number> | null = null;
function codewordTable(): Map<string, number> {
    if (!table) {
        const src = readFileSync(
            path.resolve(__dirname, '../../node_modules/bwip-js/src/bwipp.js'), 'utf-8');
        // Anchor on the identifier first: the literal "212222" also opens
        // codablockf_encs and code16k_encs tables elsewhere in bwipp.js.
        const decl = src.indexOf('code128_encs');
        const start = decl >= 0 ? src.indexOf('"212222"', decl) : -1;
        const end = src.indexOf('])', start);
        if (start < 0 || end < 0) throw new Error('code128_encs table not found in bwipp.js');
        const patterns = src.slice(start, end).match(/"\d{6,7}"/g)!.map(s => JSON.parse(s));
        table = new Map(patterns.map((p, i) => [p as string, i]));
    }
    return table;
}

export const START_A = 103;
export const START_B = 104;
export const START_C = 105;
export const FNC1 = 102;
export const STOP = 106;

/**
 * bwip raw() linear symbol -> codeword numbers (check digit and stop
 * included). `sbs` is bar-first alternating element widths; every Code 128
 * codeword is 11 modules (the stop is 13) starting with a bar.
 */
export const decodeCode128 = (sym: { sbs: number[] }): number[] => {
    let bits = '';
    sym.sbs.forEach((w, i) => { bits += (i % 2 === 0 ? '1' : '0').repeat(w); });
    const out: number[] = [];
    let pos = 0;
    while (pos < bits.length) {
        const len = bits.length - pos === 13 ? 13 : 11;
        const chunk = bits.slice(pos, pos + len);
        const runs: number[] = [];
        let last = '';
        for (const ch of chunk) {
            if (ch === last && runs.length) runs[runs.length - 1]++;
            else runs.push(1);
            last = ch;
        }
        if (chunk[0] !== '1') throw new Error(`codeword at ${pos} does not start with a bar`);
        const cw = codewordTable().get(runs.join(''));
        if (cw === undefined) throw new Error(`undecodable pattern at ${pos}: ${runs.join('')}`);
        out.push(cw);
        pos += len;
    }
    return out;
};

/** mod-103 check digit: start cw weight 1, then position weight on the rest. */
export const code128Check = (cws: number[]): number => {
    let sum = cws[0];
    for (let i = 1; i < cws.length; i++) sum += cws[i] * i;
    return sum % 103;
};
