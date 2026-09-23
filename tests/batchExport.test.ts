// Batch E (2026-09-21): multi-label export. The viewer preview can step
// through a job's labels (<RS> batches x <US> copies, odometer-advanced
// <FS>/<GS> regions), but PNG/PDF export only ever captured the CURRENT
// label. streamBatchPages()/buildBatchPages() render every label of the job
// offscreen into PNG pages the modal feeds to jsPDF — WYSIWYG with the
// stepper, since it uses the exact same resolveLabelAtBatch mapping the
// preview uses. Review hardening: streaming callback (peak memory = one
// page), event-loop yields, cap pure-helper, extentOverride only for manual
// paper sizes (auto extent stays per-label so widening odometer data never
// clips).
import './golden/setup'; // real canvas + bwip shims (module level!)
import { describe, it, expect, beforeAll } from 'vitest';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { ensureBarcodesReady } from '../services/ipl/barcodes';
import { totalLabelCount } from '../services/ipl/odometer';
import {
    buildBatchPages, streamBatchPages, batchPageCount, MAX_BATCH_EXPORT,
} from '../services/batchExport';

beforeAll(async () => { await ensureBarcodesReady(); });

const wrap = (fields: string[]) => parseViewerIPL([
    '<STX><ESC>C<SI>W400<SI>L200<ETX>',
    '<STX><ESC>P<ETX>',
    '<STX>E1;F1<ETX>',
    ...fields.map(f => `<STX>${f}<ETX>`),
    '<STX>R<ETX>',
].join('\n'));

/** A 6-label odometer job (<RS>3 batches x <US>2 copies), serial SN0001..06. */
const odometerJob = () => parseViewerIPL([
    '<STX><ESC>C<SI>W400<SI>L200<ETX>',
    '<STX><ESC>P<ETX>',
    '<STX>E1;F1<ETX>',
    '<STX>H1;o20,20;c0;h2;w2;d0,SN<FS>0001<FS><ETX>',
    '<STX>R<ETX>',
    '<STX><ESC>E1<CAN><ESC>F1<NUL>SN<FS>0001<FS><US>2<RS>3<ETB><FF><ETX>',
].join('\n'));

describe('buildBatchPages', () => {
    it('single-label job yields exactly one page', async () => {
        const label = wrap(['H0;o20,20;c0;h2;w2;d3,ONE LABEL']);
        const pages = await buildBatchPages(label, 203, 0);
        expect(pages).toHaveLength(1);
        expect(pages[0].dataUrl.startsWith('data:image/png')).toBe(true);
        // 400x200 dots at 203 dpi -> 141.87 x 70.94 pt
        expect(pages[0].widthPt).toBeCloseTo(400 / 203 * 72, 1);
        expect(pages[0].heightPt).toBeCloseTo(200 / 203 * 72, 1);
        expect(pages[0].landscape).toBe(true);
    });

    it('odometer job: one page per label, ALL SIX distinct (WYSIWYG with the stepper)', async () => {
        const job = odometerJob();
        expect(totalLabelCount(job)).toBe(6);
        const pages = await buildBatchPages(job, 203, 0);
        expect(pages).toHaveLength(6);
        // SN0001..SN0006: every label differs — not just "more than one".
        const uniq = new Set(pages.map(p => p.dataUrl));
        expect(uniq.size).toBe(6);
        expect(pages[5].dataUrl.startsWith('data:image/png')).toBe(true);
    }, 30000); // six full bwip + napi-canvas renders under parallel suite load
              // routinely exceed vitest's 5s default (flake found 2026-09-22:
              // passes isolated, times out in the full run)

    it('rotation swaps the page dimensions', async () => {
        const label = wrap(['H0;o20,20;c0;h2;w2;d3,ROT']);
        const p0 = (await buildBatchPages(label, 203, 0))[0];
        const p1 = (await buildBatchPages(label, 203, 1))[0];
        expect(p1.widthPt).toBeCloseTo(p0.heightPt, 1);
        expect(p1.heightPt).toBeCloseTo(p0.widthPt, 1);
        expect(p1.landscape).toBe(!p0.landscape);
    });

    it('caps at maxPages, and the default cap is MAX_BATCH_EXPORT', async () => {
        const job = parseViewerIPL([
            '<STX><ESC>C<SI>W400<SI>L200<ETX>',
            '<STX><ESC>P<ETX>',
            '<STX>E1;F1<ETX>',
            '<STX>H0;o20,20;c0;h2;w2;d3,PLAIN<ETX>',
            '<STX>R<ETX>',
            '<STX><ESC>E1<CAN><US>9999<RS>99<ETB><FF><ETX>',
        ].join('\n'));
        expect(totalLabelCount(job)).toBe(9999 * 99);
        // batchPageCount is pure — the cap math is checkable without rendering.
        expect(batchPageCount(job, { maxPages: 3 })).toBe(3);
        expect(batchPageCount(job)).toBe(MAX_BATCH_EXPORT);
        expect(MAX_BATCH_EXPORT).toBeLessThanOrEqual(500);
        const small = await buildBatchPages(job, 203, 0, { maxPages: 3 });
        expect(small).toHaveLength(3);
    });

    it('empty label yields no pages', async () => {
        const label = parseViewerIPL('<STX><ESC>C<SI>W400<ETX><STX><ESC>P<ETX><STX>E1;F1<ETX><STX>R<ETX>');
        expect(await buildBatchPages(label, 203, 0)).toHaveLength(0);
    });

    it('extentOverride locks every page to one box; without it each page measures itself', async () => {
        const label = wrap(['H0;o20,20;c0;h2;w2;d3,BOX']);
        const locked = await buildBatchPages(label, 203, 0, { extentOverride: { widthDots: 800, heightDots: 400 } });
        expect(locked[0].widthPt).toBeCloseTo(800 / 203 * 72, 1);
        expect(locked[0].heightPt).toBeCloseTo(400 / 203 * 72, 1);
        const auto = await buildBatchPages(label, 203, 0);
        expect(auto[0].widthPt).toBeCloseTo(400 / 203 * 72, 1);
    });
});

