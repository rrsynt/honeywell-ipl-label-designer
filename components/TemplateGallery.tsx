// Batch L (2026-09-21): the template gallery. Lists services/templates.ts
// as cards and hands the chosen template id to the parent (App confirms any
// unsaved changes and dispatches SET_DESIGN). Pure presentation — all
// template correctness lives in the tested builders.
import React from 'react';
import { TEMPLATES, type LabelTemplate } from '../services/templates';

const ICONS: { [id: string]: string } = {
    blank: 'crop_square',
    shipping: 'local_shipping',
    price: 'sell',
    asset: 'qr_code_2',
    lot: 'event_note',
};

export const TemplateGallery: React.FC<{
    onClose: () => void;
    onPick: (template: LabelTemplate) => void;
}> = ({ onClose, onPick }) => (
    <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50" onClick={onClose}
        onKeyDown={e => { if (e.key === 'Escape') onClose(); }} role="presentation">
        <div className="bg-gray-800 rounded-lg shadow-2xl p-6 w-full max-w-2xl mx-4 text-gray-200" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Label templates">
            <div className="flex justify-between items-center border-b border-gray-700 pb-3 mb-4">
                <h2 className="text-xl font-bold flex items-center gap-2">
                    <span className="material-icons">dashboard</span>Templates
                </h2>
                <button onClick={onClose} className="p-1 rounded-full hover:bg-gray-700" aria-label="Close">
                    <span className="material-icons">close</span>
                </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[60vh] overflow-y-auto pr-1">
                {TEMPLATES.map(t => (
                    <button
                        key={t.id}
                        onClick={() => onPick(t)}
                        className="text-left rounded-lg border border-gray-700 bg-gray-900/60 hover:border-blue-500 hover:bg-gray-700/40 p-4 transition-colors"
                    >
                        <div className="flex items-center gap-2 mb-1">
                            <span className="material-icons text-blue-400">{ICONS[t.id] ?? 'label'}</span>
                            <span className="font-semibold">{t.name}</span>
                        </div>
                        <p className="text-xs text-gray-400 leading-snug">{t.description}</p>
                    </button>
                ))}
            </div>
            <p className="mt-4 text-[11px] text-gray-500">
                A template replaces the current canvas — you'll be asked to confirm before applying.
            </p>
        </div>
    </div>
);
