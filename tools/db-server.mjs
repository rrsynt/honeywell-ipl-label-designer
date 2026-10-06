#!/usr/bin/env node
// Direct database connections (Fase 7).
//
// A browser cannot open a socket to a database, so every row a design prints
// had to be pasted in first. This is the smallest process that can: one HTTP
// server that holds named queries, runs one on demand, and hands the rows back
// as JSON. The client turns them into an ordinary table data source, so
// preview, .ipl export, batch export and Send Job all work with no second code
// path (services/tableSource.ts already treats every source alike once the
// rows exist).
//
// CONNECTION STRINGS LIVE HERE AND NEVER LEAVE. A client can list queries and
// run them; it cannot read a password, and it cannot send SQL. That is the
// whole shape the plan asked for: "run a stored query -> return rows as JSON",
// credentials on the server.
//
// Zero dependencies, like the bridge, the library server and the print server.
// The database work is delegated to tools/query-sqlserver.ps1 — PowerShell and
// System.Data.SqlClient ship with Windows, and they carry the full character
// range that sqlcmd's cp850 console output silently destroys (Привет and 日本語
// come back as '?'), which for a label means a misprinted label.
//
// Usage:
//   node tools/db-server.mjs                    # http://127.0.0.1:9184, data in ./db-data
//   node tools/db-server.mjs --port=9400        # custom port
//   node tools/db-server.mjs --dir=D:/shared    # a folder the whole shop can see
//   node tools/db-server.mjs --host=0.0.0.0 --token=s3cret
//                                               # serve the LAN, but only to token holders
//
// Hardening (audit SEC-01/SEC-02/SEC-03, 2026-10-06):
//   --host   HTTP listen address. Default 127.0.0.1 (this machine only); pass
//            --host=0.0.0.0 explicitly to serve the LAN.
//   --token  When set, every route except /ping requires
//            `Authorization: Bearer <token>`. Without it the server keeps its
//            old behaviour, so a single-station setup needs no token at all.
//   PUT      additionally requires a LOOPBACK caller even WITHOUT a token:
//            writing a query means writing a connection (server/user/password)
//            plus SQL, so it is an admin act done on the server machine —
//            hand-edited files, or curl from localhost. A browser (and the web
//            UI, which never calls PUT) can only list and run.
//   CORS     Echoes the request Origin instead of `*`, so a token-bearing
//            browser cannot be driven cross-origin by a stranger site.
//
// Endpoints (all JSON; CORS echoes the caller Origin):
//   GET    /ping                 -> { ok, service:'db', providers:[...] }
//   GET    /queries              -> query summaries, NEWEST first, no credentials
//   GET    /queries/:id          -> one definition (still no credentials)
//   PUT    /queries/:id          body = stored query (admin/script; see below)
//   DELETE /queries/:id
//   POST   /queries/:id/run      -> { ok, columns, rows, truncated, rowCount }
//
// A stored query is one file in <dir>/queries:
//   { id, name, provider, connection: { server, database?, auth },
//     sql, description? }
// where auth is 'integrated' or { user, password }. It is written by whoever
// administers the shop (hand-edited or PUT); the web UI only lists and runs
// them.
//
// READ-ONLY GUARD. Before any SQL reaches a database, the query must be a
// single statement starting with SELECT or WITH, with no statement-position
// writer keyword and no INTO. The files are the operator's, so this is defence
// in depth against an edit that was not thought through — not a sandbox.
//
// The URL id is the address; the body own id is what gets stored, and they
// must agree. Trusting the body alone would let a mistyped URL quietly
// overwrite a different query.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = name => {
    const hit = args.find(a => a === name || a.startsWith(`${name}=`));
    return hit ? (hit.includes('=') ? hit.split('=').slice(1).join('=') : true) : undefined;
};

export const DEFAULT_PORT = 9184;

/** Providers this server knows, and whether it can actually run them. */
export const PROVIDERS = { sqlserver: true, postgres: false };

/** Rows past this are dropped and the answer says so. Matches the cap the
 *  rest of the pipeline already honours (services/csvJob.ts MAX_JOB_ROWS). */
