// Document library storage (Fase 1 of the BarTender-parity plan).
//
// localStorage caps at ~5 MB and a single image field blows past that, so the
// library lives in IndexedDB. The interesting part is kept storage-agnostic:
// every function below talks to a `LibraryBackend`, and the default backend is
// chosen once (`indexedDbBackend` in a browser, `memoryBackend` everywhere
// else — happy-dom has no IndexedDB, so tests run against memory and prove the
// same code path the browser runs).
//
// Records split in two on purpose. `LibraryMeta` is small and listed often;
// `LibraryRecord` adds the full Design, which is large and only read when a
// document is actually opened.

import type { DataSource, Design } from '../types';

export interface LibraryMeta {
    name: string;
    /** Label size at save time, so the start screen can show it without
     *  loading the whole design. */
    widthMm: number;
    heightMm: number;
    dpi: number;
    /** Free-form folder/category tags. A design can sit in several. */
    tags: string[];
    updatedAt: number;
    /** data-URL PNG, or null when no thumbnail was rendered (headless save). */
    thumbnail: string | null;
}

export interface LibraryRecord extends LibraryMeta {
    design: Design;
}

/**
 * A data source saved for reuse. `source` is a COPY — a design that imports it
 * keeps its own rows, so editing or deleting the library entry never changes a
 * label that was already printed from it.
 */
export interface SourceRecord {
    name: string;
    source: DataSource;
    updatedAt: number;
}

export interface LibraryBackend {
    list(): Promise<LibraryMeta[]>;
    get(name: string): Promise<LibraryRecord | null>;
    put(record: LibraryRecord): Promise<void>;
    remove(name: string): Promise<void>;
    /** Every full record, oldest first. Used only by the one-time migration
     *  out of localStorage. */
    all(): Promise<LibraryRecord[]>;
    listSources(): Promise<SourceRecord[]>;
    putSource(record: SourceRecord): Promise<void>;
    removeSource(name: string): Promise<void>;
}

const DB_NAME = 'ipl-designer';
// Version 3 adds the `fonts` store, opened by services/fontStore.ts. Both
// modules open this one database, so the version has to move in both places or
// the second opener throws a VersionError.
const DB_VERSION = 3;
const STORE = 'designs';
/** Fase 2: data sources saved for reuse across designs. A separate store so
 *  listing the library never has to read a table's rows. */
const SOURCE_STORE = 'sources';

const requestToPromise = <T>(req: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });

/** Reject names that would collide with the key path or can't be shown. */
export const isLibraryName = (name: unknown): name is string =>
    typeof name === 'string' && name.trim().length > 0 && name.length <= 200;

const toMeta = (record: LibraryRecord): LibraryMeta => {
    const { design: _design, ...meta } = record;
    return meta;
};

/**
 * The browser backend. The database is opened lazily and the handle cached;
 * a version-change from another tab invalidates it so the next call reopens.
 */
export const indexedDbBackend = (): LibraryBackend => {
    let dbPromise: Promise<IDBDatabase> | null = null;

    const open = (): Promise<IDBDatabase> => {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, { keyPath: 'name' });
                }
                if (!db.objectStoreNames.contains(SOURCE_STORE)) {
                    db.createObjectStore(SOURCE_STORE, { keyPath: 'name' });
                }
                if (!db.objectStoreNames.contains('fonts')) {
                    db.createObjectStore('fonts', { keyPath: 'name' });
                }
            };
            req.onsuccess = () => {
                const db = req.result;
                db.onversionchange = () => { db.close(); dbPromise = null; };
                resolve(db);
            };
            req.onerror = () => { dbPromise = null; reject(req.error); };
        });
        return dbPromise;
    };

    const store = async (mode: IDBTransactionMode, which: string = STORE): Promise<IDBObjectStore> => {
        const db = await open();
        return db.transaction(which, mode).objectStore(which);
    };

    return {
        list: async () => (await requestToPromise((await store('readonly')).getAll()) as LibraryRecord[])
            .map(toMeta)
            .sort((a, b) => b.updatedAt - a.updatedAt),
        get: async (name) => (await requestToPromise((await store('readonly')).get(name)) as LibraryRecord | undefined) ?? null,
        put: async (record) => { await requestToPromise((await store('readwrite')).put(record)); },
        remove: async (name) => { await requestToPromise((await store('readwrite')).delete(name)); },
        all: async () => (await requestToPromise((await store('readonly')).getAll()) as LibraryRecord[])
            .sort((a, b) => a.updatedAt - b.updatedAt),
        listSources: async () => (await requestToPromise((await store('readonly', SOURCE_STORE)).getAll()) as SourceRecord[])
            .sort((a, b) => b.updatedAt - a.updatedAt),
        putSource: async (record) => { await requestToPromise((await store('readwrite', SOURCE_STORE)).put(record)); },
        removeSource: async (name) => { await requestToPromise((await store('readwrite', SOURCE_STORE)).delete(name)); },
    };
};

