// Fase 6: the saved printer list.
//
// The list is separate from printerTarget.ts's single active target, so the
// two must not drift: choosing a saved target has to leave the viewer's Send
// button and the designer's Send Job pointing at the same machine. That, plus
// the one-time migration off the legacy localStorage entry, is what this file
// pins.

import { describe, it, expect, beforeEach } from 'vitest';
import {
    memoryTargetBackend, setPrintTargetBackend, validateTarget, savePrintTarget, listPrintTargets,
    deletePrintTarget, activatePrintTarget, migrateLegacyTarget, defaultPrintTarget, legacyTargetAsEntry,
} from '../services/printTargets';
import { getPrinterTarget, setPrinterTarget } from '../services/printerTarget';

beforeEach(() => {
    setPrintTargetBackend(memoryTargetBackend());
    localStorage.clear();
});

const valid = { name: 'Line 1', host: '10.0.0.5', port: '9100', language: 'ipl' as const, dpi: 203 as const };

describe('validateTarget', () => {
    it('accepts a well-formed target and normalizes what it can', () => {
        const { target, error } = validateTarget({ ...valid, name: '  Line 1  ', host: ' http://10.0.0.5:9100/ ' });
        expect(error).toBeNull();
        expect(target).toEqual({ ...valid, host: '10.0.0.5' });
    });

    it('rejects each broken field with a message that names it', () => {
        expect(validateTarget({ ...valid, name: '   ' }).error).toMatch(/name/i);
        expect(validateTarget({ ...valid, name: 'x'.repeat(61) }).error).toMatch(/too long/i);
        expect(validateTarget({ ...valid, host: '' }).error).toMatch(/host/i);
        // The port guard is printerTarget's, kept in one place because an
        // invalid port once crashed the bridge daemon.
        for (const port of ['abc', '0', '65536', '91.5', '']) {
            expect(validateTarget({ ...valid, port }).error, port).toMatch(/port/i);
        }
        expect(validateTarget({ ...valid, language: 'epl' as never }).error).toMatch(/language/i);
        expect(validateTarget({ ...valid, dpi: 600 as never }).error).toMatch(/dpi/i);
    });

    it('refuses the target rather than silently repairing a field it cannot fix', () => {
        const { target } = validateTarget({ ...valid, host: '   ' });
        expect(target).toBeNull();
    });
});

describe('the target list', () => {
    it('saves, lists name-sorted, and deletes', async () => {
        await savePrintTarget({ ...valid, name: 'Zebra line' });
        await savePrintTarget({ ...valid, name: 'Alpha line' });
        expect((await listPrintTargets()).map(t => t.name)).toEqual(['Alpha line', 'Zebra line']);
        const [first] = await listPrintTargets();
        await deletePrintTarget(first.id);
        expect((await listPrintTargets()).map(t => t.name)).toEqual(['Zebra line']);
    });

    it('keeps an existing id on update, so editing does not orphan a job', async () => {
        const saved = await savePrintTarget(valid);
        const updated = await savePrintTarget({ ...saved, name: 'Renamed' });
        expect(updated.id).toBe(saved.id);
        expect(await listPrintTargets()).toHaveLength(1);
    });

    it('throws on invalid input instead of storing an unprintable target', async () => {
        await expect(savePrintTarget({ ...valid, port: 'abc' })).rejects.toThrow(/port/i);
        expect(await listPrintTargets()).toHaveLength(0);
    });

    it('two targets may share a host — the id is the identity', async () => {
        const a = await savePrintTarget({ ...valid, name: 'Front' });
        const b = await savePrintTarget({ ...valid, name: 'Back', port: '9101' });
        expect(a.id).not.toBe(b.id);
        expect(await listPrintTargets()).toHaveLength(2);
    });
});

describe('activatePrintTarget', () => {
    it('points the shared active target at the chosen printer', async () => {
        const saved = await savePrintTarget({ ...valid, host: '10.0.0.9', port: '9101' });
        expect(activatePrintTarget(saved)).toBeNull();
        expect(getPrinterTarget()).toEqual({ host: '10.0.0.9', port: '9101' });
    });

    it('reports the refusal instead of throwing at the caller', () => {
        // A target that came back from storage with a corrupt port: the write
        // must fail loudly in the UI, not silently leave the old target.
        setPrinterTarget({ host: '1.1.1.1', port: '9100' });
        const message = activatePrintTarget({ ...valid, id: 'x', host: 'ok', port: 'nope' });
        expect(message).toMatch(/port/i);
        expect(getPrinterTarget()).toEqual({ host: '1.1.1.1', port: '9100' });
    });
});

describe('migrateLegacyTarget', () => {
    it('turns a stored legacy target into the first list entry, once', async () => {
        // What Batch K wrote: a plain JSON {host, port}.
        localStorage.setItem('ipl_printer_target', JSON.stringify({ host: '192.168.1.50', port: '9101' }));
        expect(await migrateLegacyTarget()).toBe(true);
        const [entry] = await listPrintTargets();
        expect(entry).toMatchObject({ host: '192.168.1.50', port: '9101', language: 'ipl', dpi: 203 });
        // Second call: the flag is set, nothing more is added.
        expect(await migrateLegacyTarget()).toBe(false);
        expect(await listPrintTargets()).toHaveLength(1);
    });

    it('invents nothing when there was no legacy target', async () => {
        expect(await migrateLegacyTarget()).toBe(false);
        expect(await listPrintTargets()).toHaveLength(0);
    });

    it('never touches a list the user already made', async () => {
        await savePrintTarget({ ...valid, name: 'Real printer' });
        localStorage.setItem('ipl_printer_target', JSON.stringify({ host: 'stale.host', port: '9100' }));
        expect(await migrateLegacyTarget()).toBe(false);
        const list = await listPrintTargets();
        expect(list).toHaveLength(1);
        expect(list[0].host).toBe('10.0.0.5');
    });

    it('survives a corrupt legacy entry', async () => {
        localStorage.setItem('ipl_printer_target', 'not json{');
        // An unparsable entry falls back to the default host and IS valid, so
        // the migration records the default rather than crashing.
        await expect(migrateLegacyTarget()).resolves.toBe(true);
        expect((await listPrintTargets())[0].port).toBe('9100');
    });
});

describe('defaultPrintTarget', () => {
    it('prefers the first saved target', async () => {
        await savePrintTarget({ ...valid, name: 'Saved' });
        expect((await defaultPrintTarget()).name).toBe('Saved');
    });

    it('falls back to the active legacy target as a one-off entry', async () => {
        setPrinterTarget({ host: '10.20.5.8', port: '9101' });
        const fallback = await defaultPrintTarget();
        expect(fallback).toMatchObject({ host: '10.20.5.8', port: '9101', id: 'legacy' });
        // A one-off is not written to the list: the user has not decided to
        // keep this machine.
        expect(await listPrintTargets()).toHaveLength(0);
    });

    it('describes the legacy entry the way the migration does', () => {
        setPrinterTarget({ host: 'p.local', port: '9100' });
        expect(legacyTargetAsEntry()).toEqual({ name: 'p.local:9100', host: 'p.local', port: '9100', language: 'ipl', dpi: 203 });
    });
});
