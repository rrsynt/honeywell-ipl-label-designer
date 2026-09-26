// Fase 6: the sheet preview — a whole print job laid out the way it comes off
// the line, one cell per record, records numbered.
//
// One canvas per SHEET, not per label. A 300-record job at 4×4 is 19 sheets;
// 300 mounted canvases would each hold a bitmap, and the browser would start
// evicting them at unpredictable moments. A sheet canvas is also what makes
// "sheet" a real thing to look at — labels line up in rows and columns the way
// the stock does, which is the question a print preview has to answer.
//
// Cells are painted through the SAME pipeline as the print job: labelAtRecord
// → generateIPL → parseViewerIPL → renderLabel (services/printRecords.ts). So
// what a cell shows is what the printer receives for that record — including
// its own suppression state. The dashed marker comes from
// suppressedFieldIdsForRow, the generator's own test, so a cell can never show
// a field the stream still prints.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Design } from '../types';
import {
    designJobPlan, designRecordCount, labelAtRecord, recordsPerSheet, sheetCellDots, sheetLayout,
} from '../services/printRecords';
import { suppressedFieldIdsForRow } from '../services/iplGenerator';
import { elementVisualBox, renderLabel } from '../services/ipl/renderer';
import { MAX_BATCH_EXPORT } from '../services/batchExport';
import type { ViewerLabel } from '../services/ipl/types';

const CELL_PX_PER_DOT = 0.16;
const LABEL_FONT_PX = 11;
/**
 * Height of the strip above each cell where the record number lives.
 *
 * The number used to sit INSIDE the cell's top-left corner, and that is where
 * the suppression marker of a field near the origin lands — the badge painted
 * over the marker and the preview showed a clean label for a record whose data
 * had been dropped. A band of its own removes the overlap by construction
 * rather than by drawing the two in the right order and hoping.
 */
const RECORD_BAND_PX = 18;
/** Vertical overscan: sheets inside this many pixels of the viewport are kept
 *  rendered, so a fast scroll does not flash blank paper. */
const VISIBLE_MARGIN_PX = 600;

/**
 * Where the suppression markers for one record go, in cell-local CSS pixels.
 *
 * Exported and pure so the wiring is testable: the failure this guards against
 * is not "the predicate is wrong" (suppressedFieldIdsForRow is pinned against
 * the generator's own output) but "the marker was computed and then never
 * drawn where anyone could see it". A record with nothing suppressed returns an
 * empty list, so a caller can assert both directions.
 */
export const recordMarkerRects = (
    design: Design,
    plan: { batch: { rows: string[][]; mappings: { [fieldId: number]: number }; headers: string[] } } | null,
    recordIndex: number,
    label: ViewerLabel,
    dpi: number,
    pxPerDot: number,
): { x: number; y: number; w: number; h: number }[] => {
    if (!plan) return [];
    const row = plan.batch.rows[recordIndex];
    if (!row) return [];
    const variables = design.fields.filter(
        (f): f is Extract<typeof f, { type: 'text' | 'barcode' }> => f.type === 'text' || f.type === 'barcode',
    );
    if (variables.length === 0) return [];
    const dropped = new Set(suppressedFieldIdsForRow(design, variables, row, plan.batch as never));
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    for (const id of dropped) {
        const el = label.elements.find(e => e.id === id);
        if (!el) continue;
        // elementVisualBox is the renderer's own post-rotation box, so a marker
        // sits where the field WOULD have printed, at any rotation — the
        // hand-rolled f=0-only maths this replaced drew over the cell above.
        const box = elementVisualBox(el, dpi);
        rects.push({
            x: box.x * pxPerDot,
            y: box.y * pxPerDot,
            w: Math.max(3, box.w * pxPerDot),
            h: Math.max(3, box.h * pxPerDot),
        });
    }
    return rects;
};

/**
 * Draw one sheet. Returns the canvas so the caller can release it when the
 * sheet scrolls away.
 */
