import React, { useMemo, useState } from 'react';
import { PRINTER_MODELS } from '../constants';
import {
    STOCK_PRESETS, getStockPreset, buildStockDesign, validateStock, dotsFor,
    type StockCategory, type StockPreset, type StockSelection,
} from '../services/labelStocks';
import type { Design } from '../types';

const DEFAULT_KEY = 'ipl-newlabel-default';

type Unit = 'mm' | 'in' | 'dots';

const toMm = (v: number, unit: Unit, dpi: number): number => {
    if (unit === 'in') return v * 25.4;
    if (unit === 'dots') return (v / dpi) * 25.4;
    return v;
};

const fromMm = (mm: number, unit: Unit, dpi: number): number => {
    if (unit === 'in') return mm / 25.4;
    if (unit === 'dots') return (mm / 25.4) * dpi;
    return mm;
};

const loadDefault = (): StockSelection | null => {
    try {
        const raw = localStorage.getItem(DEFAULT_KEY);
        if (!raw) return null;
        // The stored default omits the name (it is saved without one), so it
        // is re-attached here — the custom draft reads `.name` unconditionally.
        const s = { name: 'Untitled Design', ...JSON.parse(raw) } as StockSelection;
        if (!Number.isFinite(s.widthMm) || !Number.isFinite(s.heightMm)) return null;
        return s;
    } catch { return null; }
};

/** New-Label dialog, BarTender-style: pick a stock preset or define a custom
 *  size, then Finish. The result is a real Design on that stock — width, height
 *  and dpi flow to all five generators through labelSettings/printerSettings,
 *  never a UI-only size. Enter = Finish, Escape = close. */
