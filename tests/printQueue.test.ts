// Fase 6: the print queue's promises.
//
// Two of them are the reason the queue exists rather than a "Send" button that
// loops: a job survives a reload, and a job that failed half way sends only
// the REMAINDER on retry. Both are asserted on the bytes that reach the
// printer, not on a status field — a `sentChunks` counter that advances
// without the stream changing would pass a status-only test and still waste a
// shift's worth of media.
//
// The bridge is stubbed. Nothing here touches fetch, a printer or IndexedDB.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    memoryQueueBackend, setPrintQueueBackend, createPrintJob, runPrintJob, listPrintJobs,
    listPrintLog, cancelPrintJob, recoverInterruptedJobs, ambiguousChunk, prunePrintJobs,
    jobChunks, jobSendabilityError, jobWarnings, renderJobChunk,
    MAX_FINISHED_JOBS, MAX_PENDING_JOBS, type PrintJob, type JobTarget, type PrintQueueBackend,
} from '../services/printQueue';
import { PRINT_CHUNK_LABELS, streamHash } from '../services/printJob';
import type { Design } from '../types';

const target = (over: Partial<JobTarget> = {}): JobTarget => ({
    id: 't1', name: 'Line 1', host: '10.0.0.5', port: '9100', language: 'ipl', dpi: 203, ...over,
});