const paintSheet = async (
    design: Design,
    firstRecord: number,
    recordsOnSheet: number,
    dpi: number,
    layout: { columns: number; rows: number },
): Promise<HTMLCanvasElement> => {
    const { columns, rows } = layout;
    const cell = sheetCellDots(design);
    const gapDots = Math.max(4, Math.round(dpi * 0.5)); // ~0.5 mm of stock between labels
    const totalW = columns * cell.widthDots + (columns - 1) * gapDots;
    // One record band per row, so the last row's band is inside the canvas.
    const totalH = rows * cell.heightDots + (rows - 1) * gapDots + rows * (RECORD_BAND_PX / CELL_PX_PER_DOT);

    const canvas = document.createElement('canvas');
    const pxPerDot = CELL_PX_PER_DOT;
    const scratch = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = Math.max(1, Math.round(totalW * pxPerDot));
    canvas.height = Math.max(1, Math.round(totalH * pxPerDot));
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;
    if (!ctx) return canvas;

    // Dark background, white cells: a filled white canvas would make a sheet
    // read as one giant label with a few boxes on it. The cell IS the stock.
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;

    const plan = designJobPlan(design);

    for (let i = 0; i < recordsOnSheet; i++) {
        // Two indices on purpose, and mixing them is a real bug: `recordNumber`
        // is 1-based (what the user reads and what the table rows are numbered
        // by), `recordIndex` is 0-based (what the array and the renderer want).
        // The cell must show N while reading row N-1.
        const recordNumber = firstRecord + i;
        const recordIndex = recordNumber - 1;
        const col = i % columns;
        const row = Math.floor(i / columns);
        const x = col * (cell.widthDots + gapDots);
        // Centres the label in its row slot, so the record band above it has
        // somewhere to live without eating into the row below.
        const y = row * (cell.heightDots + gapDots) + RECORD_BAND_PX / pxPerDot;
        const px = x * pxPerDot;
        const py = y * pxPerDot;
        const pw = cell.widthDots * pxPerDot;
        const ph = cell.heightDots * pxPerDot;

        // White paper under the label: the cell is the physical stock, so it is
        // painted whether or not the design fills it.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(px, py, pw, ph);
        ctx.strokeStyle = 'rgba(107,114,128,0.9)';
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);

        let label: ViewerLabel | null = null;
        try {
            label = await labelAtRecord(design, plan, recordIndex, dpi);
        } catch {
            label = null; // one broken record must not blank the whole sheet
        }

        if (label) {
            renderLabel(scratch, label, cell, { dpi, pxPerDot, quality: 2, rotation: 0 });
            ctx.drawImage(scratch, px, py, pw, ph);

            // Suppression markers: the fields THIS record drops, drawn where
            // they would have been so the gap is explainable. The suppression
            // test is the generator's own, so a marker cannot disagree with
            // what the stream did (see suppressedFieldIdsForRow).
            const markers = recordMarkerRects(design, plan, recordIndex, label, dpi, pxPerDot);
            if (markers.length > 0) {
                ctx.save();
                ctx.setLineDash([3, 3]);
                ctx.strokeStyle = 'rgba(245,158,11,0.95)';
                ctx.lineWidth = 1.5;
                for (const rect of markers) {
                    ctx.strokeRect(px + rect.x + 0.5, py + rect.y + 0.5, rect.w, rect.h);
                }
                ctx.restore();
            }
        }

        // The record number sits in its own band above the cell, never on the
        // label: printed on the stock it would be ink the printer never sends,
        // and inside the cell it covered the suppression marker (see
        // RECORD_BAND_PX).
        ctx.fillStyle = 'rgba(17,24,39,0.9)';
        ctx.fillRect(px, py - RECORD_BAND_PX, Math.max(28, 26 + String(recordNumber).length * 7), RECORD_BAND_PX - 3);
        ctx.fillStyle = '#f9fafb';
        ctx.font = `${LABEL_FONT_PX}px monospace`;
        ctx.textBaseline = 'top';
        ctx.fillText(`#${recordNumber}`, px + 6, py - RECORD_BAND_PX + 3);
    }

    return canvas;
};

