// Batch E (2026-09-21): multi-label export for the IPL viewer. A job may
// print <RS>b × <US>c = b*c labels whose <FS>/<GS> regions advance per batch
// (odometer.ts). The preview steps through them one at a time; this renders
// EVERY label of the job offscreen into PNG pages (with physical page size in
// points) that the viewer assembles into one multi-page PDF. Same
// resolveLabelAtBatch mapping the stepper uses, so the PDF is WYSIWYG with
// the preview.
//
// Review hardening (2026-09-21): streamBatchPages hands each page to the
// caller the moment it is rendered — jsPDF copies the image data and the
// base64 string becomes collectable, so peak memory is ONE page, not 300.
// The loop yields to the event loop every few pages so the "…" button state
// paints and the tab never freezes for seconds on end.

import { renderLabel, computeLabelExtent } from './ipl/renderer';
import { resolveLabelAtBatch, totalLabelCount } from './ipl/odometer';
import type { ViewerLabel } from './ipl/types';

export interface BatchPage {
    dataUrl: string;
    /** Page box in PostScript points (72/in), already rotation-swapped. */
    widthPt: number;
    heightPt: number;
    landscape: boolean;
}

export interface BatchExtent {
    widthDots: number;
    heightDots: number;
}

/**
 * Cap on exported pages: each page allocates a real canvas (dots × pxPerDot ×
 * quality). 9999×99-copy jobs exist in the wild; rendering them all would
 * freeze the tab. The viewer confirms upfront and truncates past this many.
 */
export const MAX_BATCH_EXPORT = 300;

/** Raster density: 2 px/dot × quality 2 = 4 px per printer dot (~800 dpi). */
const EXPORT_PX_PER_DOT = 2;
const EXPORT_QUALITY = 2;

/** Pages a job will export: total labels, capped. Pure — pinned by tests. */
export const batchPageCount = (
    label: ViewerLabel,
    opts: { maxPages?: number } = {},
): number => Math.min(totalLabelCount(label), opts.maxPages ?? MAX_BATCH_EXPORT);

export interface BatchRenderOptions {
    maxPages?: number;
    /**
     * Lock every page to one extent (the viewer's manual paperMm override).
     * WITHOUT it each label's extent is computed per resolved label — the
     * right default, since odometer data can widen a label's element bounds
     * (review: locking the auto extent to the previewed batch would clip
     * later labels whose content grows).
     */
    extentOverride?: BatchExtent;
}

/**
 * Renders each label of the job and calls onPage(page, index) immediately.
 * Yields to the event loop every 4 pages so the UI stays responsive and
 * per-page dataUrls can be collected after the caller consumes them.
 * Returns the number of pages emitted.
 */
export const streamBatchPages = async (
    label: ViewerLabel,
    dpi: number,
    rotation: number,
    opts: BatchRenderOptions,
    onPage: (page: BatchPage, index: number) => void,
): Promise<number> => {
    const count = batchPageCount(label, opts);
    if (count === 0 || label.elements.length === 0) return 0;

    const scratch = document.createElement('canvas');
    const swap = rotation % 2 !== 0; // odd quarter-turns swap the page box
    for (let i = 0; i < count; i++) {
        const resolved = resolveLabelAtBatch(label, i, dpi);
        const extent = opts.extentOverride ?? computeLabelExtent(resolved, dpi);
        renderLabel(scratch, resolved, extent, {
            dpi,
            pxPerDot: EXPORT_PX_PER_DOT,
            quality: EXPORT_QUALITY,
            rotation,
        });
        const wDots = swap ? extent.heightDots : extent.widthDots;
        const hDots = swap ? extent.widthDots : extent.heightDots;
        onPage({
            dataUrl: scratch.toDataURL('image/png'),
            widthPt: (wDots / dpi) * 72,
            heightPt: (hDots / dpi) * 72,
            landscape: wDots >= hDots,
        }, i);
        // Let the browser paint (button "…" state) and GC settled pages.
        if (count > 1 && i % 4 === 3) await new Promise(resolve => setTimeout(resolve, 0));
    }
    return count;
};

/** Collecting convenience over streamBatchPages (tests, small jobs). */
export const buildBatchPages = async (
    label: ViewerLabel,
    dpi: number,
    rotation: number,
    opts: BatchRenderOptions = {},
): Promise<BatchPage[]> => {
    const pages: BatchPage[] = [];
    await streamBatchPages(label, dpi, rotation, opts, p => pages.push(p));
    return pages;
};
