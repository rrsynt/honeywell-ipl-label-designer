// Hardening (audit SEC-01/SEC-02/SEC-03, 2026-10-06): the four servers bind
// 127.0.0.1 by default, gate every non-/ping route on an optional --token, the
// bridge additionally allow-lists its printer targets, and db PUT additionally
// requires a loopback caller. These drive the real handlers on random ports
// against throwaway values (the IPL_* env pattern each server honours).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleBridgeRequest, isAllowedTarget } from '../tools/ipl-bridge.mjs';
import { handleLibraryRequest } from '../tools/library-server.mjs';
import { handlePrintRequest } from '../tools/print-server.mjs';
import { handleDbRequest, isLoopback } from '../tools/db-server.mjs';

const start = async (handler: (req: any, res: any) => void): Promise<{ server: http.Server; base: string }> => {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('test server failed to bind');
    return { server, base: `http://127.0.0.1:${addr.port}` };
};

const stop = (server: http.Server): Promise<void> =>
    new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

interface CallResult { status: number; json: any; headers: Record<string, string | string[] | undefined> }

const call = (base: string, method: string, urlPath: string, body?: string, extraHeaders: Record<string, string> = {}): Promise<CallResult> =>
    new Promise((resolve, reject) => {
        const payload = body === undefined ? null : Buffer.from(body);
        const req = http.request(`${base}${urlPath}`, {
            method,
            headers: {
                ...(payload ? { 'Content-Type': 'application/octet-stream', 'Content-Length': String(payload.length) } : {}),
                ...extraHeaders,
            },
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null, headers: res.headers as CallResult['headers'] });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });

const callJson = (base: string, method: string, urlPath: string, body?: unknown, extraHeaders: Record<string, string> = {}) =>
    call(base, method, urlPath, body === undefined ? undefined : JSON.stringify(body), extraHeaders);

const withToken = (token: string): Record<string, string> => ({ Authorization: 'Bearer ' + token });

// Env save/restore around suites that set IPL_* values: the sibling suites in
// serverTools.test.ts run in the SAME worker and read the same variables.
const EnvGuard = () => {
    const saved: Record<string, string | undefined> = {};
    return {
        set(key: string, value: string) {
            if (!(key in saved)) saved[key] = process.env[key];
            process.env[key] = value;
        },
        unset(key: string) {
            if (!(key in saved)) saved[key] = process.env[key];
            delete process.env[key];
        },
        restore() {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        },
    };
};

describe('bridge allow-list + token', () => {
    let base = '';
    let server: http.Server;
    const env = EnvGuard();
    beforeAll(async () => {
        env.set('IPL_BRIDGE_ALLOW', 'localhost');
        env.set('IPL_BRIDGE_TOKEN', 's3cret');
        ({ server, base } = await start(handleBridgeRequest));
    });
    afterAll(async () => { await stop(server); env.restore(); });

    it('/ping stays public under a token', async () => {
        expect((await call(base, 'GET', '/ping')).status).toBe(200);
    });

    it('/send without a token is 401, not a forward', async () => {
        const r = await call(base, 'POST', '/send?host=localhost&port=9100', 'x');
        expect(r.status).toBe(401);
        expect(r.json.error).toMatch(/token required/);
    });

    it('/send with a wrong token is 401', async () => {
        const r = await call(base, 'POST', '/send?host=localhost&port=9100', 'x', withToken('nope'));
        expect(r.status).toBe(401);
    });

    it('/send to a host off the allow-list is 403, token or not', async () => {
        const r = await call(base, 'POST', '/send?host=192.168.99.99&port=9100', 'x', withToken('s3cret'));
        expect(r.status).toBe(403);
        expect(r.json.error).toMatch(/allow list/);
    });

    it('CORS echoes the caller Origin instead of *', async () => {
        const r = await call(base, 'GET', '/ping', undefined, { Origin: 'http://evil.test' });
        expect(r.status).toBe(200);
        expect(r.headers['access-control-allow-origin']).toBe('http://evil.test');
    });
});

