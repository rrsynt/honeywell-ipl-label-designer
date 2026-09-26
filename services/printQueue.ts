// Fase 6: the print queue and its log.
//
// A job is a frozen intent: which design, which records, how many copies, in
// what order, to which printer. The design is stored as a full SNAPSHOT (not a
// name reference) because a job must be sendable again exactly as it was
// meant, even after the canvas design moved on — and the library already keeps
// whole designs with their bitmaps, so this is the same weight of record.
//
// Persistence is the point. A job that is half sent and then loses the tab
// must come back knowing which chunks already went out; otherwise the only
// safe advice is "print it all again", which wastes media. Progress is written
// after EVERY chunk, so the worst a crash can cost is the chunk in flight.
//
// The failure mode this file refuses to hide: a bridge timeout does NOT mean
// the printer got nothing. tools/ipl-bridge.mjs reports `written` only after
// the socket flushed, so a chunk that reports failure may already be on the
// media. Retrying is still the right default — but the UI must say that up to
// one chunk can print twice, and nothing here claims otherwise.

import type { Design, PrinterLanguage } from '../types';
import type { BatchData } from './iplGenerator';
import { generateIPL } from './iplGenerator';
import { generateZPL } from './zpl/zplGenerator';
import { generateEPL } from './epl/eplGenerator';
import { sendIplViaBridge, type BridgeResult } from './bridgeSend';
import { getPrintServerUrl, sendChunkViaPrintServer } from './printRemoteBackend';
import { requestToPromise, storeOf } from './designerDb';
import { designChecksum } from './libraryStore';
import { designJobPlan, designRecordCount, designHasRecords } from './printRecords';
import { buildJobChunks, printSequence, streamHash, utf8Bytes, PRINT_CHUNK_LABELS, type Collation, type JobChunk } from './printJob';

export type PrintJobStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';

/** The printer a job was created against, copied so a later edit cannot move it. */
export interface JobTarget {
    id: string;
    name: string;
    host: string;
    port: string;
    language: PrinterLanguage;
    dpi: 203 | 300 | 406;
}

export interface PrintJob {
    id: string;
    createdAt: number;
    updatedAt: number;
    designName: string;
    /** Hash of the design AT CREATION, so the UI can say "the design changed". */
    designChecksum: string;
    /** The design as it was when the job was made. */
    design: Design;
    /** 1-based inclusive record range. Ignored for a single-record design. */
    recordFrom: number;
    recordTo: number;
    copies: number;
    collation: Collation;
    target: JobTarget;
    /** Labels this job prints in total (sequence length, or copies). */
    labels: number;
    /** Chunks at creation. runJob derives the real list from the snapshot. */
    chunkCount: number;
    /** Chunks that have been reported sent. Resume starts here. */
    sentChunks: number;
    status: PrintJobStatus;
    lastError?: string;
    /**
     * Who is currently running this job. Two tabs (or a double-click) both
     * reading `sentChunks: 0` would each send the whole job — the queue stores
     * progress, so it has to store ownership too, or the second run silently
     * duplicates everything the first one printed.
     */
    runId?: string;
}

export interface PrintLogEntry {
    id: string;
    at: number;
    jobId: string;
    designName: string;
    designChecksum: string;
    targetName: string;
    host: string;
    port: string;
    chunkIndex: number;
    chunkCount: number;
    /** Labels this chunk carried. */
    labels: number;
    /** UTF-8 bytes actually posted. */
    bytes: number;
    /** Hash of those bytes; ties a printed label back to its stream. */
    streamHash: string;
    ok: boolean;
    error?: string;
    /**
     * The shared print server's accepted-chunk count for this job at the
     * moment of this attempt, when the attempt went through one. Set means the
     * server ANSWERED, so a failure carrying it is authoritative: the chunk did
     * not print, and `ambiguousChunk` must stop calling it uncertain. Absent
     * means the attempt went through the bridge and nothing is known.
     */
    accepted?: number;
}

