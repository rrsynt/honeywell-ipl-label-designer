// Batch J (2026-09-21): shared bridge transport. The IPL viewer's Send
// button grew this logic inline; the designer's CSV job exporter needs the
// same path (paste CSV -> preview -> send, no file round-trip). Extracted
// here so both surfaces speak one protocol and the fetch plumbing is unit-
// testable with a stubbed fetch.
//
// Protocol (tools/ipl-bridge.mjs, forward mode):
//   GET  /ping                       -> {ok:true}
//   POST /send?host=H&port=P         body = raw IPL bytes -> {ok, written} | {ok:false, error}

import { getPrinterTarget, isValidPrinterPort, normalizeHost } from './printerTarget';

export const DEFAULT_BRIDGE_URL = 'http://localhost:9181';
// Batch K moved the host/port defaults to printerTarget.DEFAULT_TARGET (the
// single persisted source of truth); the old DEFAULT_PRINTER_* exports
// became dead code and were removed.
export interface BridgeResult {
    ok: boolean;
    /** Bytes written by the bridge on success. */
    written?: number;
    /** Human-readable failure reason (bridge error or unreachable hint). */
    error?: string;
}

const UNREACHABLE = 'Bridge unreachable. Start it with: node tools/ipl-bridge.mjs';

/** POST raw IPL text to the printer through the local bridge. */
export const sendIplViaBridge = async (
    ipl: string,
    opts: { bridgeUrl?: string; host?: string; port?: string; timeoutMs?: number } = {},
): Promise<BridgeResult> => {
    // Review HIGH: a non-numeric/out-of-range port reaches the bridge as
    // NaN and crashes its net.createConnection (unhandled RangeError kills
    // the daemon). Validate via the shared guard so the UI never sends one;
    // the bridge got its own guard too (defense in depth). Batch K: when
    // host/port are omitted they come from the persisted printer target.
    const persisted = getPrinterTarget();
    const rawPort = (opts.port ?? persisted.port).trim();
    if (!isValidPrinterPort(rawPort)) {
        return { ok: false, error: `Invalid printer port "${rawPort}" — must be 1-65535.` };
    }
    const portNum = Number(rawPort);
    // Review MEDIUM: a trailing slash would make `${base}//send`, which the
    // bridge's URL parser reads as an authority, not a path → 404.
    const base = (opts.bridgeUrl ?? DEFAULT_BRIDGE_URL).replace(/\/+$/, '');
    // Review LOW: an EXPLICIT host that normalizes to empty must error, not
    // silently retarget to localhost (a persisted empty host can't happen —
    // getPrinterTarget falls back to the default).
    const rawHost = opts.host ?? persisted.host;
    const host = normalizeHost(rawHost);
    if (!host) return { ok: false, error: 'Printer host is empty.' };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15_000);
    try {
        const r = await fetch(
            `${base}/send?host=${encodeURIComponent(host)}&port=${encodeURIComponent(String(portNum))}`,
            { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: ipl, signal: ctl.signal },
        );
        const j = await r.json().catch(() => null);
        if (j && j.ok) return { ok: true, written: j.written };
        return { ok: false, error: j?.error ? `Bridge error: ${j.error}` : `Bridge returned HTTP ${r.status}` };
    } catch (e) {
        // Review LOW: name-check without instanceof — cross-realm aborts
        // (workers, polyfills) may not carry the DOMException identity.
        if ((e as Error | undefined)?.name === 'AbortError') return { ok: false, error: 'Bridge timed out.' };
        return { ok: false, error: UNREACHABLE };
    } finally {
        clearTimeout(timer);
    }
};

/** Liveness probe for the bridge (short timeout; UI shows a status dot). */
export const pingBridge = async (bridgeUrl = DEFAULT_BRIDGE_URL, timeoutMs = 1500): Promise<boolean> => {
    const base = bridgeUrl.replace(/\/+$/, ''); // same trailing-slash guard as send
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const r = await fetch(`${base}/ping`, { signal: ctl.signal });
        const j = await r.json().catch(() => null);
        return !!(j && j.ok);
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
};
