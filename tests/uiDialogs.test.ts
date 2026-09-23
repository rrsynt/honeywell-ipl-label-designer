import { describe, it, expect } from 'vitest';
import {
    requestConfirm,
    resolveConfirm,
    notify,
    dismissToast,
    getUiDialogSnapshot,
    subscribeUiDialogs,
} from '../services/uiDialogs';

// The non-blocking confirm/alert replacement store (audit batch 6: no more
// window.confirm/alert). Pure state machine — DialogHost just renders it.

describe('uiDialogs confirm queue', () => {
    it('requestConfirm publishes a request and resolveConfirm answers it', async () => {
        let notified = 0;
        const unsub = subscribeUiDialogs(() => notified++);
        const p = requestConfirm({ title: 'T', message: 'M', confirmLabel: 'Yes' });
        expect(getUiDialogSnapshot().confirm).toMatchObject({ title: 'T', message: 'M', confirmLabel: 'Yes', danger: true });
        expect(notified).toBeGreaterThanOrEqual(1);
        resolveConfirm(true);
        expect(await p).toBe(true);
        expect(getUiDialogSnapshot().confirm).toBeNull();
        unsub();
    });
    it('a second confirm cancels the first (never a hanging promise)', async () => {
        const first = requestConfirm({ message: 'first' });
        const second = requestConfirm({ message: 'second' });
        expect(await first).toBe(false);
        expect(getUiDialogSnapshot().confirm?.message).toBe('second');
        resolveConfirm(false);
        expect(await second).toBe(false);
    });
    it('resolveConfirm with no open request is a no-op', () => {
        expect(() => resolveConfirm(true)).not.toThrow();
    });
});

describe('uiDialogs toasts', () => {
    it('notify appends a dismissible toast', () => {
        notify('boom');
        const before = getUiDialogSnapshot().toasts;
        expect(before.some(t => t.message === 'boom' && t.kind === 'error')).toBe(true);
        dismissToast(before[before.length - 1].id);
        expect(getUiDialogSnapshot().toasts.some(t => t.message === 'boom')).toBe(false);
    });
    it('dismissToast on an unknown id is a no-op', () => {
        const n = getUiDialogSnapshot().toasts.length;
        dismissToast(-12345);
        expect(getUiDialogSnapshot().toasts).toHaveLength(n);
    });
});