// --- persistence -------------------------------------------------------------

const JOB_STORE = 'printJobs';
const LOG_STORE = 'printLog';

export interface PrintQueueBackend {
    listJobs(): Promise<PrintJob[]>;
    putJob(job: PrintJob): Promise<void>;
    removeJob(id: string): Promise<void>;
    listLog(): Promise<PrintLogEntry[]>;
    putLog(entry: PrintLogEntry): Promise<void>;
    removeLog(id: string): Promise<void>;
}

export const indexedDbQueueBackend = (): PrintQueueBackend => {
    const store = (mode: IDBTransactionMode, which: string): Promise<IDBObjectStore> => storeOf(which, mode);
    return {
        listJobs: async () => await requestToPromise((await store('readonly', JOB_STORE)).getAll()) as PrintJob[],
        putJob: async (job) => { await requestToPromise((await store('readwrite', JOB_STORE)).put(job)); },
        removeJob: async (id) => { await requestToPromise((await store('readwrite', JOB_STORE)).delete(id)); },
        listLog: async () => await requestToPromise((await store('readonly', LOG_STORE)).getAll()) as PrintLogEntry[],
        putLog: async (entry) => { await requestToPromise((await store('readwrite', LOG_STORE)).put(entry)); },
        removeLog: async (id) => { await requestToPromise((await store('readwrite', LOG_STORE)).delete(id)); },
    };
};

export const memoryQueueBackend = (): PrintQueueBackend => {
    const jobs = new Map<string, PrintJob>();
    const log = new Map<string, PrintLogEntry>();
    return {
        listJobs: async () => [...jobs.values()],
        putJob: async (job) => { jobs.set(job.id, job); },
        removeJob: async (id) => { jobs.delete(id); },
        listLog: async () => [...log.values()],
        putLog: async (entry) => { log.set(entry.id, entry); },
        removeLog: async (id) => { log.delete(id); },
    };
};

const hasIndexedDb = (): boolean => {
    try { return typeof indexedDB !== 'undefined' && indexedDB !== null; } catch { return false; }
};

let backend: PrintQueueBackend = hasIndexedDb() ? indexedDbQueueBackend() : memoryQueueBackend();

/** Tests inject a backend so they exercise the real logic without a database. */
export const setPrintQueueBackend = (next: PrintQueueBackend): void => { backend = next; };

let counter = 0;
const nextId = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Newest first — the order the Jobs tab shows. */
export const listPrintJobs = async (): Promise<PrintJob[]> =>
    (await backend.listJobs()).sort((a, b) => b.createdAt - a.createdAt);

export const savePrintJob = (job: PrintJob): Promise<void> => backend.putJob(job);
export const removePrintJob = (id: string): Promise<void> => backend.removeJob(id);

/** Newest first, capped so a shop's whole history does not have to be read. */
export const listPrintLog = async (limit = 200): Promise<PrintLogEntry[]> =>
    (await backend.listLog()).sort((a, b) => b.at - a.at).slice(0, limit);

/** Keep the log bounded; it grows by one entry per chunk sent, forever. */
export const MAX_LOG_ENTRIES = 500;

export const trimPrintLog = async (): Promise<number> => {
    const all = (await backend.listLog()).sort((a, b) => b.at - a.at);
    const excess = all.slice(MAX_LOG_ENTRIES);
    for (const entry of excess) await backend.removeLog(entry.id);
    return excess.length;
};

/**
 * A job left in 'sending' by a reload was never going to finish: this process
 * is the one that was sending, and it is gone. Flipping it to 'failed' makes
 * the resume button reachable again — leaving it 'sending' forever would hide
 * the retry behind a status nothing can clear.
 */
export const recoverInterruptedJobs = async (): Promise<number> => {
    const stuck = (await backend.listJobs()).filter(j => j.status === 'sending');
    for (const job of stuck) {
        // The run token goes WITH the status: leaving it set would make the
        // next runPrintJob think a live process still owns the job and refuse
        // to retry it — the job would be permanently stuck behind a phantom.
        await backend.putJob({
            ...job, status: 'failed', runId: undefined,
            lastError: 'The page was closed while this job was sending.', updatedAt: Date.now(),
        });
    }
    return stuck.length;
};

