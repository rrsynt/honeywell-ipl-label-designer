import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import {
    subscribeUiDialogs,
    getUiDialogSnapshot,
    resolveConfirm,
    dismissToast,
} from '../services/uiDialogs';

/**
 * Renders the non-blocking confirm dialog and toast stack backed by
 * services/uiDialogs (replaces window.confirm / window.alert, audit batch 6).
 * Mount once at the App root. Escape / backdrop click cancel; the confirm
 * button takes initial focus so Enter acts as the affirmative.
 */
export const DialogHost: React.FC = () => {
    const { confirm, toasts } = useSyncExternalStore(subscribeUiDialogs, getUiDialogSnapshot);
    const okRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!confirm) return;
        okRef.current?.focus();
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                resolveConfirm(false);
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [confirm]);

    return (
        <>
            {confirm && (
                <div
                    className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-[60]"
                    onClick={() => resolveConfirm(false)}
                    role="dialog"
                    aria-modal="true"
                    aria-label={confirm.title}
                >
                    <div
                        className="bg-gray-800 rounded-lg shadow-2xl p-6 w-full max-w-md mx-4 text-gray-200"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="flex items-center gap-2 border-b border-gray-700 pb-3 mb-4">
                            <span className={`material-icons ${confirm.danger ? 'text-red-400' : 'text-blue-400'}`}>
                                {confirm.danger ? 'warning' : 'help_outline'}
                            </span>
                            <h2 className="text-lg font-bold">{confirm.title}</h2>
                        </div>
                        <p className="text-sm text-gray-300 whitespace-pre-line break-words">{confirm.message}</p>
                        <div className="mt-6 flex justify-end gap-2">
                            <button
                                onClick={() => resolveConfirm(false)}
                                className="px-4 py-2 rounded-md text-sm font-semibold bg-gray-600 hover:bg-gray-500 text-white transition-colors"
                            >
                                {confirm.cancelLabel}
                            </button>
                            <button
                                ref={okRef}
                                onClick={() => resolveConfirm(true)}
                                className={`px-4 py-2 rounded-md text-sm font-semibold text-white transition-colors ${confirm.danger ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500'}`}
                            >
                                {confirm.confirmLabel}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {toasts.length > 0 && (
                <div className="fixed bottom-4 right-4 z-[70] flex flex-col gap-2 items-end" aria-live="assertive">
                    {toasts.map(t => (
                        <div
                            key={t.id}
                            className={`max-w-sm px-4 py-3 rounded-lg shadow-2xl text-sm text-white flex items-start gap-2 ${t.kind === 'error' ? 'bg-red-700' : 'bg-gray-700'}`}
                        >
                            <span className="material-icons text-base leading-none">
                                {t.kind === 'error' ? 'error_outline' : 'info'}
                            </span>
                            <span className="break-words">{t.message}</span>
                            <button
                                onClick={() => dismissToast(t.id)}
                                className="ml-1 opacity-70 hover:opacity-100"
                                aria-label="Dismiss notification"
                            >
                                <span className="material-icons text-base leading-none">close</span>
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </>
    );
};
