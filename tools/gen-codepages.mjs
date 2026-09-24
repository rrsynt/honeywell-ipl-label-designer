// Generates the IPL code page lookup tables bundled in
// services/ipl/codePages.ts.
//
// Why a generator instead of TextDecoder: the WHATWG label names Node accepts
// are NOT reliably correct here. Measured on Node 20 / ICU 76.1, 5 of the 9
// single-byte pages decode wrongly (windows-1250 0xB1 -> U+00B1 instead of
// U+0105, windows-1252 0x84 -> U+0084 instead of U+201E, ...). Node falls back
// to Latin-1 where it lacks a mapping, and a browser may differ again — the
// failure mode being "tests green, browser wrong". A committed table is
// identical in Node and the browser, and reviewable.
//
// The tables below come from GNU iconv (the WHATWG index is what iconv
// implements). Byte values that WHATWG leaves unassigned (cp1252 0x81/0x8D/
// 0x8F/0x90/0x9D, ...) make iconv fail; those become U+FFFD, which is what a
// WHATWG TextDecoder would also produce.
//
// Run: node tools/gen-codepages.mjs   (writes testdata/codepages/*.json)
// The .json files are the audited golden the tests compare against; the
// tables in codePages.ts are generated from the same source and must match.

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'testdata', 'codepages');

/** IPL <SI>l value -> iconv charset name (PRM p.133 / 2.70 p.139). */
const PAGES = [
    { n: 10, iconv: 'CP850' },
    { n: 11, iconv: 'CP1250' },
    { n: 12, iconv: 'CP1251' },
    { n: 13, iconv: 'CP1252' },
    { n: 14, iconv: 'CP1253' },
    { n: 15, iconv: 'CP1254' },
    { n: 16, iconv: 'CP1255' },
    { n: 17, iconv: 'CP1256' },
    { n: 18, iconv: 'CP1257' },
    { n: 19, iconv: 'CP1258' },
    { n: 20, iconv: 'CP874' },
];

mkdirSync(outDir, { recursive: true });

for (const { n, iconv } of PAGES) {
    const table = [];
    for (let b = 0x80; b <= 0xff; b++) {
        try {
            const out = execFileSync('iconv', ['-f', iconv, '-t', 'UTF-8'], {
                input: Buffer.from([b]),
                stdio: ['pipe', 'pipe', 'ignore'],
            });
            table.push(out.toString('utf8').codePointAt(0));
        } catch {
            table.push(0xfffd); // unassigned in WHATWG
        }
    }
    if (table.length !== 128) throw new Error(`${iconv}: expected 128 entries, got ${table.length}`);
    writeFileSync(
        join(outDir, `${n}.json`),
        JSON.stringify({ n, iconv, table }, null, 0) + '\n',
        'utf8',
    );
    console.log(`${iconv} (n=${n}) -> testdata/codepages/${n}.json`);
}
console.log('done');
