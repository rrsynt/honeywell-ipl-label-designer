// Builds services/ipl/codePages.ts from the iconv goldens in
// testdata/codepages/. Kept as a script so the committed tables are always a
// mechanical transcription of an audited source — never hand-typed.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const PAGES = [
    [10, '850', 'CP850 — DOS Latin 1'],
    [11, '1250', 'CP1250 — Central Europe'],
    [12, '1251', 'CP1251 — Cyrillic'],
    [13, '1252', 'CP1252 — Latin 1, Western Europe'],
    [14, '1253', 'CP1253 — Greek'],
    [15, '1254', 'CP1254 — Turkish'],
    [16, '1255', 'CP1255 — Hebrew'],
    [17, '1256', 'CP1256 — Arabic'],
    [18, '1257', 'CP1257 — Baltic Rim'],
    [19, '1258', 'CP1258 — Vietnamese'],
    [20, '874', 'CP874 — Thai'],
];

const tableLines = PAGES.map(([n, name, label]) => {
    const golden = JSON.parse(readFileSync(join(root, 'testdata', 'codepages', `${n}.json`), 'utf8'));
    if (golden.table.length !== 128) throw new Error(`codepages/${n}.json: expected 128 entries`);
    const hex = golden.table.map((c) => c.toString(16).padStart(4, '0')).join('');
    return `    ${n}: { label: '${label}', table: '${hex}' },`;
}).join('\n');

const source = `// IPL Printer Language / code page support (PRM p.133 "<SI>ln", 2.70 p.139).
//
// A code page maps the 0x80-0xFF bytes of print data onto real characters. The
// pipeline carries byte-strings (one char per byte) so Direct Graphics payloads
// stay byte-exact, which makes this the step that turns bytes into text.
//
// The tables are bundled rather than delegated to TextDecoder on purpose: on
// Node 20 / ICU 76.1, 5 of these 9 labels decode WRONG (windows-1250 0xB1 ->
// U+00B1 instead of U+0105, windows-1252 0x84 -> U+0084 instead of U+201E, plus
// windows-1254/1257/1258). A committed table is identical in Node and the
// browser; TextDecoder is not. Generated from GNU iconv by
// tools/gen-codepages.mjs — tests/codePage.test.ts compares every byte against
// the goldens in testdata/codepages/.

/** A code page we can decode, plus the two families we deliberately do not. */
export interface CodePageInfo {
    /** Human label for the issues panel and the viewer settings readout. */
    label: string;
    /** 128 code points for bytes 0x80-0xFF, concatenated 4-digit hex. */
    table?: string;
    /**
     * True for n=0..9: the printer substitutes a small set of characters
     * (Appendix B), which is NOT a code page. Decoding must leave bytes alone.
     */
    resident?: boolean;
    /** True for n=30..33: CJK pages, not implemented. */
    cjk?: boolean;
}

/** Printer language n -> code page (PRM p.133-134, 2.70 p.139-140). */
export const CODE_PAGES: Record<number, CodePageInfo> = {
    0: { label: 'U.S.A.', resident: true },
    1: { label: 'United Kingdom', resident: true },
    2: { label: 'Germany', resident: true },
    3: { label: 'Denmark', resident: true },
    4: { label: 'France', resident: true },
    5: { label: 'Sweden', resident: true },
    6: { label: 'Italy', resident: true },
    7: { label: 'Spain', resident: true },
    8: { label: '8-Bit ASCII', resident: true },
    9: { label: 'Switzerland', resident: true },
${tableLines}
    30: { label: 'Code Page 932, Shift JIS, Japanese', cjk: true },
    31: { label: 'Code Page 936, GB 2312-80, Simplified Chinese', cjk: true },
    32: { label: 'Code Page 949, KSC5601, Korean Hangeul', cjk: true },
    33: { label: 'Code Page 950, Big 5, Traditional Chinese', cjk: true },
    40: { label: 'UTF-8' },
};

const REPLACEMENT = 0xfffd;

/**
 * Decode a byte-string under code page \`n\`.
 *
 * Unknown, resident (n=0..9) and CJK (n=30..33) pages return the input
 * untouched: guessing at those would corrupt text silently, and the resident
 * substitution table (Appendix B) is a separate, unimplemented feature.
 */
export function decodeCodePage(s: string, n: number | undefined): string {
    if (n === undefined || n === null) return s;
    if (n === 40) return decodeUtf8(s);
    const info = CODE_PAGES[n];
    if (!info || info.resident || info.cjk || !info.table) return s;

    const table = info.table;
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const byte = s.charCodeAt(i) & 0xff;
        if (byte < 0x80) {
            out += s.charAt(i);
            continue;
        }
        const cp = parseInt(table.substr((byte - 0x80) * 4, 4), 16);
        out += String.fromCodePoint(Number.isNaN(cp) ? REPLACEMENT : cp);
    }
    return out;
}

/** UTF-8 (n=40) over a byte-string, with U+FFFD for malformed sequences. */
function decodeUtf8(s: string): string {
    const bytes: number[] = [];
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff);
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
}

/** One-line description for the viewer settings panel. */
export function describeCodePage(n: number): string {
    const info = CODE_PAGES[n];
    if (!info) return \`Unknown (\${n})\`;
    if (info.cjk) return \`\${info.label} (n=\${n}) — not decoded\`;
    if (info.resident) return \`\${info.label} (n=\${n}) — resident character substitution\`;
    return \`\${info.label} (n=\${n})\`;
}
`;

writeFileSync(join(root, 'services', 'ipl', 'codePages.ts'), source, 'utf8');
console.log('wrote services/ipl/codePages.ts');
