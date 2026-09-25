import { describe, it, expect, beforeEach } from 'vitest';
import {
    memoryBackend, setLibraryBackend, listLibrary, getLibraryRecord, saveLibraryRecord,
    deleteLibraryRecord, migrateLegacyLibrary, isLibraryName,
    serializeLabelFile, parseLabelFile, designChecksum,
    saveSharedSource, listSharedSources, importSharedSource, deleteSharedSource,
    writeRecovery, readRecovery, clearRecovery,
} from '../services/libraryStore';
import type { Design } from '../types';

const design = (name: string, extra: Partial<Design> = {}): Design => ({
    name,
    labelSettings: { width: 100, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields: [{ id: 1, type: 'text', name: 'A', x: 0, y: 0, rotation: 0, dataSource: { type: 'fixed', data: 'hi' }, font: '25', fontSize: 12, h_mag: 1, w_mag: 1 }],
    dataSources: [],
    nextId: 2,
    guides: { horizontal: [], vertical: [] },
    ...extra,
} as Design);

beforeEach(() => {
    setLibraryBackend(memoryBackend());
    localStorage.clear();
});

describe('shared data sources', () => {
    const table = {
        id: 'tbl-1', type: 'table' as const, name: 'Stock',
        columns: ['SKU'], rows: [{ SKU: 'A1' }, { SKU: 'B2' }],
        query: { filters: [], combine: 'and' as const },
    };

    it('round-trips a table and reports its size', async () => {
        await saveSharedSource('Warehouse', table, 1000);
        const list = await listSharedSources();
        expect(list).toEqual([{ name: 'Warehouse', type: 'table', detail: '2 rows', updatedAt: 1000 }]);
    });

    it('imports a COPY with a fresh id, leaving the stored one untouched', async () => {
        await saveSharedSource('Warehouse', table);
        const copy = await importSharedSource('Warehouse', 'tbl-fresh');
        expect(copy?.id).toBe('tbl-fresh');
        expect(copy?.type === 'table' && copy.rows).toEqual(table.rows);

        // Mutating the copy must not change what the library hands out next.
        if (copy && copy.type === 'table') copy.rows.push({ SKU: 'C3' });
        const again = await importSharedSource('Warehouse', 'tbl-other');
        expect(again?.type === 'table' && again.rows).toHaveLength(2);
    });

    it('returns null for a name that is not there', async () => {
        expect(await importSharedSource('missing', 'x')).toBeNull();
    });

    it('refuses a blank name', async () => {
        await expect(saveSharedSource('   ', table)).rejects.toThrow();
    });

    it('delete removes it from the list', async () => {
        await saveSharedSource('Warehouse', table);
        await deleteSharedSource('Warehouse');
        expect(await listSharedSources()).toEqual([]);
    });
});

describe('libraryStore save/list/load/delete', () => {
    it('round-trips a design including its bitmap image field', async () => {
        const bitmap = ['101', '010', '101'];
        const d = design('With image', {
            fields: [{ id: 1, type: 'image', name: 'Logo', x: 1, y: 2, rotation: 0, bitmap, width: 10, height: 10, threshold: 128 } as Design['fields'][number]],
        });
        await saveLibraryRecord(d, { thumbnail: 'data:image/png;base64,AAAA', tags: ['shipping'], now: 1000 });

        const meta = await listLibrary();
        expect(meta).toHaveLength(1);
        expect(meta[0]).toMatchObject({ name: 'With image', widthMm: 100, heightMm: 50, dpi: 203, tags: ['shipping'], thumbnail: 'data:image/png;base64,AAAA' });
        // The listing must not carry the design itself — it is the heavy part.
        expect(meta[0]).not.toHaveProperty('design');

        const loaded = await getLibraryRecord('With image');
        expect(loaded?.design.fields[0]).toMatchObject({ type: 'image', bitmap });
    });

    it('lists newest first', async () => {
        await saveLibraryRecord(design('old'), { now: 1 });
        await saveLibraryRecord(design('new'), { now: 2 });
        expect((await listLibrary()).map(m => m.name)).toEqual(['new', 'old']);
    });

    it('an update keeps tags and thumbnail it was not given', async () => {
        await saveLibraryRecord(design('A'), { tags: ['kept'], thumbnail: 'png', now: 1 });
        await saveLibraryRecord(design('A'), { now: 2 });
        const rec = await getLibraryRecord('A');
        expect(rec?.tags).toEqual(['kept']);
        expect(rec?.thumbnail).toBe('png');
        expect(rec?.updatedAt).toBe(2);
    });

    it('an explicit null thumbnail clears it', async () => {
        await saveLibraryRecord(design('A'), { thumbnail: 'png', now: 1 });
        await saveLibraryRecord(design('A'), { thumbnail: null, now: 2 });
        expect((await getLibraryRecord('A'))?.thumbnail).toBeNull();
    });

    it('refuses an empty or over-long name without storing anything', async () => {
        await expect(saveLibraryRecord(design('   '))).rejects.toThrow();
        await expect(saveLibraryRecord(design('x'.repeat(201)))).rejects.toThrow();
        expect(await listLibrary()).toEqual([]);
    });

    it('delete removes the record and only that record', async () => {
        await saveLibraryRecord(design('A'), { now: 1 });
        await saveLibraryRecord(design('B'), { now: 2 });
        await deleteLibraryRecord('A');
        expect((await listLibrary()).map(m => m.name)).toEqual(['B']);
        expect(await getLibraryRecord('A')).toBeNull();
    });
});

describe('isLibraryName', () => {
    it('accepts only non-blank strings within the length cap', () => {
        expect(isLibraryName('Label 1')).toBe(true);
        expect(isLibraryName('')).toBe(false);
        expect(isLibraryName('   ')).toBe(false);
        expect(isLibraryName(42)).toBe(false);
    });
});

describe('label file envelope', () => {
    it('round-trips a design byte for byte', () => {
        const d = design('Exported');
        const back = parseLabelFile(serializeLabelFile(d));
        expect(back.ok).toBe(true);
        if (back.ok) {
            expect(back.version).toBe(1);
            expect(back.design).toEqual(d);
        }
    });

    it('refuses a file whose checksum was disturbed', () => {
        const text = serializeLabelFile(design('Exported'));
        const tampered = text.replace('"Exported"', '"Tampered"');
        const back = parseLabelFile(tampered);
        expect(back.ok).toBe(false);
        if (back.ok === false) expect(back.error).toMatch(/[Cc]hecksum/);
    });

    it('still imports a legacy bare design JSON', () => {
        const back = parseLabelFile(JSON.stringify(design('Old export')));
        expect(back.ok).toBe(true);
        if (back.ok) expect(back.version).toBe(0);
    });

    it('refuses a schema version this build does not know', () => {
        const back = parseLabelFile(JSON.stringify({ labelFileVersion: 99, checksum: 'x', design: design('Future') }));
        expect(back.ok).toBe(false);
    });

    it('refuses non-design payloads without throwing', () => {
        expect(parseLabelFile('not json').ok).toBe(false);
        expect(parseLabelFile('[1,2,3]').ok).toBe(false);
        expect(parseLabelFile('{"hello":1}').ok).toBe(false);
    });

    it('checksum is stable for identical content', () => {
        expect(designChecksum(design('A'))).toBe(designChecksum(design('A')));
        expect(designChecksum(design('A'))).not.toBe(designChecksum(design('B')));
    });
});

describe('migrateLegacyLibrary', () => {
    const legacy = (names: string[], bodies: Record<string, string>) => {
        localStorage.setItem('ipl_designer_saved_designs', JSON.stringify(names));
        for (const [name, body] of Object.entries(bodies)) localStorage.setItem(`ipl_design_${name}`, body);
    };

    it('moves localStorage designs over, skipping malformed ones', async () => {
        legacy(['Good', 'Bad', 'Missing'], {
            Good: JSON.stringify(design('Good')),
            Bad: '"not a design"',
        });
        expect(await migrateLegacyLibrary()).toBe(1);
        expect((await listLibrary()).map(m => m.name)).toEqual(['Good']);
    });

    it('runs only once', async () => {
        legacy(['Good'], { Good: JSON.stringify(design('Good')) });
        expect(await migrateLegacyLibrary()).toBe(1);
        localStorage.setItem('ipl_design_Later', JSON.stringify(design('Later')));
        expect(await migrateLegacyLibrary()).toBe(0);
        expect(await getLibraryRecord('Later')).toBeNull();
    });

    it('does not overwrite a design the backend already holds', async () => {
        await saveLibraryRecord(design('A', { nextId: 99 }), { now: 5 });
        legacy(['A'], { A: JSON.stringify(design('A', { nextId: 1 })) });
        expect(await migrateLegacyLibrary()).toBe(0);
        expect((await getLibraryRecord('A'))?.design.nextId).toBe(99);
    });

    it('tolerates a corrupt legacy index', async () => {
        localStorage.setItem('ipl_designer_saved_designs', '{not json');
        expect(await migrateLegacyLibrary()).toBe(0);
        expect(await listLibrary()).toEqual([]);
    });
});

describe('autosave drafts (Fase 1)', () => {
    it('round-trips a draft with the name it was edited under', async () => {
        await writeRecovery(design('Invoice', { nextId: 7 }), 1234);
        const draft = await readRecovery();
        expect(draft?.designName).toBe('Invoice');
        expect(draft?.design.nextId).toBe(7);
        expect(draft?.updatedAt).toBe(1234);
    });

    it('replaces the previous draft rather than accumulating them', async () => {
        await writeRecovery(design('A', { nextId: 2 }), 1);
        await writeRecovery(design('A', { nextId: 3 }), 2);
        expect((await readRecovery())?.design.nextId).toBe(3);
    });

    it('CANNOT overwrite a design the user saved — that is the point of the slot', async () => {
        // The whole reason drafts live in their own store: a user who saves a
        // good version and then experiments must still find the good version.
        await saveLibraryRecord(design('A', { nextId: 99 }), { now: 1 });
        await writeRecovery(design('A', { nextId: 4 }), 2);
        expect((await getLibraryRecord('A'))?.design.nextId).toBe(99);
        expect((await readRecovery())?.design.nextId).toBe(4);
        // And the draft never shows up as a saved design.
        expect((await listLibrary()).map(m => m.name)).toEqual(['A']);
    });

    it('clearing the draft leaves the saved design untouched', async () => {
        await saveLibraryRecord(design('A', { nextId: 99 }), { now: 1 });
        await writeRecovery(design('A', { nextId: 4 }), 2);
        await clearRecovery();
        expect(await readRecovery()).toBeNull();
        expect((await getLibraryRecord('A'))?.design.nextId).toBe(99);
    });

    it('returns false for an unstorable name instead of storing a nameless draft', async () => {
        expect(await writeRecovery(design('   '), 1)).toBe(false);
        expect(await readRecovery()).toBeNull();
    });
});