export const MAX_ROWS = 5000;

const port = parseInt(opt('--port') || String(DEFAULT_PORT), 10);
// Resolved per request, not once at import: the CLI passes --dir, and tests
// point each run at its own throwaway directory through the environment.
const dataDir = () => path.resolve(process.env.IPL_DB_DIR || String(opt('--dir') || 'db-data'));
const queriesDir = () => path.join(dataDir(), 'queries');
const bindHost = () => process.env.IPL_DB_HOST || String(opt('--host') || '127.0.0.1');
const serverToken = () => process.env.IPL_DB_TOKEN || (typeof opt('--token') === 'string' ? opt('--token') : '');

const corsHeaders = (req) => {
    const origin = req.headers?.origin;
    return {
        ...(origin ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {}),
        'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
};

const sendJson = (req, res, code, obj) => {
    res.writeHead(code, { ...corsHeaders(req), 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
};

/** Bearer check for every route except /ping. Public when no --token is set,
 *  so a single-station setup behaves exactly as before. Exported for tests. */
export const isAuthorized = (req) => {
    const token = serverToken();
    if (!token) return true;
    return (req.headers?.authorization ?? '') === `Bearer ${token}`;
};

/** Loopback check for PUT: writing a query writes credentials + SQL, so it is
 *  an on-the-machine admin act even when no --token is set. Exported for tests. */
export const isLoopback = (req) => {
    // socket.remoteAddress is the TCP peer — what actually connected, not a
    // header anyone can forge. Covers IPv4, IPv6 and IPv4-mapped IPv6.
    const peer = req.socket?.remoteAddress ?? '';
    return peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
};

/** FNV-1a 32-bit, hex. Filenames only; the record own id is the identity. */
const fileHash = (text) => {
    let hash = 0x811c9dc5;
    const bytes = Buffer.from(String(text), 'utf8');
    for (const b of bytes) {
        hash ^= b;
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
};

const queryPath = (id) => path.join(queriesDir(), `${fileHash(id)}.json`);

const readQuery = (id) => {
    try {
        return JSON.parse(fs.readFileSync(queryPath(id), 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        // Present but unreadable is a real failure: reporting it as "not
        // found" would let a save silently overwrite a query the disk could
        // not show us.
        throw err;
    }
};

const writeQuery = (id, record) => {
    fs.mkdirSync(queriesDir(), { recursive: true });
    const target = queryPath(id);
    // Write aside, then rename: a crash mid-write must leave the previous
    // version intact.
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, target);
};

const deleteQuery = (id) => {
    try {
        fs.unlinkSync(queryPath(id));
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
};

/** Every stored query. Corrupt files are skipped, not fatal. */
const listQueries = () => {
    let names = [];
    try {
        names = fs.readdirSync(queriesDir());
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
    const records = [];
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try {
            const record = JSON.parse(fs.readFileSync(path.join(queriesDir(), name), 'utf8'));
            if (record && typeof record.id === 'string') records.push(record);
        } catch { /* skip one bad file */ }
    }
    return records;
};

/**
 * What a client may see of a stored query: never the connection details.
 * The summary is what the picker lists; the definition is what it needs to
 * show a name and a description. Neither needs a password, so neither gets one.
 */
const publicQuery = (record) => ({
    id: record.id,
    name: record.name ?? record.id,
    provider: record.provider ?? 'sqlserver',
    description: record.description ?? '',
    database: record.connection?.database ?? '',
    server: record.connection?.server ?? '',
});

const readBody = (req, maxBytes) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
            reject(Object.assign(new Error(`request body exceeds ${maxBytes} bytes`), { status: 413 }));
            req.destroy();
            return;
        }
        chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
});

const MAX_BODY = 4 * 1024 * 1024;

// --- the read-only guard -----------------------------------------------------

/**
 * Keywords that change data or schema. Matched at the START of a statement
 * (after a comment or whitespace), not as substrings: a column called
 * `created_at` or a filter on 'DELETED' is ordinary SELECT text and must pass.
 */
const WRITER = /\b(insert|update|delete|drop|alter|create|truncate|merge|exec|execute|grant|revoke|deny|backup|restore|shutdown|reconfigure)\b/i;
const STATEMENT_START = /(^|;)\s*(insert|update|delete|drop|alter|create|truncate|merge|exec|execute|grant|revoke|deny|backup|restore|shutdown|reconfigure)\b/i;

/**
 * Why this query may not be run, or null when it is safe to send.
 *
 * The stored queries are the operator's own files, so this is not a sandbox —
 * it is the guard that catches an edit nobody thought through, and the reason
 * a copy/paste of "DELETE FROM ..." becomes a clear refusal instead of a
 * emptied table on a print server.
 */
export const readOnlyRefusal = (sql) => {
    const text = String(sql ?? '').trim();
    if (text === '') return 'the query is empty';

    // Comments would otherwise let `/* hi */ DELETE ...` past a start-anchored
    // check while the database still sees the DELETE.
    const stripped = text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/--[^\n\r]*/g, ' ')
        .trim();

    if (!/^(select|with)\b/i.test(stripped)) {
        return 'only a SELECT (or WITH ... SELECT) may be run from here';
    }
    // One statement. A trailing semicolon is ordinary; anything after it is
    // not, and "SELECT 1; DROP TABLE x" must not slip through as a "SELECT".
    const withoutTrailing = stripped.replace(/;\s*$/, '');
    if (withoutTrailing.includes(';')) {
        return 'only one statement may be run at a time';
    }
    if (STATEMENT_START.test(withoutTrailing) || WRITER.test(withoutTrailing)) {
        return 'the query contains a statement that changes data';
    }
    // SELECT ... INTO writes a new table.
    if (/\binto\b/i.test(withoutTrailing)) {
        return 'SELECT ... INTO creates a table, so it is not allowed';
    }
    return null;
};

// --- running a query ---------------------------------------------------------

/** One line of a child process's stderr, trimmed for a UI, nothing more. */
const firstLine = (text) => String(text ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0] ?? '';

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'query-sqlserver.ps1');

/**
 * Run one query and parse the helper's XML back into rows.
 *
 * Exported so the tests can drive it directly (and so a provider can be added
 * without touching the router).
 */
export const runStoredQuery = (record, { maxRows = MAX_ROWS, timeoutMs = 90_000 } = {}) => new Promise((resolve) => {
    const connection = record?.connection ?? {};
    const provider = record?.provider ?? 'sqlserver';

    // The guard lives HERE, at the last step before a database is touched,
    // not only in the router. A second caller (a future provider, a script, a
    // test) then cannot reach a database without passing it.
    const refusal = readOnlyRefusal(record?.sql);
    if (refusal) {
        resolve({ ok: false, refusal: true, error: `refused: ${refusal}` });
        return;
    }
    if (provider !== 'sqlserver') {
        resolve({ ok: false, error: `the ${provider} provider is not available on this server yet` });
        return;
    }
    if (!connection.server) {
        resolve({ ok: false, error: 'the stored query has no server configured' });
        return;
    }

    // The SQL goes through a FILE, never an argument: a query string mangled
    // by shell quoting is exactly how an early probe of this feature failed.
    let sqlFile;
    try {
        sqlFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ipl-dbq-')), 'query.sql');
        fs.writeFileSync(sqlFile, String(record.sql ?? ''), 'utf8');
    } catch (err) {
        resolve({ ok: false, error: `could not stage the query: ${err.message}` });
        return;
    }

    const auth = connection.auth;
    const child = spawn('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER,
        '-Instance', String(connection.server),
        ...(connection.database ? ['-Database', String(connection.database)] : []),
        ...(auth && typeof auth === 'object'
            ? ['-User', String(auth.user ?? ''), '-Password', String(auth.password ?? '')]
            : []),
        '-QueryFile', sqlFile,
        '-MaxRows', String(maxRows),
        '-TimeoutSec', String(Math.max(1, Math.round(timeoutMs / 1000))),
    ], { windowsHide: true });

    const out = [];
    const err = [];
    let failed = null;
    const timer = setTimeout(() => {
        failed = failed ?? `the query took longer than ${Math.round(timeoutMs / 1000)}s`;
        child.kill();
    }, timeoutMs);

    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', (e) => { failed = failed ?? `could not start powershell: ${e.message}`; });
    child.on('close', () => {
        clearTimeout(timer);
        fs.rmSync(path.dirname(sqlFile), { recursive: true, force: true });

        const stderr = Buffer.concat(err).toString('utf8');
        if (failed) { resolve({ ok: false, error: failed }); return; }
        const text = Buffer.concat(out).toString('utf8').trim();
        if (text === '') {
            resolve({ ok: false, error: firstLine(stderr) || 'the query returned nothing' });
            return;
        }
        try {
            resolve({ ok: true, ...parseRowsXml(text) });
        } catch (e) {
            // A malformed document means the helper broke, not the user's SQL;
            // say so rather than reporting an empty result as success.
            resolve({ ok: false, error: `could not read the query result: ${e.message}` });
        }
    });
});

