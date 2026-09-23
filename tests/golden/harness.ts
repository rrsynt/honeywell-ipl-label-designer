/**
 * Golden-file test harness (Fase 3 roadmap): renders parsed IPL labels to real
 * pixels in Node and compares against committed reference PNGs, following the
 * recipe proven by GOODBOY008/labelize — per-channel threshold comparison,
 * percent-of-max-area diff metric, red-overlay + side-by-side artifacts, and
 * an UPDATE_GOLDEN escape hatch. Also hosts the barcode c-parameter parity
 * suites (EAN/UPC versions, Code 39/128 modes, EAN add-ons).
 *
 * Environment shims (real napi canvases + the bwip-js node adapter) live in
 * ./setup.ts and are installed by importing it below. Tests that only need
 * the shims must import ./setup directly — importing this file would re-run
 * every golden pixel comparison once per importer.
 */
import './setup';
import { describe, it, expect, beforeAll } from 'vitest';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { newRealCanvas, nodeRender, BwipCanvasDrawing, type NapiCanvas } from './setup';
import { raw as bwipRaw } from 'bwip-js/browser'; // the mock's raw = real default-export raw

import { parseViewerIPL } from '../../services/ipl/viewerParser';
import { computeLabelExtent, estimateElementSize, renderLabel } from '../../services/ipl/renderer';
import { ensureBarcodesReady, measureBarcode, resolveBcid, buildBwipSpec, paintBarcode, EAN_SUPPLEMENT_GAP_MODULES, type BwipSpec } from '../../services/ipl/barcodes';
import { decodeCode128, code128Check } from './code128Decode';

/** Encode a spec with bwip and decode the resulting symbol back to codewords. */
const bwipRawForced = (spec: BwipSpec): { sbs: number[] } =>
    (bwipRaw as unknown as (o: Record<string, unknown>) => { sbs: number[] }[])({
        bcid: spec.main.bcid, text: spec.main.text, ...spec.main.opts,
    })[0];

const GOLDEN_DIR = path.resolve(__dirname, '../../testdata/golden');
const DIFF_DIR = path.join(GOLDEN_DIR, 'diffs');

interface GoldenCase {
    name: string;
    dpi: number;
    /** Explicit label size in dots; overrides SI values / content bounds. */
    widthDots?: number;
    heightDots?: number;
    /**
     * Allowed diff percent. Default 0.05% — tight enough that a whole
     * interpretive text row (~900 px on a 812x400 canvas ≈ 0.28%) fails,
     * while still absorbing single-pixel antialiasing noise.
     */
    tolerance?: number;
}

const loadCases = async (): Promise<GoldenCase[]> =>
    JSON.parse(await readFile(path.join(GOLDEN_DIR, 'cases.json'), 'utf-8'));

const renderCase = async (caseDef: GoldenCase) => {
    await ensureBarcodesReady();
    const source = await readFile(path.join(GOLDEN_DIR, `${caseDef.name}.ipl`), 'utf-8');
    const label = parseViewerIPL(source);
    const extent = computeLabelExtent(label, caseDef.dpi);
    const widthDots = caseDef.widthDots ?? extent.widthDots;
    const heightDots = caseDef.heightDots ?? extent.heightDots;
    const canvas = newRealCanvas(widthDots, heightDots);
    renderLabel(
        canvas as unknown as HTMLCanvasElement,
        label,
        { widthDots, heightDots },
        { dpi: caseDef.dpi, pxPerDot: 1, quality: 1 },
    );
    return canvas;
};

// ---------------------------------------------------------------------------
// Image comparison (Labelize recipe)
// ---------------------------------------------------------------------------

const getPixels = (canvas: NapiCanvas) => {
    const ctx = canvas.getContext('2d');
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
};

export interface DiffReport {
    differingPixels: number;
    maxArea: number;
    diffPercent: number;
}

