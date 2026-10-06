// Fase 7: the shared print server, as a client.
//
// services/printQueue.ts keeps its persistence behind `PrintQueueBackend` and
// services/printTargets.ts behind `PrintTargetBackend`, both with an IndexedDB
// implementation and a memory one for tests. These are the third kind: two
// backends over tools/print-server.mjs, which holds the queue, the printer
// list and the log as JSON files in a directory any station can point at.
//
// What makes this more than a shared folder is the chunk acknowledgement. The
// bridge reports `written` only after its socket flushed, so a fetch that
// times out may still have printed — which is why the queue warns that a retry
// can duplicate a chunk. The server answers `accepted` only after ITS socket
// flushed, so a failure that carries `accepted` is proof the chunk did NOT
// print. That one distinction is what lets the UI drop a warning it would
// otherwise have to keep.
//
// Everything is in this one file for the same reason services/bridgeSend.ts
// holds both directions of the bridge protocol: it is one server with one
// address, and a second `DEFAULT_PRINT_SERVER_URL` in a second file is exactly
// the drift this codebase keeps writing comments to prevent.

import type { BridgeResult } from './bridgeSend';
import { authHeader, isAuthFailure } from './serverTokens';
import {
    MAX_LOG_ENTRIES, indexedDbQueueBackend, memoryQueueBackend, setPrintQueueBackend,
} from './printQueue';
import type { PrintJob, PrintLogEntry, PrintQueueBackend } from './printQueue';
import {
    indexedDbTargetBackend, memoryTargetBackend, setPrintTargetBackend,
} from './printTargets';
import type { PrintTarget, PrintTargetBackend } from './printTargets';

const hasIndexedDb = (): boolean => {
    try { return typeof indexedDB !== 'undefined' && indexedDB !== null; } catch { return false; }
};

export const DEFAULT_PRINT_SERVER_URL = 'http://localhost:9183';

// Where the shared queue lives. Empty means "this browser" — the IndexedDB
// backends the app picks on its own. A stored address survives reload, the
// same way the printer target and the library address do.
const SERVER_URL_KEY = 'ipl_print_server_url';

/** Same guard as the library address: http(s) only, '' when unset or corrupt. */
const isServerUrl = (url: string): boolean => /^https?:\/\/[^/]+$/.test(url);

/**
 * The shared-print-server address, or '' when the queue stays in this browser.
 * A corrupted entry reads as unset rather than throwing on every read.
 */
export const getPrintServerUrl = (storage: Storage = localStorage): string => {
    try {
        const raw = (storage.getItem(SERVER_URL_KEY) ?? '').trim().replace(/\/+$/, '');
        return isServerUrl(raw) ? raw : '';
    } catch {
        return '';
    }
};

/** Persist the address. Pass '' to go back to this browser's own queue.
 *  Throws on a malformed address so the form can show it; a storage failure
 *  (private mode) is swallowed — the choice still holds for this session. */
export const setPrintServerUrl = (url: string, storage: Storage = localStorage): string => {
    const clean = url.trim().replace(/\/+$/, '');
    if (clean !== '' && !isServerUrl(clean)) {
        throw new Error('Enter the server address as http://host:9183, or leave it empty to keep the queue on this computer.');
    }
    try {
        if (clean === '') storage.removeItem(SERVER_URL_KEY);
        else storage.setItem(SERVER_URL_KEY, clean);
    } catch { /* storage unavailable; the caller still applies it in memory */ }
    return clean;
};

const AUTH_HINT = 'print server refused the token (HTTP 401). Enter the same token the server was started with (--token), or restart it without one.';

const failFromResponse = (res: Response, body: { ok?: boolean; error?: unknown } | null): Error =>
    new Error(isAuthFailure(res.status)
        ? AUTH_HINT
        : body?.error ? String(body.error) : `print server returned HTTP ${res.status}`);

const unreachable = (base: string, e: unknown): Error =>
    (e as { name?: string } | undefined)?.name === 'AbortError'
        ? new Error('print server timed out')
        : new Error(`print server unreachable at ${base} — start it with: node tools/print-server.mjs`);

