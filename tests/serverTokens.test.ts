// Hardening frontend side (audit SEC-02, 2026-10-06): per-server tokens are
// stored locally and attached as `Authorization: Bearer` by the four remote
// backends. Without a stored token nothing is sent (old servers stay public);
// a 401 surfaces the token fix, never a generic "unreachable".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getServerToken, setServerToken, authHeader, isAuthFailure } from '../services/serverTokens';
import { sendIplViaBridge, BRIDGE_AUTH_HINT } from '../services/bridgeSend';

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('serverTokens storage', () => {
    it('stores per server, trims, clears on empty', () => {
        expect(getServerToken('print')).toBe('');
        setServerToken('print', '  abc  ');
        expect(getServerToken('print')).toBe('abc');
        expect(getServerToken('library')).toBe('');
        setServerToken('print', '');
        expect(getServerToken('print')).toBe('');
    });

    it('authHeader is undefined without a token, Bearer with one', () => {
        expect(authHeader('db')).toBeUndefined();
        setServerToken('db', 't');
        expect(authHeader('db')).toEqual({ Authorization: 'Bearer t' });
    });

    it('only 401 is an auth failure', () => {
        expect(isAuthFailure(401)).toBe(true);
        expect(isAuthFailure(403)).toBe(false);
        expect(isAuthFailure(502)).toBe(false);
    });
});

describe('bridge client sends the token and names a 401', () => {
    const jsonResponse = (body: unknown, status = 200) => ({ status, json: async () => body });

    it('attaches the stored bridge token', async () => {
        setServerToken('bridge', 's3cret');
        let seen: Record<string, string> = {};
        vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
            seen = (init.headers ?? {}) as Record<string, string>;
            return jsonResponse({ ok: true, written: 1 });
        });
        const res = await sendIplViaBridge('X', { host: 'localhost', port: '9100' });
        expect(res.ok).toBe(true);
        expect(seen['Authorization']).toBe('Bearer s3cret');
    });

    it('sends no Authorization header without a stored token', async () => {
        let seen: Record<string, string> = {};
        vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
            seen = (init.headers ?? {}) as Record<string, string>;
            return jsonResponse({ ok: true, written: 1 });
        });
        await sendIplViaBridge('X', { host: 'localhost', port: '9100' });
        expect('Authorization' in seen).toBe(false);
    });

    it('a 401 maps to the token hint, not a generic bridge error', async () => {
        vi.stubGlobal('fetch', async () => jsonResponse({ ok: false, error: 'bridge token required' }, 401));
        const res = await sendIplViaBridge('X', { host: 'localhost', port: '9100' });
        expect(res.ok).toBe(false);
        expect(res.error).toBe(BRIDGE_AUTH_HINT);
    });
});
