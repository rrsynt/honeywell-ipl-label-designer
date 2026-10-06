#!/usr/bin/env node
// IPL Bridge - zero-dependency local relay for the IPL Viewer.
//
// Browsers cannot open raw TCP sockets, so the viewer talks to this tiny
// local HTTP server, which forwards payloads to a printer / Honeywell
// printer-simulator listening on a raw TCP port (default 9100).
//
// Usage:
//   node tools/ipl-bridge.mjs                 # forward mode  (HTTP 127.0.0.1:9181 -> TCP localhost:9100)
//   node tools/ipl-bridge.mjs --port=9200     # custom HTTP port
//   node tools/ipl-bridge.mjs --listen=9100   # capture mode: fake printer that records streams
//   node tools/ipl-bridge.mjs --host=0.0.0.0 --token=s3cret --allow=192.168.1.20:9100
//                                             # LAN mode: other stations may send, but only
//                                             # to the listed printer(s) and only with the token
//
// Endpoints (forward mode):
//   GET  /ping                     -> { ok: true } (always public: the UI status dot)
//   POST /send?host=&port=&ms=     -> forwards request body (text/binary) over TCP
// Endpoints (capture mode, --listen=N):
//   GET  /capture                  -> last received stream as text (or base64 if binary)
//   DELETE /capture                -> clears the buffer
//
// Hardening (audit SEC-01/SEC-02, 2026-10-06):
//   --host   HTTP listen address. Default 127.0.0.1 (this machine only); pass
//            --host=0.0.0.0 explicitly to serve the LAN.
//   --token  When set, /send (and DELETE /capture) require
//            `Authorization: Bearer <token>`. Without it the bridge keeps its
//            old behaviour, so a single-station setup needs no token at all.
//   --allow  Printer targets /send may forward to (`host` or `host:port`,
//            repeatable or comma-separated). Default: localhost only — without
//            this the bridge is an open TCP relay anyone on the LAN (or any
//            website the operator visits, via CORS) can aim at any machine.
//   CORS     Echoes the request Origin instead of `*`, so a token-bearing
//            browser cannot be driven cross-origin by a stranger site.

import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = name => {
    const hit = args.find(a => a === name || a.startsWith(`${name}=`));
    return hit ? (hit.includes('=') ? hit.split('=')[1] : true) : undefined;
};
const optAll = name => args
    .filter(a => a === name || a.startsWith(`${name}=`))
    .flatMap(a => (a.includes('=') ? a.split('=').slice(1).join('=').split(',') : []))
    .map(s => s.trim()).filter(Boolean);

const httpPort = parseInt(opt('--port') || '9181', 10);
const listenPort = opt('--listen') ? parseInt(opt('--listen'), 10) : null;
// Read per request (not once at import): the CLI passes flags, and tests point
// each run at their own values through the environment — the same pattern the
// sibling servers use for their data directories (process.env.IPL_*_DIR).
const bindHost = () => process.env.IPL_BRIDGE_HOST || String(opt('--host') || '127.0.0.1');
const bridgeToken = () => process.env.IPL_BRIDGE_TOKEN || (typeof opt('--token') === 'string' ? opt('--token') : '');
const allowList = () => {
    const fromEnv = (process.env.IPL_BRIDGE_ALLOW || '').split(',').map(s => s.trim()).filter(Boolean);
    const entries = [...fromEnv, ...optAll('--allow')];
    return entries.length > 0 ? entries : ['localhost'];
};

// QW-SEC (audit 2026-10-06): /send had no body cap while the sibling servers
// cap at 64 MB — a multi-GB POST OOM-killed the bridge daemon. Same cap, 413.
export const MAX_SEND_BYTES = 64 * 1024 * 1024;

const corsHeaders = (req) => {
    const origin = req.headers?.origin;
    return {
        ...(origin ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {}),
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
};

const json = (req, res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { ...corsHeaders(req), 'Content-Type': 'application/json' });
    res.end(body);
};

/** Bearer check for the mutating routes. Public when no --token is set, so a
 *  single-station setup (the default) behaves exactly as before. */