interface RequestOptions {
    method?: string;
    body?: unknown;
}

/**
 * One HTTP call. A `{ok:false}` answer carries the server's own words and is
 * re-thrown with them; anything else means the server could not be reached at
 * all, which is a different sentence for the user.
 */
const request = async (
    base: string,
    path: string,
    timeoutMs: number,
    init?: RequestOptions,
): Promise<{ status: number; body: any }> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const payload = init?.body !== undefined ? JSON.stringify(init.body) : undefined;
    try {
        const res = await fetch(`${base}${path}`, {
            method: init?.method ?? 'GET',
            headers: { ...authHeader('print'), ...(payload !== undefined ? { 'Content-Type': 'application/json' } : undefined) },
            body: payload,
            signal: ctl.signal,
        });
        const body = await res.json().catch(() => null);
        if (!res.ok || body?.ok === false) throw failFromResponse(res, body);
        return { status: res.status, body };
    } catch (e) {
        if (e instanceof Error && e.message.startsWith('print server returned')) throw e;
        throw unreachable(base, e);
    } finally {
        clearTimeout(timer);
    }
};

/** Liveness probe, same shape as pingBridge and pingLibraryServer. */
export const pingPrintServer = async (serverUrl = DEFAULT_PRINT_SERVER_URL, timeoutMs = 1500): Promise<boolean> => {
    try {
        const { body } = await request(serverUrl.replace(/\/+$/, ''), '/ping', timeoutMs);
        return body?.ok === true && body?.service === 'print';
    } catch {
        return false;
    }
};

export interface SendChunkOptions {
    jobId: string;
    /** The chunk number this client believes is next. */
    seq: number;
    serverUrl?: string;
    timeoutMs?: number;
}

/**
 * POST one chunk's raw bytes and report what the server did with them.
 *
 * Two failures, and the difference is the whole point:
 *
 *   - The server ANSWERED and refused (a gap, a dead printer, a disk error).
 *     Its `accepted` is then facts, not a guess: the chunk definitely did not
 *     print, so it comes back here and the log records it.
 *   - The transport failed — timeout, DNS, connection refused. Nothing is
 *     known, `accepted` is absent, and the caller must keep treating the chunk
 *     as possibly printed. Absent means unknown; it is never defaulted to 0.
 */
export const sendChunkViaPrintServer = async (
    stream: string,
    opts: SendChunkOptions,
): Promise<BridgeResult> => {
    const base = (opts.serverUrl ?? getPrintServerUrl() ?? DEFAULT_PRINT_SERVER_URL).replace(/\/+$/, '') || DEFAULT_PRINT_SERVER_URL;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const res = await fetch(
            `${base}/jobs/${encodeURIComponent(opts.jobId)}/chunk?seq=${encodeURIComponent(String(opts.seq))}`,
            {
                method: 'POST',
                // UTF-8, exactly what the bridge path posts: the chunk is a
                // string but it carries IPL control bytes.
                headers: { 'Content-Type': 'text/plain; charset=utf-8', ...authHeader('print') },
                body: stream,
                signal: ctl.signal,
            },
        );
        const body = await res.json().catch(() => null);
        const accepted = typeof body?.accepted === 'number' ? body.accepted : undefined;
        if (res.ok && body?.ok === true) return { ok: true, written: body.written, accepted };
        if (isAuthFailure(res.status)) return { ok: false, accepted, error: AUTH_HINT };
        return {
            ok: false,
            accepted,
            error: body?.error ? `Print server: ${body.error}` : `Print server returned HTTP ${res.status}`,
        };
    } catch (e) {
        // No `accepted`: the chunk's fate is genuinely unknown.
        if ((e as Error | undefined)?.name === 'AbortError') return { ok: false, error: 'Print server timed out.' };
        return { ok: false, error: unreachable(base, e).message };
    } finally {
        clearTimeout(timer);
    }
};

