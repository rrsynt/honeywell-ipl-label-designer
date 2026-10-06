#!/usr/bin/env node
// Shared print server (Fase 7).
//
// tools/ipl-bridge.mjs forwards one stream and forgets it, so a shop with five
// stations runs five bridges and none of them knows what the others printed.
// This is that bridge with a memory: one process on the LAN holds the print
// queue, the printer list and the print log as JSON files, and it is the only
// thing that opens a socket to a printer.
//
// The contract that matters is the acknowledgement. A chunk is recorded as
// accepted ONLY after the printer socket flushed the bytes, the same moment
// the bridge reports `written`. Before that, a failure is a failure and the
// chunk was not printed. That is the one fact the browser cannot know (its
// fetch times out while the bridge may already be forwarding), and it is why
// services/printQueue.ts warns that a retry may print a chunk twice. A job run
// through here does not need that warning: the accepted count is exact.
//
// It stores the client records (services/printQueue.ts PrintJob and
// PrintLogEntry, services/printTargets.ts PrintTarget) and adds nothing of its
// own. Zero dependencies, like the bridge and the library server.
//
// Usage:
//   node tools/print-server.mjs                    # http://127.0.0.1:9183, data in ./print-data
//   node tools/print-server.mjs --port=9300        # custom port
//   node tools/print-server.mjs --dir=D:/shared    # a folder the whole shop can see
//   node tools/print-server.mjs --host=0.0.0.0 --token=s3cret
//                                                  # serve the LAN, but only to token holders
//
// Hardening (audit SEC-01/SEC-02, 2026-10-06):
//   --host   HTTP listen address. Default 127.0.0.1 (this machine only); pass
//            --host=0.0.0.0 explicitly to serve the LAN.
//   --token  When set, every route except /ping requires
//            `Authorization: Bearer <token>`. Without it the server keeps its
//            old behaviour, so a single-station setup needs no token at all.
//   CORS     Echoes the request Origin instead of `*`, so a token-bearing
//            browser cannot be driven cross-origin by a stranger site.
//
// Endpoints (all JSON; CORS echoes the caller Origin):
//   GET    /ping
//   GET    /jobs                    -> PrintJob[], newest first
//   GET    /jobs/:id                -> PrintJob | 404
//   PUT    /jobs/:id                body = PrintJob
//   DELETE /jobs/:id
//   GET    /targets                 -> PrintTarget[], name sorted
//   PUT    /targets/:id             body = PrintTarget
//   DELETE /targets/:id
//   GET    /log                     -> PrintLogEntry[], newest first
//   POST   /log                     body = PrintLogEntry (the server stamps the id)
//   DELETE /log/:id
//   POST   /jobs/:id/chunk?seq=N    body = raw printer bytes
//                                      -> { ok:true,  accepted }  the chunk flushed
//                                      -> { ok:false, accepted }  it did NOT
//                                   `accepted` is how many chunks this server
//                                   has flushed for the job, and it only ever
//                                   grows. The client sends chunk number
//                                   `accepted` next.
//
//                                   The rule is one line: a chunk FLUSHES only
//                                   when `seq === accepted`. A chunk behind the
//                                   count is refused (it already printed, and
//                                   `ok:true` here would have to mean "these
//                                   bytes printed", which would be false), and
//                                   so is one ahead of it (that would leave a
//                                   hole). Both are 409 carrying the true
//                                   count, so a caller that is out of step
//                                   learns where it really is instead of
//                                   being told a comfortable lie.
//
// The URL id is the address; the body own id is what gets stored, and they
// must agree. Trusting the body alone would let a mistyped URL quietly
// overwrite a different job.
//
// What this server does NOT check, because it cannot: that the bytes of chunk
// N really are chunk N. It holds the job's target and its count, not its
// content (a 5000-row job is megabytes). Same trust boundary as the library
// server, and deliberate rather than missing.

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = name => {
    const hit = args.find(a => a === name || a.startsWith(`${name}=`));
    return hit ? (hit.includes('=') ? hit.split('=').slice(1).join('=') : true) : undefined;
};

export const DEFAULT_PORT = 9183;

