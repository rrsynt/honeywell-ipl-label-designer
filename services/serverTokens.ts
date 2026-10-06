// Hardening (audit SEC-02, 2026-10-06): the four local servers accept an
// optional --token, and every route except /ping then requires
// `Authorization: Bearer <token>`. This module is the browser side of that:
// per-server tokens in localStorage (same storage pattern as the server URLs),
// attached by the four remote backends' central request functions.
//
// Without a token stored, nothing is sent — a server started without --token
// stays public and old setups keep working with zero changes. A 401 answer
// names the fix ("start the UI with the same token"), it is never swallowed
// into a generic "unreachable".

export type ServerKind = 'bridge' | 'print' | 'library' | 'db';

const TOKEN_KEYS: Record<ServerKind, string> = {
    bridge: 'ipl_bridge_token',
    print: 'ipl_print_server_token',
    library: 'ipl_library_server_token',
    db: 'ipl_db_server_token',
};

const readKey = (key: string, storage: Storage): string => {
    try {
        return (storage.getItem(key) ?? '').trim();
    } catch {
        return '';
    }
};

/** The stored token for a server, or '' when none is set. Never throws. */
export const getServerToken = (kind: ServerKind, storage: Storage = localStorage): string =>
    readKey(TOKEN_KEYS[kind], storage);

/** Persist a token ('' clears it). Never throws — private mode keeps it for
 *  the session via the caller's in-memory use. Returns the cleaned value. */
export const setServerToken = (kind: ServerKind, token: string, storage: Storage = localStorage): string => {
    const clean = token.trim();
    try {
        if (clean === '') storage.removeItem(TOKEN_KEYS[kind]);
        else storage.setItem(TOKEN_KEYS[kind], clean);
    } catch { /* storage unavailable; the caller still applies it in memory */ }
    return clean;
};

/** `Authorization` header for a server, or undefined when no token is stored —
 *  so requests to a token-less server are byte-identical to before. */
export const authHeader = (kind: ServerKind, storage: Storage = localStorage): { Authorization: string } | undefined => {
    const token = getServerToken(kind, storage);
    return token === '' ? undefined : { Authorization: `Bearer ${token}` };
};

/** True when an HTTP status is an auth refusal rather than a dead server — the
 *  UI must say "wrong/missing token", not "start the server". */
export const isAuthFailure = (status: number): boolean => status === 401;
