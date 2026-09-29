import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { Field, TextField, BarcodeField, LineField, BoxField, ImageField, EllipseField, PolygonField, TriangleField, HRIPlacement, FieldDataSource, Design, DateFormat, TimeFormat } from '../types';
import { FONT_MAP, BARCODE_MAP } from '../constants';
import { installFontFile, listInstalledFonts, type StoredFont } from '../services/fontStore';
import { GS1_AIS, buildGs1, type Gs1Pair } from '../services/gs1';
import { validateBarcode } from '../services/validator';
import { notify } from '../services/uiDialogs';
import { loadImageFileToBitmap, invertBitmap, MAX_IMAGE_DOTS } from '../services/imageField';
import { applyTransform } from '../services/tableSource';

const usePropEditor = <T,>(
    initialValue: T | 'multiple',
    onCommit: (newValue: T) => void
) => {
    const [localValue, setLocalValue] = useState<string>(initialValue === 'multiple' ? '' : (initialValue?.toString() ?? ''));
    const initialValueRef = useRef(initialValue);
    // The editor unmounts when the right panel switches tabs, and React fires
    // no blur on unmount — so a blur-only commit silently drops the edit. A
    // focus flag stops the sync effect from overwriting a live edit instead.
    const focusedRef = useRef(false);

    useEffect(() => {
        if (focusedRef.current) return;
        const strValue = initialValue === 'multiple' ? '' : (initialValue?.toString() ?? '');
        setLocalValue(strValue);
        initialValueRef.current = initialValue;
    }, [initialValue]);

    const commitValue = (raw: string, parser: (value: string) => T, validator?: (value: T, original: T | 'multiple') => T) => {
        if (raw === '') return false;
        let parsedValue = parser(raw);
        if (validator) {
            parsedValue = validator(parsedValue, initialValueRef.current);
        }
        if (initialValueRef.current === 'multiple' || JSON.stringify(parsedValue) !== JSON.stringify(initialValueRef.current)) {
            onCommit(parsedValue);
            return true;
        }
        return false;
    };

    // Commit as the user types. An entry that is not yet a finished value (an
    // empty box, or the lone "1" of "150") is skipped here and left to blur,
    // so the model never receives a parse of an unfinished edit.
    const handleChange = (raw: string, parser: (value: string) => T, validator?: (value: T, original: T | 'multiple') => T) => {
        setLocalValue(raw);
        commitValue(raw, parser, validator);
    };

    const handleBlur = (parser: (value: string) => T, validator?: (value: T, original: T | 'multiple') => T) => {
        focusedRef.current = false;
        if (!commitValue(localValue, parser, validator)) {
            // Nothing was written (empty or unchanged): snap the box back to
            // the value the model actually holds.
            setLocalValue(initialValueRef.current === 'multiple' ? '' : (initialValueRef.current?.toString() ?? ''));
        } else {
            const parsedValue = parser(localValue);
            setLocalValue(validator ? String(validator(parsedValue, initialValueRef.current)) : localValue);
        }
    };

    const handleFocus = () => { focusedRef.current = true; };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !(e.currentTarget.tagName === 'TEXTAREA' && e.shiftKey)) {
             e.preventDefault();
             e.currentTarget.blur();
        }
    };

    return { localValue, setLocalValue, handleChange, handleBlur, handleFocus, handleKeyDown };
};

const PropInput: React.FC<{ label: string; children: React.ReactNode; fullWidth?: boolean; }> = ({ label, children, fullWidth }) => (
    <div className={fullWidth ? 'col-span-2' : ''}>
        <label className="block text-xs font-medium text-gray-400 mb-1">{label}</label>
        {children}
    </div>
);

const inputClasses = "w-full p-1.5 text-sm border border-gray-600 bg-gray-700 rounded-md focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-none";
const pInt = (v: string) => parseInt(v, 10);
const pFloat = (v: string) => parseFloat(v);
const vMin1 = (v: number) => isNaN(v) ? 1 : Math.max(1, v);
const vMinFloat = (v: number) => isNaN(v) ? 0.1 : Math.max(0.1, v);
const pString = (v: string) => v;

/**
 * Select for an optional numeric/string symbology modifier: the empty value
 * means "printer default" (undefined on the field, so the generator omits
 * the parameter entirely instead of hard-coding a default).
 */