/**
 * Jobs are a design snapshot each, so an unbounded queue duplicates a whole
 * label (bitmaps included) per job. Finished jobs are history — the LOG is
 * what an audit reads — so the oldest sent/cancelled ones are dropped past
 * this many.
 *
 * Pending jobs are bounded too, and this is not decoration: pruning only when
 * a run completes means a job that is queued and never sent, or that fails and
 * is never retried, sits in IndexedDB forever. Queue twenty of those and the
 * origin has twenty label bitmaps of quota gone with nothing to show for it.
 * A job still 'sending' is never touched — a live run owns its record.
 */
export const MAX_FINISHED_JOBS = 25;
export const MAX_PENDING_JOBS = 25;

export const prunePrintJobs = async (): Promise<number> => {
    const all = await backend.listJobs();
    const oldestFirst = (jobs: PrintJob[]) => jobs.sort((a, b) => a.createdAt - b.createdAt);
    const finished = oldestFirst(all.filter(j => j.status === 'sent' || j.status === 'cancelled'));
    const pending = oldestFirst(all.filter(j => j.status === 'queued' || j.status === 'failed'));
    const excess = [
        ...finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS)),
        ...pending.slice(0, Math.max(0, pending.length - MAX_PENDING_JOBS)),
    ];
    for (const job of excess) await backend.removeJob(job.id);
    return excess.length;
};

/**
 * The chunk whose fate is genuinely unknown: it was POSTed and the transport
 * reported a failure, but the bytes may have flushed before the failure was
 * noticed (services/bridgeSend.ts aborts its fetch on a 15 s timeout while the
 * bridge may already be forwarding). Derived from the LOG rather than stored
 * on the job, because the log entry is written for every attempt — so this
 * answer survives a reload and covers retries of retries.
 *
 * A failure WITH `accepted` is not ambiguous and is skipped. That field is
 * written only when the shared print server answered, and it answers only
 * after its own socket flushed: so a refusal carrying it is proof the chunk
 * never reached the media. This is the whole reason Fase 7's server exists —
 * routed through it, the warning stops being necessary instead of merely
 * honest.
 *
 * Returns the chunk index the last AMBIGUOUS failed attempt was on, with the
 * label count it carried, or null when nothing is ambiguous.
 */
export const ambiguousChunk = async (jobId: string): Promise<{ chunkIndex: number; labels: number } | null> => {
    const failed = (await backend.listLog())
        .filter(entry => entry.jobId === jobId && !entry.ok && entry.accepted === undefined)
        .sort((a, b) => b.at - a.at)[0];
    return failed ? { chunkIndex: failed.chunkIndex, labels: failed.labels } : null;
};

// --- building a job ----------------------------------------------------------

export interface NewJobOptions {
    recordFrom: number;
    recordTo: number;
    copies: number;
    collation: Collation;
    target: JobTarget;
    /** Injectable clock so tests can assert ordering without sleeping. */
    now?: number;
    id?: string;
}

/**
 * Why this design cannot be sent to this target, or null when it can.
 *
 * The one real refusal: ZPL and EPL both emit a SINGLE label per stream with
 * the copy count inside it (^PQ and P), so a table-backed design pointed at
 * either would print one record and silently drop the rest. Refusing is the
 * only honest answer; the UI shows this sentence next to the target picker.
 */
export const jobSendabilityError = (design: Design, target: Pick<JobTarget, 'language'>): string | null => {
    if (target.language !== 'ipl' && designHasRecords(design)) {
        const name = target.language === 'epl' ? 'EPL' : 'ZPL';
        return `${name} output prints one label per stream, so a record range cannot be sent to a ${name} printer. Pick an IPL target, or export the records as images instead.`;
    }
    return null;
};