/** In-memory backend: tests, and the fallback when IndexedDB is missing. */
export const memoryBackend = (): LibraryBackend => {
    const records = new Map<string, LibraryRecord>();
    const sources = new Map<string, SourceRecord>();
    return {
        list: async () => [...records.values()].map(toMeta).sort((a, b) => b.updatedAt - a.updatedAt),
        get: async (name) => records.get(name) ?? null,
        put: async (record) => { records.set(record.name, record); },
        remove: async (name) => { records.delete(name); },
        all: async () => [...records.values()].sort((a, b) => a.updatedAt - b.updatedAt),
        listSources: async () => [...sources.values()].sort((a, b) => b.updatedAt - a.updatedAt),
        putSource: async (record) => { sources.set(record.name, record); },
        removeSource: async (name) => { sources.delete(name); },
    };
};

const hasIndexedDb = (): boolean => {
    try { return typeof indexedDB !== 'undefined' && indexedDB !== null; } catch { return false; }
};

let backend: LibraryBackend = hasIndexedDb() ? indexedDbBackend() : memoryBackend();

/** Tests inject a backend so they exercise the real logic without a database. */
export const setLibraryBackend = (next: LibraryBackend): void => { backend = next; };

export const listLibrary = (): Promise<LibraryMeta[]> => backend.list();

/** Names only would hide a table's size, so the list carries a short summary. */
export interface SourceSummary {
    name: string;
    type: DataSource['type'];
    /** Rows for a table, the sample for a variable, the padded start for a counter. */
    detail: string;
    updatedAt: number;
}

const summarize = (record: SourceRecord): SourceSummary => {
    const s = record.source;
    const detail = s.type === 'table' ? `${s.rows.length} row${s.rows.length === 1 ? '' : 's'}`
        : s.type === 'counter' ? s.start.toString().padStart(s.padding, '0')
        : (s.sampleData || '(empty)');
    return { name: record.name, type: s.type, detail, updatedAt: record.updatedAt };
};

export const listSharedSources = async (): Promise<SourceSummary[]> =>
    (await backend.listSources()).map(summarize);

/**
 * Save a copy under its own name. The id is stripped of meaning on purpose: an
 * imported copy gets a fresh id, so two designs can hold the same source
 * without their field links colliding.
 */
export const saveSharedSource = async (name: string, source: DataSource, now = Date.now()): Promise<void> => {
    if (!isLibraryName(name)) throw new Error('Source name is empty or too long to store.');
    await backend.putSource({ name, source, updatedAt: now });
};

/**
 * A copy ready to drop into a design: same rows, new id. Returns null when the
 * name isn't in the library — the caller says so rather than adding a blank.
 */
export const importSharedSource = async (name: string, newId: string): Promise<DataSource | null> => {
    const found = (await backend.listSources()).find(r => r.name === name);
    if (!found) return null;
    // A deep copy: the rows array (and every row) must not be shared with the
    // stored record, or editing the imported source would rewrite the library.
    return { ...structuredClone(found.source), id: newId };
};

export const deleteSharedSource = (name: string): Promise<void> => backend.removeSource(name);
export const getLibraryRecord = (name: string): Promise<LibraryRecord | null> => backend.get(name);
export const deleteLibraryRecord = (name: string): Promise<void> => backend.remove(name);

export interface SaveLibraryOptions {
    /** data-URL PNG. Omitted on headless saves (tests, autosave before the
     *  canvas has painted) — the previous thumbnail is kept if there is one. */
    thumbnail?: string | null;
    tags?: string[];
    /** Injectable clock so tests can assert ordering without sleeping. */
    now?: number;
}

/**
 * Insert or replace by name. Tags and thumbnail default to "keep what was
 * there" on update, because an autosave must not wipe a tag the user set or a
 * thumbnail it can't recompute.
 */
export const saveLibraryRecord = async (design: Design, opts: SaveLibraryOptions = {}): Promise<LibraryRecord> => {
    if (!isLibraryName(design.name)) throw new Error('Design name is empty or too long to store.');
    const existing = await backend.get(design.name);
    const record: LibraryRecord = {
        name: design.name,
        widthMm: design.labelSettings.width,
        heightMm: design.labelSettings.height,
        dpi: design.printerSettings.dpi,
        tags: opts.tags ?? existing?.tags ?? [],
        updatedAt: opts.now ?? Date.now(),
        thumbnail: opts.thumbnail !== undefined ? opts.thumbnail : (existing?.thumbnail ?? null),
        design,
    };
    await backend.put(record);
    return record;
};