export const compareCanvases = (expected: NapiCanvas, actual: NapiCanvas): DiffReport => {
    // A dimension mismatch is a hard failure, scored as 100%: comparing only
    // the intersection let a transposed render (800×400 vs 400×800) pass with
    // diff 0 — exactly the rotation regressions this project has fought.
    if (expected.width !== actual.width || expected.height !== actual.height) {
        const union = Math.max(expected.width * expected.height, actual.width * actual.height);
        return { differingPixels: union, maxArea: union, diffPercent: 100 };
    }
    const pe = getPixels(expected);
    const pa = getPixels(actual);
    const w = Math.min(pe.width, pa.width);
    const h = Math.min(pe.height, pa.height);
    let differing = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const ia = (y * pe.width + x) * 4;
            const ib = (y * pa.width + x) * 4;
            for (let c = 0; c < 4; c++) {
                if (Math.abs(pe.data[ia + c] - pa.data[ib + c]) > 32) {
                    differing++;
                    break;
                }
            }
        }
    }
    // Dimensions are guaranteed equal by the early return above, so a plain
    // full-canvas scan can't skip any pixel.
    const maxArea = pe.width * pe.height;
    return {
        differingPixels: differing,
        maxArea,
        diffPercent: (differing / maxArea) * 100,
    };
};

/** Red-overlay diff artifact + side-by-side composite into golden/diffs/. */
const writeDiffArtifacts = async (name: string, expected: NapiCanvas, actual: NapiCanvas) => {
    await mkdir(DIFF_DIR, { recursive: true });
    const w = Math.max(expected.width, actual.width);
    const h = Math.max(expected.height, actual.height);

    const pe = getPixels(expected);
    const pa = getPixels(actual);
    const overlay = newRealCanvas(w, h);
    const octx = overlay.getContext('2d');
    const img = octx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const ei = x < pe.width && y < pe.height ? (y * pe.width + x) * 4 : -1;
            const ai = x < pa.width && y < pa.height ? (y * pa.width + x) * 4 : -1;
            const eDark = ei >= 0 && pe.data[ei] < 128;
            const aDark = ai >= 0 && pa.data[ai] < 128;
            if (eDark && !aDark) {
                img.data[i] = 255; img.data[i + 1] = 60; img.data[i + 2] = 60;   // lost ink: red
            } else if (!eDark && aDark) {
                img.data[i] = 60; img.data[i + 1] = 200; img.data[i + 2] = 60;  // extra ink: green
            } else if (eDark && aDark) {
                img.data[i] = 40; img.data[i + 1] = 40; img.data[i + 2] = 40;   // both dark
            } else {
                img.data[i] = 245; img.data[i + 1] = 245; img.data[i + 2] = 245;
            }
            img.data[i + 3] = 255;
        }
    }
    octx.putImageData(img, 0, 0);
    await writeFile(path.join(DIFF_DIR, `${name}_diff.png`), await overlay.encode('png'));

    const side = newRealCanvas(w * 2 + 12, h);
    const sctx = side.getContext('2d');
    sctx.fillStyle = '#dddddd';
    sctx.fillRect(0, 0, side.width, side.height);
    sctx.drawImage(expected, 0, 0);
    sctx.drawImage(actual, w + 12, 0);
    await writeFile(path.join(DIFF_DIR, `${name}.png`), await side.encode('png'));
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('EAN/UPC version selection', () => {
    it.each([
        [1, '9638507', 'ean8'],
        [2, '211234567891', 'ean13'],
        [3, '01234567890', 'upca'],
        [4, '0123456', 'upce'],
    ])('renders c7,0,%i with its selected encoder', async (version, data, bcid) => {
        await ensureBarcodesReady();
        const label = parseViewerIPL(`<STX><ESC>P<ETX><STX>E1;F1<ETX><STX>B8;f0;o10,10;c7,0,${version};w3;h76;d3,${data}<ETX><STX>R<ETX>`);
        const barcode = label.elements.find(el => el.kind === 'barcode')!;
        expect(barcode).toMatchObject({ symbology: '7', eanUpcVersion: version });
        expect(label.issues.filter(issue => issue.code === 'barcode-data-invalid')).toEqual([]);
        const expected = newRealCanvas(1, 1);
        nodeRender!({ bcid, text: data, scale: 1, padding: 0, includetext: false, height: 10 }, new BwipCanvasDrawing(expected));
        expect(estimateElementSize(barcode, 203)).toEqual({ lengthDots: expected.width * 3, crossDots: 76 });
        const actual = newRealCanvas(expected.width * 3 + 20, 96);
        renderLabel(actual as unknown as HTMLCanvasElement, label,
            { widthDots: actual.width, heightDots: actual.height },
            { dpi: 203, pxPerDot: 1, quality: 1 });
        const row = actual.getContext('2d').getImageData(10, 40, expected.width * 3, 1).data;
        const reference = expected.getContext('2d').getImageData(0, Math.floor(expected.height / 2), expected.width, 1).data;
        for (let x = 0; x < expected.width * 3; x++) {
            expect(Array.from(row.slice(x * 4, x * 4 + 3))).toEqual(Array.from(reference.slice(Math.floor(x / 3) * 4, Math.floor(x / 3) * 4 + 3)));
        }
    });

    it('keeps automatic selection separate from explicit versions in the measurement cache', async () => {
        await ensureBarcodesReady();
        expect(resolveBcid('7', '211234567891')).toBe('upca');
        expect(measureBarcode('7', '211234567891')).toBeNull();
        expect(measureBarcode('7', '211234567891', { eanUpcVersion: 2 })).not.toBeNull();
        expect(measureBarcode('7', '211234567891', { eanUpcVersion: 0 })).toBeNull();
        expect(resolveBcid('6', '211234567891', 2)).toBe('code128');
        expect(resolveBcid('7', '211234567891', 5)).toBeNull();
    });
});

