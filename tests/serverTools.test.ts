// NOW-5 (2026-10-06): the four bare-Node servers had ZERO test coverage —
// regressions in the HTTP contract (the queue, the library, the bridge) could
// only be found by running the shop. These drive the real handlers on random
// ports against throwaway directories (the IPL_*_DIR env pattern each server
// already honours), plus the print-server data-dir lock that keeps two
// processes from double-printing one directory.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { handleBridgeRequest } from '../tools/ipl-bridge.mjs';
import { handleLibraryRequest } from '../tools/library-server.mjs';
import { handlePrintRequest, acquireDataDirLock, releaseDataDirLock } from '../tools/print-server.mjs';
import { handleDbRequest } from '../tools/db-server.mjs';

const start = async (handler: (req: any, res: any) => void): Promise<{ server: http.Server; base: string }> => {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('test server failed to bind');
    return { server, base: `http://127.0.0.1:${addr.port}` };
};

const stop = (server: http.Server): Promise<void> =>
    new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

const call = (base: string, method: string, urlPath: string, body?: Buffer | string): Promise<{ status: number; json: any; raw: string }> =>
    new Promise((resolve, reject) => {
        const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
        const req = http.request(`${base}${urlPath}`, {
            method,
            headers: payload ? { 'Content-Type': 'application/octet-stream', 'Content-Length': String(payload.length) } : {},
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null, raw });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });

const callJson = (base: string, method: string, urlPath: string, body?: unknown) =>
    call(base, method, urlPath, body === undefined ? undefined : JSON.stringify(body));

describe('bridge: ping, port validation, capture-mode refusal', () => {
    let base = '';
    let server: http.Server;
    beforeAll(async () => { ({ server, base } = await start(handleBridgeRequest)); });
    afterAll(async () => { await stop(server); });

    it('answers /ping', async () => {
        const r = await call(base, 'GET', '/ping');
        expect(r.status).toBe(200);
        expect(r.json.ok).toBe(true);
    });

    it('rejects an invalid printer port instead of crashing the daemon', async () => {
        const r = await call(base, 'POST', '/send?host=localhost&port=banana', 'x');
        expect(r.status).toBe(400);
        expect(r.json.error).toMatch(/invalid port/);
    });

    it('reports an unreachable printer as failure, not success', async () => {
        // Port 1 is never a printer; a dead IP used to report {ok:true}.
        const r = await call(base, 'POST', '/send?host=127.0.0.1&port=1&ms=300', 'x');
        expect(r.status).toBe(502);
        expect(r.json.ok).toBe(false);
    });

    it('unknown endpoints are 404 JSON, not a hang', async () => {
        const r = await call(base, 'GET', '/nope');
        expect(r.status).toBe(404);
    });
});

describe('library: PUT/GET round-trip, id mismatch, unknown 404', () => {
    let base = '';
    let server: http.Server;
    let dir = '';
    const savedEnv = process.env.IPL_LIBRARY_DIR;
    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipl-lib-'));
        process.env.IPL_LIBRARY_DIR = dir;
        ({ server, base } = await start(handleLibraryRequest));
    });
    afterAll(async () => {
        await stop(server);
        if (savedEnv === undefined) delete process.env.IPL_LIBRARY_DIR;
        else process.env.IPL_LIBRARY_DIR = savedEnv;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('stores and returns a design', async () => {
        const put = await callJson(base, 'PUT', '/designs/Ship', { name: 'Ship', design: { a: 1 } });
        expect(put.status).toBe(200);
        const get = await call(base, 'GET', '/designs/Ship');
        expect(get.status).toBe(200);
        expect(get.json.record.design).toEqual({ a: 1 });
    });

    it('refuses a body whose id disagrees with the URL', async () => {
        const r = await callJson(base, 'PUT', '/designs/A', { name: 'B' });
        expect(r.status).toBe(400);
        expect(r.json.error).toMatch(/does not match/);
    });

    it('a slash in the id still round-trips (hashed filenames)', async () => {
        const put = await callJson(base, 'PUT', `/designs/${encodeURIComponent('a/b')}`, { name: 'a/b', design: {} });
        expect(put.status).toBe(200);
        const get = await call(base, 'GET', `/designs/${encodeURIComponent('a/b')}`);
        expect(get.status).toBe(200);
    });

    it('DELETE removes, second GET is 404', async () => {
        await callJson(base, 'PUT', '/designs/Temp', { name: 'Temp' });
        expect((await call(base, 'DELETE', '/designs/Temp')).status).toBe(200);
        expect((await call(base, 'GET', '/designs/Temp')).status).toBe(404);
    });
});