// --- portable file format -----------------------------------------------------
//
// A `.label.json` file is the design plus an explicit schema version and a
// checksum. The version gives migrateDesign (App.tsx) something to branch on
// instead of guessing from shape; the checksum tells an import that the file
// was truncated or hand-mangled before it ever reaches the canvas. Older bare
// design JSON (no envelope) still imports — it simply carries no checksum.

export const LABEL_FILE_VERSION = 1;

export interface LabelFile {
    labelFileVersion: number;
    checksum: string;
    design: Design;
}

/** FNV-1a 32-bit over the canonical JSON. Short on purpose: it catches
 *  truncation and accidental edits, it is not a security control. */
export const designChecksum = (design: Design): string => {
    const json = JSON.stringify(design);
    let hash = 0x811c9dc5;
    for (let i = 0; i < json.length; i++) {
        hash ^= json.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
};

export const serializeLabelFile = (design: Design): string =>
    JSON.stringify({ labelFileVersion: LABEL_FILE_VERSION, checksum: designChecksum(design), design } satisfies LabelFile, null, 2);

export type LabelImport =
    | { ok: true; design: Design; version: number }
    | { ok: false; error: string };

/**
 * Accept either an enveloped file or a legacy bare design. An enveloped file
 * with a checksum that doesn't match is REFUSED — loading it would put a
 * silently corrupted design on the canvas. A future schema version is also
 * refused, because migrateDesign only knows how to move old shapes forward.
 */
export const parseLabelFile = (text: string): LabelImport => {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return { ok: false, error: 'File is not valid JSON.' }; }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, error: 'File does not contain a design.' };
    }
    const obj = parsed as Record<string, unknown>;

    if ('labelFileVersion' in obj) {
        const version = obj.labelFileVersion;
        if (typeof version !== 'number' || version > LABEL_FILE_VERSION) {
            return { ok: false, error: `This file needs a newer version of the designer (schema ${String(version)}).` };
        }
        const design = obj.design as Design;
        if (!design || !Array.isArray(design.fields)) return { ok: false, error: 'File does not contain a design.' };
        if (typeof obj.checksum === 'string' && obj.checksum !== designChecksum(design)) {
            return { ok: false, error: 'Checksum does not match — the file was modified or truncated.' };
        }
        return { ok: true, design, version };
    }

    if (!Array.isArray((obj as { fields?: unknown }).fields)) return { ok: false, error: 'File does not contain a design.' };
    return { ok: true, design: obj as unknown as Design, version: 0 };
};

// --- one-time migration out of the pre-IndexedDB localStorage library --------

const LEGACY_LIST_KEY = 'ipl_designer_saved_designs';
const LEGACY_KEY_PREFIX = 'ipl_design_';
const MIGRATED_FLAG = 'ipl_library_migrated_v1';

/**
 * Move every design the old localStorage library holds into the backend, once.
 * Idempotent: a flag is set only after a complete pass, and names already in
 * the backend are left untouched (the backend wins — it may hold a newer
 * autosave). Malformed entries are skipped, not fatal, matching the tolerance
 * the old designManager had.
 *
 * Returns the number of designs actually moved, so the UI can say so.
 */
export const migrateLegacyLibrary = async (storage: Storage = localStorage): Promise<number> => {
    if (storage.getItem(MIGRATED_FLAG) === 'done') return 0;
    let names: string[] = [];
    try {
        const parsed = JSON.parse(storage.getItem(LEGACY_LIST_KEY) ?? 'null');
        if (Array.isArray(parsed)) names = parsed.filter((s): s is string => typeof s === 'string');
    } catch { names = []; }

    const present = new Set((await backend.list()).map(m => m.name));
    let moved = 0;
    for (const name of names) {
        if (present.has(name)) continue;
        const raw = storage.getItem(`${LEGACY_KEY_PREFIX}${name}`);
        if (!raw) continue;
        try {
            const design = JSON.parse(raw) as Design;
            if (!design || !Array.isArray(design.fields)) continue;
            await saveLibraryRecord({ ...design, name: design.name || name }, { now: 0 });
            moved++;
        } catch { /* one bad entry must not block the rest */ }
    }
    storage.setItem(MIGRATED_FLAG, 'done');
    return moved;
};
