// Fase 7 item 2: rows straight from a database, as an ordinary data table.
//
// The browser cannot open a socket to SQL Server, so tools/db-server.mjs holds
// the named queries and runs one on demand. This is the client: list them,
// run one, hand back a DataTable.
//
// Two things this module deliberately cannot do:
//
//   - It never sees a connection string. The server answers with a name, a
//     provider and a description, and nothing else; credentials stay in the
//     query files on the server machine.
//   - It never sends SQL. The caller picks a NAME. That is the shape the plan
//     asked for ("run a stored query -> return rows as JSON"), and it means a
//     browser bug cannot become a dropped table.
//
// A run lands as a `type: 'table'` source, not a new kind of source:
// services/tableSource.ts already treats every table alike once the rows
// exist, so preview, .ipl export, batch export and Send Job all keep working
// with no second code path. The connection is only needed to FETCH — the rows
// are stored in the design like an imported CSV, so opening a saved design
// later does not need the database at all.

import type { DataTable } from './tableSource';

export const DEFAULT_DB_SERVER_URL = 'http://localhost:9184';

// Where the database server lives. Same storage pattern as the print server
// and the library server: a stored address survives reload.
const SERVER_URL_KEY = 'ipl_db_server_url';

const isServerUrl = (url: string): boolean => /^https?:\/\/[^/]+$/.test(url);

/** The database server's address, or '' when none has been set. */
export const getDbServerUrl = (storage: Storage = localStorage): string => {
    try {
        const raw = (storage.getItem(SERVER_URL_KEY) ?? '').trim().replace(/\/+$/, '');
        return isServerUrl(raw) ? raw : '';
    } catch {
        return '';
    }
};

/** Persist the address. Pass '' to clear it. Throws on a malformed address so
 *  the form can show it; a storage failure is swallowed (private mode). */
export const setDbServerUrl = (url: string, storage: Storage = localStorage): string => {
    const clean = url.trim().replace(/\/+$/, '');
    if (clean !== '' && !isServerUrl(clean)) {
        throw new Error('Enter the server address as http://host:9184, or leave it empty to skip the database.');
    }
    try {
        if (clean === '') storage.removeItem(SERVER_URL_KEY);
        else storage.setItem(SERVER_URL_KEY, clean);
    } catch { /* storage unavailable; the caller still applies it in memory */ }
    return clean;
};

const unreachable = (base: string, e: unknown): Error =>
    (e as { name?: string } | undefined)?.name === 'AbortError'
        ? new Error('database server timed out')
        : new Error(`database server unreachable at ${base} — start it with: node tools/db-server.mjs`);

/** Both kinds of answer this module raises. The distinction is what decides
 *  the message: a server that ANSWERED (however badly) is worth quoting, while
 *  a server that could not be reached needs the "start it with" hint instead. */
class ServerSaidNo extends Error {}

const request = async (
    base: string,
    path: string,
    timeoutMs: number,
    init?: { method?: string },
): Promise<{ status: number; body: any }> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const res = await fetch(`${base}${path}`, { method: init?.method ?? 'GET', signal: ctl.signal });
        const body = await res.json().catch(() => null);
        if (!res.ok || body?.ok === false) {
            // The reason the query was refused, or which table is missing, is
            // far more useful than "unreachable" — quote the server.
            throw new ServerSaidNo(body?.error ? String(body.error) : `database server returned HTTP ${res.status}`);
        }
        return { status: res.status, body };
    } catch (e) {
        if (e instanceof ServerSaidNo) throw e;
        throw unreachable(base, e);
    } finally {
        clearTimeout(timer);
    }
};

/** Liveness probe, same shape as the other servers' pings. */
export const pingDbServer = async (serverUrl = DEFAULT_DB_SERVER_URL, timeoutMs = 1500): Promise<boolean> => {
    try {
        const { body } = await request(serverUrl.replace(/\/+$/, ''), '/ping', timeoutMs);
        return body?.ok === true && body?.service === 'db';
    } catch {
        return false;
    }
};

/** What the picker shows. No credentials, by construction on the server side. */
export interface SavedQuerySummary {
    id: string;
    name: string;
    provider: string;
    description: string;
    database: string;
    server: string;
}

/** The saved queries, name-sorted. */
export const listSavedQueries = async (serverUrl = getDbServerUrl(), timeoutMs = 10_000): Promise<SavedQuerySummary[]> => {
    const base = (serverUrl || DEFAULT_DB_SERVER_URL).replace(/\/+$/, '');
    const { body } = await request(base, '/queries', timeoutMs);
    const queries: SavedQuerySummary[] = Array.isArray(body?.queries) ? body.queries : [];
    return queries.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
};

export interface QueryResult extends DataTable {
    /** True when the server dropped rows past its cap (services/csvJob.ts MAX_JOB_ROWS). */
    truncated: boolean;
    rowCount: number;
}

/**
 * Run one saved query and return its rows.
 *
 * The rows arrive as strings keyed by column name — the same shape
 * services/tableSource.ts's DataTable already uses, so the result can be
 * dropped straight into a `type: 'table'` source. A NULL cell is absent from
 * the server's answer and reads as '' here, which is what an empty cell
 * already means downstream.
 */
export const runSavedQuery = async (id: string, serverUrl = getDbServerUrl(), timeoutMs = 120_000): Promise<QueryResult> => {
    const base = (serverUrl || DEFAULT_DB_SERVER_URL).replace(/\/+$/, '');
    const { body } = await request(base, `/queries/${encodeURIComponent(id)}/run`, timeoutMs, { method: 'POST' });
    const columns: string[] = Array.isArray(body?.columns) ? body.columns : [];
    const rows: Record<string, string>[] = Array.isArray(body?.rows) ? body.rows : [];
    return {
        columns,
        // Normalise every cell to a string: a missing (NULL) cell becomes '',
        // so a field reading it prints empty rather than "undefined".
        rows: rows.map(row => {
            const filled: Record<string, string> = {};
            for (const column of columns) filled[column] = row[column] ?? '';
            return filled;
        }),
        truncated: body?.truncated === true,
        rowCount: typeof body?.rowCount === 'number' ? body.rowCount : rows.length,
    };
};
