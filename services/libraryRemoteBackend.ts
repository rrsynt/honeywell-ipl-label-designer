// Fase 7: the shared design library, as a LibraryBackend.
//
// services/libraryStore.ts keeps every function storage-agnostic behind the
// LibraryBackend interface, with two implementations: IndexedDB in the browser
// and an in-memory map for tests. This is the third, and it changes none of
// that logic. It speaks HTTP to tools/library-server.mjs, which stores the
// exact records this module already builds (LibraryRecord, SourceRecord,
// RecoveryRecord) as JSON files in a directory any number of PCs can share.
//
// It is deliberately NOT the default backend. Autosave and recovery stay local
// unless the caller points them at a server — a shared draft would put one
// station's half-finished work onto every other station's screen.

import type { LibraryBackend, LibraryMeta, LibraryRecord, RecoveryRecord, SourceRecord } from './libraryStore';
import { authHeader, isAuthFailure } from './serverTokens';

const AUTH_HINT = 'library server refused the token (HTTP 401). Enter the same token the server was started with (--token), or restart it without one.';

export const DEFAULT_LIBRARY_SERVER_URL = 'http://localhost:9182';

// Where the shared library lives. Empty means "this browser" — the IndexedDB
// backend libraryStore picks on its own. A stored address survives reload, the
// same way the printer target does, so a station keeps pointing at the shop's
// server without anyone retyping it.
const SERVER_URL_KEY = 'ipl_library_server_url';

/**
 * The shared-library address, or '' when the library stays in this browser.
 * Anything that is not an http(s) URL is treated as unset: a corrupted entry
 * must fall back to the local library, not throw on every save.
 */
export const getLibraryServerUrl = (storage: Storage = localStorage): string => {
    try {
        const raw = (storage.getItem(SERVER_URL_KEY) ?? '').trim().replace(/\/+$/, '');
        if (!/^https?:\/\/[^/]+$/.test(raw)) return '';
        return raw;
    } catch {
        return '';
    }
};

/** Persist the address. Pass '' to go back to this browser's own library.
 *  Throws on a malformed address so the form can show it; a storage failure
 *  (private mode) is swallowed — the choice still holds for this session. */
export const setLibraryServerUrl = (url: string, storage: Storage = localStorage): string => {
    const clean = url.trim().replace(/\/+$/, '');
    if (clean !== '' && !/^https?:\/\/[^/]+$/.test(clean)) {
        throw new Error('Enter the server address as http://host:9182, or leave it empty to keep designs on this computer.');
    }
    try {
        if (clean === '') storage.removeItem(SERVER_URL_KEY);
        else storage.setItem(SERVER_URL_KEY, clean);
    } catch { /* storage unavailable; the caller still applies it in memory */ }
    return clean;
};

export interface RemoteBackendOptions {
    /** Base URL of tools/library-server.mjs. Trailing slashes are tolerated. */
    serverUrl?: string;
    /** Per-request ceiling. A library call that hangs must fail, not freeze the UI. */
    timeoutMs?: number;
    /**
     * Which collections live on the server. Anything not listed is served from
     * `local` instead — recovery defaults to local so an autosave never leaves
     * the machine (see the note above).
     */
    remote?: { designs?: boolean; sources?: boolean; recovery?: boolean };
    /** Backend for the collections that stay local. Required when any do. */
    local?: LibraryBackend;
}

const DEFAULT_REMOTE = { designs: true, sources: true, recovery: false };

/**
 * One HTTP call. Every failure becomes a thrown Error carrying a readable
 * message, because the library UI already renders a rejection as "could not
 * read the library" — a raw TypeError from fetch would say nothing useful.
 */
/** The server's own `{ok:false, error}` answers, re-thrown with their text.
 *  Anything else — DNS failure, connection refused, an abort — means the
 *  server could not be reached at all, which is a different message. */
const failFromResponse = (res: Response, body: { ok?: boolean; error?: unknown } | null): Error =>
    new Error(isAuthFailure(res.status)
        ? AUTH_HINT
        : body?.error ? String(body.error) : `library server returned HTTP ${res.status}`);

const unreachable = (base: string, e: unknown): Error =>
    (e as { name?: string } | undefined)?.name === 'AbortError'
        ? new Error('library server timed out')
        : new Error(`library server unreachable at ${base} — start it with: node tools/library-server.mjs`);