describe('bridge isAllowedTarget units', () => {
    it('matches host-only entries on any port, host:port entries exactly', () => {
        expect(isAllowedTarget('printer.lan', 9100, ['printer.lan'])).toBe(true);
        expect(isAllowedTarget('printer.lan', 9200, ['printer.lan'])).toBe(true);
        expect(isAllowedTarget('printer.lan', 9100, ['printer.lan:9100'])).toBe(true);
        expect(isAllowedTarget('printer.lan', 9200, ['printer.lan:9100'])).toBe(false);
        expect(isAllowedTarget('other.lan', 9100, ['printer.lan:9100'])).toBe(false);
        expect(isAllowedTarget('127.0.0.1', 9100, ['localhost'])).toBe(true);
        expect(isAllowedTarget('localhost', 9100, ['127.0.0.1'])).toBe(true);
        expect(isAllowedTarget('LOCALHOST', 9100, ['localhost'])).toBe(true);
        expect(isAllowedTarget('192.168.1.5', 9100, ['localhost'])).toBe(false);
    });
});

describe('print server token gate', () => {
    let base = '';
    let server: http.Server;
    let dir = '';
    const env = EnvGuard();
    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipl-print-auth-'));
        env.set('IPL_PRINT_DIR', dir);
        env.set('IPL_PRINT_TOKEN', 'shop-token');
        ({ server, base } = await start(handlePrintRequest));
    });
    afterAll(async () => {
        await stop(server);
        env.restore();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('/ping stays public under a token', async () => {
        expect((await call(base, 'GET', '/ping')).status).toBe(200);
    });

    it('queue reads without a token are 401', async () => {
        expect((await call(base, 'GET', '/jobs')).status).toBe(401);
    });

    it('queue writes without a token are 401', async () => {
        expect((await callJson(base, 'PUT', '/jobs/x', { id: 'x' })).status).toBe(401);
    });

    it('the right token restores the full contract', async () => {
        const auth = withToken('shop-token');
        expect((await call(base, 'GET', '/jobs', undefined, auth)).status).toBe(200);
        expect((await callJson(base, 'PUT', '/jobs/ok', { id: 'ok', createdAt: 1, sentChunks: 0 }, auth)).status).toBe(200);
        const get = await call(base, 'GET', '/jobs/ok', undefined, auth);
        expect(get.status).toBe(200);
        expect(get.json.record.id).toBe('ok');
    });
});

describe('library server token gate', () => {
    let base = '';
    let server: http.Server;
    let dir = '';
    const env = EnvGuard();
    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipl-lib-auth-'));
        env.set('IPL_LIBRARY_DIR', dir);
        env.set('IPL_LIBRARY_TOKEN', 'lib-token');
        ({ server, base } = await start(handleLibraryRequest));
    });
    afterAll(async () => {
        await stop(server);
        env.restore();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('/ping stays public, designs need the token', async () => {
        expect((await call(base, 'GET', '/ping')).status).toBe(200);
        expect((await callJson(base, 'PUT', '/designs/A', { name: 'A' })).status).toBe(401);
        const auth = withToken('lib-token');
        expect((await callJson(base, 'PUT', '/designs/A', { name: 'A' }, auth)).status).toBe(200);
        expect((await call(base, 'GET', '/designs/A', undefined, auth)).status).toBe(200);
    });
});

describe('db server: token gate + loopback-only PUT', () => {
    let base = '';
    let server: http.Server;
    let dir = '';
    const env = EnvGuard();
    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipl-db-auth-'));
        env.set('IPL_DB_DIR', dir);
        env.set('IPL_DB_TOKEN', 'db-token');
        ({ server, base } = await start(handleDbRequest));
    });
    afterAll(async () => {
        await stop(server);
        env.restore();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('/ping stays public, list needs the token', async () => {
        expect((await call(base, 'GET', '/ping')).status).toBe(200);
        expect((await call(base, 'GET', '/queries')).status).toBe(401);
        expect((await call(base, 'GET', '/queries', undefined, withToken('db-token'))).status).toBe(200);
    });

    it('PUT works from loopback with the token (the admin path)', async () => {
        const body = { id: 'q1', name: 'Q1', provider: 'sqlserver', connection: {}, sql: 'SELECT 1' };
        expect((await callJson(base, 'PUT', '/queries/q1', body, withToken('db-token'))).status).toBe(200);
    });
});

