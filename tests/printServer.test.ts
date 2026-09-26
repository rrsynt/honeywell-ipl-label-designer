// Fase 7: the shared print server, driven through a real one.
//
// A stubbed fetch would prove the client builds the right URLs and nothing
// about whether the server prints once, in order, and tells the truth about
// what it accepted. So each test boots tools/print-server.mjs on a random port
// with its own data directory, and the chunks go to a REAL TCP socket that
// records what arrived. The assertions are on those bytes.
//
// The point of the whole feature is the acknowledgement, so the tests that
// matter most are the ones where a retry must NOT print again, and the one
// where a failed chunk stops being "maybe printed" — measured end to end,
// through the queue's own functions, against a socket that either did or did
// not receive something.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handlePrintRequest } from '../tools/print-server.mjs';
import {
    sendChunkViaPrintServer, remoteQueueBackend, remoteTargetBackend,
    pingPrintServer, getPrintServerUrl, setPrintServerUrl, applyPrintServerUrl,
} from '../services/printRemoteBackend';
import {
    setPrintQueueBackend, createPrintJob, runPrintJob,
    listPrintJobs, listPrintLog, ambiguousChunk, type JobTarget, type PrintJob,
} from '../services/printQueue';
import { setPrintTargetBackend, savePrintTarget, listPrintTargets } from '../services/printTargets';
import type { Design } from '../types';

// The server reads its data directory per request from IPL_PRINT_DIR, so each
// run gets a throwaway directory and never touches ./print-data or another
// suite's files.
let dataDir = '';
let server: http.Server;
let baseUrl = '';

beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipl-print-'));
    process.env.IPL_PRINT_DIR = dataDir;
    server = http.createServer(handlePrintRequest);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('test server failed to bind');
    baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    delete process.env.IPL_PRINT_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Raw request helper: JSON bodies, and BYTES for a chunk. */
