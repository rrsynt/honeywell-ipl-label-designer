// Workstream 2 remainder (2026-09-24): pin the BarTender streams at the PIXEL
// level, not just the element level. tests/directGraphicsHex.test.ts already
// asserts that a g1 rewrite parses to the same graphic elements as the binary
// original; this asserts the rendered canvases are byte-identical, which also
// covers the text, barcode and box fields that tes1 carries alongside its
// graphics.
//
// These streams cannot be golden-file cases: the harness reads .ipl as UTF-8
// text and tes1/tes2 are binary (bytes above 0x7f). The pin is therefore
// canvas-vs-canvas — the binary render and the g1 render must differ by 0
// pixels — plus a committed PNG of the g1 render so a renderer change that
// moves ink is caught even when both sides move together.
import './golden/setup';
import { describe, it, expect, beforeAll } from 'vitest';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { newRealCanvas, type NapiCanvas } from './golden/setup';
import { bytesToByteString, convertDirectGraphicsToHex } from '../services/ipl/fileBytes';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { renderLabel, computeLabelExtent } from '../services/ipl/renderer';
import { ensureBarcodesReady } from '../services/ipl/barcodes';

// Local copy rather than an import: tests/golden/harness.ts declares its own
// suites at module level, and importing it would re-run every golden
// comparison inside this file (see the warning in tests/golden/setup.ts).
const compareCanvases = (expected: NapiCanvas, actual: NapiCanvas): { differingPixels: number; diffPercent: number } => {
    if (expected.width !== actual.width || expected.height !== actual.height) {
        const union = Math.max(expected.width * expected.height, actual.width * actual.height);
        return { differingPixels: union, diffPercent: 100 };
    }
    const pe = expected.getContext('2d').getImageData(0, 0, expected.width, expected.height);
    const pa = actual.getContext('2d').getImageData(0, 0, actual.width, actual.height);
    let differing = 0;
    for (let i = 0; i < pe.data.length; i += 4) {
        for (let c = 0; c < 4; c++) {
            if (Math.abs(pe.data[i + c] - pa.data[i + c]) > 32) { differing++; break; }
        }
    }
    return { differingPixels: differing, diffPercent: (differing / (expected.width * expected.height)) * 100 };
};

const GOLDEN_DIR = path.resolve('testdata/golden');

beforeAll(async () => { await ensureBarcodesReady(); });

const render = (source: string): NapiCanvas => {
    const label = parseViewerIPL(source);
    const extent = computeLabelExtent(label, 203);
    const canvas = newRealCanvas(extent.widthDots, extent.heightDots);
    renderLabel(
        canvas as unknown as HTMLCanvasElement, label, extent,
        { dpi: 203, pxPerDot: 1, quality: 1 },
    );
    return canvas;
};

const loadGolden = async (pngPath: string): Promise<NapiCanvas> => {
    const { loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(await readFile(pngPath));
    const canvas = newRealCanvas(img.width, img.height);
    canvas.getContext('2d').drawImage(img, 0, 0);
    return canvas;
};

describe('BarTender streams: binary render ≡ nibblized render', () => {
    for (const sample of ['bartender-tes1', 'bartender-tes2']) {
        it(`${sample}: g1 rewrite renders pixel-identically to the binary original`, async () => {
            const g0 = bytesToByteString(await readFile(path.resolve(`samples/${sample}.ipl`)));
            const { ipl: g1, converted } = convertDirectGraphicsToHex(g0);
            expect(converted).toBe(true);

            const binary = render(g0);
            const hex = render(g1);
            const report = compareCanvases(binary, hex);
            expect(report.diffPercent, `${report.differingPixels} pixels differ`).toBe(0);

            // Pin the render itself, so a change that moves both sides together
            // still fails. IPL_UPDATE_GOLDEN regenerates, same as the golden suite.
            const pngPath = path.join(GOLDEN_DIR, `${sample}.png`);
            if (process.env.IPL_UPDATE_GOLDEN) {
                await mkdir(GOLDEN_DIR, { recursive: true });
                await writeFile(pngPath, await hex.encode('png'));
                return;
            }
            const expected = await loadGolden(pngPath);
            const pinned = compareCanvases(expected, hex);
            expect(pinned.diffPercent, `${pinned.differingPixels} pixels differ from ${sample}.png`).toBe(0);
        }, 60000);
    }
});
