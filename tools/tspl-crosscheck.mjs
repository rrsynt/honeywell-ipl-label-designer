#!/usr/bin/env node
// TSPL: what can and cannot be verified here, stated plainly.
//
// The EPL path has an INDEPENDENT oracle: labelize renders EPL, so our reading
// can be checked against someone else's implementation instead of only against
// itself. **TSPL has no such oracle.** Both candidates were checked and neither
// works:
//
//   * Labelary takes ZPL only as INPUT. Its documentation lists IPL/EPL/DPL/
//     SBPL/PCL as OUTPUT formats, and a TSPL body is rejected.
//   * @goodboy008/labelize-wasm, the EPL oracle, parses ZPL and EPL only.
//
// So this tool does NOT pretend to cross-check anything. It reports what OUR
// parser found in a file, element by element, so a person can hold that against
// the TSC manual's worked examples and a real printer. That is a weaker check
// than EPL's and it is labelled as such rather than dressed up.
//
// Usage:
//   npm run crosscheck:tspl -- samples/product.tspl

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [, input] = process.argv.slice(1);
if (!input || !fs.existsSync(input)) {
    console.error('usage: npm run crosscheck:tspl -- <file.tspl>');
    process.exit(1);
}

// The parser is TypeScript, which Node cannot import. Rather than add a loader
// for one script, the work runs where the project already compiles TS: a
// throwaway vitest file that prints the reading. It is a reporting tool, so it
// asserts nothing — the assertions live in tests/tspl.test.ts.
const parserUrl = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'services', 'tspl', 'tsplParser.ts'),
).href;

const report = `
import { it } from 'vitest';
import fs from 'node:fs';
import { parseTSPL } from ${JSON.stringify(parserUrl)};

it('reports the reading', () => {
    const label = parseTSPL(fs.readFileSync(${JSON.stringify(path.resolve(input))}, 'utf8'));
    const lines = [];
    lines.push('SIZE ' + (label.widthDots ?? '?') + ' x ' + (label.heightDots ?? '?') + ' dots');
    for (const el of label.elements) {
        const at = el.ox + ',' + el.oy + ' f' + el.f;
        let what;
        if (el.kind === 'text') what = 'text "' + (el.source && el.source.data ? el.source.data : '') + '"';
        else if (el.kind === 'barcode') what = 'barcode ' + el.symbology + ' hri=' + el.hri;
        else if (el.kind === 'box') what = 'box ' + el.widthDots + 'x' + el.heightDots + ' t' + el.thicknessDots;
        else if (el.kind === 'line') what = 'line len' + el.lengthDots + ' t' + el.thicknessDots;
        else what = el.kind;
        lines.push('  ' + el.kind.padEnd(8) + ' @ ' + at.padEnd(14) + ' ' + what);
    }
    for (const i of label.issues) {
        if (i.level !== 'info') lines.push('  [' + i.level + '] ' + i.message);
    }
    console.log(lines.join('\\n'));
});
`;

// The report file goes under tests/ because that is where vitest looks
// (vitest.config.ts includes `tests/**/*.test.{ts,tsx}`); a file in the system
// temp directory is simply not found. It is written, run and deleted in one go.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(root, 'tests', 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });
const tmp = path.join(tmpDir, `tspl-report-${Date.now()}.test.ts`);
fs.writeFileSync(tmp, report, 'utf8');

// The vitest CLI is invoked by its own entry point rather than through `npx`:
// spawn() does not go through a shell, and on Windows `npx` is a .cmd that Node
// cannot execute directly (ENOENT).
const vitestBin = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
let out = '';
try {
    out = execFileSync(process.execPath, [vitestBin, 'run', tmp, '--reporter=verbose'], {
        encoding: 'utf8', timeout: 180_000,
    });
} catch (e) {
    out = String(e.stdout || e.message || e);
} finally {
    fs.rmSync(tmp, { force: true });
    // Leave no empty directory behind if nothing else is using it.
    try { fs.rmdirSync(tmpDir); } catch { /* not empty: leave it */ }
}

// Vitest echoes the console output; print only the block this tool produced.
const block = out.split(/\r?\n/).filter(l => /^SIZE |^ {2}(text|barcode|box|line|graphic|unknown|\[)/.test(l));
if (block.length === 0) {
    console.error('Could not read the parser output. Run the tests directly: npx vitest run tests/tspl.test.ts');
    process.exit(2);
}
console.log(`${path.basename(input)}:`);
console.log(block.join('\n'));
console.log('\nNO INDEPENDENT ORACLE EXISTS FOR TSPL (see the header of this file).');
console.log('This is THIS parser reading the file. Check it against the TSC manual and,');
console.log('before production, against the printer — a self-consistency check cannot');
console.log('catch a misread specification.');