const port = parseInt(opt('--port') || String(DEFAULT_PORT), 10);
// Resolved per request, not once at import: the CLI passes --dir, and tests
// point each run at its own throwaway directory through the environment so
// two suites never share files.
const dataDir = () => path.resolve(process.env.IPL_PRINT_DIR || String(opt('--dir') || 'print-data'));
const bindHost = () => process.env.IPL_PRINT_HOST || String(opt('--host') || '127.0.0.1');
const serverToken = () => process.env.IPL_PRINT_TOKEN || (typeof opt('--token') === 'string' ? opt('--token') : '');

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

const unauthorized = (req, res) =>
    sendJson(req, res, 401, { ok: false, error: 'print server token required (start the UI with the same token, or restart the server without --token)' });

// One subdirectory per collection. Ids are never used as filenames: a job id
// with a slash or a Windows-illegal name must store and round-trip, so the
// filename is a hash and the record own id is the identity.
const COLLECTIONS = {
    jobs: { dir: 'jobs', keyOf: r => r?.id, order: 'newest' },
    targets: { dir: 'targets', keyOf: r => r?.id, order: 'name' },
    log: { dir: 'log', keyOf: r => r?.id, order: 'newest' },
};

/** FNV-1a 32-bit, hex. Filenames only; not a checksum anyone verifies. */
const fileHash = (text) => {
    let hash = 0x811c9dc5;
    const bytes = Buffer.from(String(text), 'utf8');
    for (const b of bytes) {
        hash ^= b;
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
};

const collectionDir = (collection) => path.join(dataDir(), collection.dir);

const recordPath = (collection, key) => path.join(collectionDir(collection), `${fileHash(key)}.json`);

const readRecord = (collection, key) => {
    try {
        return JSON.parse(fs.readFileSync(recordPath(collection, key), 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        // A file that is present but unreadable is a real failure: reporting it
        // as "not found" would let a save silently overwrite a job the disk
        // could not show us.
        throw err;
    }
};

const writeRecord = (collection, key, record) => {
    const dir = collectionDir(collection);
    fs.mkdirSync(dir, { recursive: true });
    const target = recordPath(collection, key);
    // Write aside, then rename: a crash mid-write must leave the previous
    // version intact, not a half-written JSON the client would refuse to open.
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, target);
};

const deleteRecord = (collection, key) => {
    try {
        fs.unlinkSync(recordPath(collection, key));
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
};

/** Every stored record. Corrupt files are skipped, not fatal: one bad file
 *  must not hide the rest of the queue. */
const listRecords = (collection) => {
    let names = [];
    try {
        names = fs.readdirSync(collectionDir(collection));
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
    const records = [];
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try {
            const record = JSON.parse(fs.readFileSync(path.join(collectionDir(collection), name), 'utf8'));
            if (record && typeof collection.keyOf(record) === 'string') records.push(record);
        } catch { /* skip one bad file */ }
    }
    if (collection.order === 'name') {
        return records.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
    }
    const stamp = r => r.createdAt ?? r.at ?? r.updatedAt ?? 0;
    const dir = collection.order === 'oldest' ? 1 : -1;
    return records.sort((a, b) => (stamp(a) - stamp(b)) * dir);
};

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

/**
 * Write a stream to a printer socket and report whether it FLUSHED.
 *
 * Same rules as tools/ipl-bridge.mjs, and they matter here for the same
 * reason: a silent failure that reports success puts a chunk in the
 * `accepted` count that never reached the media, and the queue would then
 * refuse to ever resend it. So a stalled connection is a failure, an error is
 * a failure, and success is claimed only after `end()`'s callback says the
 * buffer left for the kernel.
 */
const forwardToPrinter = (host, port, payload, ms) => new Promise(resolve => {
    let settled = false;
    let flushed = false;
    let socket;
    // net.createConnection throws SYNCHRONOUSLY on an out-of-range port
    // (RangeError); inside a promise executor that becomes an unhandled
    // rejection and kills the daemon.
    try {
        socket = net.createConnection({ host, port });
    } catch (err) {
        resolve({ ok: false, error: String(err.message || err) });
        return;
    }
    const done = result => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(result);
    };
    socket.setTimeout(ms, () => done(flushed
        ? { ok: true, written: payload.length }
        : { ok: false, error: `no response from ${host}:${port} within ${ms}ms` }));
    socket.on('error', err => done({ ok: false, error: String(err.message || err) }));
    socket.on('connect', () => {
        socket.end(payload, () => {
            flushed = true;
            setTimeout(() => done({ ok: true, written: payload.length }), Math.min(ms, 500));
        });
    });
    socket.on('close', () => {
        if (flushed) done({ ok: true, written: payload.length });
    });
});

const MAX_BODY = 64 * 1024 * 1024;

/** A log id, since the server is the one that assigns them. */
const logId = () => `l${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`;

/**
 * Handle one request. Exported so tests drive the routing without binding a
 * port; the CLI below is the only thing that listens.
 *
 * Returns nothing; the response is always ended here.
 */
export const handlePrintRequest = (req, res) => {
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
        sendJson(req, res, 200, { ok: true, service: 'print' });
        return;
    }

    // /ping is the only public route: liveness must work before the UI knows
    // any token. Everything else — queue, targets, log, chunks — is LAN-powerful.
    if (!isAuthorized(req)) { unauthorized(req, res); return; }

    const fail = (err) => {
        const status = err.status || 500;
        sendJson(req, res, status, { ok: false, error: err.message || String(err) });
    };

    const parts = url.pathname.split('/').filter(Boolean);

    // POST /jobs/:id/chunk?seq=N — the whole reason this server exists.
    if (parts[0] === 'jobs' && parts[2] === 'chunk') {
        if (req.method !== 'POST') {
            sendJson(req, res, 405, { ok: false, error: `${req.method} not allowed on a chunk` });
            return;
        }
        handleChunk(req, res, decodeURIComponent(parts[1] ?? ''), url.searchParams.get('seq'), fail);
        return;
    }

    const collection = COLLECTIONS[parts[0]];
    if (!collection || parts.length > 2) {
        sendJson(req, res, 404, { ok: false, error: 'unknown endpoint' });
        return;
    }
    const key = parts.length === 2 ? decodeURIComponent(parts[1]) : null;

    // POST /log is a COLLECTION call: the client builds the entry and the
    // server assigns the id it will be addressed by, exactly as the header
    // promises. It has to be handled BEFORE the missing-id guard below, which
    // would otherwise answer 405 to every log append.
    if (req.method === 'POST' && collection === COLLECTIONS.log && key === null) {
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
            try {
                const record = { ...body, id: logId() };
                writeRecord(collection, record.id, record);
                sendJson(req, res, 200, { ok: true, id: record.id });
            } catch (err) { fail(err); }
        }).catch(fail);
        return;
    }

    if (req.method === 'GET' && key === null) {
        try {
            sendJson(req, res, 200, { ok: true, records: listRecords(collection) });
        } catch (err) { fail(err); }
        return;
    }

    if (key === null) {
        sendJson(req, res, 405, { ok: false, error: `${req.method} needs an id` });
        return;
    }

    if (req.method === 'GET') {
        try {
            const record = readRecord(collection, key);
            if (!record) { sendJson(req, res, 404, { ok: false, error: 'not found' }); return; }
            sendJson(req, res, 200, { ok: true, record });
        } catch (err) { fail(err); }
        return;
    }

    if (req.method === 'DELETE') {
        try {
            deleteRecord(collection, key);
            sendJson(req, res, 200, { ok: true });
        } catch (err) { fail(err); }
        return;
    }

    if (req.method === 'PUT') {
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
            const bodyKey = collection.keyOf(body);
            if (typeof bodyKey !== 'string' || bodyKey !== key) {
                sendJson(req, res, 400, { ok: false, error: `record id "${bodyKey}" does not match the URL` });
                return;
            }
            try {
                writeWithFloor(collection, key, body);
                sendJson(req, res, 200, { ok: true });
            } catch (err) { fail(err); }
        }).catch(fail);
        return;
    }

    sendJson(req, res, 405, { ok: false, error: `unsupported method ${req.method}` });
};