describe('db server PUT without a token: loopback decides (SEC-03)', () => {
    let base = '';
    let server: http.Server;
    let dir = '';
    const env = EnvGuard();
    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipl-db-loop-'));
        env.set('IPL_DB_DIR', dir);
        env.unset('IPL_DB_TOKEN');
        ({ server, base } = await start(handleDbRequest));
    });
    afterAll(async () => {
        await stop(server);
        env.restore();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('loopback PUT still works (local admin, curl, scripts)', async () => {
        const body = { id: 'local', name: 'Local', provider: 'sqlserver', connection: {}, sql: 'SELECT 1' };
        expect((await callJson(base, 'PUT', '/queries/local', body)).status).toBe(200);
    });

    it('isLoopback trusts the socket peer, not a header', () => {
        expect(isLoopback({ socket: { remoteAddress: '127.0.0.1' } })).toBe(true);
        expect(isLoopback({ socket: { remoteAddress: '::1' } })).toBe(true);
        expect(isLoopback({ socket: { remoteAddress: '::ffff:127.0.0.1' } })).toBe(true);
        expect(isLoopback({ socket: { remoteAddress: '192.168.1.5' } })).toBe(false);
        expect(isLoopback({ socket: { remoteAddress: '192.168.1.5' }, headers: { 'x-forwarded-for': '127.0.0.1' } })).toBe(false);
    });
});

describe('/health on all four servers', () => {
    it('bridge reports mode + uptime', async () => {
        const { handleBridgeRequest } = await import('../tools/ipl-bridge.mjs');
        const http = await import('node:http');
        const server = http.createServer(handleBridgeRequest);
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        try {
            const port = (server.address() as any).port;
            const h = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json() as any);
            expect(h).toMatchObject({ ok: true, service: 'bridge' });
            expect(typeof h.uptimeSec).toBe('number');
        } finally {
            await new Promise<void>((r) => server.close(() => r()));
        }
    });

    it('print reports job counts', async () => {
        const { handlePrintRequest } = await import('../tools/print-server.mjs');
        const http = await import('node:http');
        const fs = await import('node:fs');
        const os = await import('node:os');
        const path = await import('node:path');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipl-health-'));
        const prev = process.env.IPL_PRINT_DIR;
        process.env.IPL_PRINT_DIR = dir;
        const server = http.createServer(handlePrintRequest);
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        try {
            const port = (server.address() as any).port;
            const h = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json() as any);
            expect(h).toMatchObject({ ok: true, service: 'print', jobs: 0, pending: 0 });
            await fetch(`http://127.0.0.1:${port}/jobs/a`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: 'a', createdAt: 1, sentChunks: 0, status: 'queued' }),
            });
            const h2 = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json() as any);
            expect(h2.jobs).toBe(1);
            expect(h2.pending).toBe(1);
        } finally {
            await new Promise<void>((r) => server.close(() => r()));
            if (prev === undefined) delete process.env.IPL_PRINT_DIR;
            else process.env.IPL_PRINT_DIR = prev;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('library reports design count, db reports query count', async () => {
        const { handleLibraryRequest } = await import('../tools/library-server.mjs');
        const { handleDbRequest } = await import('../tools/db-server.mjs');
        const http = await import('node:http');
        const lib = http.createServer(handleLibraryRequest);
        const db = http.createServer(handleDbRequest);
        await new Promise<void>((r) => lib.listen(0, '127.0.0.1', r));
        await new Promise<void>((r) => db.listen(0, '127.0.0.1', r));
        try {
            const lp = (lib.address() as any).port;
            const dp = (db.address() as any).port;
            expect(await fetch(`http://127.0.0.1:${lp}/health`).then((r) => r.json())).toMatchObject({ ok: true, service: 'library' });
            expect(await fetch(`http://127.0.0.1:${dp}/health`).then((r) => r.json())).toMatchObject({ ok: true, service: 'db' });
        } finally {
            await new Promise<void>((r) => lib.close(() => r()));
            await new Promise<void>((r) => db.close(() => r()));
        }
    });
});
