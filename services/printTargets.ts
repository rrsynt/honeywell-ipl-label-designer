// Fase 6: the saved printer list.
//
// Until now a shop had exactly one printer: services/printerTarget.ts holds a
// sync localStorage {host, port} that the viewer's Send button and the
// designer's "Send Job" both read. That is still the ACTIVE target and stays
// exactly as it was — this module is the address book around it. A job picks
// a target from the list, and picking one also writes it back through
// setPrinterTarget so the older surfaces keep pointing at the machine the user
// last chose.
//
// The list lives in IndexedDB (schema owned by services/designerDb.ts) because
// a target is real configuration, not a UI preference, and because Fase 7's
// shared print server will want the same records. Validation reuses
// printerTarget's host normalizer and port guard rather than growing a second,
// subtly different parser — the port guard exists because an invalid port once
// crashed the bridge daemon.

import { requestToPromise, storeOf } from './designerDb';
import { isValidPrinterPort, normalizeHost, DEFAULT_TARGET, getPrinterTarget, setPrinterTarget } from './printerTarget';

export interface PrintTarget {
    /** Generated, stable. Two targets may share a host, so name is not a key. */
    id: string;
    name: string;
    host: string;
    port: string;
    /** Which language the stream for this machine must be generated in. */
    language: 'ipl' | 'zpl';
    dpi: 203 | 300 | 406;
}

const TARGET_STORE = 'targets';

/** What the UI may type; id and the validated host/port are the service's job. */
export type PrintTargetInput = Omit<PrintTarget, 'id'> & { id?: string };

