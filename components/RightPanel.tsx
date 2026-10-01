import React, { useState, useEffect, useRef, useMemo } from 'react';
import type { Design, Field, DataSource, PrinterLanguage } from '../types';
import { FieldEditor } from './FieldEditor';
import { CodePanel } from './CodePanel';
import { PRINTER_MODELS, UNPRINTABLE_MARGIN_MM } from '../constants';
import { generateIPL, fontSubstitutions, suppressionWarnings, type FontSubstitution } from '../services/iplGenerator';
import { designerOnlyWarnings } from '../services/designerOnly';
import { generateZPL } from '../services/zpl/zplGenerator';
import { generateEPL } from '../services/epl/eplGenerator';
import { generateTSPL } from '../services/tspl/tsplGenerator';
import { generateDPL } from '../services/dpl/dplGenerator';
import { parseCsv, exportableVariableFields, planCsvJob, MAX_JOB_ROWS, decodeCsvText, MAX_CSV_FILE_BYTES } from '../services/csvJob';
import { CsvRowPreview } from './CsvRowPreview';
import { sendIplViaBridge } from '../services/bridgeSend';
import { getPrinterTarget } from '../services/printerTarget';
import { sanitizeBaseName } from '../services/zipStore';
import { newCounter, newTable, newVariable, linkedFieldIds, nextSourceName, parseClampedInt } from '../services/dataSources';
import { planDesignTableJob, applyQuery, applyTransform, applyLinkedTransforms } from '../services/tableSource';
import { readWorkbook, sheetToTable } from '../services/xlsxImport';
import type { WorkbookSheet } from '../services/xlsxImport';
import type { TableDataSource, DataQuery } from '../types';
import { requestConfirm, notify } from '../services/uiDialogs';
import { listSharedSources, saveSharedSource, importSharedSource, deleteSharedSource } from '../services/libraryStore';
import { getDbServerUrl, setDbServerUrl, pingDbServer, listSavedQueries, runSavedQuery, type SavedQuerySummary } from '../services/dbSource';
import type { SourceSummary } from '../services/libraryStore';

const PropInput: React.FC<{ label: string; children: React.ReactNode; fullWidth?: boolean }> = ({ label, children, fullWidth }) => (
    <div className={fullWidth ? 'col-span-2' : ''}>
        <label className="block text-xs font-medium text-gray-400 mb-1">{label}</label>
        {children}
    </div>
);

const inputClasses = "w-full p-1.5 text-sm border border-gray-600 bg-gray-700 rounded-md focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-none";

const CM_PER_MM = 0.1;
const IN_PER_MM = 1 / 25.4;

const convertFromMm = (value: number, unit: 'mm' | 'cm' | 'in'): number => {
    if (unit === 'cm') return value * CM_PER_MM;
    if (unit === 'in') return value * IN_PER_MM;
    return value;
};

const convertToMm = (value: number, unit: 'mm' | 'cm' | 'in'): number => {
    if (unit === 'cm') return value / CM_PER_MM;
    if (unit === 'in') return value / IN_PER_MM;
    return value;
};


const LabelSettingsEditor: React.FC<{ settings: Design['labelSettings']; dispatch: React.Dispatch<any>; }> = ({ settings, dispatch }) => {

    const [width, setWidth] = useState(convertFromMm(settings.width, settings.unit).toFixed(2));
    const [height, setHeight] = useState(convertFromMm(settings.height, settings.unit).toFixed(2));
    const [cols, setCols] = useState((settings.columns || 1).toString());
    const [rows, setRows] = useState((settings.rows || 1).toString());
    // A panel switch unmounts these inputs, and React fires no blur on
    // unmount — so a blur-only commit loses whatever was typed. Track which
    // field has focus so the sync effect below cannot clobber a live edit.
    const focusedRef = useRef<string | null>(null);

    useEffect(() => {
        if (focusedRef.current !== 'width') setWidth(convertFromMm(settings.width, settings.unit).toFixed(2));
        if (focusedRef.current !== 'height') setHeight(convertFromMm(settings.height, settings.unit).toFixed(2));
        if (focusedRef.current !== 'columns') setCols((settings.columns || 1).toString());
        if (focusedRef.current !== 'rows') setRows((settings.rows || 1).toString());
    }, [settings]);

    const markFocused = (id: string) => () => { focusedRef.current = id; };
    const markBlurred = () => { focusedRef.current = null; };

    const handleUpdate = (updates: Partial<Design['labelSettings']>) => {
        dispatch({ type: 'UPDATE_SETTING', payload: { settingType: 'labelSettings', updates } });
    };
    
    const handleUnitChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        handleUpdate({ unit: e.target.value as 'mm' | 'cm' | 'in' });
    };

    const handleDimensionBlur = (
        localValue: string,
        propName: 'width' | 'height'
    ) => {
        let numValue = parseFloat(localValue);
        const fallback = settings[propName];
        if (isNaN(numValue) || numValue < 0.1) {
            numValue = convertFromMm(fallback, settings.unit);
        }

        const valueInMm = convertToMm(numValue, settings.unit);

        if (valueInMm !== settings[propName]) {
            handleUpdate({ [propName]: valueInMm });
        } else {
            if (propName === 'width') setWidth(numValue.toFixed(2));
            if (propName === 'height') setHeight(numValue.toFixed(2));
        }
    };

    // Commit while typing, not on blur: switching tabs unmounts these inputs
    // and React fires no blur then, so a blur-only commit loses the edit. An
    // incomplete entry (empty, or the "1" of "150") is left to blur to
    // normalize, never written to the design mid-keystroke.
    const handleDimensionChange = (e: React.ChangeEvent<HTMLInputElement>, propName: 'width' | 'height') => {
        const raw = e.target.value;
        if (propName === 'width') setWidth(raw); else setHeight(raw);
        const n = parseFloat(raw);
        if (raw.trim() === '' || isNaN(n) || n < 0.1) return;
        const valueInMm = convertToMm(n, settings.unit);
        if (valueInMm !== settings[propName]) handleUpdate({ [propName]: valueInMm });
    };

    const handleOrientationChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        handleUpdate({ orientation: e.target.value as 'portrait' | 'landscape' });
    };

    const handleGridBlur = (
        localValue: string,
        propName: 'columns' | 'rows'
    ) => {
         let numValue = parseInt(localValue);
         const fallback = settings[propName] || 1;
         if (isNaN(numValue) || numValue < 1) {
            numValue = fallback;
         }
         if (numValue !== fallback) {
             handleUpdate({ [propName]: numValue });
         } else {
             if (propName === 'columns') setCols(numValue.toString());
             if (propName === 'rows') setRows(numValue.toString());
         }
    };

    const handleGridChange = (e: React.ChangeEvent<HTMLInputElement>, propName: 'columns' | 'rows') => {
        const raw = e.target.value;
        if (propName === 'columns') setCols(raw); else setRows(raw);
        const n = parseInt(raw);
        if (raw.trim() === '' || isNaN(n) || n < 1) return;
        if (n !== (settings[propName] || 1)) handleUpdate({ [propName]: n });
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') e.currentTarget.blur();
    };

    return (
        <div className="grid grid-cols-2 gap-3">
            <PropInput label={`Width (${settings.unit})`}><input type="number" min="1" step="0.1" value={width} onChange={e => handleDimensionChange(e, 'width')} onFocus={markFocused('width')} onBlur={() => { markBlurred(); handleDimensionBlur(width, 'width'); }} onKeyDown={handleKeyDown} className={inputClasses} title="Total width of the label stock"/></PropInput>
            <PropInput label={`Height (${settings.unit})`}><input type="number" min="1" step="0.1" value={height} onChange={e => handleDimensionChange(e, 'height')} onFocus={markFocused('height')} onBlur={() => { markBlurred(); handleDimensionBlur(height, 'height'); }} onKeyDown={handleKeyDown} className={inputClasses} title="Total height of the label stock"/></PropInput>
            <PropInput label="Unit" fullWidth>
                <select value={settings.unit} onChange={handleUnitChange} className={inputClasses}>
                    <option value="mm">mm</option>
                    <option value="cm">cm</option>
                    <option value="in">in</option>
                </select>
            </PropInput>
             <PropInput label="Orientation" fullWidth>
                 <select value={settings.orientation} onChange={handleOrientationChange} className={inputClasses}>
                    <option value="portrait">Portrait</option>
                    <option value="landscape">Landscape</option>
                </select>
            </PropInput>
            <PropInput label="Grid Columns"><input type="number" min="1" value={cols} onChange={e => handleGridChange(e, 'columns')} onFocus={markFocused('columns')} onBlur={() => { markBlurred(); handleGridBlur(cols, 'columns'); }} onKeyDown={handleKeyDown} className={inputClasses} title="Number of labels horizontally across the stock"/></PropInput>
            <PropInput label="Grid Rows"><input type="number" min="1" value={rows} onChange={e => handleGridChange(e, 'rows')} onFocus={markFocused('rows')} onBlur={() => { markBlurred(); handleGridBlur(rows, 'rows'); }} onKeyDown={handleKeyDown} className={inputClasses} title="Number of labels vertically down the stock"/></PropInput>
        </div>
    );
};

