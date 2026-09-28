// Generates the double-byte (CJK) code page tables used for printer languages
// 30-33 (<SI>l), from the WHATWG Encoding Standard's index files.
//
// Why a table instead of TextDecoder — the same reason the 11 single-byte
// pages already carry one, and this time it was measured rather than assumed:
//
//  * TextDecoder is implementation-dependent and DISAGREES between Node and
//    Chromium on every one of these four labels. Node 22 / ICU 76.1 decodes
//    CP949 lead bytes 0x81-0xA0 as raw Latin-1 (0x8141 -> U+0081 U+0041) where
//    Chromium gives the Hangul syllable U+AC02 — 8824 of 17048 cells wrong —
//    and gives U+00F6B1 for CP950 0xC6A1 where Chromium gives U+2460. A
//    committed table is identical in both; TextDecoder is not.
//
//  * GNU iconv is right about the single-byte pages (it matches the Unicode
//    Consortium's Microsoft tables on 1279/1280 cells) but is the JIS variant
//    of CP932 — it returns U+301C for 0x8160 where the printer's "Code Page
//    932" and Chromium both return U+FF5E — and it REFUSES the Big5 ETEN area
//    (0xC6A1) that code page 950 defines.
//
//  * The WHATWG index IS the normative definition of the labels
//    shift_jis/gbk/euc-kr/big5 that a browser implements, and it is a
//    published, reviewable file rather than an opaque library behaviour.
//    tests/codePageCjk.test.ts replays every byte pair through Chromium and
//    requires zero disagreements, so "spec == browser" is checked, not claimed.
//
// The pointer arithmetic, validity rules and the two special areas below are
// transcribed from the decoders in the same standard:
//   https://encoding.spec.whatwg.org/#shift_jis-decoder
//   https://encoding.spec.whatwg.org/#gbk-decoder
//   https://encoding.spec.whatwg.org/#euc-kr-decoder
//   https://encoding.spec.whatwg.org/#big5-decoder
//
// Run: node tools/gen-cjk-codepages.mjs   (writes testdata/codepages/*.json)
//
// The index files are read from $WHATWG_INDEX_DIR (default .tmp-whatwg). They
// are NOT committed: they are upstream artifacts, and the tables they generate
// are what the tests actually pin. A missing file is downloaded, so a clean
// checkout reproduces the goldens with no manual step — the same shape as
// gen-codepages.mjs, which needs `iconv` on the machine.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, '..');
const outDir = join(rootDir, 'testdata', 'codepages');
const srcDir = process.env.WHATWG_INDEX_DIR || join(rootDir, '.tmp-whatwg');
const INDEX_URL = 'https://encoding.spec.whatwg.org/';

/** Read an index file, downloading it once if this checkout has never seen it. */
async function indexFile(name) {
    const path = join(srcDir, name);
    try {
        return readFileSync(path, 'utf8');
    } catch {
        mkdirSync(srcDir, { recursive: true });
        const res = await fetch(INDEX_URL + name);
        if (!res.ok) throw new Error(`${INDEX_URL}${name}: HTTP ${res.status}`);
        const text = await res.text();
        writeFileSync(path, text, 'utf8');
        console.log(`fetched ${name}`);
        return text;
    }
}

/**
 * Parse a WHATWG index into a Map. A line is `pointer 0xCODEPOINT name`, with
 * the character and its name in parentheses after the hex — all of which is a
 * comment as far as the mapping is concerned.
 */
function readIndex(text) {
    const map = new Map();
    for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const [p, c] = t.split(/\s+/);
        const ptr = Number(p);
        const cp = Number(c);
        if (!Number.isFinite(ptr) || !Number.isFinite(cp)) continue;
        map.set(ptr, cp);
    }
    return map;
}

/** Slot order shared by every page: trails 0x40-0xFE with the 0x7F hole. */
const TRAILS = [];
for (let t = 0x40; t <= 0xfe; t++) if (t !== 0x7f) TRAILS.push(t);
const SLOT_COUNT = TRAILS.length;

/** Slot index for a trail byte. 0x40-0x7E keep their offset, 0x80+ shift by one. */
const slotOf = (trail) => trail - 0x40 - (trail > 0x7f ? 1 : 0);

function* range(lo, hi) { for (let v = lo; v <= hi; v++) yield v; }

/** A slot with no mapping. U+FFFF is a noncharacter, so no page legibly uses it. */
const UNMAPPED = 0xffff;
/** A slot whose value is in `special` instead (astral code point, or a pair). */
const SPECIAL = 0xfffe;