export interface RemoteBackendOptions {
    /** Base URL of tools/print-server.mjs. Trailing slashes are tolerated. */
    serverUrl?: string;
    /** Per-request ceiling. A queue read that hangs must fail, not freeze the UI. */
    timeoutMs?: number;
}

const baseOf = (opts: RemoteBackendOptions): string =>
    (opts.serverUrl ?? DEFAULT_PRINT_SERVER_URL).replace(/\/+$/, '');

/**
 * The queue on the server. Drop-in: pass it to setPrintQueueBackend and every
 * existing queue call talks to the server without further change.
 *
 * `listJobs`/`listLog` sort exactly as the IndexedDB backend does (newest
 * first) so a caller cannot tell them apart, and `removeJob`/`removeLog` are
 * idempotent because the server already treats a missing file as gone.
 */
export const remoteQueueBackend = (opts: RemoteBackendOptions = {}): PrintQueueBackend => {
    const base = baseOf(opts);
    const timeoutMs = opts.timeoutMs ?? 15_000;

    return {
        listJobs: async () => {
            const { body } = await request(base, '/jobs', timeoutMs);
            const records: PrintJob[] = Array.isArray(body?.records) ? body.records : [];
            return records.sort((a, b) => b.createdAt - a.createdAt);
        },
        putJob: (job) => request(base, `/jobs/${encodeURIComponent(job.id)}`, timeoutMs, { method: 'PUT', body: job }).then(() => undefined),
        removeJob: (id) => request(base, `/jobs/${encodeURIComponent(id)}`, timeoutMs, { method: 'DELETE' }).then(() => undefined),
        listLog: async () => {
            const { body } = await request(base, '/log', timeoutMs);
            const records: PrintLogEntry[] = Array.isArray(body?.records) ? body.records : [];
            // Bounded by the same constant the local backend trims to. The
            // server's log is the whole shop's history, so an unbounded read
            // grows without limit across stations.
            return records.sort((a, b) => b.at - a.at).slice(0, MAX_LOG_ENTRIES);
        },
        // The server owns the id it files an entry under, so it is read back
        // from the answer instead of assumed.
        putLog: (entry) => request(base, '/log', timeoutMs, { method: 'POST', body: entry }).then(() => undefined),
        removeLog: (id) => request(base, `/log/${encodeURIComponent(id)}`, timeoutMs, { method: 'DELETE' }).then(() => undefined),
    };
};

/** The saved printer list on the server, name-sorted like the local one. */
export const remoteTargetBackend = (opts: RemoteBackendOptions = {}): PrintTargetBackend => {
    const base = baseOf(opts);
    const timeoutMs = opts.timeoutMs ?? 15_000;

    return {
        list: async () => {
            const { body } = await request(base, '/targets', timeoutMs);
            const records: PrintTarget[] = Array.isArray(body?.records) ? body.records : [];
            return records.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
        },
        put: (target) => request(base, `/targets/${encodeURIComponent(target.id)}`, timeoutMs, { method: 'PUT', body: target }).then(() => undefined),
        remove: (id) => request(base, `/targets/${encodeURIComponent(id)}`, timeoutMs, { method: 'DELETE' }).then(() => undefined),
    };
};

/**
 * Point the queue and the printer list at a server, or back at this browser.
 *
 * ONE function rather than the two lines it wraps, because the meaning of an
 * empty address has to be identical everywhere: the app's startup effect and
 * the Print Center's address row both call this, so they cannot drift into
 * disagreeing about what "local" means. Returns the cleaned address.
 */
export const applyPrintServerUrl = (url: string, storage: Storage = localStorage): string => {
    const clean = setPrintServerUrl(url, storage);
    const local = hasIndexedDb();
    if (clean === '') {
        setPrintQueueBackend(local ? indexedDbQueueBackend() : memoryQueueBackend());
        setPrintTargetBackend(local ? indexedDbTargetBackend() : memoryTargetBackend());
    } else {
        setPrintQueueBackend(remoteQueueBackend({ serverUrl: clean }));
        setPrintTargetBackend(remoteTargetBackend({ serverUrl: clean }));
    }
    return clean;
};