const call = (method: string, urlPath: string, body?: unknown, raw = false): Promise<{ status: number; json: any }> =>
    new Promise((resolve, reject) => {
        const payload = body === undefined ? null : (raw ? Buffer.from(String(body), 'utf8') : Buffer.from(JSON.stringify(body)));
        const req = http.request(`${baseUrl}${urlPath}`, {
            method,
            headers: payload ? { 'Content-Type': raw ? 'text/plain' : 'application/json', 'Content-Length': String(payload.length) } : {},
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

/**
 * A printer that is nothing but a socket, so "did this chunk print" is a
 * question about bytes that arrived rather than a number the server reported
 * about itself.
 */
interface FakePrinter {
    port: number;
    received: string[];
    /** Close the listening socket, so the next connection is refused. */
    close: () => Promise<void>;
}

const fakePrinter = async (): Promise<FakePrinter> => {
    const received: string[] = [];
    const printer = net.createServer((sock) => {
        const chunks: Buffer[] = [];
        sock.on('data', (c) => chunks.push(c));
        sock.on('end', () => received.push(Buffer.concat(chunks).toString('utf8')));
    });
    await new Promise<void>((resolve) => printer.listen(0, '127.0.0.1', resolve));
    const addr = printer.address();
    if (!addr || typeof addr === 'string') throw new Error('fake printer failed to bind');
    return {
        port: addr.port,
        received,
        close: () => new Promise<void>((resolve, reject) => printer.close(err => err ? reject(err) : resolve())),
    };
};

const settle = (ms = 250): Promise<void> => new Promise(r => setTimeout(r, ms));

const jobRecord = (id: string, target: Partial<JobTarget>, over: Record<string, unknown> = {}) => ({
    id,
    createdAt: 1,
    updatedAt: 1,
    designName: 'Test',
    designChecksum: 'x',
    design: { name: 'Test' },
    recordFrom: 1,
    recordTo: 1,
    copies: 1,
    collation: 'collated',
    target: { id: 't1', name: 'Line 1', host: '127.0.0.1', port: '9100', language: 'ipl', dpi: 203, ...target },
    labels: 3,
    chunkCount: 3,
    sentChunks: 0,
    status: 'queued',
    ...over,
});

// --- the queue, through the server -------------------------------------------------

const namedRender = async (job: PrintJob, chunkIndex: number): Promise<string> =>
    `<STX>CHUNK${chunkIndex}:${job.id}<ETX>`;

const tableDesign = (rowCount: number): Design => ({
    name: 'Job design',
    labelSettings: { width: 100, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields: [{
        id: 1, type: 'text', name: 'SKU', x: 5, y: 5, rotation: 0,
        dataSource: { type: 'linked', sourceId: 's1' },
        font: '25', fontSize: 12, h_mag: 1, w_mag: 1,
    }],
    dataSources: [{
        id: 's1', name: 'Table 1', type: 'table',
        columns: ['SKU'],
        rows: Array.from({ length: rowCount }, (_, i) => ({ SKU: `R${i + 1}` })),
        query: { filters: [], combine: 'and' },
    }],
    nextId: 2,
    guides: { horizontal: [], vertical: [] },
} as Design);

describe('print server HTTP contract', () => {
    it('answers /ping with the print service marker', async () => {
        const res = await call('GET', '/ping');
        expect(res.status).toBe(200);
        expect(res.json).toEqual({ ok: true, service: 'print' });
    });

    it('stores a job and hands back exactly the record it was given', async () => {
        const record = jobRecord('http-roundtrip', {});
        expect((await call('PUT', '/jobs/http-roundtrip', record)).json.ok).toBe(true);

        const got = await call('GET', '/jobs/http-roundtrip');
        expect(got.status).toBe(200);
        expect(got.json.record).toEqual(record);
        expect(got.json.record.sentChunks).toBe(0);
    });

    it('refuses a body whose id does not match the URL, and stores nothing', async () => {
        const res = await call('PUT', '/jobs/Alpha', jobRecord('Beta', {}));
        expect(res.status).toBe(400);
        expect((await call('GET', '/jobs/Alpha')).status).toBe(404);
        expect((await call('GET', '/jobs/Beta')).status).toBe(404);
    });

    it('404s a job that was never stored', async () => {
        expect((await call('GET', '/jobs/nope')).status).toBe(404);
    });

    it('round-trips an id that is hostile as a filename', async () => {
        const id = '../CON:job';
        await call('PUT', `/jobs/${encodeURIComponent(id)}`, jobRecord(id, {}));
        const got = await call('GET', `/jobs/${encodeURIComponent(id)}`);
        expect(got.status).toBe(200);
        expect(got.json.record.id).toBe(id);
    });

    it('delete is idempotent and removes the job from the list', async () => {
        await call('PUT', '/jobs/gone', jobRecord('gone', {}));
        expect((await call('DELETE', '/jobs/gone')).status).toBe(200);
        expect((await call('DELETE', '/jobs/gone')).status).toBe(200);
        expect((await call('GET', '/jobs')).json.records.map((r: { id: string }) => r.id)).not.toContain('gone');
    });

    it('lists targets by name so a picker does not reshuffle between reads', async () => {
        await call('PUT', '/targets/tz', { id: 'tz', name: 'Zulu', host: 'h', port: '1', language: 'ipl', dpi: 203 });
        await call('PUT', '/targets/ta', { id: 'ta', name: 'Alpha', host: 'h', port: '1', language: 'ipl', dpi: 203 });
        const names = (await call('GET', '/targets')).json.records.map((t: { name: string }) => t.name);
        expect(names).toContain('Alpha');
        expect(names.indexOf('Alpha')).toBeLessThan(names.indexOf('Zulu'));
    });

    it('the log append stamps the id the entry will be addressed by', async () => {
        const res = await call('POST', '/log', { at: 5, jobId: 'j', ok: true, chunkIndex: 0, labels: 3 });
        expect(res.status).toBe(200);
        expect(typeof res.json.id).toBe('string');

        const list = await call('GET', '/log');
        expect(list.json.records.map((e: { id: string }) => e.id)).toContain(res.json.id);
        expect((await call('DELETE', `/log/${res.json.id}`)).status).toBe(200);
    });

    it('rejects a body that is not a JSON object', async () => {
        expect((await call('PUT', '/jobs/bad', [1, 2, 3])).status).toBe(400);
        expect((await call('POST', '/log', 'not-an-object')).status).toBe(400);
    });
});

describe('the chunk acknowledgement', () => {
    it('prints an accepted chunk, reports the count, and sends those exact bytes', async () => {
        const printer = await fakePrinter();
        await call('PUT', '/jobs/ack1', jobRecord('ack1', { port: String(printer.port) }));

        // § and a raw control byte, so a test that secretly stringified or
        // re-encoded the body would fail here rather than pass quietly.
        const bytes = '<STX>CHUNK§\x02<ETX>';
        const res = await call('POST', '/jobs/ack1/chunk?seq=0', bytes, true);
        await settle();

        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({ ok: true, accepted: 1 });
        expect(printer.received).toEqual([bytes]);
        expect((await call('GET', '/jobs/ack1')).json.record.sentChunks).toBe(1);
        await printer.close();
    });

    it('REFUSES a chunk that was already accepted, and prints nothing more', async () => {
        // The double-print this server exists to remove: a client whose fetch
        // timed out resends the chunk it is unsure about.
        const printer = await fakePrinter();
        await call('PUT', '/jobs/ack2', jobRecord('ack2', { port: String(printer.port) }));

        await call('POST', '/jobs/ack2/chunk?seq=0', 'FIRST', true);
        await settle();
        expect(printer.received).toHaveLength(1);

        const replay = await call('POST', '/jobs/ack2/chunk?seq=0', 'REPLAY', true);
        await settle();

        expect(replay.status).toBe(409);
        expect(replay.json.accepted).toBe(1);
        expect(printer.received).toHaveLength(1);
        expect(printer.received).not.toContain('REPLAY');
        await printer.close();
    });

    it('refuses a chunk that would leave a hole, without printing', async () => {
        const printer = await fakePrinter();
        await call('PUT', '/jobs/ack3', jobRecord('ack3', { port: String(printer.port) }));

        const gap = await call('POST', '/jobs/ack3/chunk?seq=3', 'SKIP', true);
        await settle();

        expect(gap.status).toBe(409);
        expect(gap.json.accepted).toBe(0);
        expect(printer.received).toEqual([]);
        await printer.close();
    });

    it('two stations resuming at once print the chunk ONCE', async () => {
        // The race the ack has to survive: both read sentChunks 0, both post
        // seq 0. Exactly one may reach the media.
        const printer = await fakePrinter();
        await call('PUT', '/jobs/ack4', jobRecord('ack4', { port: String(printer.port) }));

        const [a, b] = await Promise.all([
            call('POST', '/jobs/ack4/chunk?seq=0', 'STATION-A', true),
            call('POST', '/jobs/ack4/chunk?seq=0', 'STATION-B', true),
        ]);
        await settle(400);

        expect([a.status, b.status].sort()).toEqual([200, 409]);
        expect(printer.received).toHaveLength(1);
        expect((await call('GET', '/jobs/ack4')).json.record.sentChunks).toBe(1);
        await printer.close();
    });

    it('400s an empty chunk rather than forwarding nothing', async () => {
        const printer = await fakePrinter();
        await call('PUT', '/jobs/ack5', jobRecord('ack5', { port: String(printer.port) }));

        const res = await call('POST', '/jobs/ack5/chunk?seq=0', '', true);
        await settle();

        expect(res.status).toBe(400);
        expect(printer.received).toEqual([]);
        expect((await call('GET', '/jobs/ack5')).json.record.sentChunks).toBe(0);
        await printer.close();
    });

    it('404s a chunk for a job that does not exist', async () => {
        const res = await call('POST', '/jobs/ghost/chunk?seq=0', 'X', true);
        expect(res.status).toBe(404);
        expect(res.json.accepted).toBe(0);
    });

    it('400s a seq that is not a chunk number', async () => {
        expect((await call('POST', '/jobs/ack5/chunk?seq=abc', 'X', true)).status).toBe(400);
        expect((await call('POST', '/jobs/ack5/chunk?seq=-1', 'X', true)).status).toBe(400);
        expect((await call('POST', '/jobs/ack5/chunk', 'X', true)).status).toBe(400);
    });

    it('A FAILED FLUSH DOES NOT COUNT: the count stays, and the same seq still works', async () => {
        // This is what makes `ok:false` mean "definitely did not print". If a
        // failure bumped the count, the queue would skip a chunk forever.
        const deadPort = 9; // discard: nothing listens
        await call('PUT', '/jobs/ack6', jobRecord('ack6', { port: String(deadPort) }));

        const failed = await call('POST', '/jobs/ack6/chunk?seq=0', 'LOST', true);
        expect(failed.json.ok).toBe(false);
        expect(failed.json.accepted).toBe(0);
        expect((await call('GET', '/jobs/ack6')).json.record.sentChunks).toBe(0);

        // The printer comes back, and the SAME seq is accepted.
        const printer = await fakePrinter();
        await call('PUT', '/jobs/ack6', { ...jobRecord('ack6', { port: String(printer.port) }), sentChunks: 0 });
        const retried = await call('POST', '/jobs/ack6/chunk?seq=0', 'ARRIVED', true);
        await settle();

        expect(retried.status).toBe(200);
        expect(retried.json.accepted).toBe(1);
        expect(printer.received).toEqual(['ARRIVED']);
        await printer.close();
    });

    it('prints to the job\'s OWN printer, ignoring host/port in the query', async () => {
        // Otherwise this server is an open relay: anyone on the LAN could aim
        // it at any machine.
        const real = await fakePrinter();
        const decoy = await fakePrinter();
        await call('PUT', '/jobs/ack7', jobRecord('ack7', { port: String(real.port) }));

        const res = await call('POST', `/jobs/ack7/chunk?seq=0&host=127.0.0.1&port=${decoy.port}`, 'TO-REAL', true);
        await settle();

        expect(res.status).toBe(200);
        expect(real.received).toEqual(['TO-REAL']);
        expect(decoy.received).toEqual([]);
        await real.close();
        await decoy.close();
    });

    it('refuses to print a job with no usable target, and says so', async () => {
        await call('PUT', '/jobs/ack8', jobRecord('ack8', { port: 'not-a-port' }));
        const res = await call('POST', '/jobs/ack8/chunk?seq=0', 'X', true);
        expect(res.status).toBe(502);
        expect(res.json.ok).toBe(false);
        expect(res.json.error).toMatch(/target/i);
    });

    it('a client PUT cannot roll the accepted count BACKWARDS', async () => {
        // A station that read the job before a chunk was accepted would
        // otherwise resend chunks the printer already has.
        const printer = await fakePrinter();
        await call('PUT', '/jobs/ack9', jobRecord('ack9', { port: String(printer.port) }));
        await call('POST', '/jobs/ack9/chunk?seq=0', 'ONE', true);
        await settle();

        await call('PUT', '/jobs/ack9', jobRecord('ack9', { port: String(printer.port) }, { sentChunks: 0, note: 'stale tab' }));

        expect((await call('GET', '/jobs/ack9')).json.record.sentChunks).toBe(1);
        // And the stale write is otherwise honoured, so this is a floor and not
        // a blanket refusal to update.
        expect((await call('GET', '/jobs/ack9')).json.record.note).toBe('stale tab');
        await printer.close();
    });
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
        expect(getPrintServerUrl(s)).toBe('');
        expect(setPrintServerUrl('http://192.168.1.10:9183/', s)).toBe('http://192.168.1.10:9183');
        expect(getPrintServerUrl(s)).toBe('http://192.168.1.10:9183');
    });

    it('refuses an address that is not an http URL, and stores nothing', () => {
        const s = storage();
        expect(() => setPrintServerUrl('192.168.1.10:9183', s)).toThrow();
        expect(() => setPrintServerUrl('ftp://h/print', s)).toThrow();
        expect(getPrintServerUrl(s)).toBe('');
    });

    it('an empty address clears the stored one, returning to this browser', () => {
        const s = storage();
        setPrintServerUrl('http://h:9183', s);
        expect(setPrintServerUrl('   ', s)).toBe('');
        expect(getPrintServerUrl(s)).toBe('');
    });

    it('a corrupted stored value reads back as unset', () => {
        const s = storage();
        s.setItem('ipl_print_server_url', 'not a url');
        expect(getPrintServerUrl(s)).toBe('');
    });

    it('applying an empty address puts the local backends back, not the server ones', async () => {
        const s = storage();
        // Point at the server, then take it away. The queue must return to
        // this browser, or a station keeps writing to a server the user left.
        expect(applyPrintServerUrl(baseUrl, s)).toBe(baseUrl);
        expect(applyPrintServerUrl('', s)).toBe('');
        // The local backend holds no jobs, while the server one holds several.
        expect(await listPrintJobs()).toEqual([]);
    });

    it('the ping distinguishes a print server from anything else on the port', async () => {
        expect(await pingPrintServer(baseUrl)).toBe(true);
        expect(await pingPrintServer('http://127.0.0.1:1')).toBe(false);
    });
});

describe('the queue and the printer list through the remote backends', () => {
    beforeEach(() => {
        setPrintQueueBackend(remoteQueueBackend({ serverUrl: baseUrl }));
    });

    it('save, list and delete round-trip a job', async () => {
        const job = await createPrintJob(tableDesign(10), {
            recordFrom: 1, recordTo: 10, copies: 1, collation: 'collated',
            target: { id: 't1', name: 'Line 1', host: '127.0.0.1', port: '9100', language: 'ipl', dpi: 203 },
            now: 500, id: `remote-job-${Date.now().toString(36)}`,
        });
        const listed = (await listPrintJobs()).find(j => j.id === job.id);
        expect(listed?.designName).toBe('Job design');
        expect(listed?.labels).toBe(10);
        expect(listed?.sentChunks).toBe(0);
    });

    it('lists jobs newest first, like the local backend', async () => {
        await createPrintJob(tableDesign(1), { recordFrom: 1, recordTo: 1, copies: 1, collation: 'collated', target: { id: 't', name: 'T', host: '127.0.0.1', port: '9100', language: 'ipl', dpi: 203 }, now: 1, id: 'olderjob' });
        await createPrintJob(tableDesign(1), { recordFrom: 1, recordTo: 1, copies: 1, collation: 'collated', target: { id: 't', name: 'T', host: '127.0.0.1', port: '9100', language: 'ipl', dpi: 203 }, now: 9, id: 'newerjob' });
        const ids = (await listPrintJobs()).map(j => j.id);
        expect(ids.indexOf('newerjob')).toBeLessThan(ids.indexOf('olderjob'));
    });

    it('saves and lists printer targets with the shared list', async () => {
        setPrintTargetBackend(remoteTargetBackend({ serverUrl: baseUrl }));
        await savePrintTarget({ name: 'Front line', host: '10.0.0.9', port: '9100', language: 'ipl', dpi: 203 });
        expect((await listPrintTargets()).map(t => t.name)).toContain('Front line');
    });
});

describe('runPrintJob through the shared server', () => {
    let printer: FakePrinter;

    beforeEach(async () => {
        setPrintQueueBackend(remoteQueueBackend({ serverUrl: baseUrl }));
        printer = await fakePrinter();
    });

    afterAll(async () => {
        if (printer) await printer.close();
    });

    const target = (): JobTarget => ({ id: 't1', name: 'Line 1', host: '127.0.0.1', port: String(printer.port), language: 'ipl', dpi: 203 });

    /** The real client, against the real server, to the real socket. */
    const serverSend = (stream: string, opts: { host: string; port: string; jobId?: string; seq?: number }) =>
        sendChunkViaPrintServer(stream, { jobId: String(opts.jobId), seq: Number(opts.seq), serverUrl: baseUrl });

    it('sends every chunk in order, and the socket receives them', async () => {
        const job = await createPrintJob(tableDesign(250), { recordFrom: 1, recordTo: 250, copies: 1, collation: 'collated', target: target(), now: 1 });
        const done = await runPrintJob(job, { render: namedRender, send: serverSend, now: () => 2 });
        await settle();

        expect(done.status).toBe('sent');
        expect(done.sentChunks).toBe(3);
        expect(printer.received).toEqual([
            `<STX>CHUNK0:${job.id}<ETX>`,
            `<STX>CHUNK1:${job.id}<ETX>`,
            `<STX>CHUNK2:${job.id}<ETX>`,
        ]);
    });

    it('THE POINT: a failed chunk is NOT ambiguous through the server — the retry caution goes away', async () => {
        // The printer dies after the first chunk, so chunk 1 is refused by the
        // server (its socket could not flush). The server answers with the
        // accepted count, and that answer is a fact rather than a guess.
        const job = await createPrintJob(tableDesign(250), { recordFrom: 1, recordTo: 250, copies: 1, collation: 'collated', target: target(), now: 1 });

        let chunk = 0;
        const dyingPrinter = async (stream: string, opts: { host: string; port: string; jobId?: string; seq?: number }) => {
            const result = await serverSend(stream, opts);
            // Pull the plug once the first chunk has printed.
            if (result.ok && chunk++ === 0) await printer.close();
            return result;
        };

        const failed = await runPrintJob(job, { render: namedRender, send: dyingPrinter, now: () => 2 });
        await settle();

        expect(failed.status).toBe('failed');
        expect(failed.sentChunks).toBe(1);
        // The bridge would have to say "up to 100 labels may already have
        // printed". The server KNOWS chunk 1 never left, so nothing is in doubt.
        expect(await ambiguousChunk(job.id)).toBeNull();

        const log = await listPrintLog();
        const failure = log.find(e => !e.ok);
        expect(failure?.accepted).toBe(1);
        expect(failure?.chunkIndex).toBe(1);
    });

    it('a TRANSPORT failure is still ambiguous — nothing acknowledged it', async () => {
        // Same shape, but the failure carries no `accepted`, so the chunk's
        // fate is genuinely unknown and the warning must stay.
        const job = await createPrintJob(tableDesign(250), { recordFrom: 1, recordTo: 250, copies: 1, collation: 'collated', target: target(), now: 1 });
        const done = await runPrintJob(job, {
            render: namedRender,
            send: async () => ({ ok: false, error: 'Bridge timed out.' }),
            now: () => 2,
        });

        expect(done.status).toBe('failed');
        expect(await ambiguousChunk(job.id)).toEqual({ chunkIndex: 0, labels: 100 });
    });

    it('a resumed job picks up where the server says it is, and does not reprint', async () => {
        const job = await createPrintJob(tableDesign(250), { recordFrom: 1, recordTo: 250, copies: 1, collation: 'collated', target: target(), now: 1 });
        await runPrintJob(job, {
            render: namedRender,
            send: async (stream, opts) => (opts.seq === 0 ? { ok: false, error: 'paper out' } : serverSend(stream, opts)),
            now: () => 2,
        });
        await settle();

        const reloaded = (await listPrintJobs()).find(j => j.id === job.id)!;
        const printedSoFar = printer.received.length;
        const done = await runPrintJob(reloaded, { render: namedRender, send: serverSend, now: () => 3 });
        await settle();

        expect(done.status).toBe('sent');
        // Only the chunks that had not gone out.
        expect(printer.received.slice(printedSoFar)).toEqual([
            `<STX>CHUNK0:${job.id}<ETX>`,
            `<STX>CHUNK1:${job.id}<ETX>`,
            `<STX>CHUNK2:${job.id}<ETX>`,
        ]);
    });
});