const authorized = (req) => {
    const token = bridgeToken();
    if (!token) return true;
    const header = req.headers?.authorization ?? '';
    return header === `Bearer ${token}`;
};

/** Is `host:port` on the --allow list? An entry without a port allows that host
 *  on any port; localhost entries also cover 127.0.0.1 and ::1. */
export const isAllowedTarget = (host, port, entries = allowList()) => {
    const h = String(host).toLowerCase();
    const loopbacks = new Set(['localhost', '127.0.0.1', '::1']);
    return entries.some(e => {
        const idx = e.lastIndexOf(':');
        // A bare IPv6 address has several colons and no port; only split when
        // there is exactly one colon (host:port) to avoid misreading one.
        const hasPort = idx > 0 && e.indexOf(':') === idx && /^\d+$/.test(e.slice(idx + 1));
        const eh = (hasPort ? e.slice(0, idx) : e).toLowerCase();
        if (hasPort && Number(e.slice(idx + 1)) !== Number(port)) return false;
        if (h === eh) return true;
        return loopbacks.has(h) && loopbacks.has(eh);
    });
};

let captured = null; // { buffer: Buffer, at: Date, remote: string }

function startCaptureServer() {
    const server = net.createServer(socket => {
        const chunks = [];
        socket.on('data', c => chunks.push(c));
        socket.on('end', () => {
            captured = { buffer: Buffer.concat(chunks), at: new Date(), remote: socket.remoteAddress ?? '?' };
            console.log(`[bridge] captured ${captured.buffer.length} bytes from ${captured.remote}`);
        });
        socket.on('error', () => {});
    });
    server.listen(listenPort, () => console.log(`[bridge] fake printer listening on tcp/${listenPort}`));
}

function forwardToTcp(host, port, body, ms) {
    return new Promise(resolve => {
        const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
        let settled = false;
        let flushed = false;
        let grace = null;
        let socket;
        // net.createConnection throws SYNCHRONOUSLY on an invalid port
        // (RangeError) — inside a Promise executor that becomes an unhandled
        // rejection and kills the daemon. Guard it (review HIGH).
        try {
            socket = net.createConnection({ host, port });
        } catch (err) {
            resolve({ ok: false, error: String(err.message || err) });
            return;
        }
        const done = result => {
            if (settled) return;
            settled = true;
            if (grace) clearTimeout(grace);
            socket.destroy();
            resolve(result);
        };
        // A stalled idle connection is a FAILURE, not a success: previously a
        // dead printer IP reported {ok:true} after the timeout. If the write
        // already flushed (end() callback ran), the bytes reached the kernel.
        socket.setTimeout(ms, () => done(flushed
            ? { ok: true, written: payload.length }
            : { ok: false, error: `no response from ${host}:${port} within ${ms}ms` }));
        socket.on('error', err => done({ ok: false, error: String(err.message || err) }));
        socket.on('connect', () => {
            // end() flushes the whole buffer and sends FIN before calling back;
            // write()+destroy() truncated large payloads (RST over queued data).
            socket.end(payload, () => {
                flushed = true;
                // Give the device a moment to ACK/close, then report success.
                grace = setTimeout(() => done({ ok: true, written: payload.length }), Math.min(ms, 500));
            });
        });
        socket.on('close', () => {
            // Some printers close right after receiving; if flushed, that's success.
            if (flushed) done({ ok: true, written: payload.length });
        });
    });
}

// NOW-5: exported (like handlePrintRequest/handleLibraryRequest/handleDbRequest)
// so tests can drive the real HTTP contract on a random port without spawning
// a process. Importing this module never listens — only the isMain block below.

/** Process start, for /health uptime. */
const startedAt = Date.now();

/** One line per forward (/send): who printed what, where, and whether the
 *  bytes flushed. Reads stay quiet. */
const accessLog = (req, path, note) => {
    const peer = req.socket?.remoteAddress ?? '?';
    console.log(`[bridge] ${peer} ${req.method} ${path}${note ? ` ${note}` : ''}`);
};

