// One owner for the `ipl-designer` IndexedDB schema.
//
// Two modules store documents here — libraryStore.ts (designs, sources,
// recovery) and fontStore.ts (fonts) — and until this file existed each one
// carried its OWN copy of DB_NAME, DB_VERSION and the upgrade handler. That
// worked only as long as the copies agreed, and they did not: the `recovery`
// store was created with `keyPath: 'name'` by one and `keyPath: 'slot'` by the
// other, while the record written to it carries only `slot`.
//
// Which copy won was decided by whichever module opened the database first, so
// the failure was invisible to every test: on a browser that had already run an
// earlier build, fontStore opened first and autosave worked; on a FRESH browser
// App.tsx's migrateLegacyLibrary() ran before the font load, libraryStore won
// the race, and every single autosave threw `DataError: Evaluating the object
// store's key path did not yield a value` — the exact silent loss of work the
// feature exists to prevent. happy-dom has no IndexedDB, so no test executed
// the path at all.
//
// The schema now lives here, once, and both modules open through it. A store
// whose key path has drifted is repaired in place on the next upgrade, keeping
// whatever records it holds.

const DB_NAME = 'ipl-designer';
/**
 * Version 5 repairs a `recovery` store keyed by anything but `slot`.
 * Version 6 adds the Fase 6 print stores (targets, printJobs, printLog) —
 * purely additive, so an existing database keeps every record it holds.
 */
const DB_VERSION = 6;

/**
 * Every store this database owns, with the key path it must have. Adding one
 * means adding it here and nowhere else.
 *
 * Exported so tests can hold the backends to it: a record whose key path does
 * not resolve is exactly the bug this file was written to kill, and the
 * in-memory test backend does not evaluate key paths the way IndexedDB does.
 */
export const SCHEMA: readonly { name: string; keyPath: string }[] = [
    { name: 'designs', keyPath: 'name' },
    { name: 'sources', keyPath: 'name' },
    { name: 'fonts', keyPath: 'name' },
    { name: 'recovery', keyPath: 'slot' },
    // Fase 6. Keyed by a generated id rather than by name: two printer targets
    // may legitimately share a host, and a log entry is never addressed by
    // anything but its own identity.
    { name: 'targets', keyPath: 'id' },
    { name: 'printJobs', keyPath: 'id' },
    { name: 'printLog', keyPath: 'id' },
];

/** The key path a store's records must carry, or undefined if unknown. */
export const keyPathFor = (store: string): string | undefined =>
    SCHEMA.find(s => s.name === store)?.keyPath;

export const requestToPromise = <T>(req: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });

/**
 * Bring one store to the shape SCHEMA declares, inside an upgrade transaction.
 *
 * A missing store is simply created. A store that exists under the WRONG key
 * path is emptied into memory, replaced, and refilled — the upgrade
 * transaction keeps a cursor's callback alive, so the records survive the
 * swap. Records lacking the new key are dropped rather than put back, because
 * a throw in here would abort the whole upgrade and leave the database at the
 * old version.
 */
const ensureStore = (
    db: IDBDatabase,
    txn: IDBTransaction,
    name: string,
    keyPath: string,
): void => {
    if (!db.objectStoreNames.contains(name)) {
        db.createObjectStore(name, { keyPath });
        return;
    }
    if (txn.objectStore(name).keyPath === keyPath) return;

    const existing = txn.objectStore(name);
    const salvaged: Record<string, unknown>[] = [];
    existing.openCursor().onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (cursor) {
            salvaged.push(cursor.value as Record<string, unknown>);
            cursor.continue();
            return;
        }
        db.deleteObjectStore(name);
        db.createObjectStore(name, { keyPath });
        for (const record of salvaged) {
            if (record && typeof record === 'object' && record[keyPath] !== undefined) {
                txn.objectStore(name).put(record);
            }
        }
    };
};

/**
 * The shared handle. Opening is lazy and cached; a version change from another
 * tab invalidates it so the next call reopens instead of throwing.
 */
let handle: Promise<IDBDatabase> | null = null;

export const openDesignerDb = (): Promise<IDBDatabase> => {
    if (handle) return handle;
    handle = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            for (const store of SCHEMA) {
                ensureStore(req.result, req.transaction!, store.name, store.keyPath);
            }
        };
        req.onsuccess = () => {
            const db = req.result;
            db.onversionchange = () => { db.close(); handle = null; };
            resolve(db);
        };
        req.onerror = () => { handle = null; reject(req.error); };
    });
    return handle;
};

export const storeOf = async (which: string, mode: IDBTransactionMode): Promise<IDBObjectStore> =>
    (await openDesignerDb()).transaction(which, mode).objectStore(which);