describe('barcode c-parameter parity (PRM pp.150-154)', () => {
    beforeAll(async () => { await ensureBarcodesReady(); });

    it.each([
        // mode, charset expectation, checksum expectation
        ['0', 'code39', false, false],
        ['1', 'code39', true, false],
        ['2', 'code39', false, true],
        ['3', 'code39ext', false, false],
        ['4', 'code39ext', true, false],
        ['5', 'code39ext', false, true],
        ['6', 'code39', false, false],
        ['7', 'code39', true, false],
        ['8', 'code39', false, true],
    ])('c0,%s maps to %s (printerCheck=%s hostCheck=%s)', (mode, bcid, includecheck, validatecheck) => {
        const spec = buildBwipSpec('0', 'ABC123', { code39Mode: mode })!;
        expect(spec.main.bcid).toBe(bcid);
        expect(!!spec.main.opts.includecheck).toBe(includecheck);
        expect(!!spec.main.opts.validatecheck).toBe(validatecheck);
    });

    it('full-ASCII modes accept lower-case, plain modes reject it', () => {
        expect(measureBarcode('0', 'abc123', { code39Mode: '3' })).not.toBeNull(); // full ASCII
        expect(measureBarcode('0', 'abc123', { code39Mode: '4' })).not.toBeNull(); // full ASCII + printer ck
        expect(measureBarcode('0', 'abc123', { code39Mode: '0' })).toBeNull();     // 43-char set only
        expect(measureBarcode('0', 'abc123', { code39Mode: '6' })).toBeNull();
        // host-verified mode 5. Mod-43 is computed over the full-ASCII expansion
        // (pairs included), so 'abc123' verifies against 'X'. The digit case in
        // the next test pins the plain mod-43 arithmetic itself.
        expect(measureBarcode('0', 'abc123X', { code39Mode: '5' })).not.toBeNull();
        expect(measureBarcode('0', 'abc123', { code39Mode: '5' })).toBeNull();     // missing check char
    });

    it('host-entered check-digit modes verify the data', () => {
        // '12345678' + check char '-' (value 38 of 43-char set: sum 1+2+..=valid pair below)
        const wrong = measureBarcode('0', '12345678Z', { code39Mode: '2' });
        expect(wrong).toBeNull(); // Z is not the correct check char
        // correct check digit for 12345678 in Code 39 mod-43 is '-'
        const right = measureBarcode('0', '12345678-', { code39Mode: '2' });
        expect(right).not.toBeNull();
        // mode 0 neither adds nor verifies: the trailing Z encodes as data
        expect(measureBarcode('0', '12345678Z', { code39Mode: '0' })).not.toBeNull();
    });

    it('c6,m3 forces the Code 128 start subset (codeword-verified)', () => {
        const auto = buildBwipSpec('6', 'AB12', {})!;
        expect(auto.main.text).toBe('AB12');
        const forcedData = (spec: BwipSpec): number[] => {
            const cw = decodeCode128(bwipRawForced(spec));
            expect(cw[cw.length - 1]).toBe(106); // stop
            expect(cw[cw.length - 2]).toBe(code128Check(cw.slice(0, -2))); // bwip's appended check
            return cw.slice(0, -2);
        };
        // 'AB12' in subset A: A=33, B=34, 1=17, 2=18
        const forcedA = buildBwipSpec('6', 'AB12', { code128StartSubset: '1' })!;
        expect(forcedA.main.opts.raw).toBe(true);
        expect(forcedData(forcedA)).toEqual([103, 33, 34, 17, 18]);
        // digits only in subset C: pairs 12,34,56,78
        const forcedC = buildBwipSpec('6', '12345678', { code128StartSubset: '3' })!;
        expect(forcedData(forcedC)).toEqual([105, 12, 34, 56, 78]);
        // lowercase is outside subset A's plain range (needs shift) -> rejected
        expect(buildBwipSpec('6', 'ab', { code128StartSubset: '1' })).toBeNull();
        // odd digits cannot fully pair in subset C -> rejected
        expect(buildBwipSpec('6', '123', { code128StartSubset: '3' })).toBeNull();
    });

    it('forced subset B encodes the full printable ASCII range literally', () => {
        // '{' is a normal subset-B character (cw 91) — no escaping syntax,
        // because the raw-codeword path bypasses bwip's text parsing.
        const spec = buildBwipSpec('6', '{A1', { code128StartSubset: '2' })!;
        const cw = decodeCode128(bwipRawForced(spec));
        expect(cw[cw.length - 2]).toBe(code128Check(cw.slice(0, -2)));
        expect(cw.slice(0, -2)).toEqual([104, 91, 33, 17]);
    });

    it('EAN/UPC supplemental data splits into main symbol + add-on', () => {
        const spec = buildBwipSpec('7', '211234567891.12', { eanUpcVersion: 2 })!;
        expect(spec.main.bcid).toBe('ean13');
        expect(spec.main.text).toBe('211234567891');
        expect(spec.supplement?.bcid).toBe('ean2');
        expect(spec.supplement?.text).toBe('12');
        const spec5 = buildBwipSpec('7', '211234567891.12345', { eanUpcVersion: 2 })!;
        expect(spec5.supplement?.bcid).toBe('ean5');
        // invalid add-on length (3 digits) must fail validation, not silently drop
        expect(measureBarcode('7', '211234567891.123', { eanUpcVersion: 2 })).toBeNull();
        // multiple delimiters (PRM error 07) must fail too, not render main-only
        expect(measureBarcode('7', '4006381333931.12.34', { eanUpcVersion: 2 })).toBeNull();
        expect(measureBarcode('7', '211234567891.12.12345', { eanUpcVersion: 2 })).toBeNull();
    });

    it('EAN/UPC version diagnostics blame the parameter, not the data', () => {
        // valid 8-digit EAN with an out-of-domain version → version warning +
        // defaulted to variable-length, and NO data-invalid error (data is fine).
        const bad = parseViewerIPL('<STX><ESC>P<ETX><STX>E1;F1<ETX><STX>B1;o10,10;c7,0,99;w3;h50;d3,96385074<ETX><STX>R<ETX>');
        expect(bad.issues.some(i => i.code === 'ean-upc-version-invalid')).toBe(true);
        expect(bad.issues.some(i => i.code === 'barcode-data-invalid')).toBe(false);
        // UPC D-series (c7,m2 5) is manual-valid but has no encoder → info, not a data error.
        const dser = parseViewerIPL('<STX><ESC>P<ETX><STX>E1;F1<ETX><STX>B1;o10,10;c7,0,5;w3;h50;d3,1234567890123<ETX><STX>R<ETX>');
        expect(dser.issues.some(i => i.code === 'ean-upc-d-unsupported')).toBe(true);
        expect(dser.issues.some(i => i.code === 'barcode-data-invalid')).toBe(false);
    });

    it('the add-on widens the measured symbol by its modules plus quiet gap', async () => {
        const bare = measureBarcode('7', '211234567891', { eanUpcVersion: 2 })!;
        const withAddon = measureBarcode('7', '211234567891.12', { eanUpcVersion: 2 })!;
        // ean2's own natural width through the same encoder path:
        const e2 = newRealCanvas(10, 10);
        nodeRender!({ bcid: 'ean2', text: '12', scale: 1, padding: 0, includetext: false, height: 10 }, new BwipCanvasDrawing(e2));
        expect(withAddon.widthModules - bare.widthModules).toBe(EAN_SUPPLEMENT_GAP_MODULES + e2.width);
    });

    it('paints the add-on to the right of the main symbol', async () => {
        const canvas = newRealCanvas(520, 100);
        const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
        expect(paintBarcode(ctx, '7', '211234567891.12', 2, 2, 1, 3, 80, { eanUpcVersion: 2 })).toBe(true);
        const ink = (x: number, w: number) => {
            const d = ctx.getImageData(x, 2, w, 78).data;
            let n = 0;
            for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && d[i] < 128) n++; // opaque dark pixel
            return n;
        };
        const bare = measureBarcode('7', '211234567891', { eanUpcVersion: 2 })!;
        // BWIPP's ean2 natural width at scale 1, measured through the same path:
        const e2Canvas = newRealCanvas(10, 10);
        nodeRender!({ bcid: 'ean2', text: '12', scale: 1, padding: 0, includetext: false, height: 10 }, new BwipCanvasDrawing(e2Canvas));
        const modulePx = 3; // moduleDots 3 x pxPerDot 1
        const mainEnd = 2 + bare.widthModules * modulePx;
        expect(ink(mainEnd + 1, 20)).toBe(0);                                   // quiet gap stays blank
        expect(ink(mainEnd + 11 * modulePx, e2Canvas.width * modulePx)).toBeGreaterThan(0); // add-on ink
    });
});

