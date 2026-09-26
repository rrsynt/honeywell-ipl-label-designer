// Fase 6: turning "records 10–50, 3 copies, collated" into print blocks.
//
// Pure arithmetic on purpose. The order labels print in is the thing a print
// job is judged on, and it must be assertable without a printer, a bridge or
// a canvas: printSequence() below is the whole answer, and the tests pin it.
//
// Two physical facts shape the design:
//
//  - One POST = one print block sequence. The bridge (tools/ipl-bridge.mjs)
//    reports `written` only after the socket flushed, so a chunk that reports
//    a timeout may still have put ink on the media. That is why a job is
//    SPLIT: the granularity of "did this already print?" is the chunk, and
//    PRINT_CHUNK_LABELS bounds how much can be duplicated by a retry.
//
//  - Copies are rows. The batch path of the generator emits one print block
//    per row and never writes `<FS>`/`<ESC>I` (services/iplGenerator.ts:663),
//    so the printer cannot be asked to repeat a row. Duplicating the row IS
//    the mechanism. A design with a serial counter source prints the same
//    number on each copy — correct for a batch job, and the UI says so.

import type { BatchData } from './iplGenerator';
import type { JobPlan } from './csvJob';
import { fnv1aHex } from './libraryStore';

/**
 * Labels per bridge POST.
 *
 * Two costs pull in opposite directions. Smaller chunks shrink the blast
 * radius of a chunk that printed but reported a failure (the bridge reports
 * `written` only after a flush, but services/bridgeSend.ts aborts its fetch on
 * a 15 s timeout while the bridge may already be forwarding). Larger chunks
 * waste less on the fixed part of a stream: every chunk re-emits the whole
 * format definition, including the downloaded graphics and Direct Graphics
 * hex, so a bitmap-heavy design posts its images once per chunk. 100 labels
 * keeps that overhead around 1% for a typical label while capping a duplicate
 * at 100 labels of media.
 */
export const PRINT_CHUNK_LABELS = 100;

export type Collation = 'collated' | 'uncollated';

export interface RecordRange {
    /** 1-based, inclusive. */
    from: number;
    to: number;
}

/**
 * The record index for every label the job prints, in print order.
 *
 *   collated   1,2,3,…,N, 1,2,3,…,N   (one full set per copy)
 *   uncollated 1,1,1, 2,2,2, …, N,N,N (copies of a record stay together)
 *
 * Bounds are clamped into [1, recordCount] and an inverted range is swapped,
 * because a half-typed "from" box must not produce a job of nothing — the same
 * tolerance services/tableSource.ts applyQuery() gives its record range.
 * `copies` below 1 is treated as 1.
 */
export const printSequence = (range: RecordRange, copies: number, collation: Collation, recordCount: number): number[] => {
    if (recordCount < 1) return [];
    const lo = Math.max(1, Math.min(range.from, range.to));
    const hi = Math.min(recordCount, Math.max(range.from, range.to));
    if (lo > hi) return [];
    const count = Math.max(1, Math.floor(copies) || 1);
    const sequence: number[] = [];
    if (collation === 'uncollated') {
        for (let record = lo; record <= hi; record++) {
            for (let c = 0; c < count; c++) sequence.push(record);
        }
        return sequence;
    }
    for (let c = 0; c < count; c++) {
        for (let record = lo; record <= hi; record++) sequence.push(record);
    }
    return sequence;
};

/** Total labels a job prints. */
export const sequenceLabelCount = (range: RecordRange, copies: number, collation: Collation, recordCount: number): number =>
    printSequence(range, copies, collation, recordCount).length;

export interface JobChunk {
    /** 0-based index in the job; storage persists how many of these are done. */
    index: number;
    /** Record indices, in print order, that this chunk prints. */
    records: number[];
    batch: BatchData;
}

/**
 * Split a built BatchData by row index. The batch's rows are already in print
 * order (the caller reordered them via printSequence → batchRowsForRecords), so
 * a chunk is a contiguous slice — and the headers/mappings are shared, since
 * every chunk defines the same fields.
 */
export const splitBatch = (batch: BatchData, chunkLabels = PRINT_CHUNK_LABELS): BatchData[] => {
    const size = Math.max(1, Math.floor(chunkLabels));
    const chunks: BatchData[] = [];
    for (let start = 0; start < batch.rows.length; start += size) {
        chunks.push({ headers: batch.headers, mappings: batch.mappings, rows: batch.rows.slice(start, start + size) });
    }
    return chunks;
};

/**
 * Build the job's BatchData for a table-backed design: the plan's rows, picked
 * and repeated in print order.
 *
 * Every mapped column that a field reads follows the row automatically, since
 * a row IS the cell array — copying the array copies the data. A record index
 * outside the plan's rows is skipped rather than clamped: printSequence already
 * clamped to recordCount, so an out-of-range index here means the plan changed
 * under the job (the design was edited), and printing a neighbour's data would
 * be worse than printing fewer labels.
 */
export const batchRowsForRecords = (plan: JobPlan, records: number[]): string[][] =>
    records
        .map(record => plan.batch.rows[record - 1])
        .filter((row): row is string[] => row !== undefined);

/**
 * The chunk list for a table-backed job. Each chunk carries the records it
 * prints so a failed chunk can be retried, described, and logged by RECORD,
 * not just by count.
 */
export const buildJobChunks = (plan: JobPlan, records: number[], chunkLabels = PRINT_CHUNK_LABELS): JobChunk[] => {
    const size = Math.max(1, Math.floor(chunkLabels));
    const chunks: JobChunk[] = [];
    for (let start = 0; start < records.length; start += size) {
        const slice = records.slice(start, start + size);
        const rows = batchRowsForRecords(plan, slice);
        chunks.push({
            index: chunks.length,
            // A row the plan no longer has is dropped from the batch; drop it
            // from the description too, so chunk.records always describes what
            // the batch actually prints.
            records: slice.slice(0, rows.length),
            batch: { headers: plan.batch.headers, mappings: plan.batch.mappings, rows },
        });
    }
    return chunks;
};

/**
 * FNV-1a over the exact bytes posted to the bridge. The log records this so a
 * printed label can be tied back to the stream that produced it without
 * storing the stream itself (a 5000-row job is megabytes).
 */
export const streamHash = (stream: string): string => fnv1aHex(stream);

/** UTF-8 byte length — what the bridge actually writes to the socket. */
export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** Rough label count for a progress display before generating anything. */
export const pendingChunkCount = (chunkCount: number, sentChunks: number): number =>
    Math.max(0, chunkCount - Math.max(0, Math.min(sentChunks, chunkCount)));