const PrinterSettingsEditor: React.FC<{ settings: Design['printerSettings']; dispatch: React.Dispatch<any>; }> = ({ settings, dispatch }) => {
    
    const [quantity, setQuantity] = useState(settings.quantity.toString());
    // See LabelSettingsEditor: this panel unmounts on a tab switch and React
    // fires no blur then, so quantity has to be committed as it is typed.
    const quantityFocusedRef = useRef(false);

    useEffect(() => {
        if (!quantityFocusedRef.current) setQuantity(settings.quantity.toString());
    }, [settings.quantity]);

    useEffect(() => {
        if (!Object.keys(PRINTER_MODELS).includes(settings.model)) {
            const defaultModel = Object.keys(PRINTER_MODELS)[0] as keyof typeof PRINTER_MODELS;
            const availableDPIs = PRINTER_MODELS[defaultModel];
            const newDpi = availableDPIs.includes(settings.dpi) ? settings.dpi : availableDPIs[0];
            dispatch({ 
                type: 'UPDATE_SETTING', 
                payload: { 
                    settingType: 'printerSettings', 
                    updates: { model: defaultModel, dpi: newDpi } 
                } 
            });
        }
    }, [settings.model, settings.dpi, dispatch]);
    
    const handleUpdate = (updates: Partial<Design['printerSettings']>) => {
        dispatch({ type: 'UPDATE_SETTING', payload: { settingType: 'printerSettings', updates } });
    };

    const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const model = e.target.value;
        const availableDPIs = PRINTER_MODELS[model] ?? PRINTER_MODELS['Generic'];
        const dpi = availableDPIs.includes(settings.dpi) ? settings.dpi : availableDPIs[0];
        handleUpdate({ model, dpi });
    };

    const handleQuantityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const raw = e.target.value;
        setQuantity(raw);
        const n = parseInt(raw);
        if (raw.trim() === '' || isNaN(n) || n < 1) return;
        if (n !== settings.quantity) handleUpdate({ quantity: n });
    };

    const handleQuantityBlur = () => {
        quantityFocusedRef.current = false;
        let numValue = parseInt(quantity);
        if (isNaN(numValue) || numValue < 1) {
            numValue = settings.quantity || 1;
        }
        setQuantity(numValue.toString());
        if (numValue !== settings.quantity) {
            handleUpdate({ quantity: numValue });
        }
    };
    
    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') e.currentTarget.blur();
    };


    return (
        <div className="grid grid-cols-2 gap-3">
            <PropInput label="Printer Language" fullWidth>
                <select value={settings.language ?? 'ipl'} aria-label="Printer language"
                    onChange={e => handleUpdate({ language: e.target.value as PrinterLanguage })}
                    className={inputClasses} title="Language the Code panel and the download button emit. The canvas does not change.">
                    <option value="ipl">IPL (Honeywell)</option>
                    <option value="zpl">ZPL (Zebra)</option>
                    <option value="epl">EPL (Eltron/Zebra desktop)</option>
                    <option value="tspl">TSPL (TSC)</option>
                </select>
            </PropInput>
            <PropInput label="Printer Model" fullWidth>
                <select value={settings.model} onChange={handleModelChange} className={inputClasses} title="Select target printer model">
                    {Object.keys(PRINTER_MODELS).map(model => <option key={model} value={model}>{model}</option>)}
                </select>
            </PropInput>
            <PropInput label="DPI">
                 <select value={String(settings.dpi)} onChange={e => handleUpdate({ dpi: parseInt(e.target.value) as Design['printerSettings']['dpi'] })} className={inputClasses} title="Printer resolution in Dots Per Inch">
                    {(PRINTER_MODELS[settings.model as keyof typeof PRINTER_MODELS] || []).map(dpi => <option key={dpi} value={String(dpi)}>{dpi}</option>)}
                </select>
            </PropInput>
            <PropInput label="Quantity">
                <input type="number" min="1" value={quantity} onChange={handleQuantityChange} onFocus={() => { quantityFocusedRef.current = true; }} onKeyDown={handleKeyDown} onBlur={handleQuantityBlur} className={inputClasses} title="Number of copies to print"/>
            </PropInput>
            <PropInput label="Media Type" fullWidth>
                <select value={settings.mediaType} onChange={e => handleUpdate({ mediaType: e.target.value as Design['printerSettings']['mediaType'] })} className={inputClasses} title="Type of label media being used">
                    <option value="thermal-transfer">Thermal Transfer (Ribbon)</option>
                    <option value="direct-thermal">Direct Thermal</option>
                </select>
            </PropInput>
            <PropInput label="Media Sensing" fullWidth>
                <select value={settings.mediaSenseMode} onChange={e => handleUpdate({ mediaSenseMode: e.target.value as Design['printerSettings']['mediaSenseMode'] })} className={inputClasses} title="How the printer detects the start of a new label">
                    <option value="gap">Gap (Labels with Gaps)</option>
                    <option value="reflective">Reflective (Black Mark)</option>
                    <option value="continuous">Continuous (No Gaps)</option>
                </select>
            </PropInput>
            <PropInput label="Print Speed">
                 <select value={String(settings.printSpeed)} onChange={e => handleUpdate({ printSpeed: parseInt(e.target.value) })} className={inputClasses} title="Printer speed setting">
                    {[...Array(11).keys()].map(i => <option key={i+1} value={String(i+1)}>{i+1}</option>)}
                </select>
            </PropInput>
            <PropInput label="Darkness (Heat)">
                 <select value={String(settings.darkness)} onChange={e => handleUpdate({ darkness: parseInt(e.target.value) })} className={inputClasses} title="Printer darkness/heat setting">
                    {[...Array(20).keys()].map(i => <option key={i} value={String(i)}>{i}</option>)}
                </select>
            </PropInput>
            <PropInput label="Image Graphics" fullWidth>
                <select value={settings.directGraphics ? 'g1' : 'stored'} onChange={e => handleUpdate({ directGraphics: e.target.value === 'g1' })} className={inputClasses} title="How image fields are written into the IPL stream">
                    <option value="stored">Stored graphic (G/U, compact)</option>
                    <option value="g1">Direct Graphics (ASCII hex, paste-safe)</option>
                </select>
            </PropInput>
            {(UNPRINTABLE_MARGIN_MM[settings.model] ?? 0) > 0 && (
                <p className="col-span-2 text-xs text-orange-300/80" title="From the printer driver's own model table (Stock.UnprintableWidth), not an estimate. It covers the two edges across the print head; the leading and trailing edges are not inset.">
                    Unprintable margin: {UNPRINTABLE_MARGIN_MM[settings.model]} mm per edge — shown as the dashed orange guide on the canvas.
                </p>
            )}
        </div>
    );
};