/** Non-blocking notices for a runnable job: the things that are legal but surprising. */
export const jobWarnings = (design: Design, target: Pick<JobTarget, 'language' | 'dpi'>): string[] => {
    const warnings: string[] = [];
    const designLanguage = design.printerSettings.language ?? 'ipl';
    if (designLanguage !== target.language) {
        warnings.push(`This design is set to ${designLanguage.toUpperCase()} output, but the job will be generated as ${target.language.toUpperCase()} for this printer.`);
    }
    if (design.printerSettings.dpi !== target.dpi) {
        warnings.push(`The design is built at ${design.printerSettings.dpi} dpi and this printer is ${target.dpi} dpi. The stream uses the design's dpi, so the printed size will differ.`);
    }
    return warnings;
};

/**
 * Build (and persist) a job. The record range is clamped to what the design
 * actually has, so a job never claims to print records that do not exist.
 */
export const createPrintJob = async (design: Design, opts: NewJobOptions): Promise<PrintJob> => {
    const refusal = jobSendabilityError(design, opts.target);
    if (refusal) throw new Error(refusal);

    const hasRecords = designHasRecords(design);
    const recordCount = designRecordCount(design);
    const from = hasRecords ? Math.max(1, Math.min(opts.recordFrom, recordCount)) : 1;
    const to = hasRecords ? Math.max(from, Math.min(opts.recordTo, recordCount)) : 1;
    const copies = Math.max(1, Math.floor(opts.copies) || 1);
    const sequence = hasRecords ? printSequence({ from, to }, copies, opts.collation, recordCount) : [];
    const chunkCount = hasRecords ? Math.max(1, Math.ceil(sequence.length / PRINT_CHUNK_LABELS)) : 1;

    const now = opts.now ?? Date.now();
    const job: PrintJob = {
        id: opts.id ?? nextId('j'),
        createdAt: now,
        updatedAt: now,
        designName: design.name,
        designChecksum: designChecksum(design),
        // A deep copy, not the object the caller handed in. IndexedDB would
        // structured-clone it on the way out anyway, but the memory backend
        // keeps the reference — and that reference is the LIVE canvas design,
        // so an edit after queueing would silently rewrite a job that claims to
        // be a snapshot. Same reasoning as importSharedSource's copy.
        design: structuredClone(design),
        recordFrom: from,
        recordTo: to,
        copies,
        collation: opts.collation,
        target: opts.target,
        labels: hasRecords ? sequence.length : copies,
        chunkCount,
        sentChunks: 0,
        status: 'queued',
    };
    await backend.putJob(job);
    return job;
};

/**
 * Stop a job. Cancelling a RUN does not abort the chunk already on the wire —
 * it cannot, the POST has left the browser — so it clears the run token and
 * lets runPrintJob notice at the next chunk boundary. Whatever was in flight
 * still prints; nothing after it does. Cancelling a job that is not running
 * just sets the status.
 */
export const cancelPrintJob = async (id: string): Promise<PrintJob | null> => {
    const job = (await backend.listJobs()).find(j => j.id === id);
    if (!job) return null;
    const next: PrintJob = { ...job, status: 'cancelled', runId: undefined, updatedAt: Date.now() };
    await backend.putJob(next);
    return next;
};

// --- running a job -----------------------------------------------------------

/**
 * The transport a run uses unless a caller injects one.
 *
 * With a shared print server configured, a chunk goes to the SERVER and the
 * server owns the socket — that is the point of it, and it is what makes the
 * acknowledgement exact. With none, the local bridge carries the stream
 * exactly as before, and the result carries no `accepted`, so the retry
 * caution stays honest rather than quietly dropping.
 */
const defaultSend = (stream: string, opts: { host: string; port: string; jobId?: string; seq?: number }): Promise<BridgeResult> => {
    const serverUrl = getPrintServerUrl();
    if (serverUrl && opts.jobId !== undefined && opts.seq !== undefined) {
        return sendChunkViaPrintServer(stream, { jobId: opts.jobId, seq: opts.seq, serverUrl });
    }
    return sendIplViaBridge(stream, { host: opts.host, port: opts.port });
};

