// Fase 7: the shared library goes through a real HTTP server, not a stub.
//
// A stubbed fetch would prove the client builds the right URLs and nothing
// about whether the server stores them, which is the whole feature. So each
// test boots tools/library-server.mjs on a random port with its own data
// directory and talks to it through remoteBackend — the same object the app
// passes to setLibraryBackend.
//
// Two layers are pinned. The HTTP cases drive the server with raw requests, so
// a bad body or a hostile name fails even if the client never sends one. The
// backend cases go through libraryStore's own functions, so a regression in
// the store's logic fails here too, against a server instead of a Map.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleLibraryRequest } from '../tools/library-server.mjs';
import { remoteBackend, pingLibraryServer, getLibraryServerUrl, setLibraryServerUrl } from '../services/libraryRemoteBackend';
import {
    memoryBackend, setLibraryBackend, listLibrary, getLibraryRecord, saveLibraryRecord,
    deleteLibraryRecord, saveSharedSource, listSharedSources, importSharedSource,
    writeRecovery, readRecovery, clearRecovery,
} from '../services/libraryStore';
import type { Design } from '../types';

const design = (name: string): Design => ({
    name,
    labelSettings: { width: 100, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields: [{ id: 1, type: 'text', name: 'A', x: 0, y: 0, rotation: 0, dataSource: { type: 'fixed', data: 'hi' }, font: '25', fontSize: 12, h_mag: 1, w_mag: 1 }],
    dataSources: [],
    nextId: 2,
    guides: { horizontal: [], vertical: [] },
} as Design);

// The server reads its data directory per request from IPL_LIBRARY_DIR, so
// each run gets a throwaway directory and never touches ./library-data or
// another suite's files.
let dataDir = '';
let server: http.Server;
let baseUrl = '';

beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipl-library-'));
    process.env.IPL_LIBRARY_DIR = dataDir;
    server = http.createServer(handleLibraryRequest);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('test server failed to bind');
    baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    delete process.env.IPL_LIBRARY_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = (method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: any }> =>
    new Promise((resolve, reject) => {
        const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const req = http.request(`${baseUrl}${urlPath}`, {
            method,
            headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {},
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });

describe('the stored server address', () => {
    const storage = (): Storage => {
        const mem = new Map<string, string>();
        return {
            get length() { return mem.size; },
            clear: () => mem.clear(),
            getItem: (k) => mem.get(k) ?? null,
            key: (i) => [...mem.keys()][i] ?? null,
            removeItem: (k) => { mem.delete(k); },
            setItem: (k, v) => { mem.set(k, v); },
        };
    };

    it('is empty until someone sets one, and round-trips what was set', () => {
        const s = storage();
        expect(getLibraryServerUrl(s)).toBe('');
        expect(setLibraryServerUrl('http://192.168.1.10:9182/', s)).toBe('http://192.168.1.10:9182');
        expect(getLibraryServerUrl(s)).toBe('http://192.168.1.10:9182');
    });

    it('refuses an address that is not an http URL, and stores nothing', () => {
        const s = storage();
        expect(() => setLibraryServerUrl('192.168.1.10:9182', s)).toThrow();
        expect(() => setLibraryServerUrl('ftp://h/library', s)).toThrow();
        expect(getLibraryServerUrl(s)).toBe('');
    });

    it('an empty address clears the stored one, returning to the local library', () => {
        const s = storage();
        setLibraryServerUrl('http://h:9182', s);
        expect(setLibraryServerUrl('   ', s)).toBe('');
        expect(getLibraryServerUrl(s)).toBe('');
    });

    it('a corrupted stored value reads back as unset', () => {
        const s = storage();
        s.setItem('ipl_library_server_url', 'not a url');
        expect(getLibraryServerUrl(s)).toBe('');
    });
});

describe('library server HTTP contract', () => {
    it('answers /ping with the library service marker', async () => {
        const res = await call('GET', '/ping');
        expect(res.status).toBe(200);
        expect(res.json).toEqual({ ok: true, service: 'library' });
    });

    it('stores a design and hands back exactly the record it was given', async () => {
        const record = { name: 'Invoice', updatedAt: 5, design: { fields: [{ id: 1 }] }, thumbnail: null };
        expect((await call('PUT', '/designs/Invoice', record)).json.ok).toBe(true);

        const got = await call('GET', '/designs/Invoice');
        expect(got.status).toBe(200);
        expect(got.json.record).toEqual(record);

        const list = await call('GET', '/designs');
        expect(list.json.records.map((r: { name: string }) => r.name)).toContain('Invoice');
    });

    it('lists newest first and returns 404 for a name that was never stored', async () => {
        await call('PUT', '/designs/older', { name: 'older', updatedAt: 1 });
        await call('PUT', '/designs/newer', { name: 'newer', updatedAt: 9 });
        const names = (await call('GET', '/designs')).json.records.map((r: { name: string }) => r.name);
        expect(names.indexOf('newer')).toBeLessThan(names.indexOf('older'));

        expect((await call('GET', '/designs/nope')).status).toBe(404);
    });

    it('refuses a body whose name does not match the URL, and stores nothing', async () => {
        const res = await call('PUT', '/designs/Alpha', { name: 'Beta', updatedAt: 1 });
        expect(res.status).toBe(400);
        expect((await call('GET', '/designs/Alpha')).status).toBe(404);
        expect((await call('GET', '/designs/Beta')).status).toBe(404);
    });

    it('round-trips a name that is hostile as a filename', async () => {
        const name = '../CON:secret';
        await call('PUT', `/designs/${encodeURIComponent(name)}`, { name, updatedAt: 3, note: 'kept' });
        const got = await call('GET', `/designs/${encodeURIComponent(name)}`);
        expect(got.status).toBe(200);
        expect(got.json.record.note).toBe('kept');
    });

    it('delete is idempotent and removes the record from the list', async () => {
        await call('PUT', '/sources/Stock', { name: 'Stock', updatedAt: 2, source: { rows: 1 } });
        expect((await call('DELETE', '/sources/Stock')).status).toBe(200);
        expect((await call('DELETE', '/sources/Stock')).status).toBe(200);
        expect((await call('GET', '/sources')).json.records).toEqual([]);
    });

    it('rejects a body that is not a JSON object', async () => {
        const res = await call('PUT', '/recovery/current', [1, 2, 3]);
        expect(res.status).toBe(400);
    });
});

describe('remoteBackend through the real server', () => {
    beforeEach(() => {
        setLibraryBackend(remoteBackend({ serverUrl: baseUrl, local: memoryBackend() }));
    });

    it('save, list, load and delete round-trip a design', async () => {
        const name = `Remote ${Date.now().toString(36)}`;
        await saveLibraryRecord(design(name), { thumbnail: 'data:image/png;base64,AAAA', tags: ['shared'], now: 4000 });

        const meta = (await listLibrary()).find(m => m.name === name);
        expect(meta).toMatchObject({ widthMm: 100, heightMm: 50, dpi: 203, tags: ['shared'], thumbnail: 'data:image/png;base64,AAAA' });
        expect(meta).not.toHaveProperty('design');

        const loaded = await getLibraryRecord(name);
        expect(loaded?.design.fields).toHaveLength(1);

        await deleteLibraryRecord(name);
        expect(await getLibraryRecord(name)).toBeNull();
    });

    it('keeps an update from wiping a thumbnail it did not resend', async () => {
        const name = `Keep ${Date.now().toString(36)}`;
        await saveLibraryRecord(design(name), { thumbnail: 'png', tags: ['kept'], now: 1 });
        await saveLibraryRecord(design(name), { now: 2 });
        const meta = (await listLibrary()).find(m => m.name === name);
        expect(meta).toMatchObject({ thumbnail: 'png', tags: ['kept'], updatedAt: 2 });
    });

    it('shares a data source and imports a copy with a fresh id', async () => {
        const table = {
            id: 'tbl-1', type: 'table' as const, name: 'Stock',
            columns: ['SKU'], rows: [{ SKU: 'A1' }],
            query: { filters: [], combine: 'and' as const },
        };
        const sourceName = `Warehouse ${Date.now().toString(36)}`;
        await saveSharedSource(sourceName, table, 1000);
        expect((await listSharedSources()).find(s => s.name === sourceName)?.detail).toBe('1 row');

        const copy = await importSharedSource(sourceName, 'tbl-fresh');
        expect(copy?.id).toBe('tbl-fresh');
        expect(copy && copy.type === 'table' && copy.rows).toEqual(table.rows);
    });

    it('keeps recovery LOCAL even while designs go to the server', async () => {
        const name = `Draft ${Date.now().toString(36)}`;
        expect(await writeRecovery(design(name), 7)).toBe(true);
        expect((await readRecovery())?.designName).toBe(name);

        // A second backend with its own local store must not see that draft:
        // recovery never reached the server.
        const other = remoteBackend({ serverUrl: baseUrl, local: memoryBackend() });
        expect(await other.getRecovery('current')).toBeNull();

        await clearRecovery();
        expect(await readRecovery()).toBeNull();
    });

    it('the ping distinguishes a library server from anything else on the port', async () => {
        expect(await pingLibraryServer(baseUrl)).toBe(true);
        expect(await pingLibraryServer('http://127.0.0.1:1')).toBe(false);
    });
});
