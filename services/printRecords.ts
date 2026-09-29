// Fase 6: what "record 7" means for a design.
//
// One place answers it, and both the sheet preview and the print job ask THAT
// place — a preview that computes its own record count can disagree with what
// actually prints, and the disagreement is invisible until the media is
// wasted.
//
// Two shapes of job exist and they are not the same thing:
//
//   Table-backed. Each row of the design's table sources is one label; the
//   job sends one print block per row (services/iplGenerator.ts batch path).
//   Record i is a ROW, and its label is generateIPL(design, rowBatchData).
//
//   Single-record. No table: the design prints one label, and printerSettings
//   .quantity is encoded INSIDE the stream (<RS>n). Records here are copies,
//   and previewing one means simulating whatever the stream itself does —
//   the <FS>/<ESC>I serial odometer (services/ipl/odometer.ts), which is the
//   same simulation the viewer and the image exports already use.

import { generateIPL } from './iplGenerator';
import { parseViewerIPL } from './ipl/viewerParser';
import { ensureBarcodesReady } from './ipl/barcodes';
import { ensureCjkReady } from './ipl/codePages';
import { resolveLabelAtBatch } from './ipl/odometer';
import { planDesignTableJob } from './tableSource';
import { rowBatchData, type JobPlan } from './csvJob';
import { DPI_MAP } from '../constants';
import { printedLabelMm } from './stockFrame';
import type { Design } from '../types';
import type { ViewerLabel } from './ipl/types';

/** The design's table job, or null when it has no printing table. */
export const designJobPlan = (design: Design): JobPlan | null => planDesignTableJob(design).plan;

/**
 * Labels a record range can address. A table design prints one label per row;
 * a design without tables prints one (its quantity lives in the stream, and
 * copies are a job option, not a record count).
 */
export const designRecordCount = (design: Design): number => {
    const plan = designJobPlan(design);
    return plan ? plan.batch.rows.length : 1;
};

/** True when this design prints from a table, i.e. records are rows. */
export const designHasRecords = (design: Design): boolean => designJobPlan(design) !== null;

/**
 * The viewer label for one record, through the real pipeline: generateIPL →
 * parseViewerIPL → (odometer). Barcode measurement needs the encoder loaded,
 * so this is async; callers must tolerate the same latency the viewer has.
 *
 * Out-of-range indices are clamped rather than refused: a preview that steps
 * past the end shows the last label, which is what the existing row preview
 * does (components/CsvRowPreview.tsx), and a job builder never asks for one.
 */
export const labelAtRecord = async (
    design: Design,
    plan: JobPlan | null,
    recordIndex: number,
    dpi: number,
): Promise<ViewerLabel> => {
    // An export cannot re-parse, so both lazy engines are awaited here.
    await Promise.all([ensureBarcodesReady(), ensureCjkReady()]);
    if (plan) {
        const index = Math.max(0, Math.min(recordIndex, plan.batch.rows.length - 1));
        return parseViewerIPL(await generateIPL(design, rowBatchData(plan, index)));
    }
    const label = parseViewerIPL(await generateIPL(design));
    return resolveLabelAtBatch(label, Math.max(0, recordIndex), dpi);
};

/**
 * One cell of the sheet in dots. The STOCK size, not the content bounds: a
 * sheet is a physical layout, so every cell must be the same size regardless
 * of how much ink a particular record puts in it.
 */
export const sheetCellDots = (design: Design): { widthDots: number; heightDots: number } => {
    const { dpi } = design.printerSettings;
    // The PRINTED label's size, which swaps for landscape: the generator sends
    // <SI>W/<SI>L and every origin in the turned frame, so a landscape design
    // prints 65x100 where its settings say 100x65. Sizing the cell from the raw
    // settings made it the wrong way round, and since the cell extent is also
    // what renderLabel draws the label into, the preview stretched a tall label
    // across a wide cell. See services/stockFrame.ts.
    const { widthMm, heightMm } = printedLabelMm(design.labelSettings);
    return {
        widthDots: Math.max(1, Math.round(widthMm * DPI_MAP[dpi])),
        heightDots: Math.max(1, Math.round(heightMm * DPI_MAP[dpi])),
    };
};

/**
 * The stock as a render EXTENT: the physical page, in dots.
 *
 * This is the size a label is DRAWN at. `computeLabelExtent` answers a
 * different question — how much room the content needs — and so it grows the
 * canvas when a field hangs past the edge. That is right for a viewer opening a
 * stranger's stream, and wrong for an export: the printer clips at the stock,
 * so anything outside it is not printed and must not enlarge the page. Measured
 * before this existed: a box authored at x=88 spanning to x=118 on a 100mm
 * stock exported as a 118x65mm PNG with the ink running 18mm past the label,
 * while the designer canvas clipped it at 100 as the printer would.
 */
export const stockExtentDots = (design: Design): { widthDots: number; heightDots: number } =>
    sheetCellDots(design);

/**
 * Cells laid out on a sheet: rows × columns from the label settings, floored
 * at 1 each (0 would divide the page count by zero).
 */
export const sheetLayout = (design: Design): { columns: number; rows: number } => ({
    columns: Math.max(1, Math.floor(design.labelSettings.columns || 1)),
    rows: Math.max(1, Math.floor(design.labelSettings.rows || 1)),
});

/** Sheets needed for `records` labels at this design's layout. */
export const sheetCount = (design: Design, records: number): number => {
    const { columns, rows } = sheetLayout(design);
    return Math.max(1, Math.ceil(records / (columns * rows)));
};

/** Records per sheet — the step between one sheet's first record and the next. */
export const recordsPerSheet = (design: Design): number => {
    const { columns, rows } = sheetLayout(design);
    return columns * rows;
};