describe('batch pages -> ZIP integration (Batch F)', () => {
    it('zips all six odometer labels as distinct numbered PNG entries', async () => {
        const { createZipBlob, zipEntryBytes, numberedPngName } = await import('../services/zipStore');
        const job = odometerJob();
        const pages = await buildBatchPages(job, 203, 0);
        const blob = createZipBlob(pages.map((p, i) => ({
            name: numberedPngName('job', i, pages.length),
            data: zipEntryBytes(p.dataUrl),
        })));
        const buf = new Uint8Array(await blob.arrayBuffer());
        // EOCD entry count at fixed offset (no comment): total = 6.
        expect(buf.length).toBeGreaterThan(22);
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        expect(dv.getUint32(buf.length - 22, true)).toBe(0x06054b50);
        expect(dv.getUint16(buf.length - 22 + 10, true)).toBe(6);
        // Archive size must cover all six PNG payloads (store method:
        // uncompressed) plus headers — and each decoded page really is a PNG.
        expect(pages.every(p => zipEntryBytes(p.dataUrl).subarray(0, 4).every((b, i) => b === [0x89, 0x50, 0x4e, 0x47][i]))).toBe(true);
        const payloadBytes = pages.reduce((s, p) => s + zipEntryBytes(p.dataUrl).length, 0);
        expect(buf.length).toBeGreaterThanOrEqual(payloadBytes);
    }, 30000); // six renders again
});

describe('streamBatchPages', () => {
    it('emits pages incrementally in index order and returns the count', async () => {
        const job = odometerJob();
        const seen: number[] = [];
        let firstPageLen = 0;
        const n = await streamBatchPages(job, 203, 0, {}, (page, i) => {
            seen.push(i);
            if (i === 0) firstPageLen = page.dataUrl.length;
        });
        expect(n).toBe(6);
        expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
        expect(firstPageLen).toBeGreaterThan(100);
    }, 30000); // same six-render load as the WYSIWYG case above

    it('yields to the event loop between pages (UI can paint the busy state)', async () => {
        // If the loop never awaited, a macrotask marker set from a timer
        // could not interleave with the page callbacks.
        const job = odometerJob();
        let timerRan = false;
        const timer = setTimeout(() => { timerRan = true; }, 0);
        await streamBatchPages(job, 203, 0, {}, () => undefined);
        clearTimeout(timer);
        expect(timerRan).toBe(true);
    }, 30000); // six renders again
});