const unescapeXml = (s) => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const ATTR = /([^\s=]+)="([^"]*)"/g;

/**
 * `<rows truncated="…"><columns><c name="a"/></columns><row a="1"/>…</rows>`
 * into `{columns, rows}`.
 *
 * The columns come from the document's own `<columns>`, NOT from the first
 * row's attributes: a column whose first value is NULL is omitted from that
 * row, and reading the shape off a row would drop the column entirely — every
 * later row's value for it would be silently missing, which downstream is a
 * field that prints empty. The column list is a property of the RESULT.
 *
 * A column absent from a row (a NULL) is left undefined here; `tableSource`'s
 * `cell()` reads it as '' the same way it reads any empty cell.
 */
export const parseRowsXml = (xml) => {
    const truncated = /<rows[^>]*\btruncated="true"/.test(xml);
    const columns = [];
    const columnBlock = /<columns>([\s\S]*?)<\/columns>/.exec(xml);
    if (columnBlock) {
        for (const c of columnBlock[1].matchAll(/<c\s+name="([^"]*)"\s*\/>/g)) columns.push(unescapeXml(c[1]));
    }
    const rows = [];
    for (const match of xml.matchAll(/<row\b([^>]*)\/>/g)) {
        const record = {};
        for (const attr of match[1].matchAll(ATTR)) record[unescapeXml(attr[1])] = unescapeXml(attr[2]);
        rows.push(record);
    }
    return { columns, rows, truncated, rowCount: rows.length };
};