/**
 * Store a record, but never let it move BACKWARDS on progress.
 *
 * `sentChunks` is what the chunk endpoint acknowledges, and it is the one
 * field this server owns. A client that read the job before a chunk was
 * accepted and then writes it back would otherwise roll the count down — and
 * the next run would reprint chunks the printer already has. Monotonicity is
 * enforced here, at the only place a client can write, rather than trusted to
 * every caller.
 */
const writeWithFloor = (collection, key, record) => {
    const stored = readRecord(collection, key);
    const floor = Number(stored?.sentChunks);
    const merged = Number.isFinite(floor) && Number(record.sentChunks) < floor
        ? { ...record, sentChunks: floor }
        : record;
    writeRecord(collection, key, merged);
    return merged;
};

/**
 * One ack in flight per job.
 *
 * The check-then-flush-then-bump is asynchronous (the socket write is awaited),
 * so two stations resuming the SAME job would both read `accepted: 0`, both
 * flush chunk 0, and both record `1` — two copies of the chunk on the media
 * and a count that hides one of them. That is precisely the double print this
 * server exists to remove, so the sequence is chained per job id instead of
 * merely hoping requests do not overlap.
 */
const ackChain = new Map();

const serializePerJob = (jobId, work) => {
    const previous = ackChain.get(jobId) ?? Promise.resolve();
    // catch() so a rejection from one ack cannot poison the chain for the next.
    const next = previous.then(work, work);
    ackChain.set(jobId, next.catch(() => undefined));
    return next;
};

