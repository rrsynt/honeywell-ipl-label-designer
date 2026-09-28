// Batch P (2026-09-23): designer image export. PNG / multi-page PDF / ZIP of
// numbered PNGs — all three routed through the SAME pipeline the viewer's
// export buttons use: generateIPL(design) → parseViewerIPL → streamBatchPages.
// That is deliberate: the viewer path is golden-test-pinned, so what the
// designer exports is what the printer prints (WYSIWYG parity), instead of a
// second canvas-drawing export path that could drift from the generator.
//
// A design with quantity N streams N pages (resolveLabelAtBatch semantics —
// identical copies unless the IPL carries <FS>/<GS> odometer regions, which
// the designer's generator never emits; those belong to imported viewer jobs).
// The MAX_BATCH_EXPORT cap and the upfront truncation confirm mirror Batch E;
// the confirm lives in the caller (App) so this module stays DOM-light, and
// only the three download* functions touch document/URL.

import { generateIPL } from './iplGenerator';
import { parseViewerIPL } from './ipl/viewerParser';
import { ensureBarcodesReady } from './ipl/barcodes';
import { ensureCjkReady } from './ipl/codePages';
import { totalLabelCount } from './ipl/odometer';
import { streamBatchPages, MAX_BATCH_EXPORT, type BatchPage, type BatchRenderOptions } from './batchExport';
import { createZipBlob, zipEntryBytes, numberedPngName, sanitizeBaseName, type ZipEntry } from './zipStore';
import type { Design } from '../types';

export type ImageExportKind = 'png' | 'pdf' | 'zip';
export { MAX_BATCH_EXPORT };

/** Prepare the shared engine, then parse the design's own IPL stream. */
const labelOf = async (design: Design) => {
    // Both engines are async-only: bwip because the parser measures barcodes
    // through it, the CJK tables because a parse that runs before they land
    // leaves <SI>l30..33 data as raw bytes — and an export cannot re-parse.
    await Promise.all([ensureBarcodesReady(), ensureCjkReady()]);
    return parseViewerIPL(await generateIPL(design));
};

/** Labels a design would print (quantity × batch-count). Pure async. */
export const designJobLabelCount = async (design: Design): Promise<number> =>
    totalLabelCount(await labelOf(design));

/**
 * Stream every page of the design's job (or the first maxPages of them)
 * through onPage, exactly like the viewer's batch exports: physical page
 * size in points, event-loop yields, per-label extent. Rotation follows the
 * viewer's 'auto' mode — the format direction embedded in the stream (the
 * designer's generator never emits q, so this is 0; imported-and-edited
 * designs keep whatever the stream says).
 */
export const streamDesignPages = async (
    design: Design,
    opts: BatchRenderOptions,
    onPage: (page: BatchPage, index: number) => void,
): Promise<number> => {
    const label = await labelOf(design);
    return streamBatchPages(label, design.printerSettings.dpi, label.settings.formatDirection ?? 0, opts, onPage);
};

const triggerDownload = (href: string, filename: string): void => {
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    a.click();
};

/** First label as a standalone PNG (~800 dpi raster, same as batch pages). */
export const downloadDesignPng = async (design: Design): Promise<number> => {
    const dpi = design.printerSettings.dpi;
    let emitted = 0;
    await streamDesignPages(design, { maxPages: 1 }, (page) => {
        triggerDownload(page.dataUrl, `${sanitizeBaseName(design.name)}-${dpi}dpi.png`);
        emitted++;
    });
    return emitted;
};

/** Every (capped) label as one multi-page PDF sized per physical label. */
export const downloadDesignPdf = async (design: Design, maxPages?: number): Promise<number> => {
    const dpi = design.printerSettings.dpi;
    const { jsPDF } = await import('jspdf');
    let pdf: InstanceType<typeof jsPDF> | null = null;
    let emitted = 0;
    await streamDesignPages(design, { maxPages }, (page) => {
        if (!pdf) {
            pdf = new jsPDF({
                orientation: page.landscape ? 'landscape' : 'portrait',
                unit: 'pt',
                format: [Math.max(28, page.widthPt), Math.max(28, page.heightPt)],
                // Without this jsPDF embeds addImage's raster as UNCOMPRESSED
                // RGB. A label rasterizes at 4 px per printer dot, so the
                // shipping template (816x1216 dots) produces a 3264x4864 image
                // = 47.6 MB of raw pixels, and the exported PDF measured
                // exactly that while the identical PNG inside a ZIP was
                // 584 KB. Measured at the same size: 45.4 MB -> 0.06 MB with
                // compression. Nothing else about the page changes.
                compress: true,
            });
        } else {
            pdf.addPage([Math.max(28, page.widthPt), Math.max(28, page.heightPt)],
                page.landscape ? 'landscape' : 'portrait');
        }
        pdf.addImage(page.dataUrl, 'PNG', 0, 0, page.widthPt, page.heightPt);
        emitted++;
    });
    if (!pdf) return 0;
    pdf.save(`${sanitizeBaseName(design.name)}-${emitted}x-${dpi}dpi.pdf`);
    return emitted;
};

/**
 * Every (capped) label as a numbered PNG inside one ZIP (store method — the
 * PNGs are already deflated). Blob URL is revoked late so the download
 * manager can finish reading a large archive (same as the viewer's Batch F).
 */
export const downloadDesignZip = async (design: Design, maxPages?: number): Promise<number> => {
    const dpi = design.printerSettings.dpi;
    const baseName = sanitizeBaseName(design.name);
    const pageCount = Math.min(await designJobLabelCount(design), maxPages ?? MAX_BATCH_EXPORT);
    if (pageCount === 0) return 0;
    const entries: ZipEntry[] = [];
    await streamDesignPages(design, { maxPages }, (page, i) => {
        entries.push({ name: numberedPngName(baseName, i, pageCount), data: zipEntryBytes(page.dataUrl) });
    });
    if (entries.length === 0) return 0;
    const blob = createZipBlob(entries);
    const url = URL.createObjectURL(blob);
    triggerDownload(url, `${baseName}-${entries.length}png-${dpi}dpi.zip`);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return entries.length;
};
