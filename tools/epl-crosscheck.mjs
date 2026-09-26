#!/usr/bin/env node
// EPL cross-check: render an EPL file through an INDEPENDENT engine and keep
// the PNG beside it, for comparing against this app's viewer.
//
// Why this exists, and what it does NOT prove:
//
// The unit tests in tests/epl.test.ts check the parser against the manual's
// tables, and the generator against the parser. Both are closed under our own
// reading of the spec: if the parser and the generator agree with each other
// but both misread the manual, every test still passes. This tool puts the same
// EPL through someone else's implementation, which is the only way to catch
// that class of error — exactly how the IPL path found two real converter bugs
// that no unit test had caught.
//
// It does NOT prove pixel equality with our renderer. labelize makes its own
// layout choices (font metrics, barcode module widths, spacing), so the
// meaningful check is that the two AGREE ON THE LAYOUT — which elements are on
// the label and roughly where — not that they agree dot for dot.
//
// Usage:
//   node tools/epl-crosscheck.mjs samples/product.epl
//   npm run crosscheck:epl -- samples/product.epl
//
// The engine is @goodboy008/labelize-wasm (MIT), the same MIT Rust project this
// repo's docs/research/LABELIZE-ARCHITECTURE.md already studied as the blueprint
// for the IPL viewer. It is a lazy dependency: the script reports how to install
// it rather than failing obscurely.

import fs from 'node:fs';
import path from 'node:path';

const [, input] = process.argv.slice(1);
if (!input || !fs.existsSync(input)) {
    console.error('usage: npm run crosscheck:epl -- <file.epl>');
    process.exit(1);
}

const source = fs.readFileSync(input, 'utf8');

// Default to the label size the file asks for, in millimetres. q is width, Q is
// length (manual pp. 3-89, 3-91); 8 dots/mm is 203 dpi.
const dotsToMm = (dots) => Math.round((dots / 8) * 10) / 10;
const q = /^\s*q(\d+)/m.exec(source);
const Q = /^\s*Q(\d+)/m.exec(source);
const widthMm = q ? dotsToMm(Number(q[1])) : 100;
const heightMm = Q ? dotsToMm(Number(Q[1])) : 50;

let lz_render;
try {
    ({ lz_render } = await import('@goodboy008/labelize-wasm/init'));
} catch {
    console.error('This check needs the labelize engine:\n  npm install --save-dev @goodboy008/labelize-wasm');
    process.exit(2);
}

const out = input.replace(/\.epl$/i, '') + '.crosscheck.png';
try {
    const png = lz_render(Buffer.from(source, 'ascii'), widthMm, heightMm, 8, true, false, true);
    fs.writeFileSync(out, png);
    console.log(`[1/1] rendered -> ${out} (${png.length} bytes, ${widthMm}x${heightMm}mm @ 8 dots/mm)`);
    console.log(`\nOpen ${path.basename(out)} and compare with the in-app viewer.`);
    console.log('Layout agreement is the signal — not pixel identity: the two renderers make');
    console.log('their own font and spacing choices, so diff the ELEMENTS and their places.');
} catch (e) {
    // labelize prefixes its failures with the stage: 1: parse, 2: render.
    console.error(`labelize could not render this file: ${e}`);
    process.exit(3);
}