export interface RunJobDeps {
    /** Renders one chunk's stream. Injectable so tests need no canvas/barcodes. */
    render: (job: PrintJob, chunkIndex: number, labels: number) => Promise<string>;
    /**
     * Posts one chunk. `jobId`/`seq` are what a shared print server needs to
     * acknowledge it (services/printRemoteBackend.ts); the bridge ignores them.
     */
    send: (stream: string, opts: { host: string; port: string; jobId?: string; seq?: number }) => Promise<BridgeResult>;
    now?: () => number;
}

/**
 * Every chunk of a job, in order, with the labels each one prints. Derived
 * from the job's own snapshot, so a resumed job produces byte-identical chunks
 * to the ones the original run produced.
 *
 * A single-record design is exactly one chunk: its copies live inside the
 * stream (`<RS>n`), and its serial counter advances per printed label —
 * duplicating print blocks would print the same number on every copy instead.
 */
export const jobChunks = (job: PrintJob): { records: number[]; batch?: BatchData; labels: number }[] => {
    const plan = designJobPlan(job.design);
    if (!plan) return [{ records: [1], labels: job.copies }];
    const sequence = printSequence({ from: job.recordFrom, to: job.recordTo }, job.copies, job.collation, designRecordCount(job.design));
    return buildJobChunks(plan, sequence).map((chunk: JobChunk) => ({
        records: chunk.records,
        batch: chunk.batch,
        labels: chunk.batch.rows.length,
    }));
};

/** The real renderer: IPL through the batch path, ZPL for a single-record job. */
export const renderJobChunk = async (job: PrintJob, chunkIndex: number, chunks = jobChunks(job)): Promise<string> => {
    const chunk = chunks[chunkIndex];
    if (!chunk) return '';
    if (job.target.language === 'zpl' || job.target.language === 'epl') {
        // jobSendabilityError already refused a record range on these, so this
        // is the single-label case: the copy count travels inside the stream
        // (^PQ for ZPL, P for EPL), applied to a COPY of the snapshot so the
        // stored job keeps the design the user made.
        const design: Design = {
            ...job.design,
            printerSettings: { ...job.design.printerSettings, quantity: Math.max(1, job.copies) },
        };
        return job.target.language === 'epl' ? generateEPL(design).epl : generateZPL(design).zpl;
    }
    if (chunk.batch) return generateIPL(job.design, chunk.batch);
    // Single-record IPL: the copies live inside the stream as <RS>n, so the
    // job's copy count has to reach the generator. Without this the job would
    // print ONCE whatever number of copies was asked for — a silently short
    // run, the kind of failure nobody notices until the order ships.
    return generateIPL({
        ...job.design,
        printerSettings: { ...job.design.printerSettings, quantity: Math.max(1, job.copies) },
    });
};

/**
 * Send the chunks that have not gone out yet, persisting progress after each
 * one and appending a log entry per ATTEMPT.
 *
 * Returns the job as it stands afterwards. A failure stops the run (later
 * chunks are not attempted) and leaves `sentChunks` exactly where it got to —
 * which is what makes a retry send only the remainder.
 */
