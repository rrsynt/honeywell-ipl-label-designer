// Fase 6: the print ORDER, which is the whole point of a job.
//
// "3 copies × records 10–50, collated" is a claim about what comes out of the
// printer, and it is decidable here, without a printer: printSequence is pure.
// These tests pin it literally, because a collation bug is invisible until the
// media is sorted at the end of the line.

import { describe, it, expect } from 'vitest';
import {
    printSequence, sequenceLabelCount, buildJobChunks, batchRowsForRecords, splitBatch,
    streamHash, utf8Bytes, pendingChunkCount, PRINT_CHUNK_LABELS,
} from '../services/printJob';
import type { JobPlan } from '../services/csvJob';

const plan = (rows: string[][]): JobPlan => ({
    batch: { headers: ['SKU'], mappings: { 1: 0 }, rows } as never,
    mapped: 1,
    total: 1,
    truncated: false,
});

const rows = (n: number): string[][] => Array.from({ length: n }, (_, i) => [`R${i + 1}`]);

describe('printSequence', () => {
    it('collated repeats the whole set per copy', () => {
        expect(printSequence({ from: 1, to: 3 }, 3, 'collated', 10)).toEqual([1, 2, 3, 1, 2, 3, 1, 2, 3]);
    });

    it('uncollated keeps a record\'s copies together', () => {
        expect(printSequence({ from: 1, to: 3 }, 3, 'uncollated', 10)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3]);
    });

    it('both orders print the same NUMBER of labels', () => {
        const range = { from: 10, to: 50 };
        expect(sequenceLabelCount(range, 3, 'collated', 100))
            .toBe(sequenceLabelCount(range, 3, 'uncollated', 100));
        expect(sequenceLabelCount(range, 3, 'collated', 100)).toBe(123);
    });

    it('a single copy is the range itself, whichever order was asked for', () => {
        expect(printSequence({ from: 2, to: 5 }, 1, 'collated', 10)).toEqual([2, 3, 4, 5]);
        expect(printSequence({ from: 2, to: 5 }, 1, 'uncollated', 10)).toEqual([2, 3, 4, 5]);
    });

    it('clamps the range to the records that exist', () => {
        expect(printSequence({ from: 8, to: 99 }, 1, 'collated', 10)).toEqual([8, 9, 10]);
    });

    it('a half-typed range does not produce an empty job', () => {
        // from > to: the user is mid-typing. Swapping is what they meant.
        expect(printSequence({ from: 5, to: 3 }, 1, 'collated', 10)).toEqual([3, 4, 5]);
        // from 0 / negative: clamp UP to the first record, never to a phantom.
        expect(printSequence({ from: 0, to: 2 }, 1, 'collated', 10)).toEqual([1, 2]);
        expect(printSequence({ from: -5, to: 2 }, 1, 'collated', 10)).toEqual([1, 2]);
    });

    it('treats a nonsense copy count as one copy', () => {
        expect(printSequence({ from: 1, to: 2 }, 0, 'collated', 10)).toEqual([1, 2]);
        expect(printSequence({ from: 1, to: 2 }, -3, 'collated', 10)).toEqual([1, 2]);
        expect(printSequence({ from: 1, to: 2 }, 2.7, 'collated', 10)).toEqual([1, 2, 1, 2]);
    });

    it('an empty design prints nothing', () => {
        expect(printSequence({ from: 1, to: 10 }, 3, 'collated', 0)).toEqual([]);
    });
});