describe('golden files', () => {
    beforeAll(async () => {
        await mkdir(GOLDEN_DIR, { recursive: true });
    });

    it('has a non-empty cases manifest', async () => {
        expect((await loadCases()).length).toBeGreaterThan(0);
    });

    it('renders every case to its golden reference', async () => {
        const updateMode = !!process.env.IPL_UPDATE_GOLDEN;
        const failures: string[] = [];

        for (const caseDef of await loadCases()) {
            const pngPath = path.join(GOLDEN_DIR, `${caseDef.name}.png`);
            const actual = await renderCase(caseDef);

            if (updateMode) {
                await writeFile(pngPath, await actual.encode('png'));
                continue;
            }

            let expected: NapiCanvas;
            try {
                const { loadImage } = await import('@napi-rs/canvas');
                const img = await loadImage(await readFile(pngPath));
                expected = newRealCanvas(img.width, img.height);
                const ectx = expected.getContext('2d');
                ectx.drawImage(img, 0, 0);
            } catch {
                failures.push(`${caseDef.name}: missing/unreadable golden ${path.basename(pngPath)} (run with IPL_UPDATE_GOLDEN=1)`);
                continue;
            }

            const report = compareCanvases(expected, actual);
            const tol = caseDef.tolerance ?? 0.05;
            if (report.diffPercent > tol) {
                await writeDiffArtifacts(caseDef.name, expected, actual);
                failures.push(
                    `${caseDef.name}: diff ${report.diffPercent.toFixed(2)}% exceeds ${tol}% ` +
                    `(${report.differingPixels}/${report.maxArea} px) — see testdata/golden/diffs/${caseDef.name}_diff.png`,
                );
            }
        }

        expect(failures).toEqual([]);
    }, 120_000);
});