export const runPrintJob = async (
    job: PrintJob,
    deps: Partial<RunJobDeps> = {},
    onProgress?: (job: PrintJob) => void,
): Promise<PrintJob> => {
    const now = deps.now ?? (() => Date.now());
    // The default transport IS the shared server whenever one is configured —
    // that is what makes "Send" on a station print through the shop's queue
    // instead of straight out of the browser. Without a server the bridge is
    // still what carries the stream, unchanged.
    const send = deps.send ?? defaultSend;
    const render = deps.render ?? ((j, index) => renderJobChunk(j, index, jobChunks(j)));

    // Claim the job before touching the printer. `sentChunks` comes from the
    // STORED record, not from the argument: the argument may have been read
    // before another tab advanced the job, and starting from a stale count is
    // exactly the double-print this guards against.
    const stored = (await backend.listJobs()).find(j => j.id === job.id);
    const base = stored ?? job;
    if (base.status === 'sending' && base.runId !== undefined) {
        // Another run is live. Refusing is the only safe answer: a second
        // sender would print everything that one has not finished yet.
        return base;
    }

    const runId = nextId('r');
    const chunks = jobChunks(base);
    let current: PrintJob = { ...base, status: 'sending', lastError: undefined, runId, updatedAt: now() };
    await backend.putJob(current);
    onProgress?.(current);

    // Prune on EVERY run, not only on a successful one. A shop that queues ten
    // jobs and has the first fail would otherwise accumulate ten design
    // snapshots with nothing ever cleaning them up — the failure path is
    // exactly when jobs pile up, so it is the wrong place to skip the sweep.
    await prunePrintJobs().catch(() => 0);

    /**
     * The stored job as it stands now. This run writes THROUGH it rather than
     * over it: a chunk that went out really did print, but if the user
     * cancelled meanwhile, saving our own 'sending' snapshot over their
     * 'cancelled' one would resurrect a job they stopped — and the next run
     * would send the rest of it.
     */
    const liveJob = async (): Promise<PrintJob | undefined> =>
        (await backend.listJobs()).find(j => j.id === current.id);

    for (let index = current.sentChunks; index < chunks.length; index++) {
        const chunk = chunks[index];
        let stream: string;
        try {
            stream = await render(current, index, chunk.labels);
        } catch (e) {
            const message = `Could not generate the stream: ${e instanceof Error ? e.message : String(e)}`;
            current = { ...current, status: 'failed', lastError: message, runId: undefined, updatedAt: now() };
            await backend.putJob(current);
            onProgress?.(current);
            return current;
        }

        const bytes = utf8Bytes(stream);
        const hash = streamHash(stream);
        const result = await send(stream, { host: current.target.host, port: current.target.port, jobId: current.id, seq: index });

        await backend.putLog({
            id: nextId('l'),
            at: now(),
            jobId: current.id,
            designName: current.designName,
            designChecksum: current.designChecksum,
            targetName: current.target.name,
            host: current.target.host,
            port: current.target.port,
            chunkIndex: index,
            chunkCount: chunks.length,
            labels: chunk.labels,
            bytes,
            streamHash: hash,
            ok: result.ok,
            error: result.ok ? undefined : (result.error ?? 'Send failed.'),
            accepted: result.accepted,
        });

        if (!result.ok) {
            const live = await liveJob();
            // If someone else took the job over (cancelled it, or a second tab
            // resumed), their record is the truth; do not stamp a failure onto
            // a job they already moved on from.
            if (live && live.runId !== runId) return live;
            current = { ...current, status: 'failed', lastError: result.error ?? 'Send failed.', runId: undefined, updatedAt: now() };
            await backend.putJob(current);
            onProgress?.(current);
            return current;
        }

        // Progress is written BEFORE the next chunk, so a crash between the two
        // costs a re-send of a chunk that printed — never a silent skip.
        //
        // But it must be written ONTO the stored record, read first: a cancel
        // (or a second tab) that landed while this chunk was in flight has
        // already changed the status, and saving our own snapshot over it would
        // resurrect a job the user stopped. The chunk really did print, so its
        // count is kept either way.
        const after = await liveJob();
        current = { ...(after ?? current), sentChunks: index + 1, updatedAt: now() };
        await backend.putJob(current);
        onProgress?.(current);
        // No longer ours: the status is theirs and this run stops here, before
        // the next chunk reaches the printer.
        if (after && after.runId !== runId) return current;
    }

    current = { ...current, status: 'sent', runId: undefined, updatedAt: now() };
    await backend.putJob(current);
    onProgress?.(current);
    await trimPrintLog().catch(() => 0);
    return current;
};