/**
 * The sheet grid actually used for a preview.
 *
 * `labelSettings.columns`/`rows` describe the STOCK (multi-up media), and
 * nearly every design leaves them at 1×1 — which is a sheet holding exactly
 * one label, and a "sheet preview" of a 300-record job as 300 sheets, one
 * label each. That is not a preview, it is the existing single-label stepper
 * with extra steps.
 *
 * So when the design declares a 1×1 sheet, the preview arranges the RECORDS in
 * a grid instead: the sheet becomes "one page of the job", several records to a
 * page, which is the question this view exists to answer (what does the run
 * look like, and which record is which). A design that DOES declare multi-up
 * stock keeps its own layout exactly — there the sheet really is the physical
 * media and the layout is not ours to choose.
 */
export const previewSheetLayout = (design: Design): { columns: number; rows: number } => {
    const declared = sheetLayout(design);
    if (declared.columns > 1 || declared.rows > 1) return declared;
    return { columns: 2, rows: 3 };
};

export const SheetPreview: React.FC<{
    design: Design;
    /** First record to show (1-based). */
    from: number;
    /** Last record to show (1-based, inclusive). */
    to: number;
    /** Re-render trigger: sheets paint on change even if the design is equal. */
    revision: number;
}> = ({ design, from, to, revision }) => {
    const dpi = design.printerSettings.dpi;
    const recordCount = designRecordCount(design);
    const plan = designJobPlan(design);

    const first = Math.max(1, Math.min(from, to));
    const last = Math.min(recordCount, Math.max(from, to));
    const shown = Math.max(0, last - first + 1);
    const capped = Math.min(shown, MAX_BATCH_EXPORT);
    const layout = previewSheetLayout(design);
    const perSheet = layout.columns * layout.rows;
    const sheets = Math.max(1, Math.ceil(capped / perSheet));

    const scrollRef = useRef<HTMLDivElement>(null);
    const [visible, setVisible] = useState<Set<number>>(() => new Set([0]));

    // Which sheets are worth rendering. Without this every sheet of a large job
    // would paint at once on open, which is the freeze this view exists to
    // avoid.
    useEffect(() => {
        setVisible(new Set([0]));
    }, [design, from, to, revision]);

    useEffect(() => {
        const root = scrollRef.current;
        if (!root) return;
        const onScroll = () => {
            const top = root.scrollTop - VISIBLE_MARGIN_PX;
            const bottom = root.scrollTop + root.clientHeight + VISIBLE_MARGIN_PX;
            const next = new Set<number>();
            for (const holder of root.querySelectorAll<HTMLElement>('[data-sheet-index]')) {
                const index = Number(holder.dataset.sheetIndex);
                if (holder.offsetTop + holder.offsetHeight >= top && holder.offsetTop <= bottom) next.add(index);
            }
            setVisible(prev => {
                if (prev.size === next.size && [...next].every(i => prev.has(i))) return prev;
                return next;
            });
        };
        onScroll();
        root.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onScroll);
        return () => {
            root.removeEventListener('scroll', onScroll);
            window.removeEventListener('resize', onScroll);
        };
    }, [sheets, design]);

    const cellStyle = useMemo(() => {
        const cell = sheetCellDots(design);
        const gap = Math.max(4, Math.round(dpi * 0.5));
        const { columns, rows } = layout;
        return {
            width: Math.round((columns * cell.widthDots + (columns - 1) * gap) * CELL_PX_PER_DOT),
            // Includes the record band above each row — the same total paintSheet
            // uses, or the canvas would be clipped by its holder.
            height: Math.round((rows * cell.heightDots + (rows - 1) * gap) * CELL_PX_PER_DOT) + rows * RECORD_BAND_PX,
        };
    }, [design, dpi, layout.columns, layout.rows]);

    return (
        <div className="flex flex-col h-full min-h-0">
            <div className="flex items-center gap-3 mb-2 text-xs text-gray-400 flex-shrink-0">
                <span title={sheetLayout(design).columns > 1 || sheetLayout(design).rows > 1
                    ? 'Rows × columns from the label settings (the stock itself is multi-up)'
                    : 'Records per preview sheet — the label stock is single-up, so the preview groups records onto a page'}>
                    {layout.rows} × {layout.columns} per sheet
                </span>
                <span>{sheets} sheet{sheets === 1 ? '' : 's'}</span>
                <span>{capped} of {recordCount} record{recordCount === 1 ? '' : 's'}</span>
                {shown > capped && <span className="text-amber-400">capped at {MAX_BATCH_EXPORT} for preview</span>}
                <span className="ml-auto flex items-center gap-1" title="A field hidden by a suppression rule for that record">
                    <span className="inline-block w-3 h-3 border border-dashed border-amber-400" /> suppressed
                </span>
            </div>
            <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto workspace-bg rounded-md p-4 bg-gray-900">
                <div className="flex flex-col items-center gap-6">
                    {Array.from({ length: sheets }, (_, sheetIndex) => (
                        <SheetCanvas
                            key={`${sheetIndex}-${revision}`}
                            design={design}
                            sheetIndex={sheetIndex}
                            firstRecord={first}
                            perSheet={perSheet}
                            layout={layout}
                            recordsOnSheet={Math.min(perSheet, capped - sheetIndex * perSheet)}
                            dpi={dpi}
                            style={cellStyle}
                            active={visible.has(sheetIndex)}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
};

const SheetCanvas: React.FC<{
    design: Design;
    sheetIndex: number;
    firstRecord: number;
    perSheet: number;
    layout: { columns: number; rows: number };
    recordsOnSheet: number;
    dpi: number;
    style: { width: number; height: number };
    active: boolean;
}> = ({ design, sheetIndex, firstRecord, perSheet, layout, recordsOnSheet, dpi, style, active }) => {
    const holderRef = useRef<HTMLDivElement>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!active || recordsOnSheet <= 0) {
            // Release the canvas when the sheet scrolls out of reach: its bitmap
            // is the memory this view has to protect.
            const holder = holderRef.current;
            if (holder) holder.replaceChildren();
            return;
        }
        let alive = true;
        const seq = ++sheetSeq.current;
        const first = firstRecord + sheetIndex * perSheet;
        paintSheet(design, first, recordsOnSheet, dpi, layout)
            .then(canvas => {
                if (!alive || seq !== sheetSeq.current) return;
                const holder = holderRef.current;
                if (!holder) return;
                setError(null);
                holder.replaceChildren(canvas);
            })
            .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
        return () => { alive = false; };
    }, [active, design, sheetIndex, firstRecord, perSheet, recordsOnSheet, dpi, layout.columns, layout.rows]);

    const lastRecord = firstRecord + sheetIndex * perSheet + recordsOnSheet - 1;
    return (
        <div data-sheet-index={sheetIndex} className="flex flex-col items-center">
            <div
                ref={holderRef}
                style={style}
                className="bg-gray-900 shadow-2xl rounded-sm"
                aria-label={`Sheet ${sheetIndex + 1}: records ${firstRecord + sheetIndex * perSheet}–${lastRecord}`}
            />
            <div className="text-[11px] text-gray-500 mt-1">
                Sheet {sheetIndex + 1} · records {firstRecord + sheetIndex * perSheet}–{lastRecord}
                {!active && ' · scroll to preview'}
                {error && <span className="text-red-400"> · {error}</span>}
            </div>
        </div>
    );
};

/** Guards against an older sheet's paint landing after a newer one. */
const sheetSeq = { current: 0 };
