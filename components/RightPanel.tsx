// Right panel shell: tab bar + per-tab editors. The editors themselves live in
// components/panels/ (split from this 1219-line file, layout phase 2) — this
// file owns the tab state, the Code-tab generation, and nothing else.
import React, { useState, useEffect } from 'react';
import type { Design } from '../types';
import { FieldEditor } from './FieldEditor';
import { CodePanel } from './CodePanel';
import { LabelSettingsEditor } from './panels/LabelStockPanel';
import { PrinterSettingsEditor } from './panels/PrinterPanel';
import { DataSourcePanel } from './panels/DataPanel';
import { generateIPL, fontSubstitutions, suppressionWarnings, type FontSubstitution } from '../services/iplGenerator';
import { designerOnlyWarnings } from '../services/designerOnly';
import { generateZPL } from '../services/zpl/zplGenerator';
import { generateEPL } from '../services/epl/eplGenerator';
import { generateTSPL } from '../services/tspl/tsplGenerator';
import { generateDPL } from '../services/dpl/dplGenerator';

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
