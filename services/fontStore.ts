// Fase 3: user-uploaded fonts.
//
// A thermal printer can only print the fonts burned into it, so an uploaded
// TTF/OTF is a SCREEN font. The generator still emits the nearest resident IPL
// family (see nearestResidentFont) and says how far the two widths differ —
// the screen may show the real face, the printer must never silently print a
// different width.
//
// What gets stored is the font bytes plus a per-mille advance table measured
// exactly the way the Liberation tables in fontMetrics.ts were measured: one
// canvas measureText per printable ASCII glyph, divided by the font size. The
// viewer's layout math is a pure function with no canvas, so it can only read a
// table; measuring here, once, is what lets the two agree.

import { registerUploadedFontMetrics, clearUploadedFontMetrics, type UploadedFontMetrics } from './ipl/fontMetrics';

export interface StoredFont {
    /** Family name taken from the file, and the key everywhere else. */
    name: string;
    /** Per-mille advances, ASCII 32..126. */
    advances: number[];
    /** Which resident IPL family this face is closest to. */
    nearest: UploadedFontMetrics['family'];
    bytes: ArrayBuffer;
}

export interface FontBackend {
    list(): Promise<StoredFont[]>;
    put(font: StoredFont): Promise<void>;
    remove(name: string): Promise<void>;
}

const DB_NAME = 'ipl-designer';
// Version 3 added the `fonts` store, version 4 the `recovery` one. The upgrade
// handler in libraryStore.ts is bumped in lockstep — both open the same
// database, so a lower version here would throw on a browser that already ran
// the other.
const DB_VERSION = 4;
const FONT_STORE = 'fonts';

const requestToPromise = <T>(req: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });

export const indexedDbFontBackend = (): FontBackend => {
    let dbPromise: Promise<IDBDatabase> | null = null;
    const open = (): Promise<IDBDatabase> => {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                // Recreated here too: this module can be the one that opens the
                // database first, and a version jump must not drop the stores
                // libraryStore.ts owns.
                if (!db.objectStoreNames.contains('designs')) db.createObjectStore('designs', { keyPath: 'name' });
                if (!db.objectStoreNames.contains('sources')) db.createObjectStore('sources', { keyPath: 'name' });
                if (!db.objectStoreNames.contains(FONT_STORE)) db.createObjectStore(FONT_STORE, { keyPath: 'name' });
                if (!db.objectStoreNames.contains('recovery')) db.createObjectStore('recovery', { keyPath: 'slot' });
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
    return {
        list: async () => {
            const db = await open();
            return await requestToPromise(db.transaction(FONT_STORE, 'readonly').objectStore(FONT_STORE).getAll()) as StoredFont[];
        },
        put: async (font) => {
            const db = await open();
            await requestToPromise(db.transaction(FONT_STORE, 'readwrite').objectStore(FONT_STORE).put(font));
        },
        remove: async (name) => {
            const db = await open();
            await requestToPromise(db.transaction(FONT_STORE, 'readwrite').objectStore(FONT_STORE).delete(name));
        },
    };
};

/** In-memory backend: tests, and the fallback where IndexedDB does not exist. */
export const memoryFontBackend = (): FontBackend => {
    const fonts = new Map<string, StoredFont>();
    return {
        list: async () => [...fonts.values()],
        put: async (font) => { fonts.set(font.name, font); },
        remove: async (name) => { fonts.delete(name); },
    };
};

const hasIndexedDb = (): boolean => {
    try { return typeof indexedDB !== 'undefined' && indexedDB !== null; } catch { return false; }
};

let backend: FontBackend = hasIndexedDb() ? indexedDbFontBackend() : memoryFontBackend();

/** Tests inject a backend so they exercise the real logic without a database. */
export const setFontBackend = (next: FontBackend): void => { backend = next; };

const FIRST = 32;
const LAST = 126;

/**
 * Per-mille-of-em advance for every printable ASCII glyph, measured the same
 * way the vendored Liberation tables were: render at one large size and divide
 * by it. The ratios are scale-invariant (pinned by tests/fontMetrics.test.ts),
 * so one table serves every point size.
 */
/**
 * Only `font` and `measureText` are used, so a node canvas context (which is
 * not a DOM CanvasRenderingContext2D) satisfies this too. That is what lets the
 * golden harness measure an uploaded font the same way the browser does.
 */
export const measureAdvanceTable = (ctx: { font: string; measureText: (s: string) => { width: number } }, cssFamily: string, px = 100): number[] => {
    ctx.font = `${px}px ${cssFamily}`;
    const advances: number[] = [];
    for (let code = FIRST; code <= LAST; code++) {
        advances.push(Math.round(ctx.measureText(String.fromCharCode(code)).width / px * 1000));
    }
    return advances;
};

/** Average per-mille advance of a table — the figure families are compared by. */
export const averageAdvance = (advances: readonly number[]): number =>
    Math.round(advances.reduce((sum, n) => sum + n, 0) / advances.length);

// The resident families, as averages of the tables in fontMetrics.ts. Kept as
// literals so this module does not import the tables (they are an internal of
// that file); the test pins these numbers against the live tables.
const RESIDENT_AVERAGE: Record<UploadedFontMetrics['family'], number> = {
    'sans-serif': 524,
    'serif': 478,
    'monospace': 600,
};

/**
 * The resident IPL family whose average advance is closest. This is what the
 * printer will actually be told to use, so it is chosen by WIDTH, not by how
 * the face looks.
 */
export const nearestResidentFamily = (advances: readonly number[]): UploadedFontMetrics['family'] => {
    const avg = averageAdvance(advances);
    let best: UploadedFontMetrics['family'] = 'monospace';
    let bestDelta = Infinity;
    (Object.keys(RESIDENT_AVERAGE) as UploadedFontMetrics['family'][]).forEach(family => {
        const delta = Math.abs(RESIDENT_AVERAGE[family] - avg);
        if (delta < bestDelta) { bestDelta = delta; best = family; }
    });
    return best;
};

/**
 * How far, as a fraction, the uploaded face's average advance sits from the
 * resident family the printer will substitute. 0.12 means the printed line runs
 * about 12% off the one drawn on screen. The generator warns with this rather
 * than letting the mismatch pass silently.
 */
export const widthDelta = (advances: readonly number[], family: UploadedFontMetrics['family']): number =>
    Math.abs(averageAdvance(advances) - RESIDENT_AVERAGE[family]) / RESIDENT_AVERAGE[family];

const cssFamilyName = (name: string): string => `"${name.replace(/"/g, '')}"`;

/** Push one stored font into both registries: the metrics table the viewer
 *  reads, and the canvas font the screen measures with. */
const activate = async (font: StoredFont): Promise<void> => {
    const cssFamily = cssFamilyName(font.name);
    registerUploadedFontMetrics(font.name, {
        cssFamily,
        family: font.nearest,
        advances: font.advances,
        dflt: averageAdvance(font.advances),
    });
    // document.fonts exists in the browser; the golden harness registers fonts
    // through @napi-rs/canvas instead, so its absence is expected in tests.
    const fontsApi = (globalThis as { document?: { fonts?: FontFaceSet } }).document?.fonts;
    if (fontsApi && typeof FontFace !== 'undefined') {
        const face = new FontFace(font.name, font.bytes);
        await face.load();
        fontsApi.add(face);
    }
};

/**
 * Read an uploaded font file: measure its advance table, remember the nearest
 * resident family, persist the bytes, and make it usable immediately.
 * `measureCtx` is the canvas the advances are measured on — the caller owns it,
 * because node tests measure on a real canvas and the browser measures on a
 * scratch one.
 */
export const installFontFile = async (file: File, measureCtx: { font: string; measureText: (s: string) => { width: number } }): Promise<StoredFont> => {
    const bytes = await file.arrayBuffer();
    const name = file.name.replace(/\.(ttf|otf)$/i, '').trim();
    if (!name) throw new Error('The font file has no name.');
    // The face has to be registered BEFORE it can be measured, or measureText
    // falls back to the default font and the table describes the wrong face.
    const fontsApi = (globalThis as { document?: { fonts?: FontFaceSet } }).document?.fonts;
    if (fontsApi && typeof FontFace !== 'undefined') {
        const face = new FontFace(name, bytes);
        await face.load();
        fontsApi.add(face);
    }
    const advances = measureAdvanceTable(measureCtx, cssFamilyName(name));
    const stored: StoredFont = { name, advances, nearest: nearestResidentFamily(advances), bytes };
    await backend.put(stored);
    registerUploadedFontMetrics(name, {
        cssFamily: cssFamilyName(name),
        family: stored.nearest,
        advances,
        dflt: averageAdvance(advances),
    });
    return stored;
};

/** Reload everything persisted, e.g. on application start. */
export const loadInstalledFonts = async (): Promise<StoredFont[]> => {
    const fonts = await backend.list();
    for (const font of fonts) await activate(font);
    return fonts;
};

export const removeInstalledFont = async (name: string): Promise<void> => {
    await backend.remove(name);
    clearUploadedFontMetrics(name);
};

export const listInstalledFonts = (): Promise<StoredFont[]> => backend.list();