describe('print server: queue CRUD, seq rules, stored-target rule', () => {
    let base = '';
    let server: http.Server;
    let dir = '';
    const savedEnv = process.env.IPL_PRINT_DIR;
    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipl-print-'));
        process.env.IPL_PRINT_DIR = dir;
        ({ server, base } = await start(handlePrintRequest));
    });
    afterAll(async () => {
        await stop(server);
        if (savedEnv === undefined) delete process.env.IPL_PRINT_DIR;
        else process.env.IPL_PRINT_DIR = savedEnv;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const job = (id: string, over: Record<string, unknown> = {}) => ({
        id, createdAt: 1, sentChunks: 0,
        target: { host: '127.0.0.1', port: 1 }, // nothing listens: flush FAILS, count stays
        ...over,
    });

    it('answers /ping', async () => {
        expect((await call(base, 'GET', '/ping')).status).toBe(200);
    });

    it('a chunk behind the count is refused with the true count, sending no bytes', async () => {
        await callJson(base, 'PUT', '/jobs/j1', job('j1'));
        const r = await call(base, 'POST', '/jobs/j1/chunk?seq=5', 'bytes');
        expect(r.status).toBe(409);
        expect(r.json.accepted).toBe(0);
        expect(r.json.ok).toBe(false);
    });

    it('a missing seq is not seq 0 — it must not print the first chunk', async () => {
        await callJson(base, 'PUT', '/jobs/j2', job('j2'));
        const r = await call(base, 'POST', '/jobs/j2/chunk', 'bytes');
        expect(r.status).toBe(400);
        expect(r.json.error).toMatch(/invalid seq/);
    });

    it('an empty chunk is refused without touching the count', async () => {
        await callJson(base, 'PUT', '/jobs/j3', job('j3'));
        const r = await call(base, 'POST', '/jobs/j3/chunk?seq=0', '');
        expect(r.status).toBe(400);
        const back = await call(base, 'GET', '/jobs/j3');
        expect(back.json.record.sentChunks).toBe(0);
    });

    it('a failed flush leaves the count untouched (502, accepted 0)', async () => {
        await callJson(base, 'PUT', '/jobs/j4', job('j4'));
        const r = await call(base, 'POST', '/jobs/j4/chunk?seq=0', 'bytes');
        expect(r.status).toBe(502);
        expect(r.json.accepted).toBe(0);
        const back = await call(base, 'GET', '/jobs/j4');
        expect(back.json.record.sentChunks).toBe(0);
    });

    it('a stale client PUT cannot roll sentChunks backwards', async () => {
        await callJson(base, 'PUT', '/jobs/j5', job('j5', { sentChunks: 3 }));
        const r = await callJson(base, 'PUT', '/jobs/j5', job('j5', { sentChunks: 0 }));
        expect(r.status).toBe(200);
        const back = await call(base, 'GET', '/jobs/j5');
        expect(back.json.record.sentChunks).toBe(3);
    });

    it('the happy path: chunk flushes to a real socket and the count grows', async () => {
        // A fake printer that accepts one connection then closes.
        const printer = net.createServer((sock) => { sock.on('data', () => undefined); sock.on('end', () => sock.end()); });
        await new Promise<void>((resolve) => printer.listen(0, '127.0.0.1', resolve));
        const port = (printer.address() as net.AddressInfo).port;
        try {
            await callJson(base, 'PUT', '/jobs/j6', job('j6', { target: { host: '127.0.0.1', port } }));
            const r = await call(base, 'POST', '/jobs/j6/chunk?seq=0', 'hello-printer');
            expect(r.status).toBe(200);
            expect(r.json).toMatchObject({ ok: true, accepted: 1 });
            const behind = await call(base, 'POST', '/jobs/j6/chunk?seq=0', 'again');
            expect(behind.status).toBe(409);
            expect(behind.json.accepted).toBe(1);
        } finally {
            await new Promise<void>((resolve) => printer.close(() => resolve()));
        }
    });
});