/**
 * The acknowledgement: read the job, decide, and only then touch a socket.
 *
 *   seq !== accepted   refuse with the true count, having sent NO bytes
 *   seq === accepted   forward once, and bump only if the socket flushed
 *
 * `accepted` is the job's own `sentChunks`, and it is the only place this
 * server owns a number the client also writes. It is never lowered here, and
 * `writeWithFloor` keeps a stale client PUT from lowering it either.
 */
const acceptChunk = async (req, res, jobId, seq, payload, fail) => {
    let job;
    try {
        job = readRecord(COLLECTIONS.jobs, jobId);
    } catch (err) { fail(err); return; }
    if (!job) {
        sendJson(req, res, 404, { ok: false, accepted: 0, error: `no job "${jobId}"` });
        return;
    }
    const accepted = Number.isFinite(Number(job.sentChunks)) ? Number(job.sentChunks) : 0;

    if (seq !== accepted) {
        const behind = seq < accepted;
        sendJson(req, res, 409, {
            ok: false, accepted,
            error: behind
                ? `chunk ${seq} was already accepted — this server has flushed ${accepted} chunk(s)`
                : `chunk ${seq} is ahead of ${accepted} — the queue has a hole`,
        });
        return;
    }
    if (payload.length === 0) {
        sendJson(req, res, 400, { ok: false, accepted, error: 'empty chunk body' });
        return;
    }

    // Where it prints comes from the STORED job, never from the request.
    // Trusting a query parameter would turn this server into a relay that
    // anyone on the LAN could aim at an arbitrary machine.
    const host = job.target?.host;
    const port = parseInt(String(job.target?.port ?? ''), 10);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        sendJson(req, res, 502, {
            ok: false, accepted,
            error: `job "${jobId}" has no usable printer target (${job.target?.host}:${job.target?.port})`,
        });
        return;
    }

    const result = await forwardToPrinter(host, port, payload, 5000);
    if (!result.ok) {
        // `accepted` is untouched, and that is a fact rather than a guess: the
        // bytes did not flush, so the chunk did not print. Saying otherwise
        // would make the queue skip it forever.
        sendJson(req, res, 502, { ok: false, accepted, error: result.error });
        return;
    }

    // The chunk IS on the media now, so the count has to be recorded or the
    // queue would resend it. A disk that refuses the write leaves the two
    // sides disagreeing about a label that really printed, which the caller
    // has to see rather than be told "sent".
    const next = accepted + 1;
    try {
        writeRecord(COLLECTIONS.jobs, jobId, { ...job, sentChunks: next, updatedAt: Date.now() });
    } catch (err) {
        fail(err);
        return;
    }
    sendJson(req, res, 200, { ok: true, accepted: next, written: result.written, bytes: payload.length });
};