let counter = 0;
/** Unique within a session; the store's key is the identity that matters. */
const nextId = (): string => `t${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Trim and validate a typed target. The error is RETURNED rather than thrown
 * so a form can show it next to the field; every field is checked, because a
 * target that merely looks right is worse than one that is refused.
 *
 * Two nullable fields rather than a discriminated union: this project compiles
 * without strictNullChecks, where a boolean-literal discriminant does not
 * narrow. `target === null` is the only test callers need.
 */
export interface TargetValidation {
    target: Omit<PrintTarget, 'id'> | null;
    error: string | null;
}

export const validateTarget = (input: PrintTargetInput): TargetValidation => {
    const bad = (error: string): TargetValidation => ({ target: null, error });
    const name = (input.name || '').trim();
    if (!name) return bad('Give the printer a name.');
    if (name.length > 60) return bad('Name is too long (60 characters max).');
    const host = normalizeHost(input.host);
    if (!host) return bad('Printer host is empty.');
    const port = (input.port || '').trim();
    if (!isValidPrinterPort(port)) return bad(`Invalid port "${input.port}" — must be 1-65535.`);
    if (input.language !== 'ipl' && input.language !== 'zpl') return bad('Language must be IPL or ZPL.');
    if (![203, 300, 406].includes(input.dpi)) return bad('DPI must be 203, 300 or 406.');
    return { target: { name, host, port, language: input.language, dpi: input.dpi }, error: null };
};

export interface PrintTargetBackend {
    list(): Promise<PrintTarget[]>;
    put(target: PrintTarget): Promise<void>;
    remove(id: string): Promise<void>;
}

/** The browser backend, over the shared database in services/designerDb.ts. */
export const indexedDbTargetBackend = (): PrintTargetBackend => {
    const store = (mode: IDBTransactionMode): Promise<IDBObjectStore> => storeOf(TARGET_STORE, mode);
    return {
        list: async () => await requestToPromise((await store('readonly')).getAll()) as PrintTarget[],
        put: async (target) => { await requestToPromise((await store('readwrite')).put(target)); },
        remove: async (id) => { await requestToPromise((await store('readwrite')).delete(id)); },
    };
};

/** In-memory backend: tests, and the fallback where IndexedDB does not exist. */
export const memoryTargetBackend = (initial: PrintTarget[] = []): PrintTargetBackend => {
    const targets = new Map<string, PrintTarget>(initial.map(t => [t.id, t]));
    return {
        list: async () => [...targets.values()],
        put: async (target) => { targets.set(target.id, target); },
        remove: async (id) => { targets.delete(id); },
    };
};

const hasIndexedDb = (): boolean => {
    try { return typeof indexedDB !== 'undefined' && indexedDB !== null; } catch { return false; }
};

let backend: PrintTargetBackend = hasIndexedDb() ? indexedDbTargetBackend() : memoryTargetBackend();

/** Tests inject a backend so they exercise the real logic without a database. */
export const setPrintTargetBackend = (next: PrintTargetBackend): void => { backend = next; };

/** Saved targets, name-sorted so the picker does not reshuffle between reads. */
export const listPrintTargets = async (): Promise<PrintTarget[]> =>
    (await backend.list()).sort((a, b) => a.name.localeCompare(b.name));

/** Insert or replace. Invalid input throws: a UI that swallows this would
 *  store a target that cannot be printed to. */
export const savePrintTarget = async (input: PrintTargetInput): Promise<PrintTarget> => {
    const checked = validateTarget(input);
    if (checked.target === null) throw new Error(checked.error);
    const target: PrintTarget = { ...checked.target, id: input.id || nextId() };
    await backend.put(target);
    return target;
};

export const deletePrintTarget = (id: string): Promise<void> => backend.remove(id);

/**
 * Make a saved target the ACTIVE one (services/printerTarget.ts), so the
 * viewer's Send button and the designer's Send Job follow the same choice.
 * Returns the error message when the write is refused — printerTarget throws
 * only for input it cannot accept, and a target read back from the database
 * has already been validated, so this is a truly exceptional path.
 */
export const activatePrintTarget = (target: PrintTarget): string | null => {
    try {
        setPrinterTarget({ host: target.host, port: target.port });
        return null;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
};

/** The target the legacy localStorage entry describes, as the first entry. */
export const legacyTargetAsEntry = (): Omit<PrintTarget, 'id'> => {
    const current = getPrinterTarget();
    return { name: `${current.host}:${current.port}`, host: current.host, port: current.port, language: 'ipl', dpi: 203 };
};

const MIGRATED_FLAG = 'ipl_print_targets_migrated_v1';

/**
 * Move the one legacy localStorage target into the list, once per browser.
 * The flag is set only after a complete pass, and it never touches a list that
 * already has entries — an existing list is a choice the user made, and the
 * legacy entry would just be a stale duplicate of one of them.
 *
 * Returns true when an entry was added, so the caller can refresh a picker.
 */
export const migrateLegacyTarget = async (storage: Storage = localStorage): Promise<boolean> => {
    try {
        if (storage.getItem(MIGRATED_FLAG) === 'done') return false;
        const existing = await backend.list();
        let added = false;
        if (existing.length === 0) {
            // `ipl_printer_target` absent means the user never chose a printer,
            // so there is nothing to migrate. Writing the default down would
            // invent a machine nobody configured.
            const raw = storage.getItem('ipl_printer_target');
            if (raw !== null) {
                const entry = legacyTargetAsEntry();
                const checked = validateTarget(entry);
                if (checked.target !== null) {
                    await backend.put({ ...checked.target, id: nextId() });
                    added = true;
                }
            }
        }
        storage.setItem(MIGRATED_FLAG, 'done');
        return added;
    } catch {
        // A private-mode SecurityError on setItem must not break the print UI;
        // the next load simply tries again.
        return false;
    }
};

/**
 * A target to start a job with: the first saved one, else the ACTIVE legacy
 * target wrapped as a one-off entry (never persisted — a job may print to a
 * machine the user has not decided to keep).
 */
export const defaultPrintTarget = async (): Promise<PrintTarget> => {
    const saved = await listPrintTargets();
    if (saved.length > 0) return saved[0];
    const legacy = legacyTargetAsEntry();
    return { ...legacy, id: 'legacy', name: legacy.name };
};

export { DEFAULT_TARGET };