export const NewLabelDialog: React.FC<{
    onClose: () => void;
    onCreate: (design: Design) => void;
}> = ({ onClose, onCreate }) => {
    const remembered = useMemo(loadDefault, []);
    const [presetId, setPresetId] = useState<string | null>(() => {
        if (!remembered) return STOCK_PRESETS[0].id;
        const match = STOCK_PRESETS.find(p =>
            p.widthMm === remembered.widthMm && p.heightMm === remembered.heightMm &&
            p.model === remembered.model && p.dpi === remembered.dpi &&
            p.columns === remembered.columns && p.rows === remembered.rows);
        return match ? match.id : null;
    });
    const preset: StockPreset | undefined = presetId ? getStockPreset(presetId) : undefined;
    const [custom, setCustom] = useState(() => remembered ?? {
        name: 'Untitled Design', widthMm: 100, heightMm: 65,
        orientation: 'portrait' as const, model: 'PD43', dpi: 203 as const,
        columns: 1, rows: 1,
    });
    const [unit, setUnit] = useState<Unit>('mm');
    const [query, setQuery] = useState('');
    const [category, setCategory] = useState<StockCategory | 'all'>('all');
    const [remember, setRemember] = useState(false);

    // The live selection: preset values, or the custom draft when no preset.
    const sel: StockSelection = preset ? {
        name: preset.name, widthMm: preset.widthMm, heightMm: preset.heightMm,
        orientation: preset.orientation, model: preset.model, dpi: preset.dpi,
        columns: preset.columns, rows: preset.rows,
    } : custom;

    const dpiOptions = PRINTER_MODELS[sel.model] ?? [203, 300, 406];
    const verdict = validateStock(sel.widthMm, sel.heightMm, sel.model, sel.dpi);
    const gridError = sel.columns < 1 || sel.rows < 1 || !Number.isInteger(sel.columns) || !Number.isInteger(sel.rows)
        ? 'Columns and rows must be whole numbers of 1 or more.' : null;
    const blocked = verdict.errors.length > 0 || gridError !== null;

    const shown = STOCK_PRESETS.filter(p =>
        (category === 'all' || p.category === category) &&
        (query.trim() === '' || (p.name + ' ' + p.description).toLowerCase().includes(query.trim().toLowerCase())));

    // Editing any custom control de-presets — but the custom draft must inherit
    // the preset's CURRENT values first, not the stale draft from an earlier
    // visit. Without this, changing DPI with "Shipping 4x6" selected snapped
    // the stock back to 100x65: the draft the dialog opened with.
    const editCustom = (patch: Partial<StockSelection>) => {
        setPresetId(null);
        setCustom(c => ({ ...(preset ? { ...sel, name: c.name } : c), ...patch }));
    };

    const setCustomNum = (key: 'widthMm' | 'heightMm', raw: string) => {
        const v = unit === 'mm' ? parseFloat(raw) : toMm(parseFloat(raw), unit, sel.dpi);
        editCustom({ [key]: raw.trim() === '' ? NaN : v } as Partial<StockSelection>);
    };

    const finish = () => {
        if (blocked) return;
        if (remember) {
            try { localStorage.setItem(DEFAULT_KEY, JSON.stringify({ ...sel, name: undefined })); } catch { /* private mode */ }
        }
        onCreate(buildStockDesign({ ...sel, name: preset ? preset.name : (custom.name.trim() || 'Untitled Design') }));
    };

    // The stored size is always millimetres; the unit only changes the numbers
    // shown in the inputs, so switching never alters the physical stock.
    const switchUnit = (u: Unit) => setUnit(u);

    const field = 'w-full text-sm p-1.5 bg-gray-700 rounded-md border border-gray-600 focus:ring-1 focus:ring-blue-500 outline-none';
    return (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50" onClick={onClose}
            onKeyDown={e => { if (e.key === 'Escape') onClose(); }} role="presentation">
            <form className="bg-gray-800 rounded-lg shadow-2xl p-6 w-full max-w-4xl mx-4 text-gray-200 flex flex-col"
                style={{ maxHeight: '88vh' }}
                onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="New label"
                onSubmit={e => { e.preventDefault(); finish(); }}>
                <div className="flex justify-between items-center border-b border-gray-700 pb-3 mb-4">
                    <h2 className="text-xl font-bold flex items-center gap-2">
                        <span className="material-icons">add_box</span>New Label
                    </h2>
                    <button type="button" onClick={onClose} className="p-1 rounded-full hover:bg-gray-700" aria-label="Close">
                        <span className="material-icons">close</span>
                    </button>
                </div>

                <div className="flex gap-2 mb-3">
                    {(['all', 'roll', 'sheet', 'receipt'] as const).map(c => (
                        <button key={c} type="button" onClick={() => setCategory(c)}
                            className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${category === c ? 'bg-blue-600 border-blue-500 text-white' : 'border-gray-600 text-gray-300 hover:bg-gray-700'}`}>
                            {c === 'all' ? 'All' : c[0].toUpperCase() + c.slice(1)}
                        </button>
                    ))}
                    <div className="flex-1" />
                    <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search stocks" autoFocus
                        aria-label="Search stocks" className="w-48 text-sm p-1.5 bg-gray-700 rounded-md border border-gray-600 focus:ring-1 focus:ring-blue-500 outline-none" />
                </div>

                <div className="flex gap-4 flex-1 min-h-0">
                    <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2 overflow-y-auto pr-1 content-start" role="listbox" aria-label="Stock presets">
                        {shown.map(p => (
                            <button key={p.id} type="button" role="option" aria-selected={presetId === p.id}
                                onClick={() => setPresetId(presetId === p.id ? null : p.id)}
                                className={`text-left rounded-lg border p-3 transition-colors ${presetId === p.id ? 'border-blue-500 bg-blue-900/30' : 'border-gray-700 bg-gray-900/60 hover:border-blue-500'}`}>
                                <div className="font-semibold text-sm">{p.name}</div>
                                <div className="text-[11px] text-gray-400">{p.widthMm} × {p.heightMm} mm · {p.dpi} dpi · {p.orientation}</div>
                                <div className="text-[11px] text-gray-500 leading-snug mt-0.5">{p.description}</div>
                            </button>
                        ))}
                        {shown.length === 0 && <p className="text-sm text-gray-400 col-span-2">No stock matches — define a custom size on the right.</p>}
                    </div>

                    <div className="w-64 flex-shrink-0 space-y-2 text-sm">
                        <div className="font-semibold text-gray-300">Custom size</div>
                        {!preset && (
                            <label className="block">Name
                                <input value={custom.name} onChange={e => setCustom(c => ({ ...c, name: e.target.value }))}
                                    className={field} aria-label="Design name" />
                            </label>
                        )}
                        <div className="flex gap-1" role="group" aria-label="Unit">
                            {(['mm', 'in', 'dots'] as Unit[]).map(u => (
                                <button key={u} type="button" onClick={() => switchUnit(u)}
                                    className={`flex-1 px-1 py-1 text-xs rounded border ${unit === u ? 'bg-blue-600 border-blue-500 text-white' : 'border-gray-600 text-gray-300 hover:bg-gray-700'}`}>
                                    {u === 'in' ? 'inch' : u}
                                </button>
                            ))}
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            <label className="block">Width ({unit})
                                <input type="number" min="0" step="any"
                                    value={Number.isFinite(sel.widthMm) ? Number(fromMm(sel.widthMm, unit, sel.dpi).toFixed(2)) : ''}
                                    onChange={e => { setPresetId(null); setCustomNum('widthMm', e.target.value); }}
                                    className={field} aria-label={`Width in ${unit}`} />
                            </label>
                            <label className="block">Height ({unit})
                                <input type="number" min="0" step="any"
                                    value={Number.isFinite(sel.heightMm) ? Number(fromMm(sel.heightMm, unit, sel.dpi).toFixed(2)) : ''}
                                    onChange={e => { setPresetId(null); setCustomNum('heightMm', e.target.value); }}
                                    className={field} aria-label={`Height in ${unit}`} />
                            </label>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            <label className="block">Printer
                                <select value={sel.model} onChange={e => {
                                    const model = e.target.value;
                                    // 406 dpi exists only on some models — fall back
                                    // to that model's first dpi rather than showing
                                    // a resolution the printer cannot print.
                                    const dpis = PRINTER_MODELS[model] ?? [203];
                                    editCustom({ model, dpi: (dpis.includes(sel.dpi) ? sel.dpi : dpis[0]) as 203 | 300 | 406 });
                                }}
                                    className={field} aria-label="Printer model">
                                    {Object.keys(PRINTER_MODELS).map(m => <option key={m} value={m}>{m}</option>)}
                                </select>
                            </label>
                            <label className="block">DPI
                                <select value={String(sel.dpi)} onChange={e => editCustom({ dpi: parseInt(e.target.value, 10) as 203 | 300 | 406 })}
                                    className={field} aria-label="Printer resolution">
                                    {dpiOptions.map(d => <option key={d} value={String(d)}>{d}</option>)}
                                </select>
                            </label>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                            <label className="block">Orient.
                                <select value={sel.orientation} onChange={e => editCustom({ orientation: e.target.value as 'portrait' | 'landscape' })}
                                    className={field} aria-label="Orientation">
                                    <option value="portrait">Portrait</option>
                                    <option value="landscape">Landscape</option>
                                </select>
                            </label>
                            <label className="block">Cols
                                <input type="number" min="1" step="1" value={sel.columns}
                                    onChange={e => editCustom({ columns: parseInt(e.target.value, 10) })}
                                    className={field} aria-label="Columns" />
                            </label>
                            <label className="block">Rows
                                <input type="number" min="1" step="1" value={sel.rows}
                                    onChange={e => editCustom({ rows: parseInt(e.target.value, 10) })}
                                    className={field} aria-label="Rows" />
                            </label>
                        </div>
                        <div className="rounded-md bg-gray-900/60 border border-gray-700 p-2 text-[11px] text-gray-300 tabular-nums" aria-live="polite">
                            <div>{Number.isFinite(sel.widthMm) ? sel.widthMm.toFixed(1) : '?'} × {Number.isFinite(sel.heightMm) ? sel.heightMm.toFixed(1) : '?'} mm
                                ({Number.isFinite(sel.widthMm) ? (sel.widthMm / 25.4).toFixed(2) : '?'} × {Number.isFinite(sel.heightMm) ? (sel.heightMm / 25.4).toFixed(2) : '?'} in)</div>
                            <div>{Number.isFinite(sel.widthMm) ? dotsFor(sel.widthMm, sel.dpi) : '?'} × {Number.isFinite(sel.heightMm) ? dotsFor(sel.heightMm, sel.dpi) : '?'} dots @ {sel.dpi} dpi</div>
                            {verdict.warnings.map(w => <div key={w} className="text-amber-300 mt-1">⚠ {w}</div>)}
                            {verdict.errors.map(e => <div key={e} className="text-red-400 mt-1">✕ {e}</div>)}
                            {gridError && <div className="text-red-400 mt-1">✕ {gridError}</div>}
                        </div>
                        <label className="flex items-center gap-2 text-xs text-gray-400">
                            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
                            Use as default
                        </label>
                    </div>
                </div>

                <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-gray-700">
                    <button type="button" onClick={onClose} className="px-4 py-1.5 text-sm rounded-md bg-gray-700 hover:bg-gray-600 text-white">Cancel</button>
                    <button type="submit" disabled={blocked} title={blocked ? 'Fix the errors above first' : 'Create the label (Enter)'}
                        className="px-4 py-1.5 text-sm rounded-md bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40 disabled:cursor-not-allowed">
                        Create label
                    </button>
                </div>
            </form>
        </div>
    );
};