/** A design whose table has `rowCount` rows, one field reading the SKU column. */
const tableDesign = (rowCount: number): Design => ({
    name: 'Job design',
    labelSettings: { width: 100, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields: [{
        id: 1, type: 'text', name: 'SKU', x: 5, y: 5, rotation: 0,
        dataSource: { type: 'linked', sourceId: 's1' },
        font: '25', fontSize: 12, h_mag: 1, w_mag: 1,
    }],
    dataSources: [{
        id: 's1', name: 'Table 1', type: 'table',
        columns: ['SKU'],
        rows: Array.from({ length: rowCount }, (_, i) => ({ SKU: `R${i + 1}` })),
        query: { filters: [], combine: 'and' },
    }],
    nextId: 2,
    guides: { horizontal: [], vertical: [] },
} as Design);

/** A design with no table: one label, copies live inside the stream. */
const singleDesign = (): Design => {
    const design = tableDesign(0);
    return {
        ...design,
        dataSources: [{ id: 'v1', name: 'Var', type: 'variable', sampleData: 'SAMPLE' }],
        fields: [{ ...design.fields[0], dataSource: { type: 'linked', sourceId: 'v1' } }],
    } as Design;
};

let queue: PrintQueueBackend;

beforeEach(() => {
    queue = memoryQueueBackend();
    setPrintQueueBackend(queue);
});

/** A renderer that names its chunk, so the BYTES identify which chunk went. */
const namedRender = async (job: PrintJob, chunkIndex: number): Promise<string> =>
    `<STX>CHUNK${chunkIndex}:${job.id}<ETX>`;

describe('createPrintJob', () => {
    it('clamps the record range to the rows that exist and counts the labels', async () => {
        const job = await createPrintJob(tableDesign(10), {
            recordFrom: 3, recordTo: 99, copies: 2, collation: 'collated', target: target(), now: 1000,
        });
        expect(job.recordFrom).toBe(3);
        expect(job.recordTo).toBe(10);
        expect(job.labels).toBe(16); // 8 records × 2 copies
        expect(job.status).toBe('queued');
    });

    it('stores a deep copy, so editing the canvas design does not rewrite the job', async () => {
        const design = tableDesign(3);
        const job = await createPrintJob(design, { recordFrom: 1, recordTo: 3, copies: 1, collation: 'collated', target: target() });
        design.labelSettings.width = 999;
        design.fields[0].name = 'RENAMED';
        const stored = (await listPrintJobs())[0];
        expect(stored.design.labelSettings.width).toBe(100);
        expect(stored.design.fields[0].name).toBe('SKU');
        expect(job.design.labelSettings.width).toBe(100);
    });

    it('refuses a record range to a ZPL target instead of printing one record', async () => {
        await expect(createPrintJob(tableDesign(10), {
            recordFrom: 1, recordTo: 10, copies: 1, collation: 'collated', target: target({ language: 'zpl' }),
        })).rejects.toThrow(/ZPL/i);
    });

    it('allows a single-record design on a ZPL target', async () => {
        const job = await createPrintJob(singleDesign(), {
            recordFrom: 1, recordTo: 1, copies: 3, collation: 'collated', target: target({ language: 'zpl' }),
        });
        expect(job.labels).toBe(3);
        expect(job.chunkCount).toBe(1);
    });
});

describe('jobChunks', () => {
    it('derives every chunk from the job snapshot, so a resume rebuilds the same ones', async () => {
        const design = tableDesign(250);
        const job = await createPrintJob(design, { recordFrom: 1, recordTo: 250, copies: 1, collation: 'collated', target: target() });
        const chunks = jobChunks(job);
        expect(chunks.map(c => c.labels)).toEqual([100, 100, 50]);
        expect(chunks[1].records[0]).toBe(101);
    });

    it('a single-record design is exactly one chunk even at many copies', async () => {
        const job = await createPrintJob(singleDesign(), { recordFrom: 1, recordTo: 1, copies: 50, collation: 'collated', target: target() });
        expect(jobChunks(job)).toHaveLength(1);
        expect(jobChunks(job)[0].labels).toBe(50);
    });

    it('duplicates rows for copies rather than relying on the printer', async () => {
        const job = await createPrintJob(tableDesign(3), { recordFrom: 1, recordTo: 3, copies: 3, collation: 'uncollated', target: target() });
        const [chunk] = jobChunks(job);
        expect(chunk.batch!.rows.map(r => r[0])).toEqual(['R1', 'R1', 'R1', 'R2', 'R2', 'R2', 'R3', 'R3', 'R3']);
    });
});

describe('runPrintJob', () => {
    it('sends every chunk, logs each attempt, and ends sent', async () => {
        const job = await createPrintJob(tableDesign(250), { recordFrom: 1, recordTo: 250, copies: 1, collation: 'collated', target: target(), now: 1 });
        const sent: string[] = [];
        const done = await runPrintJob(job, {
            render: namedRender,
            send: async (stream) => { sent.push(stream); return { ok: true, written: stream.length }; },
            now: () => 2,
        });
        expect(done.status).toBe('sent');
        expect(done.sentChunks).toBe(3);
        expect(sent).toEqual([
            `<STX>CHUNK0:${job.id}<ETX>`,
            `<STX>CHUNK1:${job.id}<ETX>`,
            `<STX>CHUNK2:${job.id}<ETX>`,
        ]);
        const log = await listPrintLog();
        expect(log).toHaveLength(3);
        expect(log.every(e => e.ok)).toBe(true);
        expect(log.map(e => e.labels).sort((a, b) => a - b)).toEqual([50, 100, 100]);
    });

    it('THE RESUME CONTRACT: a failure mid-job leaves the rest unsent, and the retry sends ONLY the rest', async () => {
        const job = await createPrintJob(tableDesign(250), { recordFrom: 1, recordTo: 250, copies: 1, collation: 'collated', target: target(), now: 1 });

        const firstRun: string[] = [];
        const failed = await runPrintJob(job, {
            render: namedRender,
            send: async (stream) => {
                firstRun.push(stream);
                // Chunk 0 goes out; chunk 1 fails (the printer is out of paper).
                return stream.includes('CHUNK0') ? { ok: true, written: 10 } : { ok: false, error: 'Bridge timed out.' };
            },
            now: () => 2,
        });

        expect(failed.status).toBe('failed');
        expect(failed.sentChunks).toBe(1);
        expect(failed.lastError).toBe('Bridge timed out.');
        // It stopped; it did not go on to chunk 2.
        expect(firstRun).toEqual([`<STX>CHUNK0:${job.id}<ETX>`, `<STX>CHUNK1:${job.id}<ETX>`]);

        // A fresh reload finds the job as the backend holds it.
        const reloaded = (await listPrintJobs())[0];
        expect(reloaded.sentChunks).toBe(1);

        const retrySent: string[] = [];
        const done = await runPrintJob(reloaded, {
            render: namedRender,
            send: async (stream) => { retrySent.push(stream); return { ok: true, written: 10 }; },
            now: () => 3,
        });

        expect(done.status).toBe('sent');
        // THE ASSERTION THIS FILE EXISTS FOR: two chunks, and neither is chunk 0.
        expect(retrySent).toEqual([`<STX>CHUNK1:${job.id}<ETX>`, `<STX>CHUNK2:${job.id}<ETX>`]);
        expect(retrySent.some(s => s.includes('CHUNK0'))).toBe(false);
        expect(done.sentChunks).toBe(3);
    });

    it('logs the bytes and hash of WHAT WAS POSTED, so a printed label is traceable', async () => {
        const job = await createPrintJob(tableDesign(1), { recordFrom: 1, recordTo: 1, copies: 1, collation: 'collated', target: target(), now: 1 });
        let posted = '';
        await runPrintJob(job, {
            render: async () => '<STX>SPECIFIC§<ETX>',
            send: async (stream) => { posted = stream; return { ok: true, written: stream.length }; },
            now: () => 2,
        });
        const [entry] = await listPrintLog();
        expect(entry.ok).toBe(true);
        // § is 2 UTF-8 bytes; a character count would under-report the socket.
        expect(entry.bytes).toBe(posted.length + 1);
        expect(entry.streamHash).toBe(streamHash(posted));
    });

    it('a generation failure fails the job without sending anything', async () => {
        const job = await createPrintJob(tableDesign(250), { recordFrom: 1, recordTo: 250, copies: 1, collation: 'collated', target: target(), now: 1 });
        const send = vi.fn();
        const failed = await runPrintJob(job, {
            render: async () => { throw new Error('bwip exploded'); },
            send,
            now: () => 2,
        });
        expect(failed.status).toBe('failed');
        expect(failed.lastError).toMatch(/bwip exploded/);
        expect(failed.sentChunks).toBe(0);
        expect(send).not.toHaveBeenCalled();
    });

    it('REFUSES to start a job another run owns — two tabs must not print the job twice', async () => {
        const job = await createPrintJob(tableDesign(250), { recordFrom: 1, recordTo: 250, copies: 1, collation: 'collated', target: target(), now: 1 });
        // Another tab got there first and is mid-send.
        await queue.putJob({ ...job, status: 'sending', runId: 'other-tab', sentChunks: 1 });

        const send = vi.fn();
        const result = await runPrintJob(
            // The stale copy this tab is holding: sentChunks 0.
            job,
            { render: namedRender, send, now: () => 2 },
        );
        expect(result.status).toBe('sending');
        expect(send).not.toHaveBeenCalled();
    });

    it('starts from the STORED progress, not the caller\'s stale copy', async () => {
        const job = await createPrintJob(tableDesign(250), { recordFrom: 1, recordTo: 250, copies: 1, collation: 'collated', target: target(), now: 1 });
        // Chunks 0 and 1 already went out in an earlier session; this tab still
        // holds the job as it was created.
        await queue.putJob({ ...job, status: 'failed', sentChunks: 2 });

        const sent: string[] = [];
        await runPrintJob(job, {
            render: namedRender,
            send: async (stream) => { sent.push(stream); return { ok: true, written: 1 }; },
            now: () => 2,
        });
        expect(sent).toEqual([`<STX>CHUNK2:${job.id}<ETX>`]);
    });

    it('stops after the current chunk when the job was cancelled mid-run', async () => {
        const job = await createPrintJob(tableDesign(250), { recordFrom: 1, recordTo: 250, copies: 1, collation: 'collated', target: target(), now: 1 });
        const sent: string[] = [];
        const done = await runPrintJob(job, {
            render: namedRender,
            send: async (stream) => {
                sent.push(stream);
                // The user hits Cancel while chunk 0 is on the wire.
                if (stream.includes('CHUNK0')) await cancelPrintJob(job.id);
                return { ok: true, written: 1 };
            },
            now: () => 2,
        });
        expect(sent).toEqual([`<STX>CHUNK0:${job.id}<ETX>`]);
        expect(done.status).not.toBe('sent'); // it must NOT claim the job finished
    });
});

describe('recoverInterruptedJobs', () => {
    it('a job left "sending" by a closed tab becomes retryable', async () => {
        const job = await createPrintJob(tableDesign(10), { recordFrom: 1, recordTo: 10, copies: 1, collation: 'collated', target: target(), now: 1 });
        await queue.putJob({ ...job, status: 'sending', runId: 'gone', sentChunks: 0 });
        expect(await recoverInterruptedJobs()).toBe(1);
        const [recovered] = await listPrintJobs();
        expect(recovered.status).toBe('failed');
        expect(recovered.runId).toBeUndefined();
        expect(recovered.lastError).toMatch(/closed/i);
    });
});

describe('ambiguousChunk', () => {
    it('names the chunk whose send failed, so the retry warning can quote it', async () => {
        const job = await createPrintJob(tableDesign(250), { recordFrom: 1, recordTo: 250, copies: 1, collation: 'collated', target: target(), now: 1 });
        await runPrintJob(job, {
            render: namedRender,
            send: async (stream) => stream.includes('CHUNK1') ? { ok: false, error: 'timed out' } : { ok: true, written: 1 },
            now: () => 2,
        });
        expect(await ambiguousChunk(job.id)).toEqual({ chunkIndex: 1, labels: 100 });
    });

    it('null when nothing failed', async () => {
        const job = await createPrintJob(tableDesign(1), { recordFrom: 1, recordTo: 1, copies: 1, collation: 'collated', target: target(), now: 1 });
        expect(await ambiguousChunk(job.id)).toBeNull();
    });
});

describe('prunePrintJobs', () => {
    it('drops the OLDEST finished jobs, keeping the newest', async () => {
        const design = tableDesign(1);
        for (let i = 0; i < MAX_FINISHED_JOBS + 3; i++) {
            const job = await createPrintJob(design, { recordFrom: 1, recordTo: 1, copies: 1, collation: 'collated', target: target(), now: i + 1, id: `sent${i}` });
            await queue.putJob({ ...job, status: 'sent' });
        }
        expect(await prunePrintJobs()).toBe(3);
        const remaining = await listPrintJobs();
        expect(remaining).toHaveLength(MAX_FINISHED_JOBS);
        expect(remaining.map(j => j.id)).not.toContain('sent0');
        expect(remaining.map(j => j.id)).not.toContain('sent1');
        expect(remaining.map(j => j.id)).toContain('sent26');
    });

    it('bounds PENDING jobs too — a queue nothing ever sends is still storage', async () => {
        // The leak this guards: pruning ran only on a completed run, so jobs
        // that were queued and abandoned (or that failed and were never
        // retried) accumulated one design snapshot each, forever.
        const design = tableDesign(1);
        for (let i = 0; i < MAX_PENDING_JOBS + 4; i++) {
            await createPrintJob(design, { recordFrom: 1, recordTo: 1, copies: 1, collation: 'collated', target: target(), now: i + 1, id: `q${i}` });
        }
        expect(await prunePrintJobs()).toBe(4);
        const remaining = await listPrintJobs();
        expect(remaining).toHaveLength(MAX_PENDING_JOBS);
        expect(remaining.map(j => j.id)).not.toContain('q0');
        expect(remaining.map(j => j.id)).toContain(`q${MAX_PENDING_JOBS + 3}`);
    });

    it('never touches a job that is sending, whatever its age', async () => {
        const design = tableDesign(1);
        const active = await createPrintJob(design, { recordFrom: 1, recordTo: 1, copies: 1, collation: 'collated', target: target(), now: 0, id: 'live' });
        await queue.putJob({ ...active, status: 'sending', runId: 'r1' });
        for (let i = 0; i < MAX_PENDING_JOBS + 5; i++) {
            await createPrintJob(design, { recordFrom: 1, recordTo: 1, copies: 1, collation: 'collated', target: target(), now: i + 1, id: `q${i}` });
        }
        await prunePrintJobs();
        expect((await listPrintJobs()).some(j => j.id === 'live')).toBe(true);
    });

    it('a failed run still sweeps the queue', async () => {
        const design = tableDesign(250);
        for (let i = 0; i < MAX_PENDING_JOBS + 2; i++) {
            await createPrintJob(design, { recordFrom: 1, recordTo: 250, copies: 1, collation: 'collated', target: target(), now: i + 1, id: `old${i}` });
        }
        const running = await createPrintJob(design, { recordFrom: 1, recordTo: 250, copies: 1, collation: 'collated', target: target(), now: 999, id: 'runner' });
        await runPrintJob(running, {
            render: namedRender,
            send: async () => ({ ok: false, error: 'paper out' }),
            now: () => 1000,
        });
        // The failure path is exactly when jobs pile up, so the sweep has to
        // happen there and not only on success.
        expect((await listPrintJobs()).length).toBeLessThanOrEqual(MAX_PENDING_JOBS + 1);
    });
});

describe('sendability and warnings', () => {
    it('refuses a record range on ZPL, allows it on IPL', () => {
        expect(jobSendabilityError(tableDesign(10), { language: 'zpl' })).toMatch(/ZPL/i);
        expect(jobSendabilityError(tableDesign(10), { language: 'ipl' })).toBeNull();
        expect(jobSendabilityError(singleDesign(), { language: 'zpl' })).toBeNull();
    });

    it('says nothing when the target agrees with the design', () => {
        expect(jobWarnings(tableDesign(3), { language: 'ipl', dpi: 203 })).toEqual([]);
    });

    it('names each disagreement, so a surprise at the printer was announced', () => {
        const warnings = jobWarnings(singleDesign(), { language: 'zpl', dpi: 300 });
        expect(warnings).toHaveLength(2);
        expect(warnings.some(w => /dpi/i.test(w))).toBe(true);
        expect(warnings.some(w => /IPL/.test(w) && /ZPL/.test(w))).toBe(true);
    });
});

describe('renderJobChunk', () => {
    it('applies the job\'s copies to the snapshot copy, never to the stored design', async () => {
        const design = singleDesign();
        const job = await createPrintJob(design, { recordFrom: 1, recordTo: 1, copies: 7, collation: 'collated', target: target() });
        const stream = await renderJobChunk(job, 0);
        expect(stream).toContain('<RS>7');
        // The job record itself is untouched: quantity is a job option.
        const stored = (await listPrintJobs())[0];
        expect(stored.design.printerSettings.quantity).toBe(1);
    });

    it('generates a ZPL stream for a ZPL target', async () => {
        const job = await createPrintJob(singleDesign(), { recordFrom: 1, recordTo: 1, copies: 2, collation: 'collated', target: target({ language: 'zpl' }) });
        const stream = await renderJobChunk(job, 0);
        expect(stream.startsWith('^XA')).toBe(true);
        expect(stream).toContain('^PQ2');
    });

    it('a record-backed IPL chunk carries one print block per row', async () => {
        const job = await createPrintJob(tableDesign(4), { recordFrom: 1, recordTo: 4, copies: 1, collation: 'collated', target: target() });
        const stream = await renderJobChunk(job, 0);
        expect(stream.match(/<ETB><FF>/g)).toHaveLength(4);
    });
});