describe('buildJobChunks', () => {
    it('binds the rows the sequence names, in that order', () => {
        const chunks = buildJobChunks(plan(rows(5)), [3, 1, 3]);
        expect(chunks).toHaveLength(1);
        expect(chunks[0].batch.rows).toEqual([['R3'], ['R1'], ['R3']]);
        expect(chunks[0].records).toEqual([3, 1, 3]);
    });

    it('splits at the chunk size and keeps each chunk\'s records aligned to its rows', () => {
        const sequence = printSequence({ from: 1, to: 250 }, 1, 'collated', 250);
        const chunks = buildJobChunks(plan(rows(250)), sequence, 100);
        expect(chunks.map(c => c.batch.rows.length)).toEqual([100, 100, 50]);
        expect(chunks.map(c => c.index)).toEqual([0, 1, 2]);
        // The records a chunk claims to print are the rows it actually carries.
        expect(chunks[1].records[0]).toBe(101);
        expect(chunks[1].batch.rows[0]).toEqual(['R101']);
        expect(chunks[2].records).toEqual(sequence.slice(200));
    });

    it('every chunk shares the headers and mappings of the plan', () => {
        const chunks = buildJobChunks(plan(rows(3)), [1, 2, 3], 2);
        for (const chunk of chunks) {
            expect(chunk.batch.headers).toEqual(['SKU']);
            expect(chunk.batch.mappings).toEqual({ 1: 0 });
        }
    });

    it('a record the plan no longer has is dropped from rows AND from the description', () => {
        // The design was edited after the job was built. Recording a record
        // that will not print would make the job's own report a lie.
        const chunks = buildJobChunks(plan(rows(2)), [1, 2, 9]);
        expect(chunks[0].batch.rows).toEqual([['R1'], ['R2']]);
        expect(chunks[0].records).toEqual([1, 2]);
    });

    it('collated copies land in separate chunks only at the boundary, never split mid-set', () => {
        // Not a rule the code enforces — this pins the CONSEQUENCE of chunk
        // size, so a change to PRINT_CHUNK_LABELS is a visible decision.
        const sequence = printSequence({ from: 1, to: 3 }, 2, 'collated', 3);
        const chunks = buildJobChunks(plan(rows(3)), sequence, 4);
        expect(chunks.map(c => c.records)).toEqual([[1, 2, 3, 1], [2, 3]]);
    });

    it('no chunk exceeds the limit', () => {
        const sequence = printSequence({ from: 1, to: 1000 }, 1, 'collated', 1000);
        for (const chunk of buildJobChunks(plan(rows(1000)), sequence)) {
            expect(chunk.batch.rows.length).toBeLessThanOrEqual(PRINT_CHUNK_LABELS);
        }
    });
});

describe('splitBatch', () => {
    it('slices rows and shares everything else', () => {
        const batch = { headers: ['A'], mappings: { 1: 0 }, rows: rows(5) };
        const parts = splitBatch(batch, 2);
        expect(parts.map(p => p.rows.length)).toEqual([2, 2, 1]);
        expect(parts[2].rows).toEqual([['R5']]);
        expect(parts[0].headers).toBe(batch.headers);
    });
});

describe('batchRowsForRecords', () => {
    it('copies rows by 1-based record index', () => {
        expect(batchRowsForRecords(plan(rows(3)), [2, 2, 1])).toEqual([['R2'], ['R2'], ['R1']]);
    });
});

describe('streamHash and byte count', () => {
    it('hashes the exact bytes posted, stably', () => {
        expect(streamHash('<STX>R<ETX>')).toBe(streamHash('<STX>R<ETX>'));
        expect(streamHash('<STX>R<ETX>')).not.toBe(streamHash('<STX>R<ETX> '));
    });

    it('counts UTF-8 bytes, not characters', () => {
        expect(utf8Bytes('abc')).toBe(3);
        // A label may hold a non-ASCII character (code page text, § in a
        // German charset); its length in characters would under-report what
        // actually went to the socket.
        expect(utf8Bytes('§')).toBe(2);
        expect(utf8Bytes('é')).toBe(2);
    });
});

describe('pendingChunkCount', () => {
    it('is what is left to send, clamped', () => {
        expect(pendingChunkCount(5, 0)).toBe(5);
        expect(pendingChunkCount(5, 2)).toBe(3);
        expect(pendingChunkCount(5, 9)).toBe(0);
        expect(pendingChunkCount(5, -1)).toBe(5);
    });
});
