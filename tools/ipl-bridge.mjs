#!/usr/bin/env node
// IPL Bridge - zero-dependency local relay for the IPL Viewer.
//
// Browsers cannot open raw TCP sockets, so the viewer talks to this tiny
// local HTTP server, which forwards payloads to a printer / Honeywell
// printer-simulator listening on a raw TCP port (default 9100).
//
// Usage:
//   node tools/ipl-bridge.mjs                 # forward mode  (HTTP :9181 -> TCP localhost:9100)
//   node tools/ipl-bridge.mjs --port=9200     # custom HTTP port
//   node tools/ipl-bridge.mjs --listen=9100   # capture mode: fake printer that records streams
//
// Endpoints (forward mode):
//   GET  /ping                     -> { ok: true }
//   POST /send?host=&port=&ms=     -> forwards request body (text/binary) over TCP
// Endpoints (capture mode, --listen=N):
//   GET  /capture                  -> last received stream as text (or base64 if binary)
//   DELETE /capture                -> clears the buffer

import http from 'node:http';
import net from 'node:net';

const args = process.argv.slice(2);
const opt = name => {
    const hit = args.find(a => a === name || a.startsWith(`${name}=`));
    return hit ? (hit.includes('=') ? hit.split('=')[1] : true) : undefined;
};

const httpPort = parseInt(opt('--port') || '9181', 10);
const listenPort = opt('--listen') ? parseInt(opt('--listen'), 10) : null;

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' });
    res.end(body);
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

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        return res.end();
    }
    const url = new URL(req.url, `http://localhost:${httpPort}`);

    if (url.pathname === '/ping' && req.method === 'GET') {
        return json(res, 200, { ok: true, mode: listenPort ? 'capture' : 'forward' });
    }

    if (listenPort && url.pathname === '/capture') {
        if (req.method === 'DELETE') { captured = null; return json(res, 200, { ok: true }); }
        if (!captured) return json(res, 404, { ok: false, error: 'no capture yet' });
        const text = captured.buffer.toString('utf8');
        const printable = /^[\x20-\x7e\s<>=]*$/.test(text.replace(/<STX>|<ETX>/g, '')) ||
                          /<STX>/.test(text) || !text.includes('\u0000');
        return json(res, 200, printable
            ? { ok: true, at: captured.at, remote: captured.remote, text }
            : { ok: true, at: captured.at, remote: captured.remote, base64: captured.buffer.toString('base64') });
    }

    if (url.pathname === '/send' && req.method === 'POST') {
        if (listenPort) return json(res, 400, { ok: false, error: 'running in capture mode; restart without --listen to forward' });
        const host = url.searchParams.get('host') || 'localhost';
        const rawPort = parseInt(url.searchParams.get('port') || '9100', 10);
        // Reject invalid ports with a JSON error instead of letting NaN
        // reach net.createConnection (review HIGH).
        if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
            return json(res, 400, { ok: false, error: `invalid port: ${url.searchParams.get('port')}` });
        }
        const port = rawPort;
        const ms = Math.max(200, parseInt(url.searchParams.get('ms') || '2000', 10));
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', async () => {
            const result = await forwardToTcp(host, port, Buffer.concat(chunks), ms);
            json(res, result.ok ? 200 : 502, result);
        });
        return;
    }

    json(res, 404, { ok: false, error: 'unknown endpoint' });
});

server.on('error', err => {
    console.error(`[bridge] cannot listen on http/${httpPort}: ${err.message}`);
    process.exit(1);
});
server.listen(httpPort, () => {
    console.log(`[bridge] IPL bridge on http://localhost:${httpPort} ${listenPort ? `(capture tcp/${listenPort})` : '(forward -> tcp/9100)'}`);
});
