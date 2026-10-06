// Right toolbar: document identity, save, library, import/export, viewer,
// print, help. Split from TopBar.tsx (layout phase 2).
import React, { useState, useRef } from 'react';
import type { Design } from '../../types';
import { notify } from '../../services/uiDialogs';
import { parseLabelFile } from '../../services/libraryStore';
import { IconButton, btnClasses } from './ToolbarBits';

export interface DocToolsProps {
    designName: string;
    dispatch: React.Dispatch<any>;
    dirty: boolean;
    onSave: () => void;
    onLoad: (name: string) => void;
    onDelete: (name: string) => void;
    savedDesigns: string[];
    onImportDesign: (design: Design) => void;
    onExport: () => void;
    onExportImage: (kind: 'png' | 'pdf' | 'zip') => void;
    exportingImage: 'png' | 'pdf' | 'zip' | null;
    onViewIpl: () => void;
    onPrintCenter: () => void;
    onHelp: () => void;
}

export const DocTools: React.FC<DocToolsProps> = (props) => {
    const [loadTarget, setLoadTarget] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleLoad = () => { if (loadTarget) props.onLoad(loadTarget); };
    const handleDelete = () => { if (loadTarget) { props.onDelete(loadTarget); setLoadTarget(''); } };
    const onImport = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                const result = parseLabelFile(e.target?.result as string);
                if (result.ok === false) { notify(`Failed to import design: ${result.error}`); return; }
                // Route through App's guarded action: importing replaces the
                // canvas, which deserves the same unsaved-work confirm as New.
                props.onImportDesign(result.design);
            };
            reader.readAsText(file);
        }
        if (event.target) event.target.value = '';
    };

    return (
        <div className="flex items-center gap-3">
            {/* Unsaved-work marker — mirrors the tab-title dot and beforeunload guard.
                Rendered always, opacity-toggled, so clean<->dirty shifts nothing. */}
            <span className={`w-2 h-2 rounded-full bg-amber-400 flex-shrink-0 transition-opacity ${props.dirty ? 'opacity-100' : 'opacity-0'}`} title={props.dirty ? 'Unsaved changes' : undefined} aria-label={props.dirty ? 'Unsaved changes' : undefined} aria-hidden={!props.dirty} />
            <input type="text" value={props.designName}
                onChange={e => props.dispatch({ type: 'UPDATE_INTERMEDIATE', payload: { name: e.target.value } })}
                onBlur={() => { props.dispatch({ type: 'COMMIT_INTERMEDIATE' }); }}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                className="w-40 p-1 text-center bg-gray-700 rounded-md border border-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
                title="Edit Design Name" />
            <IconButton icon="save" onClick={props.onSave} tooltip="Save to Browser (Ctrl+S)" className="text-gray-300" />
            <div className="h-6 border-l border-gray-600"></div>
            <div className="flex items-center gap-2">
                <select value={loadTarget} onChange={e => setLoadTarget(e.target.value)} className="w-32 text-sm p-1.5 bg-gray-700 rounded-md border border-gray-600 focus:ring-1 focus:ring-blue-500 outline-none" title="Select a saved design to load">
                    <option value="">Load Design...</option>
                    {props.savedDesigns.map(name => <option key={name} value={name}>{name}</option>)}
                </select>
                <button onClick={handleLoad} disabled={!loadTarget} className={`${btnClasses} bg-gray-600 hover:bg-gray-500`} title="Load the selected design">Load</button>
                <button onClick={handleDelete} disabled={!loadTarget} className={`${btnClasses} bg-red-700 hover:bg-red-800`} title="Delete the selected design">Del</button>
            </div>
            <div className="h-6 border-l border-gray-600"></div>
            <IconButton icon="upload_file" onClick={() => fileInputRef.current?.click()} tooltip="Import from File" className="text-gray-300" />
            <input type="file" ref={fileInputRef} onChange={onImport} accept=".json,.label.json" className="hidden" />
            <IconButton icon="download" onClick={props.onExport} tooltip="Export design (.label.json)" className="text-gray-300" />
            {/* Batch P: image exports render through the viewer pipeline — PNG of
                the first label, multi-page PDF, or a ZIP of numbered PNGs (one
                page per printed label, quantity-aware, 300-cap confirmed in App). */}
            <IconButton icon={props.exportingImage === 'png' ? 'hourglass_top' : 'image'} onClick={() => props.onExportImage('png')} disabled={!!props.exportingImage} tooltip={props.exportingImage === 'png' ? 'Rendering…' : 'Export PNG (first label)'} className="text-gray-300" />
            <IconButton icon={props.exportingImage === 'pdf' ? 'hourglass_top' : 'picture_as_pdf'} onClick={() => props.onExportImage('pdf')} disabled={!!props.exportingImage} tooltip={props.exportingImage === 'pdf' ? 'Rendering…' : 'Export PDF (one page per label)'} className="text-gray-300" />
            <IconButton icon={props.exportingImage === 'zip' ? 'hourglass_top' : 'folder_zip'} onClick={() => props.onExportImage('zip')} disabled={!!props.exportingImage} tooltip={props.exportingImage === 'zip' ? 'Rendering…' : 'Export ZIP of PNGs (one per label)'} className="text-gray-300" />
            <IconButton icon="code" onClick={props.onViewIpl} tooltip="View/Import IPL" className="text-gray-300" />
            {/* Fase 6: the sheet, the job queue and the print log. Kept next to
                View IPL because both answer "what will actually come out". */}
            <IconButton icon="print" onClick={props.onPrintCenter} tooltip="Print Center (sheet preview, queue, log)" className="text-gray-300" />
            <div className="h-6 border-l border-gray-600"></div>
            <IconButton icon="help_outline" onClick={props.onHelp} tooltip="Help & Shortcuts" className="text-gray-300" />
        </div>
    );
};