describe('db server: no connection string ever reaches the browser', () => {
    let base = '';
    let server: http.Server;
    let dir = '';
    const savedEnv = process.env.IPL_DB_DIR;
    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipl-dbq-'));
        process.env.IPL_DB_DIR = dir;
        ({ server, base } = await start(handleDbRequest));
    });
    afterAll(async () => {
        await stop(server);
        if (savedEnv === undefined) delete process.env.IPL_DB_DIR;
        else process.env.IPL_DB_DIR = savedEnv;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('PUT stores a query, GET strips the connection before responding', async () => {
        const body = {
            id: 'q1', name: 'Lots', provider: 'sqlserver',
            connection: { server: 'db', database: 'shop', user: 'u', password: 's3cret' },
            sql: 'SELECT lot FROM lots',
        };
        expect((await callJson(base, 'PUT', '/queries/q1', body)).status).toBe(200);
        const one = await call(base, 'GET', '/queries/q1');
        expect(one.status).toBe(200);
        expect(JSON.stringify(one.json)).not.toContain('s3cret');
        const all = await call(base, 'GET', '/queries');
        expect(JSON.stringify(all.json)).not.toContain('s3cret');
    });

    it('a non-SELECT is refused at PUT time', async () => {
        const r = await callJson(base, 'PUT', '/queries/evil', {
            id: 'evil', name: 'Evil', provider: 'sqlserver', connection: {}, sql: 'DROP TABLE lots',
        });
        expect(r.status).toBe(400);
        expect(r.json.error).toMatch(/refused/i);
    });
});

describe('print-server data-dir lock: two processes, one directory', () => {
    it('a second acquire on a live lock throws ELOCKED', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipl-lock-'));
        try {
            const first = acquireDataDirLock(dir);
            expect(fs.existsSync(path.join(dir, 'server.lock'))).toBe(true);
            let err: any = null;
            try { acquireDataDirLock(dir); } catch (e) { err = e; }
            expect(err?.code).toBe('ELOCKED');
            expect(String(err?.message)).toMatch(/already holds/);
            releaseDataDirLock(first.lockPath);
            // After release the directory is claimable again.
            const second = acquireDataDirLock(dir);
            releaseDataDirLock(second.lockPath);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a stale lock (dead pid) is reclaimed, not honoured', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipl-lock-'));
        try {
            fs.writeFileSync(path.join(dir, 'server.lock'), '999999999');
            const got = acquireDataDirLock(dir);
            expect(got.reclaimed).toBe(true);
            releaseDataDirLock(got.lockPath);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a real second process exits 1 instead of serving the same dir', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipl-lock-'));
        // Occupy the lock in THIS process, so the child must refuse.
        const held = acquireDataDirLock(dir);
        try {
            const child = spawn(process.execPath, ['tools/print-server.mjs', '--port=0', `--dir=${dir}`], { stdio: ['ignore', 'pipe', 'pipe'] });
            let stderr = '';
            child.stderr.on('data', (c) => { stderr += c.toString(); });
            const code: number = await new Promise((resolve) => {
                const timer = setTimeout(() => { child.kill(); resolve(999); }, 15000);
                child.on('exit', (c) => { clearTimeout(timer); resolve(c ?? 999); });
            });
            expect(code).toBe(1);
            expect(stderr).toMatch(/already holds/);
        } finally {
            releaseDataDirLock(held.lockPath);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