export const handleBridgeRequest = (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req));
        return res.end();
    }
    const url = new URL(req.url, `http://localhost:${httpPort}`);

    if (url.pathname === '/ping' && req.method === 'GET') {
        return json(req, res, 200, { ok: true, mode: listenPort ? 'capture' : 'forward' });
    }

    if (url.pathname === '/health' && req.method === 'GET') {
        return json(req, res, 200, {
            ok: true, service: 'bridge', mode: listenPort ? 'capture' : 'forward',
            uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        });
    }

    if (listenPort && url.pathname === '/capture') {
        if (req.method === 'DELETE') {
            if (!authorized(req)) return json(req, res, 401, { ok: false, error: 'bridge token required (Authorization: Bearer <token>)' });
            captured = null; return json(req, res, 200, { ok: true });
        }
        if (!captured) return json(req, res, 404, { ok: false, error: 'no capture yet' });
        const text = captured.buffer.toString('utf8');
        const printable = /^[\x20-\x7e\s<>=]*$/.test(text.replace(/<STX>|<ETX>/g, '')) ||
                          /<STX>/.test(text) || !text.includes('\u0000');
        return json(req, res, 200, printable
            ? { ok: true, at: captured.at, remote: captured.remote, text }
            : { ok: true, at: captured.at, remote: captured.remote, base64: captured.buffer.toString('base64') });
    }

    if (url.pathname === '/send' && req.method === 'POST') {
        if (!authorized(req)) return json(req, res, 401, { ok: false, error: 'bridge token required (Authorization: Bearer <token>)' });
        if (listenPort) return json(req, res, 400, { ok: false, error: 'running in capture mode; restart without --listen to forward' });
        const host = url.searchParams.get('host') || 'localhost';
        const rawPort = parseInt(url.searchParams.get('port') || '9100', 10);
        // Reject invalid ports with a JSON error instead of letting NaN
        // reach net.createConnection (review HIGH).
        if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
            return json(req, res, 400, { ok: false, error: `invalid port: ${url.searchParams.get('port')}` });
        }
        const port = rawPort;
        // Without this the bridge forwards to ANY host:port — an open TCP relay
        // for the LAN and, via CORS, for any website the operator visits.
        if (!isAllowedTarget(host, port)) {
            return json(req, res, 403, { ok: false, error: `printer target ${host}:${port} is not on the allow list (start with --allow=${host}:${port})` });
        }
        const ms = Math.max(200, parseInt(url.searchParams.get('ms') || '2000', 10));
        const chunks = [];
        let received = 0;
        let rejected = false;
        req.on('data', c => {
            received += c.length;
            if (received > MAX_SEND_BYTES && !rejected) {
                rejected = true;
                json(req, res, 413, { ok: false, error: `request body exceeds ${MAX_SEND_BYTES} bytes` });
                req.destroy();
                return;
            }
            if (!rejected) chunks.push(c);
        });
        req.on('end', async () => {
            if (rejected) return;
            const body = Buffer.concat(chunks);
            const result = await forwardToTcp(host, port, body, ms);
            accessLog(req, `/send?host=${host}&port=${port}`,
                result.ok ? `-> ${host}:${port} ${body.length}B flushed` : `-> ${host}:${port} FAILED ${result.error}`);
            json(req, res, result.ok ? 200 : 502, result);
        });
        return;
    }

    json(req, res, 404, { ok: false, error: 'unknown endpoint' });
};

// fileURLToPath, not `new URL(...).pathname`: a pathname keeps percent-encoding,
// so a checkout under a directory with a space compares unequal and the CLI
// silently exits having listened on nothing (same guard as the other servers).
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
    const server = http.createServer(handleBridgeRequest);
    server.on('error', err => {
        console.error(`[bridge] cannot listen on http/${httpPort}: ${err.message}`);
        process.exit(1);
    });
    const host = bindHost();
    server.listen(httpPort, host, () => {
        console.log(`[bridge] IPL bridge on http://${host}:${httpPort} ${listenPort ? `(capture tcp/${listenPort})` : '(forward -> tcp/9100)'}`);
        if (bridgeToken()) console.log('[bridge] token auth enabled for /send');
        else console.log('[bridge] no --token: /send accepts any local caller (single-station default)');
        console.log(`[bridge] printer allow list: ${allowList().join(', ')}`);
    });
}