const ModifierSelect: React.FC<{
    label: string;
    value: number | string | 'multiple' | undefined;
    options: { value: number | string; label: string }[];
    onChange: (v: number | string | undefined) => void;
}> = ({ label, value, options, onChange }) => (
    <PropInput label={label} fullWidth>
        <select
            value={value === 'multiple' ? '__multi__' : value === undefined ? '' : String(value)}
            onChange={e => {
                const raw = e.target.value;
                if (raw === '' || raw === '__multi__') { onChange(undefined); return; }
                const n = Number(raw);
                onChange(Number.isInteger(n) && raw !== '' && !isNaN(n) ? n : raw);
            }}
            className={inputClasses}
        >
            {value === 'multiple' && <option value="__multi__" disabled>Multiple Values</option>}
            <option value="">Default</option>
            {options.map(o => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
        </select>
    </PropInput>
);
/**
 * Keeps the previous value when the typed string parses to NaN ("-", ".",
 * garbage). Without this, blurring such input commits NaN into field.x/y,
 * and ctx.translate(NaN) blanks the canvas for that frame — a silent
 * corruption. With original 'multiple' there is nothing to keep: 0.
 */
const vOrKeep = (v: number, original: number | 'multiple'): number =>
    isNaN(v) ? (typeof original === 'number' ? original : 0) : v;

function getCommonValue<T, K extends keyof T>(items: T[], key: K): T[K] | 'multiple' {
    if (!items || items.length === 0) return 'multiple';
    const firstValue = items[0][key];
    const firstValueStr = JSON.stringify(firstValue);
    for (let i = 1; i < items.length; i++) {
        if (JSON.stringify(items[i][key]) !== firstValueStr) {
            return 'multiple';
        }
    }
    return firstValue;
}


/**
 * A linked field points at a data source. A variable or counter has exactly one
 * value, so the source is enough; a TABLE has columns, and the field must say
 * which one it prints. The transform is optional and the same for every source
 * type — a bad expression is reported here, where it can be fixed, and still
 * prints the raw value rather than failing the job.
 */
const LinkedSourceEditor: React.FC<{
    dataSource: Extract<FieldDataSource, { type: 'linked' }>;
    fieldName: string;
    dataSources: Design['dataSources'];
    handleUpdate: (updates: Partial<Field>) => void;
}> = ({ dataSource, fieldName, dataSources, handleUpdate }) => {
    const source = dataSources.find(ds => ds.id === dataSource.sourceId);
    const isTable = source?.type === 'table';
    const [expr, setExpr] = useState(dataSource.transform ?? '');
    const focused = useRef(false);
    useEffect(() => { if (!focused.current) setExpr(dataSource.transform ?? ''); }, [dataSource.transform]);

    const commitExpr = () => {
        focused.current = false;
        const next = expr.trim();
        if (next === (dataSource.transform ?? '')) return;
        handleUpdate({ dataSource: { ...dataSource, transform: next || undefined } } as Partial<Field>);
    };
    // The design's tables, so a LOOKUP in the expression can be checked against the
    // real columns while it is typed. Only the sources are needed for that.
    const warning = expr.trim() === '' ? null : applyTransform(expr, '', { dataSources }).warning;

    return (
        <>
            <PropInput label="Link to" fullWidth>
                <select value={dataSource.sourceId} onChange={(e) => handleUpdate({ dataSource: { ...dataSource, sourceId: e.target.value, column: undefined } } as Partial<Field>)} className={inputClasses}>
                    {dataSources.map(ds => (
                        <option key={ds.id} value={ds.id}>{ds.name}{ds.type === 'table' ? ' (table)' : ''}</option>
                    ))}
                </select>
                {dataSources.length === 0 && <p className="text-xs text-yellow-400 mt-1">No variables defined. Go to the 'Data' tab to create one.</p>}
            </PropInput>
            {isTable && source.type === 'table' && (
                <PropInput label="Column" fullWidth>
                    <select value={dataSource.column ?? ''} aria-label="Linked column"
                        onChange={e => handleUpdate({ dataSource: { ...dataSource, column: e.target.value || undefined } } as Partial<Field>)}
                        className={inputClasses}>
                        <option value="">{source.columns.includes(fieldName) ? `Match field name ("${fieldName}")` : 'Choose a column…'}</option>
                        {source.columns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    {source.columns.length === 0 && <p className="text-xs text-yellow-400 mt-1">This table has no columns yet. Load a file in the Data tab.</p>}
                </PropInput>
            )}
            <PropInput label="Transform" fullWidth>
                <input value={expr} aria-label="Value transform" placeholder="e.g. UPPER(value)"
                    onChange={e => setExpr(e.target.value)}
                    onFocus={() => { focused.current = true; }}
                    onBlur={commitExpr}
                    onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                    className={inputClasses} />
                {warning
                    ? <p className="text-[10px] text-amber-400 mt-1">{warning.message}</p>
                    : <p className="text-[10px] text-gray-500 mt-1">Optional. UPPER, LOWER, TRIM, SUBSTR, PAD, REPLACE, IF, CONCAT, LOOKUP — <span className="font-mono">value</span> is the cell.</p>}
            </PropInput>
        </>
    );
};

const DataSourceEditor: React.FC<{
    fields: (TextField | BarcodeField)[];
    dataSources: Design['dataSources'];
    handleUpdate: (updates: Partial<Field>) => void;
}> = ({ fields, dataSources, handleUpdate }) => {
    const commonDataSource = getCommonValue(fields, 'dataSource') as FieldDataSource | 'multiple';
    if (commonDataSource === 'multiple') return <div className="col-span-2 text-xs text-gray-400">Data sources differ.</div>;
    
    const dataSource = commonDataSource;
    // FIX: The nested ternary was causing issues with type inference on the discriminated union.
    // Using if/else if is safer for type narrowing.
    let data = '';
    if (dataSource.type === 'fixed') {
        data = dataSource.data;
    } else if (dataSource.type === 'variable') {
        data = dataSource.defaultData;
    }

    const dataEditor = usePropEditor(data, (val: string) => {
        if (dataSource.type === 'fixed') handleUpdate({ dataSource: { ...dataSource, data: val } } as Partial<Field>);
        else if (dataSource.type === 'variable') handleUpdate({ dataSource: { ...dataSource, defaultData: val } } as Partial<Field>);
    });

    const handleTypeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const newType = e.target.value as FieldDataSource['type'];
        if (newType === 'fixed') {
            handleUpdate({ dataSource: { type: 'fixed', data } } as Partial<Field>);
        } else if (newType === 'variable') {
            handleUpdate({ dataSource: { type: 'variable', defaultData: data } } as Partial<Field>);
        } else if (newType === 'linked') {
            const firstSourceId = dataSources[0]?.id;
            handleUpdate({ dataSource: { type: 'linked', sourceId: firstSourceId || '' } } as Partial<Field>);
        } else if (newType === 'date') {
             handleUpdate({ dataSource: { type: 'date', format: 'YYYY/MM/DD' } } as Partial<Field>);
        } else if (newType === 'time') {
             handleUpdate({ dataSource: { type: 'time', format: 'HH:MM:SS 24hr' } } as Partial<Field>);
        }
    };
    
    const staticDataError = dataSource.type === 'fixed' && dataSource.data.includes(';') ? 'Fixed data cannot contain semicolons (;).' : null;
    const isTextField = fields.every(f => f.type === 'text');

    return (
        <>
            <PropInput label="Data Source" fullWidth>
                <select value={dataSource.type} onChange={handleTypeChange} className={inputClasses}>
                    <option value="variable">Variable Data</option>
                    <option value="fixed">Fixed Data</option>
                    <option value="linked">Linked to Variable</option>
                    {isTextField && <option value="date">Current Date</option>}
                    {isTextField && <option value="time">Current Time</option>}
                </select>
            </PropInput>

            {dataSource.type === 'linked' ? (
                 <LinkedSourceEditor dataSource={dataSource} fieldName={fields.length === 1 ? fields[0].name : ''} dataSources={dataSources} handleUpdate={handleUpdate} />
            ) : dataSource.type === 'date' ? (
                <PropInput label="Date Format" fullWidth>
                    <select value={dataSource.format} onChange={(e) => handleUpdate({dataSource: { ...dataSource, format: e.target.value as DateFormat }} as Partial<Field>)} className={inputClasses}>
                        <option value="YY/MM/DD">YY/MM/DD</option>
                        <option value="YYYY/MM/DD">YYYY/MM/DD</option>
                        <option value="DD/MM/YY">DD/MM/YY</option>
                        <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                    </select>
                </PropInput>
            ) : dataSource.type === 'time' ? (
                 <PropInput label="Time Format" fullWidth>
                    <select value={dataSource.format} onChange={(e) => handleUpdate({dataSource: { ...dataSource, format: e.target.value as TimeFormat }} as Partial<Field>)} className={inputClasses}>
                        <option value="HH:MM:SS 24hr">HH:MM:SS 24hr</option>
                        <option value="HH:MM 24hr">HH:MM 24hr</option>
                        <option value="HH:MM:SS 12hr">HH:MM:SS 12hr</option>
                        <option value="HH:MM 12hr">HH:MM 12hr</option>
                        <option value="HH:MM:SS am/pm">HH:MM:SS am/pm</option>
                        <option value="HH:MM am/pm">HH:MM am/pm</option>
                    </select>
                </PropInput>
            ) : (
                <PropInput label={dataSource.type === 'fixed' ? 'Fixed Data' : 'Default Data'} fullWidth>
                     <textarea value={dataEditor.localValue} onChange={e => dataEditor.handleChange(e.target.value, pString)} onFocus={dataEditor.handleFocus} onBlur={() => dataEditor.handleBlur(pString)} onKeyDown={dataEditor.handleKeyDown} className={`${inputClasses} min-h-[60px] resize-y ${staticDataError ? 'border-red-500 ring-red-500' : ''}`} />
                    {staticDataError && <p className="text-xs text-red-400 mt-1">{staticDataError}</p>}
                </PropInput>
            )}
        </>
    );
};


const TextFieldEditor: React.FC<{ fields: TextField[]; design: Design; handleUpdate: (updates: Partial<Field>) => void; }> = ({ fields, design, handleUpdate }) => {
    const commonFont = getCommonValue(fields, 'font');
    const commonFontSize = getCommonValue(fields, 'fontSize');
    const commonHMag = getCommonValue(fields, 'h_mag');
    const commonWMag = getCommonValue(fields, 'w_mag');
    const commonAlign = getCommonValue(fields, 'align') || 'left';

    const fontSizeEditor = usePropEditor(commonFontSize, (val: number) => handleUpdate({ fontSize: val } as Partial<Field>));
    const hMagEditor = usePropEditor(commonHMag, (val: number) => handleUpdate({ h_mag: val } as Partial<Field>));
    const wMagEditor = usePropEditor(commonWMag, (val: number) => handleUpdate({ w_mag: val } as Partial<Field>));
    
    const isBitmapFont = commonFont !== 'multiple' && FONT_MAP[commonFont]?.type === 'bitmap';

    // Fase 3: faces the user uploaded. They are screen fonts — the printer gets
    // the nearest resident family, and the IPL tab says how far that is off.
    const [installed, setInstalled] = useState<StoredFont[]>([]);
    const [fontError, setFontError] = useState<string | null>(null);
    useEffect(() => { listInstalledFonts().then(setInstalled).catch(() => setInstalled([])); }, []);

    const onFontFile = async (file: File) => {
        setFontError(null);
        try {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('Cannot measure the font in this browser.');
            const stored = await installFontFile(file, ctx);
            setInstalled(await listInstalledFonts());
            handleUpdate({ font: stored.name } as Partial<Field>);
        } catch (e) {
            setFontError(e instanceof Error ? e.message : 'Could not read that font file.');
        }
    };

    return <>
        <DataSourceEditor fields={fields} dataSources={design.dataSources} handleUpdate={handleUpdate} />
        <PropInput label="Font" fullWidth>
            <select value={commonFont === 'multiple' ? '' : commonFont} onChange={e => handleUpdate({ font: e.target.value } as Partial<Field>)} className={inputClasses}>
                 {commonFont === 'multiple' && <option value="" disabled>Multiple Values</option>}
                 {Object.entries(FONT_MAP).map(([id, {name}]) => <option key={id} value={id}>{name}</option>)}
                 {installed.length > 0 && <optgroup label="Uploaded (screen only)">
                     {installed.map(f => <option key={f.name} value={f.name}>{f.name}</option>)}
                 </optgroup>}
            </select>
        </PropInput>
        <PropInput label="Upload font" fullWidth>
            <input type="file" accept=".ttf,.otf" title="Use a font from your computer. The screen shows it exactly; the printer substitutes its nearest built-in face."
                onChange={e => { const f = e.target.files?.[0]; if (f) onFontFile(f); e.target.value = ''; }}
                className="text-xs file:mr-2 file:rounded file:border-0 file:bg-gray-600 file:px-2 file:py-1 file:text-gray-100" />
            {fontError && <span className="block text-xs text-red-400 mt-1">{fontError}</span>}
        </PropInput>
        {isBitmapFont ? (
            <>
                <PropInput label="Height Mag"><input type="number" min="1" value={hMagEditor.localValue} placeholder={commonHMag === 'multiple' ? 'Multiple' : ''} onChange={e => hMagEditor.handleChange(e.target.value, pInt, vMin1)} onFocus={hMagEditor.handleFocus} onBlur={() => hMagEditor.handleBlur(pInt, vMin1)} onKeyDown={hMagEditor.handleKeyDown} className={inputClasses}/></PropInput>
                <PropInput label="Width Mag"><input type="number" min="1" value={wMagEditor.localValue} placeholder={commonWMag === 'multiple' ? 'Multiple' : ''} onChange={e => wMagEditor.handleChange(e.target.value, pInt, vMin1)} onFocus={wMagEditor.handleFocus} onBlur={() => wMagEditor.handleBlur(pInt, vMin1)} onKeyDown={wMagEditor.handleKeyDown} className={inputClasses}/></PropInput>
            </>
        ) : (
            <PropInput label="Font Size (pt)" fullWidth><input type="number" min="1" value={fontSizeEditor.localValue} placeholder={commonFontSize === 'multiple' ? 'Multiple' : ''} onChange={e => fontSizeEditor.handleChange(e.target.value, pInt, vMin1)} onFocus={fontSizeEditor.handleFocus} onBlur={() => fontSizeEditor.handleBlur(pInt, vMin1)} onKeyDown={fontSizeEditor.handleKeyDown} className={inputClasses}/></PropInput>
        )}
        <PropInput label="Align" fullWidth>
            <select value={commonAlign === 'multiple' ? '' : commonAlign} onChange={e => handleUpdate({ align: e.target.value as TextField['align'] } as Partial<Field>)} className={inputClasses}>
                {commonAlign === 'multiple' && <option value="" disabled>Multiple Values</option>}
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
            </select>
        </PropInput>
    </>
};

/**
 * Fase 4: assemble a GS1 symbol from Application Identifiers instead of asking
 * the user to type the parentheses by hand. Only offered for a single field
 * whose data is fixed — a linked field's data comes from its column, and there
 * is nothing here to write into. The built string is exactly what the encoder
 * accepts (tests/gs1.test.ts), so "Apply" cannot produce a symbol that fails.
 */
const Gs1Builder: React.FC<{ field: BarcodeField; handleUpdate: (updates: Partial<Field>) => void; }> = ({ field, handleUpdate }) => {
    const [pairs, setPairs] = useState<Gs1Pair[]>([{ ai: '01', value: '' }]);
    const [open, setOpen] = useState(false);
    if (!open) {
        return (
            <div className="col-span-2">
                <button type="button" onClick={() => setOpen(true)} className="text-xs text-blue-400 hover:text-blue-300">Build GS1 data…</button>
            </div>
        );
    }
    const built = buildGs1(pairs.filter(p => p.value.trim() !== ''));
    const data = field.dataSource.type === 'fixed' ? field.dataSource.data : '';
    const apply = () => {
        if (built.problems.length > 0 || built.data === '') return;
        handleUpdate({ dataSource: { type: 'fixed', data: built.data } } as Partial<Field>);
    };
    return (
        <div className="col-span-2 border border-gray-700 rounded-md p-2 space-y-1.5">
            <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-gray-300">GS1 Application Identifiers</span>
                <button type="button" onClick={() => setOpen(false)} className="text-xs text-gray-500 hover:text-gray-300">Close</button>
            </div>
            {pairs.map((pair, i) => (
                <div key={i} className="flex gap-1">
                    <select aria-label={`AI ${i + 1}`} value={pair.ai}
                        onChange={e => setPairs(pairs.map((p, j) => j === i ? { ...p, ai: e.target.value } : p))}
                        className={inputClasses + ' w-40 flex-shrink-0'}>
                        {Object.entries(GS1_AIS).map(([ai, spec]) => <option key={ai} value={ai}>{ai} {spec.name}</option>)}
                    </select>
                    <input aria-label={`AI ${i + 1} value`} value={pair.value} placeholder="Value"
                        onChange={e => setPairs(pairs.map((p, j) => j === i ? { ...p, value: e.target.value } : p))}
                        className={inputClasses} />
                    {pairs.length > 1 && (
                        <button type="button" aria-label={`Remove AI ${i + 1}`}
                            onClick={() => setPairs(pairs.filter((_, j) => j !== i))}
                            className="text-gray-500 hover:text-red-400 px-1">×</button>
                    )}
                </div>
            ))}
            <button type="button" onClick={() => setPairs([...pairs, { ai: '10', value: '' }])} className="text-xs text-blue-400 hover:text-blue-300">Add AI</button>
            {built.problems.map((p, i) => <p key={i} className="text-[10px] text-amber-400">{p.message}</p>)}
            {built.data && <p className="text-[10px] font-mono text-gray-400 break-all">{built.data}</p>}
            <button type="button" onClick={apply} disabled={built.problems.length > 0 || built.data === '' || built.data === data}
                className="text-xs px-2 py-1 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-md">
                {built.data === data && built.data !== '' ? 'Applied' : 'Apply to field'}
            </button>
        </div>
    );
};

const BarcodeFieldEditor: React.FC<{ fields: BarcodeField[]; design: Design; handleUpdate: (updates: Partial<Field>) => void; }> = ({ fields, design, handleUpdate }) => {
    const commonSymbology = getCommonValue(fields, 'symbology');
    const commonHMag = getCommonValue(fields, 'h_mag');
    const commonWMag = getCommonValue(fields, 'w_mag');
    const commonHRI = getCommonValue(fields, 'humanReadable');
    const commonCode39CheckDigit = getCommonValue(fields, 'code39_checkDigit');
    const commonHriFont = getCommonValue(fields, 'hriFont');
    const commonHriFontSize = getCommonValue(fields, 'hriFontSize');
    // 'left' is what the printer does (PRM p.200: an IPL interpretive field is
    // left justified), so the editor must not show 'center' for a field that
    // has never set the property.
    const commonHriAlign = getCommonValue(fields, 'hriAlign') || 'left';

    const hMagEditor = usePropEditor(commonHMag, (val: number) => handleUpdate({ h_mag: val } as Partial<Field>));
    const wMagEditor = usePropEditor(commonWMag, (val: number) => handleUpdate({ w_mag: val } as Partial<Field>));
    const hriFontSizeEditor = usePropEditor(commonHriFontSize, (val: number) => handleUpdate({ hriFontSize: val } as Partial<Field>));


    return <>
        <DataSourceEditor fields={fields} dataSources={design.dataSources} handleUpdate={handleUpdate} />

        {fields.length === 1 && fields[0].dataSource.type === 'fixed'
            && ['6', '17', '18'].includes(fields[0].symbology)
            && <Gs1Builder field={fields[0]} handleUpdate={handleUpdate} />}

        <PropInput label="Symbology" fullWidth>
            <select value={commonSymbology === 'multiple' ? '' : commonSymbology} onChange={e => handleUpdate({ symbology: e.target.value } as Partial<Field>)} className={inputClasses}>
                {commonSymbology === 'multiple' && <option value="" disabled>Multiple Values</option>}
                {Object.entries(BARCODE_MAP).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
        </PropInput>
        
        {commonSymbology !== 'multiple' && commonSymbology === '0' && (
            <PropInput label="Check Digit" fullWidth>
                <select value={commonCode39CheckDigit === 'multiple' ? '' : commonCode39CheckDigit || 'none'} onChange={e => handleUpdate({ code39_checkDigit: e.target.value as BarcodeField['code39_checkDigit'] } as Partial<Field>)} className={inputClasses}>
                    {commonCode39CheckDigit === 'multiple' && <option value="" disabled>Multiple Values</option>}
                    <option value="none">None</option>
                    <option value="printer-generated">Printer-Generated (Mod43)</option>
                    <option value="host-verifies">Host Verifies (Mod43)</option>
                </select>
            </PropInput>
        )}

        {/* Symbology-specific modifiers (PRM c-syntax). 'Default' leaves the
            parameter unset so the generator omits it and the printer's own
            default applies. */}
        {commonSymbology === '18' && (
            <>
                <ModifierSelect label="QR Model" value={getCommonValue(fields, 'qrModel')}
                    options={[{ value: 2, label: '2 (Model 2)' }, { value: 1, label: '1 (Model 1)' }]}
                    onChange={v => handleUpdate({ qrModel: v as number | undefined } as Partial<Field>)} />
                <ModifierSelect label="Error Correction" value={getCommonValue(fields, 'qrEcl')}
                    options={[{ value: 'L', label: 'L — 7%' }, { value: 'M', label: 'M — 15%' }, { value: 'Q', label: 'Q — 25%' }, { value: 'H', label: 'H — 30%' }]}
                    onChange={v => handleUpdate({ qrEcl: v as BarcodeField['qrEcl'] } as Partial<Field>)} />
                <ModifierSelect label="Mask" value={getCommonValue(fields, 'qrMask')}
                    options={[0, 1, 2, 3, 4, 5, 6, 7, 8].map(m => ({ value: m, label: m === 8 ? '8 (auto)' : String(m) }))}
                    onChange={v => handleUpdate({ qrMask: v as number | undefined } as Partial<Field>)} />
            </>
        )}
        {commonSymbology === '19' && (
            <>
                <ModifierSelect label="Data Columns" value={getCommonValue(fields, 'microColumns')}
                    options={[0, 1, 2, 3, 4].map(c => ({ value: c, label: c === 0 ? '0 (auto)' : String(c) }))}
                    onChange={v => handleUpdate({ microColumns: v as number | undefined } as Partial<Field>)} />
                <ModifierSelect label="Data Rows" value={getCommonValue(fields, 'microRows')}
                    options={[0, 4, 6, 8, 10, 11, 12, 14, 15, 16, 17, 20, 22, 23, 24, 26, 28, 32, 38, 44].map(r => ({ value: r, label: r === 0 ? '0 (auto)' : String(r) }))}
                    onChange={v => handleUpdate({ microRows: v as number | undefined } as Partial<Field>)} />
            </>
        )}
        {commonSymbology === '20' && (
            <>
                <ModifierSelect label="RSS Version" value={getCommonValue(fields, 'rssVersion')}
                    options={[
                        { value: 0, label: '0 — RSS-14' }, { value: 1, label: '1 — RSS-14 Truncated' },
                        { value: 2, label: '2 — RSS-14 Stacked' }, { value: 3, label: '3 — RSS-14 Stacked Omni' },
                        { value: 4, label: '4 — RSS Limited' }, { value: 5, label: '5 — RSS Expanded' },
                        { value: 6, label: '6 — RSS Expanded Stacked' },
                    ]}
                    onChange={v => handleUpdate({ rssVersion: v as number | undefined } as Partial<Field>)} />
                <ModifierSelect label="Separator Height" value={getCommonValue(fields, 'rssSepHeight')}
                    options={[1, 2, 3, 4].map(s => ({ value: s, label: `${s}× bar` }))}
                    onChange={v => handleUpdate({ rssSepHeight: v as number | undefined } as Partial<Field>)} />
                <ModifierSelect label="Segments / Row" value={getCommonValue(fields, 'rssSegments')}
                    options={[2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22].map(s => ({ value: s, label: String(s) }))}
                    onChange={v => handleUpdate({ rssSegments: v as number | undefined } as Partial<Field>)} />
            </>
        )}
        {commonSymbology === '14' && (
            <ModifierSelect label="MaxiCode Mode" value={getCommonValue(fields, 'maxiMode')}
                options={[
                    { value: 2, label: '2 — Numeric postal (SCM)' }, { value: 3, label: '3 — Alpha postal (SCM)' },
                    { value: 4, label: '4 — Standard' }, { value: 5, label: '5 — Full EEC' }, { value: 6, label: '6 — Reader Programming' },
                ]}
                onChange={v => handleUpdate({ maxiMode: v as number | undefined } as Partial<Field>)} />
        )}
        {(commonSymbology === '8' || commonSymbology === '16') && (
            <ModifierSelect label="HIBC Format" value={getCommonValue(fields, 'hibcMode')}
                options={[
                    { value: 0, label: '0 — Primary (supplier)' }, { value: 1, label: '1 — Alt. primary' },
                    { value: 2, label: '2 — Secondary' }, { value: 3, label: '3 — Single (provider)' },
                    { value: 4, label: '4 — First data' }, { value: 5, label: '5 — Second data' }, { value: 6, label: '6 — Multiple data' },
                ]}
                onChange={v => handleUpdate({ hibcMode: v as number | undefined } as Partial<Field>)} />
        )}

        <PropInput label="Bar Height (dots)"><input type="number" min="1" value={hMagEditor.localValue} placeholder={commonHMag === 'multiple' ? 'Multiple' : ''} onChange={e => hMagEditor.handleChange(e.target.value, pInt, vMin1)} onFocus={hMagEditor.handleFocus} onBlur={() => hMagEditor.handleBlur(pInt, vMin1)} onKeyDown={hMagEditor.handleKeyDown} className={inputClasses}/></PropInput>
        <PropInput label="Narrow Bar (dots)"><input type="number" min="1" value={wMagEditor.localValue} placeholder={commonWMag === 'multiple' ? 'Multiple' : ''} onChange={e => wMagEditor.handleChange(e.target.value, pInt, vMin1)} onFocus={wMagEditor.handleFocus} onBlur={() => wMagEditor.handleBlur(pInt, vMin1)} onKeyDown={wMagEditor.handleKeyDown} className={inputClasses}/></PropInput>
        
        <PropInput label="Human Readable" fullWidth>
            <select value={commonHRI === 'multiple' ? '' : commonHRI} onChange={e => handleUpdate({ humanReadable: e.target.value as HRIPlacement } as Partial<Field>)} className={inputClasses}>
                {commonHRI === 'multiple' && <option value="" disabled>Multiple Values</option>}
                <option value="none">None</option>
                <option value="below">Below Barcode</option>
                <option value="above">Above Barcode</option>
            </select>
        </PropInput>

        {commonHRI !== 'multiple' && commonHRI !== 'none' && (
            <>
                <PropInput label="HRI Font" fullWidth>
                    <select value={commonHriFont === 'multiple' ? '' : commonHriFont || '21'} onChange={e => handleUpdate({ hriFont: e.target.value } as Partial<Field>)} className={inputClasses}>
                        {commonHriFont === 'multiple' && <option value="" disabled>Multiple Values</option>}
                        {Object.entries(FONT_MAP).map(([id, {name}]) => <option key={id} value={id}>{name}</option>)}
                    </select>
                </PropInput>
                <PropInput label="HRI Font Size (pt)" >
                    <input type="number" min="1" value={hriFontSizeEditor.localValue} placeholder={commonHriFontSize === 'multiple' ? 'Multiple' : ''} onChange={e => hriFontSizeEditor.handleChange(e.target.value, pInt, vMin1)} onFocus={hriFontSizeEditor.handleFocus} onBlur={() => hriFontSizeEditor.handleBlur(pInt, vMin1)} onKeyDown={hriFontSizeEditor.handleKeyDown} className={inputClasses}/>
                </PropInput>
                 <PropInput label="HRI Align">
                    <select value={commonHriAlign === 'multiple' ? '' : commonHriAlign} onChange={e => handleUpdate({ hriAlign: e.target.value as BarcodeField['hriAlign'] } as Partial<Field>)} className={inputClasses}>
                        {commonHriAlign === 'multiple' && <option value="" disabled>Multiple Values</option>}
                        <option value="left">Left</option>
                        <option value="center">Center</option>
                        <option value="right">Right</option>
                    </select>
                </PropInput>
            </>
        )}
    </>
};

const LineFieldEditor: React.FC<{ fields: LineField[]; handleUpdate: (updates: Partial<Field>) => void; }> = ({ fields, handleUpdate }) => {
    const commonLength = getCommonValue(fields, 'length');
    const commonThickness = getCommonValue(fields, 'thickness');
    const commonLineEnding = getCommonValue(fields, 'lineEnding') || 'none';

    const lengthEditor = usePropEditor(commonLength, (val: number) => handleUpdate({ length: val } as Partial<Field>));
    const thicknessEditor = usePropEditor(commonThickness, (val: number) => handleUpdate({ thickness: val } as Partial<Field>));

    return <>
        <PropInput label="Length (mm)"><input type="number" step="0.1" min="0.1" value={lengthEditor.localValue} placeholder={commonLength === 'multiple' ? 'Multiple' : ''} onChange={e => lengthEditor.handleChange(e.target.value, pFloat, vMinFloat)} onFocus={lengthEditor.handleFocus} onBlur={() => lengthEditor.handleBlur(pFloat, vMinFloat)} onKeyDown={lengthEditor.handleKeyDown} className={inputClasses}/></PropInput>
        <PropInput label="Thickness (mm)"><input type="number" step="0.1" min="0.1" value={thicknessEditor.localValue} placeholder={commonThickness === 'multiple' ? 'Multiple' : ''} onChange={e => thicknessEditor.handleChange(e.target.value, pFloat, vMinFloat)} onFocus={thicknessEditor.handleFocus} onBlur={() => thicknessEditor.handleBlur(pFloat, vMinFloat)} onKeyDown={thicknessEditor.handleKeyDown} className={inputClasses}/></PropInput>
        <PropInput label="Line Ending" fullWidth>
            <select value={commonLineEnding === 'multiple' ? '' : commonLineEnding} onChange={e => handleUpdate({ lineEnding: e.target.value as LineField['lineEnding'] } as Partial<Field>)} className={inputClasses}>
                 {commonLineEnding === 'multiple' && <option value="" disabled>Multiple Values</option>}
                <option value="none">None</option>
                <option value="arrow">Arrow</option>
            </select>
        </PropInput>
    </>
};

const BoxFieldEditor: React.FC<{ fields: BoxField[]; handleUpdate: (updates: Partial<Field>) => void; }> = ({ fields, handleUpdate }) => {
    const commonWidth = getCommonValue(fields, 'width');
    const commonHeight = getCommonValue(fields, 'height');
    const commonThickness = getCommonValue(fields, 'thickness');
    const commonCornerRadius = getCommonValue(fields, 'cornerRadius');
    
    const widthEditor = usePropEditor(commonWidth, (val: number) => handleUpdate({ width: val } as Partial<Field>));
    const heightEditor = usePropEditor(commonHeight, (val: number) => handleUpdate({ height: val } as Partial<Field>));
    const thicknessEditor = usePropEditor(commonThickness, (val: number) => handleUpdate({ thickness: val } as Partial<Field>));
    const cornerRadiusEditor = usePropEditor(commonCornerRadius, (val: number) => handleUpdate({ cornerRadius: val } as Partial<Field>));
    
    return <>
        <PropInput label="Width (mm)"><input type="number" step="0.1" min="0.1" value={widthEditor.localValue} placeholder={commonWidth === 'multiple' ? 'Multiple' : ''} onChange={e => widthEditor.handleChange(e.target.value, pFloat, vMinFloat)} onFocus={widthEditor.handleFocus} onBlur={() => widthEditor.handleBlur(pFloat, vMinFloat)} onKeyDown={widthEditor.handleKeyDown} className={inputClasses}/></PropInput>
        <PropInput label="Height (mm)"><input type="number" step="0.1" min="0.1" value={heightEditor.localValue} placeholder={commonHeight === 'multiple' ? 'Multiple' : ''} onChange={e => heightEditor.handleChange(e.target.value, pFloat, vMinFloat)} onFocus={heightEditor.handleFocus} onBlur={() => heightEditor.handleBlur(pFloat, vMinFloat)} onKeyDown={heightEditor.handleKeyDown} className={inputClasses}/></PropInput>
        <PropInput label="Thickness (mm)"><input type="number" step="0.1" min="0.1" value={thicknessEditor.localValue} placeholder={commonThickness === 'multiple' ? 'Multiple' : ''} onChange={e => thicknessEditor.handleChange(e.target.value, pFloat, vMinFloat)} onFocus={thicknessEditor.handleFocus} onBlur={() => thicknessEditor.handleBlur(pFloat, vMinFloat)} onKeyDown={thicknessEditor.handleKeyDown} className={inputClasses}/></PropInput>
        <PropInput label="Corner Radius (mm)"><input type="number" step="0.1" min="0" value={cornerRadiusEditor.localValue} placeholder={commonCornerRadius === 'multiple' ? 'Multiple' : ''} onChange={e => cornerRadiusEditor.handleChange(e.target.value, pFloat, (v, o) => Math.max(0, vOrKeep(v, o)))} onFocus={cornerRadiusEditor.handleFocus} onBlur={() => cornerRadiusEditor.handleBlur(pFloat, (v, o) => Math.max(0, vOrKeep(v, o)))} onKeyDown={cornerRadiusEditor.handleKeyDown} className={inputClasses}/></PropInput>
    </>
};

/**
 * Fase 3 shapes share width, height and stroke. A zero stroke fills the shape.
 * The polygon adds a side count; below 3 there is nothing to draw, so the
 * generator emits no graphic for it.
 */
const ShapeFieldEditor: React.FC<{ fields: (EllipseField | PolygonField | TriangleField)[]; handleUpdate: (updates: Partial<Field>) => void; }> = ({ fields, handleUpdate }) => {
    const commonWidth = getCommonValue(fields, 'width');
    const commonHeight = getCommonValue(fields, 'height');
    const commonThickness = getCommonValue(fields, 'thickness');
    const widthEditor = usePropEditor(commonWidth, (val: number) => handleUpdate({ width: val } as Partial<Field>));
    const heightEditor = usePropEditor(commonHeight, (val: number) => handleUpdate({ height: val } as Partial<Field>));
    const thicknessEditor = usePropEditor(commonThickness, (val: number) => handleUpdate({ thickness: val } as Partial<Field>));

    const isPolygon = fields.every(f => f.type === 'polygon');
    const commonSides = isPolygon ? getCommonValue(fields, 'sides') : undefined;
    const sidesEditor = usePropEditor(commonSides, (val: number) => handleUpdate({ sides: Math.max(3, Math.min(24, Math.round(val))) } as Partial<Field>));

    return <>
        <PropInput label="Width (mm)"><input type="number" step="0.1" min="0.1" value={widthEditor.localValue} placeholder={commonWidth === 'multiple' ? 'Multiple' : ''} onChange={e => widthEditor.handleChange(e.target.value, pFloat, vMinFloat)} onFocus={widthEditor.handleFocus} onBlur={() => widthEditor.handleBlur(pFloat, vMinFloat)} onKeyDown={widthEditor.handleKeyDown} className={inputClasses}/></PropInput>
        <PropInput label="Height (mm)"><input type="number" step="0.1" min="0.1" value={heightEditor.localValue} placeholder={commonHeight === 'multiple' ? 'Multiple' : ''} onChange={e => heightEditor.handleChange(e.target.value, pFloat, vMinFloat)} onFocus={heightEditor.handleFocus} onBlur={() => heightEditor.handleBlur(pFloat, vMinFloat)} onKeyDown={heightEditor.handleKeyDown} className={inputClasses}/></PropInput>
        <PropInput label="Stroke (mm)"><input type="number" step="0.1" min="0" value={thicknessEditor.localValue} placeholder={commonThickness === 'multiple' ? 'Multiple' : ''} onChange={e => thicknessEditor.handleChange(e.target.value, pFloat, (v, o) => Math.max(0, vOrKeep(v, o)))} onFocus={thicknessEditor.handleFocus} onBlur={() => thicknessEditor.handleBlur(pFloat, (v, o) => Math.max(0, vOrKeep(v, o)))} onKeyDown={thicknessEditor.handleKeyDown} className={inputClasses} title="0 fills the shape solid"/></PropInput>
        {isPolygon && <PropInput label="Sides"><input type="number" step="1" min="3" max="24" value={sidesEditor.localValue} placeholder={commonSides === 'multiple' ? 'Multiple' : ''} onChange={e => sidesEditor.handleChange(e.target.value, pInt)} onFocus={sidesEditor.handleFocus} onBlur={() => sidesEditor.handleBlur(pInt)} onKeyDown={sidesEditor.handleKeyDown} className={inputClasses}/></PropInput>}
        <p className="col-span-2 text-[11px] text-gray-500">Prints as a downloaded raster graphic — IPL has no command for this shape.</p>
    </>
};

const ImageFieldEditor: React.FC<{ fields: ImageField[]; handleUpdate: (updates: Partial<Field>) => void; }> = ({ fields, handleUpdate }) => {
    const commonWidth = getCommonValue(fields, 'width');
    const commonHeight = getCommonValue(fields, 'height');
    const commonThreshold = getCommonValue(fields, 'threshold');
    const widthEditor = usePropEditor(commonWidth, (val: number) => handleUpdate({ width: val } as Partial<Field>));
    const heightEditor = usePropEditor(commonHeight, (val: number) => handleUpdate({ height: val } as Partial<Field>));
    const thresholdEditor = usePropEditor(commonThreshold, (val: number) => handleUpdate({ threshold: Math.max(1, Math.min(254, Math.round(val) || 128)) } as Partial<Field>));
    const fileRef = useRef<HTMLInputElement>(null);
    const [loading, setLoading] = useState(false);

    const dotsW = fields[0]?.bitmap[0]?.length ?? 0;
    const dotsH = fields[0]?.bitmap.length ?? 0;
    const hasImage = dotsW > 0 && dotsH > 0;

    const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (e.target) e.target.value = '';
        if (!file) return;
        setLoading(true);
        try {
            const bitmap = await loadImageFileToBitmap(file, MAX_IMAGE_DOTS, fields[0].threshold ?? 128, fields[0].dither ?? 'threshold');
            // (maxDotsW caps the wide axis; height follows the source aspect)
            if (!bitmap.length || !bitmap[0].length) throw new Error('empty');
            // Reducer re-derives mm from the dot grid at the design's dpi.
            handleUpdate({ bitmap } as Partial<Field>);
        } catch {
            notify('Could not read that image file — pick a PNG, JPEG, GIF, BMP or WebP image.');
        } finally {
            setLoading(false);
        }
    };

    return <>
        <div className="col-span-2 flex items-center gap-2">
            <button onClick={() => fileRef.current?.click()} disabled={loading}
                className="flex-1 px-2 py-1.5 text-xs font-semibold text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-50 rounded-md transition-colors">
                {loading ? 'Reading…' : hasImage ? 'Replace Image…' : 'Choose Image…'}
            </button>
            {hasImage && fields.length === 1 && (
                <button onClick={() => handleUpdate({ bitmap: invertBitmap(fields[0].bitmap) } as Partial<Field>)}
                    title="Swap ink and paper (white-on-dark logos)"
                    className="px-2 py-1.5 text-xs text-gray-200 bg-gray-600 hover:bg-gray-500 rounded-md transition-colors">Invert</button>
            )}
            <input ref={fileRef} type="file" accept="image/*" onChange={onFile} className="hidden"/>
        </div>
        <PropInput label={`Dot Grid (W×H)`}><div className="w-full text-xs p-1.5 bg-gray-900 border border-gray-600 rounded-md text-gray-400">{hasImage ? `${dotsW} × ${dotsH} dots` : 'no image loaded'}</div></PropInput>
        <PropInput label="Threshold"><input type="number" step="1" min="1" max="254" value={thresholdEditor.localValue} placeholder={commonThreshold === 'multiple' ? 'Multiple' : ''} onChange={e => thresholdEditor.handleChange(e.target.value, pInt)} onFocus={thresholdEditor.handleFocus} onBlur={() => thresholdEditor.handleBlur(pInt)} onKeyDown={thresholdEditor.handleKeyDown} className={inputClasses} title="Luminance cut-off for next import (1 dark .. 254 light)"/></PropInput>
        <PropInput label="Dithering" fullWidth>
            <select value={fields.length === 1 ? (fields[0].dither ?? 'threshold') : ''} onChange={e => handleUpdate({ dither: e.target.value as ImageField['dither'] } as Partial<Field>)} className={inputClasses} title="How a colour image is reduced to the 1 bit a thermal head prints. Applied on the next import.">
                {fields.length > 1 && <option value="" disabled>Multiple Values</option>}
                <option value="threshold">Threshold (crisp, for logos)</option>
                <option value="floyd-steinberg">Floyd–Steinberg (for photos)</option>
            </select>
        </PropInput>
        <PropInput label="Width (mm)"><input type="number" step="0.1" min="0.1" value={widthEditor.localValue} placeholder={commonWidth === 'multiple' ? 'Multiple' : ''} onChange={e => widthEditor.handleChange(e.target.value, pFloat, vMinFloat)} onFocus={widthEditor.handleFocus} onBlur={() => widthEditor.handleBlur(pFloat, vMinFloat)} onKeyDown={widthEditor.handleKeyDown} className={inputClasses} title="Resamples the bitmap to the new dot grid"/></PropInput>
        <PropInput label="Height (mm)"><input type="number" step="0.1" min="0.1" value={heightEditor.localValue} placeholder={commonHeight === 'multiple' ? 'Multiple' : ''} onChange={e => heightEditor.handleChange(e.target.value, pFloat, vMinFloat)} onFocus={heightEditor.handleFocus} onBlur={() => heightEditor.handleBlur(pFloat, vMinFloat)} onKeyDown={heightEditor.handleKeyDown} className={inputClasses} title="Resamples the bitmap to the new dot grid"/></PropInput>
    </>
};

/**
 * Fase 4: the condition that keeps a field off a label. Committed on every
 * keystroke, not on blur — this panel unmounts when the tab changes, and a blur
 * that never fires has already swallowed edits once. A condition that doesn't
 * parse is shown here and suppresses nothing, so the warning is the only signal
 * that the rule was ignored.
 */
const SuppressEditor: React.FC<{
    fields: Field[];
    dataSources: Design['dataSources'];
    handleUpdate: (updates: Partial<Field>) => void;
}> = ({ fields, dataSources, handleUpdate }) => {
    const common = getCommonValue(fields, 'suppress');
    const warning = typeof common === 'string' && common.trim() !== '' ? applyTransform(common, '', { dataSources }).warning : null;
    return (
        <PropInput label="Suppress when" fullWidth>
            <input value={common === 'multiple' ? '' : (common ?? '')} aria-label="Suppression condition"
                placeholder={common === 'multiple' ? 'Multiple values' : 'e.g. IF(value, "EQ", "EXPORT", "yes", "")'}
                onChange={e => handleUpdate({ suppress: e.target.value.trim() || undefined } as Partial<Field>)}
                className={inputClasses} />
            {warning
                ? <p className="text-[10px] text-amber-400 mt-1">{warning.message} The field prints anyway.</p>
                : <p className="text-[10px] text-gray-500 mt-1">Optional. Prints nothing while this is non-empty. <span className="font-mono">value</span> is what the field would print.</p>}
        </PropInput>
    );
};

export const FieldEditor: React.FC<{ fields: Field[]; design: Design; dispatch: React.Dispatch<any>; }> = ({ fields, design, dispatch }) => {
    const handleUpdate = useCallback((updates: Partial<Field>) => {
        dispatch({ type: 'UPDATE_MULTIPLE_FIELD_PROPERTIES', payload: { fieldIds: fields.map(f => f.id), updates } });
    }, [dispatch, fields]);
    
    const commonName = getCommonValue(fields, 'name');
    const commonX = getCommonValue(fields, 'x');
    const commonY = getCommonValue(fields, 'y');
    const commonRotation = getCommonValue(fields, 'rotation');

    const nameEditor = usePropEditor(commonName, (val: string) => handleUpdate({ name: val } as Partial<Field>));
    const xEditor = usePropEditor(commonX, (val: number) => handleUpdate({ x: val } as Partial<Field>));
    const yEditor = usePropEditor(commonY, (val: number) => handleUpdate({ y: val } as Partial<Field>));
    
    const commonType = getCommonValue(fields, 'type');

    return (
        <div className="grid grid-cols-2 gap-3">
            <PropInput label="Name" fullWidth><input type="text" value={nameEditor.localValue} placeholder={commonName === 'multiple' ? 'Multiple Values' : ''} onChange={e => nameEditor.handleChange(e.target.value, pString)} onFocus={nameEditor.handleFocus} onBlur={() => nameEditor.handleBlur(pString)} onKeyDown={nameEditor.handleKeyDown} className={inputClasses}/></PropInput>
            <PropInput label="X (mm)"><input type="number" step="0.1" value={xEditor.localValue} placeholder={commonX === 'multiple' ? 'Multiple' : ''} onChange={e => xEditor.handleChange(e.target.value, pFloat, vOrKeep)} onFocus={xEditor.handleFocus} onBlur={() => xEditor.handleBlur(pFloat, vOrKeep)} onKeyDown={xEditor.handleKeyDown} className={inputClasses}/></PropInput>
            <PropInput label="Y (mm)"><input type="number" step="0.1" value={yEditor.localValue} placeholder={commonY === 'multiple' ? 'Multiple' : ''} onChange={e => yEditor.handleChange(e.target.value, pFloat, vOrKeep)} onFocus={yEditor.handleFocus} onBlur={() => yEditor.handleBlur(pFloat, vOrKeep)} onKeyDown={yEditor.handleKeyDown} className={inputClasses}/></PropInput>
            <SuppressEditor fields={fields} dataSources={design.dataSources} handleUpdate={handleUpdate} />
            <PropInput label="Rotation" fullWidth>
                <select value={commonRotation === 'multiple' ? '' : commonRotation} onChange={e => handleUpdate({ rotation: parseInt(e.target.value) as Field['rotation'] } as Partial<Field>)} className={inputClasses}>
                    {commonRotation === 'multiple' && <option value="" disabled>Multiple Values</option>}
                    <option value="0">0°</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option>
                </select>
            </PropInput>
            
            {commonType !== 'multiple' && commonType === 'text' && <TextFieldEditor fields={fields as TextField[]} design={design} handleUpdate={handleUpdate} />}
            {commonType !== 'multiple' && commonType === 'barcode' && <BarcodeFieldEditor fields={fields as BarcodeField[]} design={design} handleUpdate={handleUpdate} />}
            {commonType !== 'multiple' && commonType === 'line' && <LineFieldEditor fields={fields as LineField[]} handleUpdate={handleUpdate} />}
            {commonType !== 'multiple' && commonType === 'box' && <BoxFieldEditor fields={fields as BoxField[]} handleUpdate={handleUpdate} />}
            {commonType !== 'multiple' && (commonType === 'ellipse' || commonType === 'polygon' || commonType === 'triangle') && <ShapeFieldEditor fields={fields as (EllipseField | PolygonField | TriangleField)[]} handleUpdate={handleUpdate} />}
            {commonType !== 'multiple' && commonType === 'image' && <ImageFieldEditor fields={fields as ImageField[]} handleUpdate={handleUpdate} />}
            {commonType === 'multiple' && <div className="col-span-2 text-center text-xs text-gray-400 p-4 border-t border-gray-700 mt-2">Select items of the same type to edit more properties.</div>}
        </div>
    );
};