const PAGES = [
    {
        n: 30,
        whatwg: 'shift_jis',
        index: 'index-jis0208.txt',
        leads: [...range(0x81, 0x9f), ...range(0xe0, 0xfc)],
        // Lead 0x81-0x9F or 0xE0-0xFC; trail 0x40-0x7E or 0x80-0xFC.
        trailOk: (t) => (t >= 0x40 && t <= 0x7e) || (t >= 0x80 && t <= 0xfc),
        pointer(lead, trail) {
            const leadOffset = lead <= 0x9f ? 0x81 : 0xc1;
            const offset = trail < 0x7f ? 0x40 : 0x41;
            return (lead - leadOffset) * 188 + (trail - offset);
        },
        // Step 8: the IBM extension area is not in the index at all — the
        // standard derives it as a PUA block instead.
        override(pointer) {
            if (pointer >= 8836 && pointer <= 10715) return 0xe000 + pointer - 8836;
            return undefined;
        },
        // Step 2 passes 0x80 through as itself; 0xA1-0xDF are halfwidth katakana.
        single(byte) {
            if (byte === 0x80) return 0x80;
            if (byte >= 0xa1 && byte <= 0xdf) return 0xff61 + byte - 0xa1;
            return undefined;
        },
    },
    {
        n: 31,
        whatwg: 'gbk',
        index: 'index-gb18030.txt',
        leads: [...range(0x81, 0xfe)],
        trailOk: (t) => (t >= 0x40 && t <= 0x7e) || (t >= 0x80 && t <= 0xfe),
        pointer(lead, trail) {
            const offset = trail < 0x7f ? 0x40 : 0x41;
            return (lead - 0x81) * 190 + (trail - offset);
        },
        // The one single-byte exception in this page: 0x80 is the Euro sign.
        single(byte) { return byte === 0x80 ? 0x20ac : undefined; },
    },
    {
        n: 32,
        whatwg: 'euc-kr',
        index: 'index-euc-kr.txt',
        leads: [...range(0x81, 0xfe)],
        // A trail of 0x41-0xFE; 0x40 is not a trail.
        trailOk: (t) => t >= 0x41 && t <= 0xfe,
        pointer(lead, trail) {
            return (lead - 0x81) * 190 + (trail - 0x41);
        },
    },
    {
        n: 33,
        whatwg: 'big5',
        index: 'index-big5.txt',
        leads: [...range(0x81, 0xfe)],
        // A trail of 0x40-0x7E or 0xA1-0xFE.
        trailOk: (t) => (t >= 0x40 && t <= 0x7e) || (t >= 0xa1 && t <= 0xfe),
        pointer(lead, trail) {
            const offset = trail < 0x7f ? 0x40 : 0x62;
            return (lead - 0x81) * 157 + (trail - offset);
        },
        // Four pointers return TWO code points. They are absent from the index
        // file, so the standard spells them out in a table beside the decoder;
        // these are transcribed from it verbatim.
        //
        // Chromium DISAGREES here, and it is Chromium that is wrong: its
        // TextDecoder emits U+0093 U+DF04 for pointer 1133 — a C1 control plus
        // a LONE SURROGATE, which is not well-formed — where its own spec, GNU
        // iconv's BIG5-HKSCS and Python's big5hkscs all three return the
        // U+00CA U+0304 the spec names. Three independent sources against one
        // is why the spec wins; tests/codePageCjk.test.ts excludes exactly
        // these four slots from its Chromium comparison and says why.
        extra(pointer) {
            switch (pointer) {
                case 1133: return [0x00ca, 0x0304];
                case 1135: return [0x00ca, 0x030c];
                case 1164: return [0x00ea, 0x0304];
                case 1166: return [0x00ea, 0x030c];
                default: return undefined;
            }
        },
    },
];

const report = [];
for (const page of PAGES) {
    const index = readIndex(await indexFile(page.index));

    const flat = new Uint16Array(page.leads.length * SLOT_COUNT).fill(UNMAPPED);
    /** [slot, cp1, cp2] — cp2 is 0 when the value is a single astral code point. */
    const special = [];
    let mapped = 0;
    let unmapped = 0;
    let rejectedTrail = 0;
    let astralCount = 0;
    let pairCount = 0;

    let row = 0;
    for (const lead of page.leads) {
        for (const trail of TRAILS) {
            const slot = row + slotOf(trail);
            if (!page.trailOk(trail)) { rejectedTrail++; continue; }

            const pointer = page.pointer(lead, trail);
            const pair = page.extra ? page.extra(pointer) : undefined;
            if (pair) {
                flat[slot] = SPECIAL;
                special.push(slot, pair[0], pair[1]);
                pairCount++;
                continue;
            }
            let cp = page.override ? page.override(pointer) : undefined;
            if (cp === undefined) cp = index.get(pointer);
            if (cp === undefined) { unmapped++; continue; }
            if (cp > 0xffff) {
                flat[slot] = SPECIAL;
                special.push(slot, cp, 0);
                astralCount++;
                continue;
            }
            flat[slot] = cp;
            mapped++;
        }
        row += SLOT_COUNT;
    }

    // Bytes below 0x80 are ASCII in every page, so only 0x80-0xFF can differ.
    const singles = new Uint16Array(128).fill(UNMAPPED);
    let singleCount = 0;
    if (page.single) {
        for (let b = 0x80; b <= 0xff; b++) {
            const cp = page.single(b);
            if (cp === undefined) continue;
            singles[b - 0x80] = cp;
            singleCount++;
        }
    }

    const b64 = (arr, bytes) => {
        const buf = Buffer.alloc(arr.length * bytes);
        arr.forEach((v, i) => (bytes === 2 ? buf.writeUInt16LE(v, i * 2) : buf.writeUInt32LE(v, i * 4)));
        return buf.toString('base64');
    };

    const golden = {
        n: page.n,
        whatwg: page.whatwg,
        leads: page.leads.map((l) => l.toString(16).padStart(2, '0')).join(''),
        // Slot layout inside a lead row: trails 0x40-0x7E then 0x80-0xFE.
        slotTrails: '40-7e,80-fe',
        flat: b64(flat, 2),
        singles: b64(singles, 2),
    };
    if (special.length) golden.special = b64(special, 4);
    writeFileSync(join(outDir, `${page.n}.json`), JSON.stringify(golden) + '\n', 'utf8');

    report.push(`n=${page.n} ${page.whatwg}: leads=${page.leads.length} slots=${flat.length}`);
    report.push(`   mapped=${mapped} unmapped=${unmapped} rejectedTrail=${rejectedTrail}`);
    report.push(`   astral=${astralCount} pairs=${pairCount} singles=${singleCount}`);
}
console.log(report.join('\n'));
console.log(`wrote ${PAGES.map((p) => `testdata/codepages/${p.n}.json`).join(', ')}`);
