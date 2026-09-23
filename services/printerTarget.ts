// Batch K (2026-09-21): one persisted printer target shared by the viewer's
// Send button and the designer's "Send Job". Warehouse/shop-floor printers
// live on the network (192.168.x.x:9100), so the localhost-only designer
// send flagged in the Batch J review is lifted: both surfaces read/write
// this same localStorage entry, and every consumer validates through the
// shared port guard before trusting it (an invalid port once crashed the
// bridge daemon — see bridgeSend/ipl-bridge history).

export interface PrinterTarget {
    host: string;
    port: string;
}

export const DEFAULT_TARGET: PrinterTarget = { host: 'localhost', port: '9100' };

const STORAGE_KEY = 'ipl_printer_target';

/** Port must be a plain integer in 1-65535 (whitespace tolerated). */
export const isValidPrinterPort = (port: string): boolean => {
    const n = Number(port.trim());
    return Number.isInteger(n) && n >= 1 && n <= 65535;
};

/**
 * Clean a user-typed host: trim, drop an accidental scheme ('http://') or
 * port suffix ('printer:9100') — people paste from browser bars and
 * config files. IPv6 is preserved: bracketed forms keep the literal
 * ('[::1]:9100' -> '::1'), and a bare address containing ':' is returned
 * untouched, because 'fe80::1' has no separable port — the old naive
 * ':\\d*$' strip corrupted '::1' into ':' (which then silently fell back
 * to localhost downstream). Empty stays empty; validity is the caller's
 * decision.
 */
export const normalizeHost = (host: string): string => {
    let h = (host || '').trim();
    h = h.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:)?\/\//, ''); // scheme:// or bare //
    h = h.replace(/^[^@/]*@/, '');                          // user:pass@host -> host
    h = h.replace(/\/.*$/, '');                          // any path
    if (h.startsWith('[')) {                             // [ipv6]:port
        const close = h.indexOf(']');
        if (close > 0) return h.slice(1, close).trim();
        return h.trim();
    }
    if (h.includes(':') && h.indexOf(':') !== h.lastIndexOf(':')) return h.trim(); // bare IPv6 — no port to strip
    h = h.replace(/:\d*$/, '');                          // host:port
    return h.trim();
};

/** Read the persisted target; corrupt/invalid storage falls back to defaults. */
export const getPrinterTarget = (): PrinterTarget => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { ...DEFAULT_TARGET };
        const j = JSON.parse(raw);
        if (!j || typeof j !== 'object' || Array.isArray(j)) return { ...DEFAULT_TARGET };
        const host = typeof j.host === 'string' ? normalizeHost(j.host) : '';
        const port = typeof j.port === 'string' ? j.port.trim() : '';
        if (!host || !isValidPrinterPort(port)) return { ...DEFAULT_TARGET };
        return { host, port };
    } catch {
        return { ...DEFAULT_TARGET };
    }
};

/** Persist a target after normalization; throws on invalid input so UIs surface the mistake. */
export const setPrinterTarget = (t: PrinterTarget): PrinterTarget => {
    const host = normalizeHost(t.host);
    const port = (t.port || '').trim();
    if (!host) throw new Error('Printer host is empty.');
    if (!isValidPrinterPort(port)) throw new Error(`Invalid printer port "${port}" — must be 1-65535.`);
    const clean = { host, port };
    // Review HIGH: a storage write failure (quota, private-mode
    // SecurityError) must not block printing — the send proceeds with the
    // clean target; persistence is best-effort.
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
    } catch { /* storage unavailable; target valid for this session */ }
    return clean;
};