/**
 * Data tab: manage the variables and counters that "Linked to Variable"
 * fields draw their print data from (the generator embeds them in the print
 * block; the canvas previews them). All list edits go through
 * services/dataSources.ts so the logic is unit-tested without React.
 */
const DataSourcePanel: React.FC<{
    design: Design;
    dispatch: React.Dispatch<any>;
    jobCsv: string;
    setJobCsv: (v: string) => void;
}> = ({ design, dispatch, jobCsv, setJobCsv }) => {
    const dataSources = design.dataSources;
    const fields = design.fields;
    // The reducer owns the list math (upsert/remove on the freshest state) —
    // computing next-lists from props here would lose rapid successive edits.
    const addSource = (source: DataSource) => dispatch({ type: 'ADD_DATA_SOURCE', payload: { source } });
    const updateSource = (source: DataSource) => dispatch({ type: 'UPDATE_DATA_SOURCE', payload: { source } });

    const handleAddVariable = () => addSource(newVariable(nextSourceName('Variable', dataSources)));
    const handleAddCounter = () => addSource(newCounter(nextSourceName('Counter', dataSources)));
    const handleAddTable = () => addSource(newTable(nextSourceName('Table', dataSources)));

    // Fase 7: rows pulled straight from a database. The address is read from
    // storage on render so the button's disabled state follows it.
    const [dbOpen, setDbOpen] = useState(false);
    const [dbServer, setDbServer] = useState(() => getDbServerUrl());

    // The shared library is read on demand, not watched: it only changes when
    // this panel writes to it, and each write bumps `sharedTick` to re-read.
    const [shared, setShared] = useState<SourceSummary[] | null>(null);
    const [sharedTick, setSharedTick] = useState(0);
    const [sharedOpen, setSharedOpen] = useState(false);
    useEffect(() => {
        if (!sharedOpen) return;
        let alive = true;
        listSharedSources().then(list => { if (alive) setShared(list); }).catch(() => { if (alive) setShared([]); });
        return () => { alive = false; };
    }, [sharedOpen, sharedTick]);

    const handleSaveShared = async (source: DataSource) => {
        try {
            await saveSharedSource(source.name, source);
            setSharedOpen(true);
            setSharedTick(t => t + 1);
            notify(`"${source.name}" saved to the shared library.`, 'info');
        } catch (e) {
            notify(`Could not save: ${e instanceof Error ? e.message : String(e)}`);
        }
    };

    const handleImportShared = async (name: string) => {
        // The id has to be fresh: a copy that kept the stored id would collide
        // with a source this design already holds.
        const copy = await importSharedSource(name, `imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
        if (!copy) { notify(`"${name}" is no longer in the library.`); setSharedTick(t => t + 1); return; }
        copy.name = nextSourceName(copy.name, dataSources);
        addSource(copy);
    };

    const handleDelete = async (source: DataSource) => {
        const linked = linkedFieldIds(fields, source.id);
        const names = fields.filter(f => linked.includes(f.id)).map(f => f.name).join(', ');
        const msg = linked.length > 0
            ? `"${source.name}" is linked by ${linked.length} field(s) (${names}). Delete anyway? Those fields become plain variable fields with empty data.`
            : `Delete "${source.name}"?`;
        if (await requestConfirm({ title: 'Delete data source', message: msg, confirmLabel: 'Delete' })) dispatch({ type: 'DELETE_DATA_SOURCE', payload: { id: source.id } });
    };

    return (
        <div>
            <h3 className="text-sm font-bold uppercase text-gray-400 mb-2">Data Sources</h3>
            <p className="text-xs text-gray-500 mb-3">Variables and counters for linked data fields.</p>
            <div className="flex gap-2 mb-3">
                <button onClick={handleAddVariable} className="flex-1 px-2 py-1 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-md" title="Add a variable data source">+ Variable</button>
                <button onClick={handleAddCounter} className="flex-1 px-2 py-1 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-md" title="Add a counter data source">+ Counter</button>
                <button onClick={handleAddTable} className="flex-1 px-2 py-1 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-md" title="Add a table of rows stored in the design">+ Table</button>
            </div>
            {dbServer === '' ? (
                <DatabaseServerRow value={dbServer} onApplied={clean => setDbServer(clean)} />
            ) : (
                <div className="flex items-center gap-1.5 mb-3">
                    <button onClick={() => setDbOpen(true)}
                        className="flex-1 px-2 py-1 text-xs font-semibold bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-md flex items-center justify-center gap-1"
                        title={`Load rows by running a query saved on ${dbServer}`}>
                        <span className="material-icons text-sm">storage</span>From database…
                    </button>
                    <button onClick={() => { setDbOpen(false); setDbServer(''); setDbServerUrl(''); }}
                        className="px-1.5 py-1 text-[10px] text-gray-500 hover:text-gray-300" title="Stop using a database server">✕</button>
                </div>
            )}
            {dbOpen && dbServer !== '' && (
                <DatabaseQueryPicker
                    server={dbServer}
                    sources={dataSources}
                    onClose={() => setDbOpen(false)}
                    onLoaded={source => { addSource(source); setDbOpen(false); }}
                />
            )}
            {dataSources.length === 0 && (
                <p className="text-xs text-gray-600 italic">None yet — add one above, then set a field's Data Source to "Linked to Variable".</p>
            )}
            <div className="space-y-3">
                {dataSources.map(source => (
                    <DataSourceRow key={source.id} source={source} fieldCount={linkedFieldIds(fields, source.id).length} onChange={s => updateSource(s)} onDelete={() => handleDelete(source)} onSaveShared={() => handleSaveShared(source)} />
                ))}
            </div>
            <SharedLibrary shared={shared} onOpen={() => setSharedOpen(true)} onImport={handleImportShared} onDelete={async name => { await deleteSharedSource(name); setSharedTick(t => t + 1); }} />
            <CsvJobExporter design={design} csv={jobCsv} setCsv={setJobCsv} />
        </div>
    );
};

/**
 * Batch G: paste a CSV (header row + data rows) and export the design as
 * one multi-label .ipl job — the generator emits one print block per row
 * with the mapped columns, the standard IPL variable-data pattern. The CSV
 * text lives in RightPanel state so it survives tab switches.
 */
const CsvJobExporter: React.FC<{ design: Design; csv: string; setCsv: (v: string) => void }> = ({ design, csv, setCsv }) => {
    const [busy, setBusy] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    // Review LOW: two rapid picks could resolve out of order; only the
    // latest read may write the textarea.
    const readSeqRef = useRef(0);
    const exportable = exportableVariableFields(design);
    // Review MEDIUM: a 4MB paste is ~100k rows and parseCsv is O(n) —
    // re-parsing on every unrelated RightPanel render would lock the
    // main thread for hundreds of ms. Memoize on the inputs that matter.
    const table = useMemo(() => parseCsv(csv), [csv]);
    const csvPlan = useMemo(() => (table.rows.length > 0 ? planCsvJob(design, table) : null), [design, table]);
    // A pasted CSV wins: it is the explicit "print THIS" and must not be silently
    // replaced by a table stored in the design. Transforms apply to it too, so a
    // field prints the same string whichever route produced the job.
    // No pasted CSV → print the design's own table sources. `empty` names a table
    // whose query matched nothing, which must be said out loud: a filter typo
    // would otherwise look exactly like "no data loaded".
    const tableJob = useMemo(() => (csv.trim() === '' ? planDesignTableJob(design) : null), [design, csv]);
    const plan = useMemo(() => {
        if (csvPlan) {
            const { batch } = applyLinkedTransforms(design, exportable, csvPlan.batch);
            return batch === csvPlan.batch ? csvPlan : { ...csvPlan, batch };
        }
        return tableJob?.plan ?? null;
    }, [design, exportable, csvPlan, tableJob]);
    const unmapped = exportable.length - (plan?.mapped ?? 0);

    // Batch H: load a CSV from disk. decodeCsvText handles Excel's
    // windows-1252 and PowerShell's UTF-16 exports; the size cap protects
    // the tab from a full database dump. The file NAME is ignored —
    // headers do the mapping.
    const readFile = async (file: File) => {
        if (file.size > MAX_CSV_FILE_BYTES) {
            notify(`"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_CSV_FILE_BYTES / 1024 / 1024} MB.`);
            return;
        }
        const seq = ++readSeqRef.current;
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            if (seq !== readSeqRef.current) return; // a newer read won
            setCsv(decodeCsvText(bytes));
        } catch (e) {
            if (seq === readSeqRef.current) notify(`Could not read "${file.name}": ${e instanceof Error ? e.message : String(e)}`);
        }
    };

    const handleDownload = async () => {
        if (!plan) return;
        if (plan.truncated && !(await requestConfirm({
            title: 'Truncate job?',
            message: `The CSV has more than ${MAX_JOB_ROWS} rows; only the first ${MAX_JOB_ROWS} will be exported. Continue?`,
            confirmLabel: 'Export',
        }))) return;
        setBusy(true);
        try {
            const ipl = await generateIPL(design, plan.batch);
            const blob = new Blob([ipl], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${sanitizeBaseName(design.name + '.ipl')}-job-${plan.batch.rows.length}.ipl`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            notify(`Job export failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setBusy(false);
        }
    };

    // Batch J: send the whole job straight to the printer through the local
    // bridge (same transport as the viewer's Send button). A physical
    // printer starts printing immediately, so it always confirms first.
    // Batch K: the target is the persisted printer target (shared with the
    // viewer — set a network printer there once, both surfaces use it).
    const handleSendJob = async () => {
        if (!plan) return;
        const target = getPrinterTarget();
        // Review MEDIUM: printing is irreversible physical media — a
        // truncated job must say so in the confirm, not just count rows.
        const truncationNotice = plan.truncated
            ? ` WARNING: the CSV exceeds ${MAX_JOB_ROWS} rows — only the first ${MAX_JOB_ROWS} will print.`
            : '';
        const proceed = await requestConfirm({
            title: 'Send job to printer?',
            message: `Sends ${plan.batch.rows.length} label(s) to ${target.host}:${target.port} via the local bridge (node tools/ipl-bridge.mjs).${truncationNotice} The printer starts immediately.`,
            confirmLabel: 'Send',
            danger: true,
        });
        if (!proceed) return;
        setBusy(true);
        try {
            const ipl = await generateIPL(design, plan.batch);
            const res = await sendIplViaBridge(ipl, { host: target.host, port: target.port });
            // Review LOW: a bridge that omits `written` must not read "undefined bytes".
            if (res.ok) notify(`Job sent: ${res.written ?? ipl.length} bytes to ${target.host}:${target.port}.`, 'info');
            else notify(res.error ?? 'Send failed.');
        } catch (e) {
            notify(`Job send failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="mt-5 pt-4 border-t border-gray-700">
            <h3 className="text-sm font-bold uppercase text-gray-400 mb-2">CSV Job Export</h3>
            <p className="text-xs text-gray-500 mb-2">
                Paste a CSV table (header + rows). Columns map to variable/linked fields by name;
                each row prints one label. {exportable.length === 0 && 'No exportable fields — add variable or linked fields first.'}
            </p>
            {exportable.length > 0 && (
                <>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".csv,text/csv"
                        className="hidden"
                        aria-hidden="true"
                        tabIndex={-1}
                        onChange={e => {
                            const f = e.target.files?.[0];
                            if (f) void readFile(f);
                            e.target.value = ''; // allow re-picking the same file
                        }}
                    />
                    <div
                        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                        onDragLeave={() => setDragOver(false)}
                        onDrop={e => {
                            e.preventDefault();
                            setDragOver(false);
                            const f = e.dataTransfer.files?.[0];
                            if (f) void readFile(f);
                        }}
                        className={dragOver ? 'ring-2 ring-blue-400 rounded-md' : ''}
                    >
                        <textarea
                            value={csv}
                            onChange={e => setCsv(e.target.value)}
                            rows={4}
                            placeholder={'Paste CSV, or click "Load CSV file" / drop a .csv here\nSKU,Desc\nA1,Widget\nB2,Gadget'}
                            className="w-full p-1.5 text-xs font-mono border border-gray-600 bg-gray-700 rounded-md focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-none"
                            aria-label="CSV data"
                        />
                    </div>
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        className="mt-1 w-full px-2 py-1 text-xs font-semibold bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-md flex items-center justify-center gap-1"
                        title="Load a .csv file (UTF-8 or Excel ANSI/windows-1252)"
                    >
                        <span className="material-icons text-sm">upload_file</span>Load CSV file
                    </button>
                    {csv.trim() === '' && tableJob && (tableJob.plan || tableJob.empty.length > 0) && (
                        <div className="text-[11px] mt-1 space-y-0.5">
                            {tableJob.plan ? (
                                <div className="text-gray-300">
                                    From the design's tables: {tableJob.plan.batch.rows.length} row{tableJob.plan.batch.rows.length === 1 ? '' : 's'} · {tableJob.plan.mapped}/{exportable.length} fields mapped
                                    {unmapped > 0 && <span className="text-amber-400"> · {unmapped} use defaults</span>}
                                    {tableJob.plan.truncated && <span className="text-amber-400"> · truncated to {MAX_JOB_ROWS}</span>}
                                </div>
                            ) : (
                                <span className="text-gray-500">The design's tables map to no field — name a field after a column, or pick the column in the field's Link.</span>
                            )}
                            {tableJob.empty.map(name => (
                                <div key={name} className="text-amber-400">"{name}" matches no rows — nothing from it will print.</div>
                            ))}
                        </div>
                    )}
                    {csv.trim() !== '' && (
                        <div className="text-[11px] mt-1 space-y-0.5">
                            {table.headers.length === 0 ? (
                                <span className="text-gray-500">Nothing parsed yet.</span>
                            ) : plan ? (
                                <>
                                    <div className="text-gray-300">
                                        {plan.batch.rows.length} row{plan.batch.rows.length === 1 ? '' : 's'} · {plan.mapped}/{exportable.length} fields mapped
                                        {unmapped > 0 && <span className="text-amber-400"> · {unmapped} use defaults</span>}
                                        {plan.truncated && <span className="text-amber-400"> · truncated to {MAX_JOB_ROWS}</span>}
                                    </div>
                                    {exportable.map(f => (
                                        <div key={f.id} className="text-gray-500">
                                            {f.name} → {plan.batch.mappings[f.id] !== undefined ? table.headers[plan.batch.mappings[f.id]] : <span className="text-amber-500">(default)</span>}
                                        </div>
                                    ))}
                                </>
                            ) : (
                                <span className="text-red-400">No header matches a field name (or source name) — nothing to map.</span>
                            )}
                        </div>
                    )}
                    {plan && <CsvRowPreview design={design} plan={plan} />}
                    <div className="mt-2 flex gap-1">
                        <button
                            onClick={handleDownload}
                            disabled={!plan || busy}
                            className="flex-1 px-2 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-md flex items-center justify-center gap-1"
                            title={plan ? `Generate one .ipl with ${plan.batch.rows.length} print blocks` : 'Paste a CSV whose headers match field names first'}
                        >
                            <span className="material-icons text-sm">download</span>{busy ? '…' : `IPL Job${plan ? ` (${plan.batch.rows.length})` : ''}`}
                        </button>
                        <button
                            onClick={handleSendJob}
                            disabled={!plan || busy}
                            className="flex-1 px-2 py-1.5 text-xs font-semibold bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-md flex items-center justify-center gap-1"
                            title={`Send ${plan ? plan.batch.rows.length : 0} label(s) to the printer via the local bridge`}
                        >
                            <span className="material-icons text-sm">print</span>{busy ? '…' : 'Send Job'}
                        </button>
                    </div>
                </>
            )}
        </div>
    );
};

/**
 * Editor for a table data source: load rows from CSV or .xlsx, then choose
 * which of them print. The query is part of the source, so it is saved with
 * the design. Only the first few rows are shown — the rest still print.
 */
const TableSourceEditor: React.FC<{
    source: TableDataSource;
    onChange: (updated: DataSource) => void;
}> = ({ source, onChange }) => {
    const fileRef = useRef<HTMLInputElement>(null);
    const [sheets, setSheets] = useState<WorkbookSheet[] | null>(null);
    const [sheet, setSheet] = useState('');
    const [headerRow, setHeaderRow] = useState('1');
    const [error, setError] = useState<string | null>(null);

    const loadCsv = async (file: File) => {
        if (file.size > MAX_CSV_FILE_BYTES) { setError(`File exceeds ${MAX_CSV_FILE_BYTES / 1024 / 1024} MB.`); return; }
        const text = decodeCsvText(new Uint8Array(await file.arrayBuffer()));
        const parsed = parseCsv(text);
        if (parsed.headers.length === 0) { setError('No header row found.'); return; }
        setError(null);
        setSheets(null);
        onChange({ ...source, columns: parsed.headers, rows: parsed.rows.map(r => {
            const rec: Record<string, string> = {};
            parsed.headers.forEach((h, i) => { rec[h] = r[i] ?? ''; });
            return rec;
        }) });
    };

    const loadXlsx = async (file: File) => {
        if (file.size > MAX_CSV_FILE_BYTES) { setError(`File exceeds ${MAX_CSV_FILE_BYTES / 1024 / 1024} MB.`); return; }
        try {
            const found = await readWorkbook(new Uint8Array(await file.arrayBuffer()));
            if (found.length === 0) { setError('Workbook has no sheets.'); return; }
            setError(null);
            setSheets(found);
            setSheet(found[0].name);
            setHeaderRow('1');
        } catch (e) {
            setError(`Could not read workbook: ${e instanceof Error ? e.message : String(e)}`);
        }
    };

    const applySheet = () => {
        if (!sheets) return;
        const table = sheetToTable(sheets, { sheet, headerRow: parseClampedInt(headerRow, 1, 1, 100000) });
        if (!table) { setError('That header row is empty or past the end of the sheet.'); return; }
        setError(null);
        onChange({ ...source, columns: table.columns, rows: table.rows });
    };

    const onFile = (file: File) => {
        const name = file.name.toLowerCase();
        if (name.endsWith('.xlsx') || name.endsWith('.xls')) void loadXlsx(file);
        else void loadCsv(file);
    };

    const setQuery = (patch: Partial<DataQuery>) => onChange({ ...source, query: { ...source.query, ...patch } });
    const shown = source.rows.slice(0, 5);

    // A hand-typed table. Columns are comma-separated so the panel stays one
    // line wide; the row editor reuses them. Both commit on change — this
    // editor unmounts when the tab switches, and a blur-only commit would lose
    // the last keystroke.
    const [draftCols, setDraftCols] = useState('');
    const [draftRow, setDraftRow] = useState<Record<string, string>>({});
    const defineColumns = () => {
        const columns = draftCols.split(',').map(c => c.trim()).filter((c, i, all) => c !== '' && all.indexOf(c) === i);
        if (columns.length === 0) { setError('Name at least one column.'); return; }
        setError(null);
        setDraftCols('');
        onChange({ ...source, columns, rows: [], query: { ...source.query, filters: [], sortColumn: undefined } });
    };
    const addRow = () => {
        if (source.columns.every(c => (draftRow[c] ?? '').trim() === '')) return;
        const rec: Record<string, string> = {};
        source.columns.forEach(c => { rec[c] = draftRow[c] ?? ''; });
        setDraftRow({});
        onChange({ ...source, rows: [...source.rows, rec] });
    };

    return (
        <div className="space-y-1.5">
            <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls,text/csv" className="hidden" aria-hidden="true" tabIndex={-1}
                onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
            <button onClick={() => fileRef.current?.click()}
                className="w-full px-2 py-1 text-xs font-semibold bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-md flex items-center justify-center gap-1"
                title="Load rows from a .csv or .xlsx file. The rows are stored in the design; the file is not.">
                <span className="material-icons text-sm">upload_file</span>Load CSV or Excel
            </button>
            {sheets && (
                <div className="flex items-end gap-1">
                    <label className="text-[10px] text-gray-500 flex-1">Sheet
                        <select value={sheet} onChange={e => setSheet(e.target.value)} className={inputClasses} aria-label="Sheet">
                            {sheets.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                        </select>
                    </label>
                    <label className="text-[10px] text-gray-500 w-16">Header row
                        <input value={headerRow} onChange={e => setHeaderRow(e.target.value)} className={inputClasses} aria-label="Header row" />
                    </label>
                    <button onClick={applySheet} className="px-2 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-md">Use</button>
                </div>
            )}
            {error && <p className="text-[10px] text-red-400">{error}</p>}
            {source.columns.length === 0 && (
                <div className="flex items-center gap-1">
                    <input value={draftCols} aria-label="Column names" placeholder="Columns, comma separated"
                        onChange={e => setDraftCols(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') defineColumns(); }}
                        className={inputClasses + ' flex-1'} />
                    <button onClick={defineColumns} className="px-2 py-1.5 text-xs font-semibold bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-md">Set</button>
                </div>
            )}
            {source.columns.length > 0 && (
                <>
                    <div className="overflow-x-auto">
                        <table className="text-[10px] font-mono text-gray-300 border-collapse">
                            <thead><tr>{source.columns.map(c => <th key={c} className="text-left font-semibold text-gray-400 pr-2 border-b border-gray-700">{c}</th>)}</tr></thead>
                            <tbody>
                                {shown.map((r, i) => <tr key={i}>{source.columns.map(c => <td key={c} className="pr-2 truncate max-w-[6rem]">{r[c] ?? ''}</td>)}</tr>)}
                            </tbody>
                        </table>
                        {source.rows.length > shown.length && <p className="text-[10px] text-gray-500">+ {source.rows.length - shown.length} more rows</p>}
                    </div>
                    <div className="flex items-center gap-1">
                        {source.columns.map(c => (
                            <input key={c} value={draftRow[c] ?? ''} aria-label={`New row ${c}`} placeholder={c}
                                onChange={e => setDraftRow(prev => ({ ...prev, [c]: e.target.value }))}
                                onKeyDown={e => { if (e.key === 'Enter') addRow(); }}
                                className={inputClasses + ' flex-1 min-w-0'} />
                        ))}
                        <button onClick={addRow} aria-label="Add row" title="Add this row"
                            className="px-2 py-1.5 text-xs font-semibold bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-md">+</button>
                    </div>
                    <QueryEditor source={source} setQuery={setQuery} />
                </>
            )}
        </div>
    );
};

/** Filter / sort / range over a table source. One clause only — the data
 *  model holds a list, but the panel is 240px wide and most label jobs
 *  filter on a single column. */
const QueryEditor: React.FC<{
    source: TableDataSource;
    setQuery: (patch: Partial<DataQuery>) => void;
}> = ({ source, setQuery }) => {
    const q = source.query;
    const clause = q.filters[0];
    const setClause = (column: string, op: DataQuery['filters'][number]['op'], value: string) =>
        setQuery({ filters: column ? [{ column, op, value }] : [] });
    // Counted here, not via planTableJob: that returns null when no field maps
    // yet, and the row count is exactly what the user is tuning the filter for.
    const matchedRows = applyQuery({ columns: source.columns, rows: source.rows }, q).rows.length;

    return (
        <div className="space-y-1 border-t border-gray-700 pt-1.5">
            <div className="flex items-center gap-1">
                <select value={clause?.column ?? ''} aria-label="Filter column"
                    onChange={e => setClause(e.target.value, clause?.op ?? 'eq', clause?.value ?? '')}
                    className={inputClasses + ' flex-1'}>
                    <option value="">No filter</option>
                    {source.columns.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <select value={clause?.op ?? 'eq'} aria-label="Filter operator" disabled={!clause}
                    onChange={e => clause && setClause(clause.column, e.target.value as DataQuery['filters'][number]['op'], clause.value)}
                    className={inputClasses + ' w-24'}>
                    <option value="eq">equals</option>
                    <option value="neq">not equal</option>
                    <option value="empty">is empty</option>
                    <option value="notEmpty">has value</option>
                </select>
            </div>
            {clause && clause.op !== 'empty' && clause.op !== 'notEmpty' && (
                <input value={clause.value} aria-label="Filter value" placeholder="value"
                    onChange={e => setClause(clause.column, clause.op, e.target.value)}
                    className={inputClasses} />
            )}
            <div className="flex items-center gap-1">
                <select value={q.sortColumn ?? ''} aria-label="Sort column"
                    onChange={e => setQuery({ sortColumn: e.target.value || undefined })}
                    className={inputClasses + ' flex-1'}>
                    <option value="">No sorting</option>
                    {source.columns.map(c => <option key={c} value={c}>Sort by {c}</option>)}
                </select>
                <select value={q.sortDir ?? 'asc'} aria-label="Sort direction" disabled={!q.sortColumn}
                    onChange={e => setQuery({ sortDir: e.target.value as 'asc' | 'desc' })}
                    className={inputClasses + ' w-20'}>
                    <option value="asc">A → Z</option>
                    <option value="desc">Z → A</option>
                </select>
            </div>
            <div className="flex items-center gap-1 text-[10px] text-gray-500">
                <span>Rows</span>
                <input value={q.fromRow ?? ''} aria-label="From row" placeholder="1"
                    onChange={e => setQuery({ fromRow: e.target.value.trim() === '' ? undefined : parseClampedInt(e.target.value, 1, 1, 1000000) })}
                    className={inputClasses + ' w-14'} />
                <span>to</span>
                <input value={q.toRow ?? ''} aria-label="To row" placeholder="end"
                    onChange={e => setQuery({ toRow: e.target.value.trim() === '' ? undefined : parseClampedInt(e.target.value, 1, 1, 1000000) })}
                    className={inputClasses + ' w-14'} />
                <span className={matchedRows === 0 ? 'text-amber-400' : 'text-gray-400'}>{matchedRows} match{matchedRows === 1 ? '' : 'es'}</span>
            </div>
        </div>
    );
};

/**
 * Where the database server lives, asked once. Shown only while no address is
 * set, so a station that never uses a database never sees it.
 */
const DatabaseServerRow: React.FC<{ value: string; onApplied: (clean: string) => void }> = ({ value, onApplied }) => {
    const [draft, setDraft] = useState(value);
    const [state, setState] = useState<{ text: string; ok: boolean } | null>(null);

    const apply = async () => {
        let clean = '';
        try {
            clean = setDbServerUrl(draft);
        } catch (e) {
            setState({ text: e instanceof Error ? e.message : String(e), ok: false });
            return;
        }
        if (clean === '') { onApplied(''); setState(null); return; }
        const up = await pingDbServer(clean);
        onApplied(clean);
        setState(up
            ? { text: `Connected to ${clean}.`, ok: true }
            : { text: `Saved, but no answer from ${clean}. Start it with: node tools/db-server.mjs`, ok: false });
    };

    return (
        <div className="mb-3">
            <div className="flex items-center gap-1.5">
                <span className="material-icons text-gray-400 text-base" title="Import rows from a database">storage</span>
                <input
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    placeholder="Database server, e.g. http://192.168.1.10:9184"
                    aria-label="Database server"
                    className="flex-1 text-xs p-1.5 bg-gray-900 border border-gray-600 rounded-md outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
                <button onClick={() => void apply()} className="px-2 py-1.5 text-xs rounded-md bg-gray-700 hover:bg-gray-600 text-white">Use</button>
            </div>
            {state && <p className={`mt-1 text-[10px] ${state.ok ? 'text-emerald-400' : 'text-amber-400'}`}>{state.text}</p>}
        </div>
    );
};

/**
 * Pick a query saved on the database server and turn its rows into a table
 * source.
 *
 * The address is the server's, and so is the SQL: this picks a NAME. The
 * connection string never reaches the browser, and neither does the query
 * text — which is the shape the plan asked for, and why a bug here cannot
 * become a dropped table.
 */
const DatabaseQueryPicker: React.FC<{
    server: string;
    sources: DataSource[];
    onClose: () => void;
    onLoaded: (source: TableDataSource) => void;
}> = ({ server, sources, onClose, onLoaded }) => {
    const [queries, setQueries] = useState<SavedQuerySummary[] | null>(null);
    const [failed, setFailed] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        listSavedQueries(server)
            .then(list => { if (alive) setQueries(list); })
            .catch(e => { if (alive) setFailed(e instanceof Error ? e.message : String(e)); });
        return () => { alive = false; };
    }, [server]);

    const load = async (query: SavedQuerySummary) => {
        setBusyId(query.id);
        setError(null);
        try {
            const result = await runSavedQuery(query.id, server);
            if (result.columns.length === 0) {
                setError(`"${query.name}" returned no columns — check the query on the server.`);
                return;
            }
            // The same upfront confirm the CSV importer uses: past the cap the
            // job would print a subset, and saying so before it happens is the
            // difference between a surprise and a decision.
            if (result.truncated) {
                const proceed = await requestConfirm({
                    title: 'More rows than a job prints',
                    message: `"${query.name}" returned more than ${MAX_JOB_ROWS} rows; only the first ${MAX_JOB_ROWS} are kept, and the rest will not print. Continue?`,
                    confirmLabel: 'Import rows',
                });
                if (!proceed) return;
            }
            onLoaded({
                ...newTable(nextSourceName(query.name, sources)),
                columns: result.columns,
                rows: result.rows,
            });
            notify(`"${query.name}" — ${result.rowCount} row(s) loaded.`, 'info');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusyId(null);
        }
    };

    return (
        <div className="mb-3 rounded-md border border-gray-700 bg-gray-900/60 p-2">
            <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] uppercase font-bold text-gray-500">Run a saved query</span>
                <button onClick={onClose} className="text-[10px] text-gray-500 hover:text-gray-300">close</button>
            </div>
            {failed && <p className="text-[11px] text-amber-400">{failed}</p>}
            {queries === null && !failed && <p className="text-[11px] text-gray-500">Loading…</p>}
            {queries !== null && queries.length === 0 && (
                <p className="text-[11px] text-gray-500">
                    No queries saved on {server}. Add one with <code className="text-gray-400">PUT /queries/&lt;id&gt;</code>, or drop a JSON file in its queries folder.
                </p>
            )}
            <div className="space-y-1">
                {(queries ?? []).map(q => (
                    <div key={q.id} className="flex items-center gap-1.5">
                        <span className="flex-1 text-xs text-gray-300 truncate" title={`${q.provider}${q.database ? ` · ${q.database}` : ''}${q.description ? ` — ${q.description}` : ''}`}>{q.name}</span>
                        <button onClick={() => void load(q)} disabled={busyId !== null}
                            className="px-1.5 py-0.5 text-[10px] font-semibold bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 text-white rounded">
                            {busyId === q.id ? 'Running…' : 'Run'}
                        </button>
                    </div>
                ))}
            </div>
            {/* Rows are stored in the design, so printing later needs no
                database. Pulling again is an explicit choice. */}
            <p className="mt-1.5 text-[10px] text-gray-500">The rows are stored in the design — printing a saved design does not need the database.</p>
            {error && <p className="mt-1 text-[11px] text-red-400">{error}</p>}
        </div>
    );
};

/**
 * Sources saved for reuse in other designs. Collapsed until opened — the list
 * is a network read on first open, and most sessions never need it.
 */
const SharedLibrary: React.FC<{
    shared: SourceSummary[] | null;
    onOpen: () => void;
    onImport: (name: string) => void;
    onDelete: (name: string) => void;
}> = ({ shared, onOpen, onImport, onDelete }) => (
    <div className="mt-3 pt-3 border-t border-gray-700">
        {shared === null ? (
            <button onClick={onOpen} className="w-full px-2 py-1 text-xs font-semibold bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-md">Shared library…</button>
        ) : shared.length === 0 ? (
            <p className="text-[10px] text-gray-500">Nothing saved for reuse yet. Use the bookmark on a data source to add one.</p>
        ) : (
            <div className="space-y-1">
                <p className="text-[10px] uppercase font-bold text-gray-500">Shared library</p>
                {shared.map(s => (
                    <div key={s.name} className="flex items-center gap-1 text-xs">
                        <span className="text-gray-300 truncate flex-1" title={`${s.type}: ${s.detail}`}>{s.name}</span>
                        <span className="text-[10px] text-gray-500">{s.detail}</span>
                        <button onClick={() => onImport(s.name)} className="px-1.5 py-0.5 text-[10px] font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded" title="Add a copy to this design">Use</button>
                        <button onClick={() => onDelete(s.name)} aria-label={`Remove ${s.name} from the library`} className="px-1 text-[10px] text-red-400 hover:text-red-300">✕</button>
                    </div>
                ))}
            </div>
        )}
    </div>
);

const DataSourceRow: React.FC<{
    source: DataSource;
    fieldCount: number;
    onChange: (updated: DataSource) => void;
    onDelete: () => void;
    onSaveShared: () => void;
}> = ({ source, fieldCount, onChange, onDelete, onSaveShared }) => {
    // Local text mirrors so typing doesn't dispatch per keystroke (each commit
    // is one undo step). The prop→mirror resync skips whichever input is
    // focused: committing field A re-renders with a new `source` object, and
    // resyncing field B mid-keystroke would wipe what the user just typed.
    const [name, setName] = useState(source.name);
    const [sample, setSample] = useState(source.type === 'variable' ? source.sampleData : '');
    const [start, setStart] = useState(source.type === 'counter' ? String(source.start) : '');
    const [step, setStep] = useState(source.type === 'counter' ? String(source.step) : '');
    const [padding, setPadding] = useState(source.type === 'counter' ? String(source.padding) : '');
    const focusedRef = useRef<string | null>(null);
    // One factory owns BOTH handlers — a later onBlur={...} prop would
    // silently override a spread onBlur and leave focusedRef stuck.
    const focusHandlers = (id: string, commit: () => void) => ({
        onFocus: () => { focusedRef.current = id; },
        onBlur: () => { focusedRef.current = null; commit(); },
    });
    useEffect(() => {
        if (focusedRef.current !== 'name') setName(source.name);
        if (focusedRef.current !== 'sample' && source.type === 'variable') setSample(source.sampleData);
        if (source.type === 'counter') {
            if (focusedRef.current !== 'start') setStart(String(source.start));
            if (focusedRef.current !== 'step') setStep(String(source.step));
            if (focusedRef.current !== 'padding') setPadding(String(source.padding));
        }
    }, [source]);

    const commitName = () => {
        const trimmed = name.trim();
        if (!trimmed || trimmed === source.name) { setName(source.name); return; }
        onChange({ ...source, name: trimmed });
    };
    const commitSample = () => {
        if (source.type !== 'variable') return;
        if (sample === source.sampleData) return;
        onChange({ ...source, sampleData: sample });
    };
    // parseClampedInt treats empty/NaN as "keep current" but accepts 0 — the
    // old `Number(x) || fallback` idiom silently rejected start=0.
    const commitCounter = () => {
        if (source.type !== 'counter') return;
        const next: DataSource = {
            ...source,
            start: parseClampedInt(start, source.start, 0, 99999999),
            step: parseClampedInt(step, source.step, -9999, 9999),
            padding: parseClampedInt(padding, source.padding, 1, 16),
        };
        setStart(String(next.start)); setStep(String(next.step)); setPadding(String(next.padding));
        if (JSON.stringify(next) !== JSON.stringify(source)) onChange(next);
    };
    const toggleSerial = () => {
        if (source.type !== 'counter') return;
        onChange({ ...source, serial: !source.serial });
    };
    const enterToCommit = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') e.currentTarget.blur(); // blur fires the commit
    };

    const preview = source.type === 'variable'
        ? (source.sampleData || '(empty)')
        : source.type === 'counter'
            ? String(source.start).padStart(source.padding, '0')
            : (() => {
                const matched = applyQuery({ columns: source.columns, rows: source.rows }, source.query).rows.length;
                return matched === source.rows.length
                    ? `${source.rows.length} row${source.rows.length === 1 ? '' : 's'}`
                    : `${matched} of ${source.rows.length} rows`;
            })();
    const startOverflows = source.type === 'counter'
        && String(source.start).length > source.padding;

    return (
        <div className="border border-gray-700 rounded-md p-2 bg-gray-900/40">
            <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-gray-700 text-gray-300" title={source.id}>{source.type}</span>
                <input value={name} onChange={e => setName(e.target.value)} {...focusHandlers('name', commitName)} onKeyDown={enterToCommit}
                    className={inputClasses + ' flex-1'} placeholder="Name" aria-label="Data source name" />
                <button onClick={onSaveShared} className="px-1 py-0.5 text-gray-400 hover:text-blue-300" title="Save a copy to the shared library, so other designs can reuse it" aria-label={`Share ${source.name}`}>
                    <span className="material-icons text-sm">bookmark_add</span>
                </button>
                <button onClick={onDelete} className="px-1.5 py-0.5 text-xs text-red-400 hover:text-red-300 border border-red-900 rounded hover:bg-red-900/30" title="Delete this data source" aria-label={`Delete ${source.name}`}>✕</button>
            </div>
            {source.type === 'variable' ? (
                <div className="flex items-center gap-2">
                    <label className="text-[10px] text-gray-500 w-14">Sample</label>
                    <input value={sample} onChange={e => setSample(e.target.value)} {...focusHandlers('sample', commitSample)} onKeyDown={enterToCommit}
                        className={inputClasses + ' flex-1'} placeholder="sample value" aria-label="Sample data" />
                </div>
            ) : source.type === 'table' ? (
                <TableSourceEditor source={source} onChange={onChange} />
            ) : (
                <>
                    <div className="grid grid-cols-3 gap-2">
                        <label className="text-[10px] text-gray-500">Start
                            <input type="number" min={0} max={99999999} value={start} onChange={e => setStart(e.target.value)} {...focusHandlers('start', commitCounter)} onKeyDown={enterToCommit} className={inputClasses} aria-label="Counter start" /></label>
                        <label className="text-[10px] text-gray-500">Step
                            <input type="number" min={-9999} max={9999} value={step} onChange={e => setStep(e.target.value)} {...focusHandlers('step', commitCounter)} onKeyDown={enterToCommit} className={inputClasses} aria-label="Counter step" /></label>
                        <label className="text-[10px] text-gray-500">Digits
                            <input type="number" min={1} max={16} value={padding} onChange={e => setPadding(e.target.value)} {...focusHandlers('padding', commitCounter)} onKeyDown={enterToCommit} className={inputClasses} aria-label="Counter padding" /></label>
                    </div>
                    <label className="flex items-center gap-1.5 text-[10px] text-gray-400 mt-1 cursor-pointer select-none" title="Printer-side odometer: the number advances by Step after every printed label (<FS> region + <ESC>I/D). With it off, every label prints the Start value.">
                        <input type="checkbox" checked={!!source.serial} onChange={toggleSerial} className="accent-blue-500" aria-label="Serial (count per printed label)"/>
                        <span>Serial — count per printed label</span>
                    </label>
                    <p className="text-[10px] text-gray-500 mt-1">{source.serial && source.step !== 0
                        ? `Printer advances ${String(source.start).padStart(source.padding, '0')} by ${source.step} after each label (IPL <FS> odometer). Set Quantity to print the run.`
                        : 'Prints once per label at its start value; per-label counting happens on the printer (IPL <FS>/<GS> regions).'}</p>
                </>
            )}
            <div className="flex justify-between mt-1 text-[10px] text-gray-500">
                <span title={startOverflows ? `Start value is longer than ${source.padding} digits — printed at full length, padding only adds leading zeros` : undefined}>Preview: <span className={`font-mono ${startOverflows ? 'text-yellow-400' : 'text-gray-300'}`}>{preview}</span></span>
                {fieldCount > 0 && <span title={`${fieldCount} field(s) linked`}>{fieldCount} linked</span>}
            </div>
        </div>
    );
};

export const RightPanel: React.FC<{ activeDesign: Design; selectedFieldIds: number[]; dispatch: React.Dispatch<any>; }> = ({ activeDesign, selectedFieldIds, dispatch }) => {
    const [activeTab, setActiveTab] = useState('properties');
    const [iplCode, setIplCode] = useState('');
    const [zplWarnings, setZplWarnings] = useState<string[]>([]);
    const [fontWarnings, setFontWarnings] = useState<FontSubstitution[]>([]);
    const [suppressWarnings, setSuppressWarnings] = useState<string[]>([]);
    const [designerOnly, setDesignerOnly] = useState<string[]>([]);
    // Lives here (not in CsvJobExporter) so pasted CSV survives tab switches.
    const [jobCsv, setJobCsv] = useState('');
    // ...but a DIFFERENT design must not inherit the old design's table:
    // the mapping preview would silently pair stale rows with new fields.
    const designKey = activeDesign.name;
    useEffect(() => { setJobCsv(''); }, [designKey]);
    
    useEffect(() => {
        if (activeTab === 'code') {
            // ZPL and EPL are synchronous and lossy: fields they cannot represent
            // come back as warnings, shown alongside the code so a missing barcode
            // is announced rather than discovered at the printer. IPL stays the
            // default — and is the explicit fallback, not just "everything else",
            // so a language added later cannot silently emit IPL here.
            const language = activeDesign.printerSettings.language ?? 'ipl';
            if (language !== 'ipl') {
                const { stream, warnings } =
                    language === 'epl' ? (() => { const r = generateEPL(activeDesign); return { stream: r.epl, warnings: r.warnings }; })()
                        : language === 'tspl' ? (() => { const r = generateTSPL(activeDesign); return { stream: r.tspl, warnings: r.warnings }; })()
                            : language === 'dpl' ? (() => { const r = generateDPL(activeDesign); return { stream: r.dpl, warnings: r.warnings }; })()
                                : (() => { const r = generateZPL(activeDesign); return { stream: r.zpl, warnings: r.warnings }; })();
                setIplCode(stream);
                setZplWarnings(warnings);
            } else {
                setZplWarnings([]);
                generateIPL(activeDesign).then(setIplCode);
            }
            // Uploaded fonts have no printer equivalent, so the stream
            // substitutes a resident face. Say so next to the code rather than
            // letting the width difference pass unnoticed.
            setFontWarnings(fontSubstitutions(activeDesign));
            setSuppressWarnings(suppressionWarnings(activeDesign));
            // These hold for every target language, so they are reported
            // whichever one the panel is showing.
            setDesignerOnly(designerOnlyWarnings(language, activeDesign));
        }
    }, [activeTab, activeDesign]);

    const renderProperties = () => {
        if (selectedFieldIds.length === 0) {
            return <LabelSettingsEditor settings={activeDesign.labelSettings} dispatch={dispatch} />;
        }
        
        const selectedFields = activeDesign.fields.filter(f => selectedFieldIds.includes(f.id));
        
        if (selectedFields.length === 0) {
             return <LabelSettingsEditor settings={activeDesign.labelSettings} dispatch={dispatch} />;
        }
        
        return <FieldEditor fields={selectedFields} design={activeDesign} dispatch={dispatch} />;
    };
    
    const renderDataSources = () => (
        <DataSourcePanel
            design={activeDesign}
            dispatch={dispatch}
            jobCsv={jobCsv}
            setJobCsv={setJobCsv}
        />
    );

    return (
        <aside className="w-72 bg-gray-800 border-l border-gray-700 flex flex-col flex-shrink-0">
            <div className="border-b border-gray-700">
                <div className="flex bg-gray-900/50">
                    <button onClick={() => setActiveTab('properties')} className={`flex-1 p-2 text-xs font-semibold uppercase tracking-wider ${activeTab === 'properties' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-700/50'}`}>Properties</button>
                    <button onClick={() => setActiveTab('printer')} className={`flex-1 p-2 text-xs font-semibold uppercase tracking-wider ${activeTab === 'printer' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-700/50'}`}>Printer</button>
                    <button onClick={() => setActiveTab('data')} className={`flex-1 p-2 text-xs font-semibold uppercase tracking-wider ${activeTab === 'data' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-700/50'}`}>Data</button>
                    <button onClick={() => setActiveTab('code')} className={`flex-1 p-2 text-xs font-semibold uppercase tracking-wider ${activeTab === 'code' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-700/50'}`}>Code</button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
                {activeTab === 'properties' && renderProperties()}
                {activeTab === 'printer' && <PrinterSettingsEditor settings={activeDesign.printerSettings} dispatch={dispatch} />}
                {activeTab === 'data' && renderDataSources()}
                {activeTab === 'code' && <CodePanel iplCode={iplCode} fontWarnings={fontWarnings} suppressionWarnings={suppressWarnings} zplWarnings={zplWarnings} designerOnlyWarnings={designerOnly} />}
            </div>
        </aside>
    );
};