const handleChunk = (req, res, jobId, rawSeq, fail) => {
    // A MISSING seq is not seq 0. Number(null) is 0, and Number('') is 0, so
    // without this an empty query would print a job's first chunk — the one
    // case where being lenient writes ink.
    const missing = rawSeq === null || rawSeq === undefined || String(rawSeq).trim() === '';
    const seq = missing ? NaN : Number(rawSeq);
    if (!Number.isInteger(seq) || seq < 0) {
        sendJson(req, res, 400, { ok: false, accepted: 0, error: `invalid seq "${rawSeq}" — must be a non-negative integer` });
        return;
    }
    readBody(req, MAX_BODY)
        .then((payload) => serializePerJob(jobId, () => acceptChunk(req, res, jobId, seq, payload, fail)))
        .catch(fail);
};

/**
 * NOW-5 (audit PRINT-01, 2026-10-06): one data directory, one server. The ack
 * chain (`ackChain`) lives in memory, so two server processes on the same
 * `--dir` both read `sentChunks: 0`, both flush chunk 0, and both record `1` —
 * two copies of the chunk on the media with a count that hides one of them.
 * The pid-file below refuses the second process instead of double-printing.
 *
 * Stale locks (a killed process that never cleaned up) are reclaimed: a lock
 * whose pid no longer exists is overwritten with a warning, not honoured.
 * Exported so tests can prove both halves against a throwaway directory.
 */
export const acquireDataDirLock = (dir) => {
    const lockPath = path.join(dir, 'server.lock');
    fs.mkdirSync(dir, { recursive: true });
    try {
        fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
        return { lockPath, reclaimed: false };
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;
    }
    let owner = '';
    try { owner = fs.readFileSync(lockPath, 'utf8').trim(); } catch { owner = ''; }
    const ownerPid = parseInt(owner, 10);
    let alive = Number.isInteger(ownerPid) && ownerPid > 0;
    if (alive) {
        try { process.kill(ownerPid, 0); }
        catch { alive = false; } // ESRCH: no such process — the lock is stale.
    }
    if (alive) {
        throw Object.assign(
            new Error(`another print server (pid ${ownerPid}) already holds ${dir} — start this one with a different --dir`),
            { code: 'ELOCKED' },
        );
    }
    fs.writeFileSync(lockPath, String(process.pid));
    return { lockPath, reclaimed: true, previousOwner: owner || undefined };
};

export const releaseDataDirLock = (lockPath) => {
    try { fs.unlinkSync(lockPath); } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
};

// fileURLToPath, not `new URL(...).pathname`: a pathname keeps percent-encoding,
// so a checkout under a directory with a space (or any escaped character)
// compares unequal and the CLI silently exits having listened on nothing.
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
    let lock;
    try {
        lock = acquireDataDirLock(dataDir());
        if (lock.reclaimed) {
            console.log(`[print] reclaimed a stale lock${lock.previousOwner ? ` (previous owner ${lock.previousOwner})` : ''} in ${dataDir()}`);
        }
    } catch (err) {
        console.error(`[print] ${err.message}`);
        process.exit(1);
    }
    const dropLock = () => releaseDataDirLock(lock.lockPath);
    process.on('exit', dropLock);
    process.on('SIGINT', () => { dropLock(); process.exit(0); });
    process.on('SIGTERM', () => { dropLock(); process.exit(0); });
    const server = http.createServer(handlePrintRequest);
    server.on('error', (err) => {
        console.error(`[print] cannot listen on http/${port}: ${err.message}`);
        process.exit(1);
    });
    const host = bindHost();
    server.listen(port, host, () => {
        console.log(`[print] shared print server on http://${host}:${port}, storing in ${dataDir()}`);
        if (serverToken()) console.log('[print] token auth enabled (all routes except /ping)');
        else console.log('[print] no --token: LAN callers can read and write the queue (single-station default)');
    });
}
