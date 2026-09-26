#!/usr/bin/env node
// Shared design library server (Fase 7).
//
// The designer keeps its library in IndexedDB, which is one browser on one PC.
// A shop with several stations wants the same designs on all of them, and a
// browser cannot read a shared folder, so this is the smallest process that
// can: one HTTP server holding the library as JSON files in a directory that
// any number of stations point at.
//
// It stores exactly the records the client already builds (services/
// libraryStore.ts: LibraryRecord, SourceRecord, RecoveryRecord) and adds
// nothing of its own — the client's remoteBackend is a thin fetch wrapper, and
// this server is a thin file wrapper. Zero dependencies, like tools/
// ipl-bridge.mjs.
//
// Usage:
//   node tools/library-server.mjs                     # http://localhost:9182, data in ./library-data
//   node tools/library-server.mjs --port=9300         # custom port
//   node tools/library-server.mjs --dir=D:/shared     # a folder the whole shop can see
//
// Endpoints (all JSON, CORS open — it is a LAN tool, not an internet service):
//   GET    /ping
//   GET    /designs                 -> LibraryRecord[], newest first
//   GET    /designs/:name           -> LibraryRecord | 404
//   PUT    /designs/:name           body = LibraryRecord
//   DELETE /designs/:name
//   GET    /sources                 -> SourceRecord[], newest first
//   PUT    /sources/:name           body = SourceRecord
//   DELETE /sources/:name
//   GET    /recovery/:slot          -> RecoveryRecord | 404
//   PUT    /recovery/:slot          body = RecoveryRecord
//   DELETE /recovery/:slot
//
// The URL name is the address; the body's own `name`/`slot` is what gets
// stored, and they must agree. Trusting the body alone would let a mistyped
// URL quietly overwrite a different design.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = name => {
    const hit = args.find(a => a === name || a.startsWith(`${name}=`));
    return hit ? (hit.includes('=') ? hit.split('=').slice(1).join('=') : true) : undefined;
};

export const DEFAULT_PORT = 9182;

const port = parseInt(opt('--port') || String(DEFAULT_PORT), 10);
// Resolved per request, not once at import: the CLI passes --dir, and tests
// point each run at its own throwaway directory through the environment so
// two suites never share files.
const dataDir = () => path.resolve(process.env.IPL_LIBRARY_DIR || String(opt('--dir') || 'library-data'));

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

const sendJson = (res, code, obj) => {
    res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
};

// One subdirectory per collection. Names are never used as filenames: a design
// called "../secret" or "CON" (illegal on Windows) must store and round-trip,
// so the filename is a hash and the record's own name is the identity.
const COLLECTIONS = {
    designs: { dir: 'designs', keyOf: r => r?.name, listOrder: 'newest' },
    sources: { dir: 'sources', keyOf: r => r?.name, listOrder: 'newest' },
    recovery: { dir: 'recovery', keyOf: r => r?.slot, listOrder: 'oldest' },
};

/** FNV-1a 32-bit, hex. Filenames only — not a checksum anyone verifies. */
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
        // as "not found" would let a save silently overwrite a design the disk
        // couldn't show us.
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

/** Every stored record. Corrupt files are skipped, not fatal — one bad file
 *  must not hide the rest of the library. */
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
    const dir = collection.listOrder === 'oldest' ? 1 : -1;
    return records.sort((a, b) => ((a.updatedAt ?? 0) - (b.updatedAt ?? 0)) * dir);
};

const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    // A design carries images, but not without limit: a runaway upload must
    // fail cleanly instead of filling the disk.
    const MAX = 64 * 1024 * 1024;
    req.on('data', (c) => {
        size += c.length;
        if (size > MAX) {
            reject(Object.assign(new Error('request body exceeds 64 MB'), { status: 413 }));
            req.destroy();
            return;
        }
        chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
});

/**
 * Handle one request. Exported so tests drive the routing without binding a
 * port; the CLI below is the only thing that listens.
 *
 * Returns nothing; the response is always ended here.
 */
export const handleLibraryRequest = (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return;
    }
    let url;
    try {
        url = new URL(req.url, 'http://localhost');
    } catch {
        sendJson(res, 400, { ok: false, error: 'bad request URL' });
        return;
    }

    if (url.pathname === '/ping' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, service: 'library' });
        return;
    }

    const parts = url.pathname.split('/').filter(Boolean);
    const collection = COLLECTIONS[parts[0]];
    if (!collection || parts.length > 2) {
        sendJson(res, 404, { ok: false, error: 'unknown endpoint' });
        return;
    }
    const key = parts.length === 2 ? decodeURIComponent(parts[1]) : null;

    const fail = (err) => {
        const status = err.status || 500;
        sendJson(res, status, { ok: false, error: err.message || String(err) });
    };

    if (req.method === 'GET' && key === null) {
        try {
            sendJson(res, 200, { ok: true, records: listRecords(collection) });
        } catch (err) { fail(err); }
        return;
    }

    if (key === null) {
        sendJson(res, 405, { ok: false, error: `${req.method} needs a name` });
        return;
    }

    if (req.method === 'GET') {
        try {
            const record = readRecord(collection, key);
            if (!record) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
            sendJson(res, 200, { ok: true, record });
        } catch (err) { fail(err); }
        return;
    }

    if (req.method === 'DELETE') {
        try {
            deleteRecord(collection, key);
            sendJson(res, 200, { ok: true });
        } catch (err) { fail(err); }
        return;
    }

    if (req.method === 'PUT') {
        readBody(req).then((text) => {
            let body;
            try { body = JSON.parse(text); } catch {
                sendJson(res, 400, { ok: false, error: 'body is not JSON' });
                return;
            }
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
                sendJson(res, 400, { ok: false, error: 'body must be a record' });
                return;
            }
            const bodyKey = collection.keyOf(body);
            if (typeof bodyKey !== 'string' || bodyKey !== key) {
                sendJson(res, 400, { ok: false, error: `record name "${bodyKey}" does not match the URL` });
                return;
            }
            try {
                writeRecord(collection, key, body);
                sendJson(res, 200, { ok: true });
            } catch (err) { fail(err); }
        }).catch(fail);
        return;
    }

    sendJson(res, 405, { ok: false, error: `unsupported method ${req.method}` });
};

// fileURLToPath, not `new URL(...).pathname`: a pathname keeps percent-encoding,
// so a checkout under a directory with a space (or any escaped character)
// compares unequal and the CLI silently exits having listened on nothing.
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
    const server = http.createServer(handleLibraryRequest);
    server.on('error', (err) => {
        console.error(`[library] cannot listen on http/${port}: ${err.message}`);
        process.exit(1);
    });
    server.listen(port, () => {
        console.log(`[library] shared design library on http://localhost:${port}, storing in ${dataDir()}`);
    });
}
