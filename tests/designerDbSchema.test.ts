// The `recovery` store shipped with two different key paths.
//
// libraryStore.ts created it with `keyPath: 'name'` and fontStore.ts with
// `keyPath: 'slot'`, while the record written to it carries only `slot`. Which
// module reset the schema was decided by whichever opened the database first,
// so on a FRESH browser (where App.tsx's migrateLegacyLibrary runs before the
// font load) every autosave threw:
//
//     DataError: Evaluating the object store's key path did not yield a value
//
// — and the whole feature was silently dead. No test caught it, because the
// in-memory backends the suite injects never evaluate a key path: they are
// Maps, so a record with the wrong key stores and reads back perfectly.
//
// These tests hold the real backends to the declared schema by wrapping them
// and rejecting any write whose record does not carry the store's key. That is
// the IndexedDB behaviour the Maps were hiding.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SCHEMA, keyPathFor } from '../services/designerDb';
import {
    memoryBackend, setLibraryBackend, saveLibraryRecord, writeRecovery, readRecovery,
    listLibrary, saveSharedSource, listSharedSources,
} from '../services/libraryStore';
import { memoryFontBackend, setFontBackend, installFontFile } from '../services/fontStore';
import type { LibraryBackend } from '../services/libraryStore';
import type { DataSource, Design } from '../types';

const design = (name: string): Design => ({
    name,
    labelSettings: { width: 100, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields: [{ id: 1, type: 'text', name: 'A', x: 0, y: 0, rotation: 0, dataSource: { type: 'fixed', data: 'hi' }, font: '25', fontSize: 12, h_mag: 1, w_mag: 1 }],
    dataSources: [], nextId: 2, guides: { horizontal: [], vertical: [] },
} as Design);

/**
 * Wrap a backend so a write whose record lacks the store's declared key path
 * fails the way IndexedDB fails — instead of quietly succeeding like a Map.
 */
const strictBackend = (inner: LibraryBackend): { backend: LibraryBackend; violations: string[] } => {
    const violations: string[] = [];
    const check = (store: string, record: Record<string, unknown>): void => {
        const keyPath = keyPathFor(store);
        if (keyPath && (record == null || (record as Record<string, unknown>)[keyPath] === undefined)) {
            violations.push(`${store} (keyPath "${keyPath}") got a record without it`);
        }
    };
    return {
        violations,
        backend: {
            ...inner,
            put: async (record) => { check('designs', record as unknown as Record<string, unknown>); await inner.put(record); },
            putSource: async (record) => { check('sources', record as unknown as Record<string, unknown>); await inner.putSource(record); },
            putRecovery: async (record) => { check('recovery', record as unknown as Record<string, unknown>); await inner.putRecovery(record); },
        },
    };
};

let strict: ReturnType<typeof strictBackend>;

beforeEach(() => {
    strict = strictBackend(memoryBackend());
    setLibraryBackend(strict.backend);
    setFontBackend(memoryFontBackend());
    localStorage.clear();
});

describe('the declared schema', () => {
    it('keys every store by a field its records actually carry', () => {
        // Pinned literally: this list is the contract the two modules share,
        // and the bug was a silent divergence between two copies of it.
        expect(SCHEMA).toEqual([
            { name: 'designs', keyPath: 'name' },
            { name: 'sources', keyPath: 'name' },
            { name: 'fonts', keyPath: 'name' },
            { name: 'recovery', keyPath: 'slot' },
        ]);
    });

    it('keys the fonts store by name', () => {
        expect(keyPathFor('fonts')).toBe('name');
    });
});

describe('every write satisfies the schema', () => {
    it('a saved design carries the `name` its store is keyed by', async () => {
        await saveLibraryRecord(design('Invoice'), { now: 1 });
        expect(strict.violations).toEqual([]);
        expect((await listLibrary())[0].name).toBe('Invoice');
    });

    it('a shared source carries `name`', async () => {
        const source: DataSource = { id: 's1', name: 'Stock', type: 'variable', sampleData: 'x' };
        await saveSharedSource('Stock', source, 1);
        expect(strict.violations).toEqual([]);
        expect(await listSharedSources()).toHaveLength(1);
    });

    it('THE BUG: an autosaved draft carries the `slot` its store is keyed by', async () => {
        // Against the shipped bug this is the assertion that fires: the record
        // has no `name`, and the store was created keyed by `name`.
        expect(await writeRecovery(design('Invoice'), 1234)).toBe(true);
        expect(strict.violations).toEqual([]);
        expect((await readRecovery())?.slot).toBe('current');
    });
});

describe('the font backend', () => {
    it('writes records carrying `name`, the key the fonts store declares', async () => {
        const puts: string[] = [];
        setFontBackend({
            list: async () => [],
            put: async (font) => {
                const keyPath = keyPathFor('fonts')!;
                expect((font as unknown as Record<string, unknown>)[keyPath]).toBeDefined();
                puts.push(font.name);
            },
            remove: async () => {},
        });
        // Measure against a stub so the test needs no canvas or font bytes.
        const measureCtx = { font: '', measureText: () => ({ width: 50 }) };
        const file = new File([new Uint8Array([0, 1, 2, 3])], 'Inter.ttf');
        await installFontFile(file, measureCtx);
        expect(puts).toEqual(['Inter']);
    });
});