// --- routing -----------------------------------------------------------------

/** The stored record for an id, or null. The read-only guard is NOT applied
 *  here: it belongs to the run path (and to PUT), so a query can still be
 *  listed, opened and corrected after someone wrote a bad one. */
const storedQuery = (id) => readQuery(id);

export const handleDbRequest = (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req));
        res.end();
        return;
    }
    let url;
    try {
        url = new URL(req.url, 'http://localhost');
    } catch {
        sendJson(req, res, 400, { ok: false, error: 'bad request URL' });
        return;
    }

    if (url.pathname === '/ping' && req.method === 'GET') {
        sendJson(req, res, 200, {
            ok: true, service: 'db',
            providers: Object.entries(PROVIDERS).filter(([, available]) => available).map(([name]) => name),
        });
        return;
    }

    // /ping is the only public route. Everything else needs the token when one
    // is set — and PUT additionally needs a loopback caller even without one,
    // because writing a query writes credentials + SQL (audit SEC-03).
    if (!isAuthorized(req)) {
        sendJson(req, res, 401, { ok: false, error: 'database token required (start the UI with the same token, or restart the server without --token)' });
        return;
    }

    const fail = (err) => {
        const status = err.status || 500;
        sendJson(req, res, status, { ok: false, error: err.message || String(err) });
    };

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'queries' || parts.length > 3) {
        sendJson(req, res, 404, { ok: false, error: 'unknown endpoint' });
        return;
    }

    // POST /queries/:id/run
    if (parts.length === 3 && parts[2] === 'run') {
        if (req.method !== 'POST') {
            sendJson(req, res, 405, { ok: false, error: `${req.method} not allowed on a run` });
            return;
        }
        const id = decodeURIComponent(parts[1]);
        let record;
        try {
            record = storedQuery(id);
        } catch (err) { fail(err); return; }
        if (!record) { sendJson(req, res, 404, { ok: false, error: `no query "${id}"` }); return; }
        runStoredQuery(record).then((result) => {
            if (!result.ok) {
                // A refused query is the operator's mistake and the caller's
                // to fix, so it is a 400; anything else is the database or the
                // helper failing, which is a 502.
                sendJson(req, res, result.refusal ? 400 : 502, result);
                return;
            }
            sendJson(req, res, 200, result);
        }).catch(fail);
        return;
    }

    const id = parts.length === 2 ? decodeURIComponent(parts[1]) : null;

    if (req.method === 'GET' && id === null) {
        try {
            const records = listQueries()
                .map(publicQuery)
                .sort((a, b) => String(a.name).localeCompare(String(b.name)));
            sendJson(req, res, 200, { ok: true, queries: records });
        } catch (err) { fail(err); }
        return;
    }

    if (id === null) {
        sendJson(req, res, 405, { ok: false, error: `${req.method} needs an id` });
        return;
    }

    if (req.method === 'GET') {
        try {
            const record = readQuery(id);
            if (!record) { sendJson(req, res, 404, { ok: false, error: 'not found' }); return; }
            sendJson(req, res, 200, { ok: true, query: publicQuery(record) });
        } catch (err) { fail(err); }
        return;
    }

    if (req.method === 'DELETE') {
        try {
            deleteQuery(id);
            sendJson(req, res, 200, { ok: true });
        } catch (err) { fail(err); }
        return;
    }

    if (req.method === 'PUT') {
        // Writing a query means writing a connection (server/user/password)
        // plus SQL — an admin act done on the server machine. A non-loopback
        // caller is refused even when no --token is set; the web UI never
        // calls PUT, so no legitimate flow breaks.
        if (!isLoopback(req)) {
            sendJson(req, res, 403, { ok: false, error: 'storing a query is an admin act: PUT is accepted from the server machine only (localhost)' });
            return;
        }
        readBody(req, MAX_BODY).then((bytes) => {
            let body;
            try { body = JSON.parse(bytes.toString('utf8')); } catch {
                sendJson(req, res, 400, { ok: false, error: 'body is not JSON' });
                return;
            }
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
                sendJson(req, res, 400, { ok: false, error: 'body must be a record' });
                return;
            }
            if (typeof body.id !== 'string' || body.id !== id) {
                sendJson(req, res, 400, { ok: false, error: `record id "${body.id}" does not match the URL` });
                return;
            }
            const refusal = readOnlyRefusal(body.sql);
            if (refusal) {
                sendJson(req, res, 400, { ok: false, error: `refused: ${refusal}` });
                return;
            }
            try {
                writeQuery(id, body);
                sendJson(req, res, 200, { ok: true, query: publicQuery(body) });
            } catch (err) { fail(err); }
        }).catch(fail);
        return;
    }

    sendJson(req, res, 405, { ok: false, error: `unsupported method ${req.method}` });
};

// fileURLToPath, not `new URL(...).pathname`: a pathname keeps percent-encoding,
// so a checkout under a directory with a space (or any escaped character)
// compares unequal and the CLI silently exits having listened on nothing.
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
    const server = http.createServer(handleDbRequest);
    server.on('error', (err) => {
        console.error(`[db] cannot listen on http/${port}: ${err.message}`);
        process.exit(1);
    });
    const host = bindHost();
    server.listen(port, host, () => {
        const providers = Object.entries(PROVIDERS).filter(([, on]) => on).map(([name]) => name).join(', ');
        console.log(`[db] database server on http://${host}:${port} (${providers}), queries in ${queriesDir()}`);
        if (serverToken()) console.log('[db] token auth enabled (all routes except /ping)');
        else console.log('[db] no --token: PUT additionally requires a loopback caller; list/run stay open (single-station default)');
    });
}
