// Batch I (2026-09-21): preview ONE CSV job row through the real pipeline —
// the row's .ipl (generateIPL with a single-row BatchData) parsed by
// parseViewerIPL and painted by the viewer's renderLabel. What the stepper
// shows is exactly what the printer receives for that label, defaults and
// all — the preview is the pipeline itself, not a re-implementation.
import React, { useState, useEffect, useRef } from 'react';
import type { Design } from '../types';
import type { JobPlan } from '../services/csvJob';
import { rowBatchData } from '../services/csvJob';
import { generateIPL } from '../services/iplGenerator';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { renderLabel } from '../services/ipl/renderer';
import { stockExtentDots } from '../services/printRecords';
import { ensureBarcodesReady } from '../services/ipl/barcodes';

export const CsvRowPreview: React.FC<{ design: Design; plan: JobPlan }> = ({ design, plan }) => {
    const [rowIdx, setRowIdx] = useState(0);
    const [bwipReady, setBwipReady] = useState(false);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const seqRef = useRef(0);
    const rowCount = plan.batch.rows.length;
    const row = Math.max(0, Math.min(rowIdx, rowCount - 1));

    // Review HIGH: when the dataset SHRINKS under a high rowIdx, the render
    // clamps but the state doesn't — stepping ◀ then decrements a phantom
    // index and the UI appears frozen for dozens of clicks. Sync the state
    // to the clamped row whenever the plan gets shorter.
    useEffect(() => {
        if (rowIdx >= rowCount) setRowIdx(Math.max(0, rowCount - 1));
    }, [rowIdx, rowCount]);

    useEffect(() => {
        let alive = true;
        ensureBarcodesReady().then(() => { if (alive) setBwipReady(true); });
        return () => { alive = false; };
    }, []);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const seq = ++seqRef.current;
        const dpi = design.printerSettings.dpi;
        generateIPL(design, rowBatchData(plan, row)).then(ipl => {
            if (seq !== seqRef.current) return; // a newer row won
            const label = parseViewerIPL(ipl);
            // The stock, not the content bounds: the printer clips at the label
            // edge, so a field hanging past it must not enlarge the preview.
            const extent = stockExtentDots(design);
            const pxPerDot = Math.min(2, Math.max(0.15, 240 / Math.max(1, extent.widthDots)));
            renderLabel(canvas, label, extent, { dpi, pxPerDot, quality: 2, rotation: 0 });
        }).catch(() => {
            // Review MEDIUM: never leave a stale label on the canvas while
            // the stepper and caption already show the new row — clear it.
            if (seq !== seqRef.current) return;
            const ctx = canvas.getContext('2d');
            if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        });
        // Review MEDIUM: unmount invalidates in-flight renders so their
        // .then never paints into a detached canvas.
        return () => { seqRef.current++; };
    }, [design, plan, row, bwipReady]);

    // Review LOW: drive the caption from headers so ragged rows show
    // 'header=' for missing cells instead of dropping them (and never
    // 'undefined=value' for extra cells).
    const rowLabel = plan.batch.headers
        .map((h, i) => `${h}=${plan.batch.rows[row]?.[i] ?? ''}`)
        .join('  ');

    return (
        <div className="mt-2 rounded-md border border-gray-700 bg-gray-900/60 p-2">
            <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-semibold text-gray-400 uppercase">Row Preview</span>
                <div className="flex items-center gap-1">
                    <button onClick={() => setRowIdx(r => Math.max(0, r - 1))} disabled={row === 0}
                        className="material-icons text-sm px-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-30" aria-label="Previous row">chevron_left</button>
                    <span className="text-[11px] text-gray-300 tabular-nums">{row + 1}/{rowCount}</span>
                    <button onClick={() => setRowIdx(r => Math.min(rowCount - 1, r + 1))} disabled={row >= rowCount - 1}
                        className="material-icons text-sm px-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-30" aria-label="Next row">chevron_right</button>
                </div>
            </div>
            <div className="flex justify-center overflow-hidden rounded bg-white py-1">
                <canvas ref={canvasRef} aria-label={`Preview of job row ${row + 1}`} />
            </div>
            <p className="mt-1 text-[10px] text-gray-500 font-mono truncate" title={rowLabel}>{rowLabel}</p>
        </div>
    );
};
