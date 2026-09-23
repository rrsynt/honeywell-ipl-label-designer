// Non-blocking replacements for window.confirm / window.alert (audit: modals).
//
// A module-level store (no React import here, so plain services like
// designManager can notify too) that <DialogHost /> renders. confirm()
// becomes requestConfirm(): Promise<boolean>; alert() becomes notify(): a
// toast that auto-dismisses. One confirm at a time — opening a second resolves
// the first as false (cancelled), matching how a stacked native dialog would
// have been dismissed, and never leaves a promise hanging.

export interface ConfirmRequest {
    id: number;
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    danger: boolean;
}

export interface UiToast {
    id: number;
    message: string;
    kind: 'error' | 'info';
}

interface Snapshot {
    confirm: ConfirmRequest | null;
    toasts: UiToast[];
}

let nextId = 1;
let pending: (ConfirmRequest & { resolve: (v: boolean) => void }) | null = null;
let toasts: UiToast[] = [];
let snapshot: Snapshot = { confirm: null, toasts: [] };
const listeners = new Set<() => void>();

const publish = (): void => {
    snapshot = {
        confirm: pending
            ? {
                id: pending.id, title: pending.title, message: pending.message,
                confirmLabel: pending.confirmLabel, cancelLabel: pending.cancelLabel,
                danger: pending.danger,
            }
            : null,
        toasts: [...toasts],
    };
    for (const l of listeners) l();
};

export const subscribeUiDialogs = (cb: () => void): (() => void) => {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
};

/** Stable between publishes — safe for useSyncExternalStore. */
export const getUiDialogSnapshot = (): Snapshot => snapshot;

export const requestConfirm = (spec: {
    title?: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
}): Promise<boolean> =>
    new Promise(resolve => {
        if (pending) {
            const prev = pending;
            pending = null;
            prev.resolve(false);
        }
        pending = {
            id: nextId++,
            title: spec.title ?? 'Please confirm',
            message: spec.message,
            confirmLabel: spec.confirmLabel ?? 'OK',
            cancelLabel: 'Cancel',
            danger: spec.danger ?? true,
            resolve,
        };
        publish();
    });

/** Answer the open confirm (from the dialog's buttons or Escape key). */
export const resolveConfirm = (value: boolean): void => {
    if (!pending) return;
    const { resolve } = pending;
    pending = null;
    publish();
    resolve(value);
};

/** Fire-and-forget toast. kind=error stays longer; both are dismissible. */
export const notify = (message: string, kind: UiToast['kind'] = 'error'): void => {
    const t: UiToast = { id: nextId++, message, kind };
    toasts = [...toasts, t];
    publish();
    setTimeout(() => dismissToast(t.id), kind === 'error' ? 6000 : 3500);
};

export const dismissToast = (id: number): void => {
    if (!toasts.some(t => t.id === id)) return;
    toasts = toasts.filter(t => t.id !== id);
    publish();
};
