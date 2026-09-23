#!/usr/bin/env node
// Labelary cross-check: IPL -> ZPL (tools/ipl2zpl.mjs) -> PNG via the free
// Labelary API. The rendered PNG is a second, independent interpretation of
// the label layout - compare it with this app's viewer to catch regressions.
//
// Usage:
//   node tools/labelary-crosscheck.mjs samples/product.ipl [dpi]
//   npm run crosscheck -- samples/box-date.ipl 300

import fs from 'node:fs';
import path from 'node:path';
import { iplToZpl } from './ipl2zpl.mjs';

const [, input, dpiArg] = process.argv.slice(1);
if (!input || !fs.existsSync(input)) {
    console.error('usage: npm run crosscheck -- <file.ipl> [dpi]');
    process.exit(1);
}

const dpi = parseInt(dpiArg || '203', 10);
const dpmm = [2, 6, 8, 12, 16, 24, 48].reduce((best, d) =>
    Math.abs(d * 25.4 / 1000 - dpi / 1000) < Math.abs(best * 25.4 / 1000 - dpi / 1000) ? d : best, 8);

const zpl = iplToZpl(fs.readFileSync(input, 'utf8'), dpi);
if (zpl.length < 60) {
    console.error(`Converted ZPL is suspiciously small (${zpl.length} bytes) - input may have no fields.`);
    process.exit(2);
}
const zplPath = input.replace(/\.ipl$/i, '') + '.crosscheck.zpl';
fs.writeFileSync(zplPath, zpl);
console.log(`[1/2] converted -> ${zplPath} (${zpl.length} bytes)`);

// Label size for the API path, expressed as WIDTHxHEIGHT in INCHES
// (current Labelary API: /v1/printers/{dpmm}dpmm/labels/{w}x{h}/{index}/).
const pw = /\^PW(\d+)/.exec(zpl);
const ll = /\^LL(\d+)/.exec(zpl);
const wIn = pw ? +(parseInt(pw[1], 10) / dpi).toFixed(2) : 4;
const hIn = ll ? +(parseInt(ll[1], 10) / dpi).toFixed(2) : 1.5;

const url = `https://api.labelary.com/v1/printers/${dpmm}dpmm/labels/${wIn}x${hIn}/0/`;
try {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Accept': 'image/png', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: zpl,
    });
    if (!res.ok) {
        console.error(`Labelary error ${res.status}: ${(await res.text()).slice(0, 300)}`);
        process.exit(2);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const pngPath = input.replace(/\.ipl$/i, '') + '.crosscheck.png';
    fs.writeFileSync(pngPath, buf);
    console.log(`[2/2] rendered  -> ${pngPath} (${buf.length} bytes @ ${dpmm}dpmm)`);
    console.log(`\nOpen ${path.basename(pngPath)} and compare with the in-app viewer.`);
} catch (e) {
    console.error(`Network failure: ${e.message}\n(ZPL was still written to ${zplPath} - render manually at https://labelary.com/viewer.html)`);
    process.exit(3);
}
