// Batch K (2026-09-21): one persisted printer target shared by the viewer's
// Send button and the designer's Send Job. Warehouse printers live on the
// network (192.168.x.x:9100), so localhost-only sending was the last
// workflow gap; and the viewer's host/port inputs did not survive reload.
// Storage is localStorage with the same shape both surfaces read; every
// value passes the shared port validator (Batch J's crash guard) before it
// is trusted.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getPrinterTarget, setPrinterTarget, isValidPrinterPort, normalizeHost, DEFAULT_TARGET } from '../services/printerTarget';

beforeEach(() => localStorage.clear());

describe('isValidPrinterPort', () => {
    it('accepts integers 1-65535, tolerates surrounding whitespace', () => {
        expect(isValidPrinterPort('9100')).toBe(true);
        expect(isValidPrinterPort(' 9100 ')).toBe(true);
        expect(isValidPrinterPort('1')).toBe(true);
        expect(isValidPrinterPort('65535')).toBe(true);
    });
    it('rejects everything else (the Batch J crash inputs)', () => {
        for (const bad of ['abc', '', '0', '65536', '-1', '91.5', '9100abc', 'e9']) {
            expect(isValidPrinterPort(bad), bad).toBe(false);
        }
    });
});

describe('normalizeHost', () => {
    it('trims whitespace and strips an accidental scheme/port suffix', () => {
        expect(normalizeHost(' 192.168.1.50 ')).toBe('192.168.1.50');
        expect(normalizeHost('http://printer.local')).toBe('printer.local');
        expect(normalizeHost('printer.local:9100')).toBe('printer.local');
        expect(normalizeHost('')).toBe('');
    });

    it('preserves IPv6 (review: naive :port strip corrupted ::1 to ":")', () => {
        expect(normalizeHost('::1')).toBe('::1');
        expect(normalizeHost('fe80::1')).toBe('fe80::1');
        expect(normalizeHost('[2001:db8::1]:9100')).toBe('2001:db8::1');
        expect(normalizeHost('[::1]')).toBe('::1');
        expect(normalizeHost('http://[::1]:9100/')).toBe('::1');
    });

    it('handles protocol-relative and userinfo pastes (review MEDIUM/LOW)', () => {
        expect(normalizeHost('//192.168.1.50:9100')).toBe('192.168.1.50');
        expect(normalizeHost('http://admin:secret@192.168.1.50:9100/')).toBe('192.168.1.50');
    });
});

describe('printerTarget persistence', () => {
    it('defaults to localhost:9100 when storage is empty', () => {
        expect(getPrinterTarget()).toEqual(DEFAULT_TARGET);
    });

    it('round-trips a network printer through localStorage', () => {
        setPrinterTarget({ host: '10.20.5.8', port: '9100' });
        expect(getPrinterTarget()).toEqual({ host: '10.20.5.8', port: '9100' });
        // raw storage is plain JSON — the bridge UI reads it too
        expect(JSON.parse(localStorage.getItem('ipl_printer_target')!)).toEqual({ host: '10.20.5.8', port: '9100' });
    });

    it('falls back to defaults on corrupt or hostile storage', () => {
        localStorage.setItem('ipl_printer_target', 'not json{');
        expect(getPrinterTarget()).toEqual(DEFAULT_TARGET);
        localStorage.setItem('ipl_printer_target', JSON.stringify({ host: 'x', port: 'abc' }));
        expect(getPrinterTarget()).toEqual(DEFAULT_TARGET); // invalid port never trusted
        localStorage.setItem('ipl_printer_target', JSON.stringify({ host: 42, port: 9100 }));
        expect(getPrinterTarget()).toEqual(DEFAULT_TARGET); // non-strings rejected
        localStorage.setItem('ipl_printer_target', JSON.stringify('just a string'));
        expect(getPrinterTarget()).toEqual(DEFAULT_TARGET);
    });

    it('setPrinterTarget normalizes and refuses invalid ports (throws)', () => {
        setPrinterTarget({ host: ' http://p.local ', port: ' 9101 ' });
        expect(getPrinterTarget()).toEqual({ host: 'p.local', port: '9101' });
        expect(() => setPrinterTarget({ host: 'p', port: 'abc' })).toThrow(/port/i);
        expect(() => setPrinterTarget({ host: '  ', port: '9100' })).toThrow(/host/i);
        // storage untouched by the refused writes
        expect(getPrinterTarget()).toEqual({ host: 'p.local', port: '9101' });
    });

    it('review HIGH: a storage write failure does NOT block the send path', () => {
        const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('exceeded the quota', 'QuotaExceededError');
        });
        // setPrinterTarget must still return the clean target (throw only
        // for invalid INPUT, never for persistence problems).
        const clean = setPrinterTarget({ host: '10.0.0.9', port: '9100' });
        expect(clean).toEqual({ host: '10.0.0.9', port: '9100' });
        spy.mockRestore();
    });
});