const request = async (
    base: string,
    path: string,
    timeoutMs: number,
    init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: any }> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const res = await fetch(`${base}${path}`, {
            method: init?.method ?? 'GET',
            headers: { ...authHeader('library'), ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined) },
            body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
            signal: ctl.signal,
        });
        const body = await res.json().catch(() => null);
        if (!res.ok || body?.ok === false) throw failFromResponse(res, body);
        return { status: res.status, body };
    } catch (e) {
        if (e instanceof Error && e.message.startsWith('library server returned')) throw e;
        if (e instanceof Error && typeof (e as { status?: unknown }).status !== 'undefined') throw e;
        throw unreachable(base, e);
    } finally {
        clearTimeout(timer);
    }
};

/** Liveness probe, same shape as services/bridgeSend.ts pingBridge. */
export const pingLibraryServer = async (serverUrl = DEFAULT_LIBRARY_SERVER_URL, timeoutMs = 1500): Promise<boolean> => {
    try {
        const { body } = await request(serverUrl.replace(/\/+$/, ''), '/ping', timeoutMs);
        return body?.ok === true && body?.service === 'library';
    } catch {
        return false;
    }
};

const toMeta = (record: LibraryRecord): LibraryMeta => {
    const { design: _design, ...meta } = record;
    return meta;
};

/**
 * A LibraryBackend whose designs (and, by default, shared data sources) live
 * on a library server. Drop-in: pass it to setLibraryBackend and every
 * existing library call talks to the server without further change.
 */
export const remoteBackend = (opts: RemoteBackendOptions = {}): LibraryBackend => {
    const base = (opts.serverUrl ?? DEFAULT_LIBRARY_SERVER_URL).replace(/\/+$/, '');
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const where = { ...DEFAULT_REMOTE, ...opts.remote };
    const local = opts.local ?? null;

    const needsLocal = !where.designs || !where.sources || !where.recovery;
    if (needsLocal && !local) {
        throw new Error('remoteBackend needs a local backend for the collections that stay on this machine');
    }

    // 404 is an answer ("no such record"), not a failure — the interface
    // contract is `null` for a missing name, and callers branch on it.
    const get = async (collection: string, key: string): Promise<any | null> => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        try {
            const res = await fetch(`${base}/${collection}/${encodeURIComponent(key)}`, { headers: { ...authHeader('library') }, signal: ctl.signal });
            if (res.status === 404) return null;
            const body = await res.json().catch(() => null);
            if (!res.ok || body?.ok === false) throw failFromResponse(res, body);
            return body?.record ?? null;
        } catch (e) {
            if (e instanceof Error && e.message.startsWith('library server returned')) throw e;
            throw unreachable(base, e);
        } finally {
            clearTimeout(timer);
        }
    };

    const listAll = async (collection: string): Promise<any[]> => {
        const { body } = await request(base, `/${collection}`, timeoutMs);
        return Array.isArray(body?.records) ? body.records : [];
    };

    const put = (collection: string, key: string, record: unknown): Promise<void> =>
        request(base, `/${collection}/${encodeURIComponent(key)}`, timeoutMs, { method: 'PUT', body: record }).then(() => undefined);

    const remove = (collection: string, key: string): Promise<void> =>
        request(base, `/${collection}/${encodeURIComponent(key)}`, timeoutMs, { method: 'DELETE' }).then(() => undefined);

    return {
        // The server lists full records; the interface promises metadata only,
        // so the design is stripped here. A local backend already returns
        // metadata, and stripping twice would be wrong — it has no `design`.
        list: () => where.designs ? listAll('designs').then(rs => rs.map(toMeta)) : local!.list(),
        get: (name) => where.designs ? get('designs', name) : local!.get(name),
        put: (record) => where.designs ? put('designs', record.name, record) : local!.put(record),
        remove: (name) => where.designs ? remove('designs', name) : local!.remove(name),
        // Oldest first, matching the interface contract the migration relies on.
        all: async () => where.designs
            ? (await listAll('designs')).sort((a: LibraryRecord, b: LibraryRecord) => a.updatedAt - b.updatedAt)
            : local!.all(),
        listSources: () => where.sources ? listAll('sources') : local!.listSources(),
        putSource: (record) => where.sources ? put('sources', record.name, record) : local!.putSource(record),
        removeSource: (name) => where.sources ? remove('sources', name) : local!.removeSource(name),
        getRecovery: (slot) => where.recovery ? get('recovery', slot) : local!.getRecovery(slot),
        putRecovery: (record) => where.recovery ? put('recovery', record.slot, record) : local!.putRecovery(record),
        removeRecovery: (slot) => where.recovery ? remove('recovery', slot) : local!.removeRecovery(slot),
    };
};

export type { LibraryRecord, SourceRecord, RecoveryRecord };
