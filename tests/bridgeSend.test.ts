// Batch J (2026-09-21): shared bridge transport tests. fetch is stubbed —
// these pin the protocol contract with tools/ipl-bridge.mjs (URL shape,
// body passthrough, ok/error mapping, timeout and unreachable handling)
// without needing a real bridge or printer.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { sendIplViaBridge, pingBridge, DEFAULT_BRIDGE_URL } from '../services/bridgeSend';

const jsonResponse = (body: unknown, status = 200) => ({ status, json: async () => body });

afterEach(() => vi.unstubAllGlobals());
// Batch K: omitted host/port now fall back to the PERSISTED printer target
// (localStorage) — tests must start from a clean slate for the
// localhost:9100 default assertions to hold.
beforeEach(() => localStorage.clear());

describe('sendIplViaBridge', () => {
    it('POSTs raw IPL to /send with host/port query and reports bytes written', async () => {
        const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
            expect(url).toBe(`${DEFAULT_BRIDGE_URL}/send?host=10.0.0.5&port=9101`);
            expect(init.method).toBe('POST');
            expect((init.headers as Record<string, string>)['Content-Type']).toBe('text/plain');
            expect(init.body).toBe('<STX>R<ETX>');
            return jsonResponse({ ok: true, written: 1234 });
        });
        vi.stubGlobal('fetch', fetchMock);
        const res = await sendIplViaBridge('<STX>R<ETX>', { host: '10.0.0.5', port: '9101' });
        expect(res).toEqual({ ok: true, written: 1234 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('defaults host/port/url when omitted', async () => {
        let seenUrl = '';
        vi.stubGlobal('fetch', async (url: string) => { seenUrl = url; return jsonResponse({ ok: true, written: 1 }); });
        const res = await sendIplViaBridge('X');
        expect(seenUrl).toBe(`${DEFAULT_BRIDGE_URL}/send?host=localhost&port=9100`);
        expect(res.ok).toBe(true);
    });

    it('Batch K: omitted host/port come from the persisted printer target', async () => {
        const { setPrinterTarget } = await import('../services/printerTarget');
        setPrinterTarget({ host: '10.20.5.8', port: '9101' });
        let seenUrl = '';
        vi.stubGlobal('fetch', async (url: string) => { seenUrl = url; return jsonResponse({ ok: true, written: 1 }); });
        await sendIplViaBridge('X');
        expect(seenUrl).toBe(`${DEFAULT_BRIDGE_URL}/send?host=10.20.5.8&port=9101`);
        // explicit opts still win over the persisted target
        await sendIplViaBridge('X', { host: 'other', port: '9200' });
        expect(seenUrl).toBe(`${DEFAULT_BRIDGE_URL}/send?host=other&port=9200`);
    });

    it('review LOW: an explicit host that normalizes to empty errors, never retargets to localhost', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const res = await sendIplViaBridge('X', { host: '   ' });
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/host is empty/i);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('maps bridge errors and non-JSON responses', async () => {
        vi.stubGlobal('fetch', async () => jsonResponse({ ok: false, error: 'connect ECONNREFUSED' }));
        expect((await sendIplViaBridge('X')).error).toBe('Bridge error: connect ECONNREFUSED');
        // HTTP error with a body that is not JSON at all
        vi.stubGlobal('fetch', async () => ({ status: 500, json: async () => { throw new Error('not json'); } }));
        expect((await sendIplViaBridge('X')).error).toBe('Bridge returned HTTP 500');
    });

    it('network failure reports the start-the-bridge hint; abort reports timeout', async () => {
        vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
        expect((await sendIplViaBridge('X')).error).toContain('ipl-bridge.mjs');
        vi.stubGlobal('fetch', async (_u: string, init: { signal?: AbortSignal }) => {
            await new Promise<void>((_, rej) => {
                init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
            });
            throw new Error('never');
        });
        expect((await sendIplViaBridge('X', { timeoutMs: 5 })).error).toBe('Bridge timed out.');
    });

    it('review HIGH: rejects invalid ports WITHOUT touching the network', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        for (const bad of ['abc', '', '0', '70000', '-1', '91.5']) {
            const res = await sendIplViaBridge('X', { port: bad });
            expect(res.ok, `port "${bad}"`).toBe(false);
            expect(res.error).toContain('Invalid printer port');
        }
        expect(fetchMock).not.toHaveBeenCalled();
        // valid variants still pass (trim tolerance)
        vi.stubGlobal('fetch', async () => jsonResponse({ ok: true, written: 5 }));
        expect((await sendIplViaBridge('X', { port: ' 9100 ' })).ok).toBe(true);
    });

    it('review MEDIUM: trailing slash on bridgeUrl is normalized (no //send)', async () => {
        let seen = '';
        vi.stubGlobal('fetch', async (url: string) => { seen = url; return jsonResponse({ ok: true, written: 1 }); });
        await sendIplViaBridge('X', { bridgeUrl: 'http://h:1/' });
        expect(seen).toContain('http://h:1/send?');
        expect(seen).not.toContain('//send');
        let pingSeen = '';
        vi.stubGlobal('fetch', async (url: string) => { pingSeen = url; return jsonResponse({ ok: true }); });
        await pingBridge('http://h:1//');
        expect(pingSeen).toBe('http://h:1/ping');
    });
});

describe('pingBridge', () => {
    it('true only for {ok:true} JSON', async () => {
        vi.stubGlobal('fetch', async () => jsonResponse({ ok: true }));
        expect(await pingBridge()).toBe(true);
        vi.stubGlobal('fetch', async () => jsonResponse({ ok: false }));
        expect(await pingBridge()).toBe(false);
        vi.stubGlobal('fetch', async () => { throw new TypeError('down'); });
        expect(await pingBridge()).toBe(false);
    });
});
