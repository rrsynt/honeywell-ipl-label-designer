import React, { useState, useRef, useEffect } from 'react';
import type { Design, Alignment, WorkspaceState } from '../types';
import { notify } from '../services/uiDialogs';

const IconButton: React.FC<{ icon: string; onClick: () => void; disabled?: boolean; tooltip: string; className?: string }> = ({ icon, onClick, disabled = false, tooltip, className = '' }) => (
    <button onClick={onClick} disabled={disabled} title={tooltip} className={`px-2 py-1 text-sm rounded-md hover:bg-gray-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${className}`}>
         <span className="material-icons text-xl">{icon}</span>
    </button>
);

const AlignmentButton: React.FC<{ icon: string; onClick: () => void; tooltip: string; disabled?: boolean }> = ({ icon, onClick, tooltip, disabled = false }) => (
    <button onClick={onClick} disabled={disabled} title={tooltip} className="px-1.5 py-0.5 text-sm rounded-md text-gray-300 hover:bg-gray-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
         <span className="material-icons text-lg">{icon}</span>
    </button>
);

export const TopBar: React.FC<{
  designName: string;
  dispatch: React.Dispatch<any>;
  onHelp: () => void;
  canUndo: boolean;
  canRedo: boolean;
  canCutCopy: boolean;
  canPaste: boolean;
  canAlign: boolean;
  canDistribute: boolean;
  canGroup: boolean;
  canUngroup: boolean;
  dirty: boolean;
  onImportDesign: (design: Design) => void;
  onNew: () => void;
  onTemplates: () => void;
  onSave: () => void;
  onLoad: (name: string) => void;
  onDelete: (name: string) => void;
  onExport: () => void;
  onExportImage: (kind: 'png' | 'pdf' | 'zip') => void;
  exportingImage: 'png' | 'pdf' | 'zip' | null;
  onViewIpl: () => void;
  savedDesigns: string[];
  workspaceState: WorkspaceState;
  setWorkspaceState: React.Dispatch<React.SetStateAction<WorkspaceState>>;
  onZoomToFit: () => void;
  snapSettings: { grid: boolean; objects: boolean; };
  onSnapSettingsChange: React.Dispatch<React.SetStateAction<{ grid: boolean; objects: boolean; }>>;
}> = (props) => {
  const [loadTarget, setLoadTarget] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [zoomInput, setZoomInput] = useState('100');
  const btnClasses = "px-3 py-1 text-sm rounded-md text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

  useEffect(() => {
    setZoomInput(Math.round(props.workspaceState.zoom * 100).toString());
  }, [props.workspaceState.zoom]);


  const handleLoad = () => { if(loadTarget) props.onLoad(loadTarget); };
  const handleDelete = () => { if(loadTarget){ props.onDelete(loadTarget); setLoadTarget(''); } };
  const onImport = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const design = JSON.parse(e.target?.result as string) as Design;
                    // Route through App's guarded action: importing replaces the
                    // canvas, which deserves the same unsaved-work confirm as New.
                    props.onImportDesign(design);
                } catch (err) { notify('Failed to import design: Invalid file format.'); }
            };
            reader.readAsText(file);
        }
        if(event.target) event.target.value = '';
    };

    const handleAlign = (alignment: Alignment) => {
      props.dispatch({ type: 'ALIGN_SELECTED_FIELDS', payload: { alignment } });
    };

    const handleDistribute = (axis: 'horizontal' | 'vertical') => {
      props.dispatch({ type: 'DISTRIBUTE_SELECTED_FIELDS', payload: { axis } });
    };

    const handleZoomChange = (factor: number | null, absoluteValue?: number) => {
        props.setWorkspaceState(prev => {
            const newZoom = absoluteValue ? absoluteValue : Math.max(0.1, Math.min(10, prev.zoom * (factor || 1)));
            return { ...prev, zoom: newZoom };
        });
    };
    
    const handleZoomInputBlur = () => {
        let val = parseInt(zoomInput);
        if (isNaN(val) || val < 10) val = 10;
        if (val > 1000) val = 1000;
        handleZoomChange(null, val / 100);
    };

  return (
    <header className="bg-gray-800 border-b border-gray-700 shadow-md p-2 flex items-center justify-between z-10 flex-shrink-0 h-14">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-bold text-blue-400 pl-2">IPL Designer</h1>
        <button onClick={props.onNew} className={`${btnClasses} bg-blue-600 hover:bg-blue-700`} title="Start a new label design">New</button>
        <button onClick={props.onTemplates} className={`${btnClasses} bg-gray-700 hover:bg-gray-600`} title="Start from a ready-made template">Templates</button>
      </div>
      
      <div className="flex-1 flex justify-center items-center gap-1">
         <IconButton icon="undo" onClick={() => props.dispatch({ type: 'UNDO' })} disabled={!props.canUndo} tooltip="Undo (Ctrl+Z)" className="text-gray-300"/>
         <IconButton icon="redo" onClick={() => props.dispatch({ type: 'REDO' })} disabled={!props.canRedo} tooltip="Redo (Ctrl+Y)" className="text-gray-300"/>
         <div className="h-6 border-l border-gray-600 mx-2"></div>
         <IconButton icon="content_cut" onClick={() => props.dispatch({ type: 'CUT_FIELD' })} disabled={!props.canCutCopy} tooltip="Cut (Ctrl+X)" className="text-gray-300"/>
         <IconButton icon="content_copy" onClick={() => props.dispatch({ type: 'COPY_FIELD' })} disabled={!props.canCutCopy} tooltip="Copy (Ctrl+C)" className="text-gray-300"/>
         <IconButton icon="content_paste" onClick={() => props.dispatch({ type: 'PASTE_FIELD' })} disabled={!props.canPaste} tooltip="Paste (Ctrl+V)" className="text-gray-300"/>
         
         {props.canAlign && (
            <>
                <div className="h-6 border-l border-gray-600 mx-2"></div>
                <div className="flex items-center gap-1 bg-gray-900 p-1 rounded-md">
                   <AlignmentButton icon="align_horizontal_left" onClick={() => handleAlign('left')} tooltip="Align Left"/>
                   <AlignmentButton icon="align_horizontal_center" onClick={() => handleAlign('hcenter')} tooltip="Align Horizontal Center"/>
                   <AlignmentButton icon="align_horizontal_right" onClick={() => handleAlign('right')} tooltip="Align Right"/>
                   <div className="h-5 border-l border-gray-600 mx-1"></div>
                   <AlignmentButton icon="align_vertical_top" onClick={() => handleAlign('top')} tooltip="Align Top"/>
                   <AlignmentButton icon="align_vertical_center" onClick={() => handleAlign('vmiddle')} tooltip="Align Vertical Middle"/>
                   <AlignmentButton icon="align_vertical_bottom" onClick={() => handleAlign('bottom')} tooltip="Align Bottom"/>
                </div>
            </>
         )}

         {props.canDistribute && (
            <>
                <div className="h-6 border-l border-gray-600 mx-2"></div>
                <div className="flex items-center gap-1 bg-gray-900 p-1 rounded-md">
                    <AlignmentButton icon="arrow_range" onClick={() => handleDistribute('horizontal')} tooltip="Distribute horizontally (even gaps)"/>
                    <AlignmentButton icon="height" onClick={() => handleDistribute('vertical')} tooltip="Distribute vertically (even gaps)"/>
                </div>
            </>
         )}

         {(props.canGroup || props.canUngroup) && (
            <>
                <div className="h-6 border-l border-gray-600 mx-2"></div>
                <div className="flex items-center gap-1 bg-gray-900 p-1 rounded-md">
                    <AlignmentButton icon="group_work" disabled={!props.canGroup} onClick={() => props.dispatch({ type: 'GROUP_SELECTED_FIELDS' })} tooltip="Group selection (Ctrl+G)"/>
                    <AlignmentButton icon="ungroup" disabled={!props.canUngroup} onClick={() => props.dispatch({ type: 'UNGROUP_SELECTED_FIELDS' })} tooltip="Ungroup (Ctrl+Shift+G)"/>
                </div>
            </>
         )}

         <div className="h-6 border-l border-gray-600 mx-3"></div>
          <IconButton 
              icon='auto_awesome'
              onClick={() => props.onSnapSettingsChange({ ...props.snapSettings, objects: !props.snapSettings.objects })}
              tooltip={`Smart Guides (${props.snapSettings.objects ? 'On' : 'Off'})`} 
              className={props.snapSettings.objects ? 'text-blue-400' : 'text-gray-300'}
          />
          <IconButton 
              icon={props.snapSettings.grid ? 'grid_on' : 'grid_off'}
              onClick={() => props.onSnapSettingsChange({ ...props.snapSettings, grid: !props.snapSettings.grid })}
              tooltip={`Snap to Grid (${props.snapSettings.grid ? 'On' : 'Off'})`} 
              className={props.snapSettings.grid ? 'text-blue-400' : 'text-gray-300'}
          />

         <div className="h-6 border-l border-gray-600 mx-2"></div>

         <div className="flex items-center gap-1">
            <IconButton icon="zoom_out" onClick={() => handleZoomChange(0.8)} tooltip="Zoom Out" className="text-gray-300"/>
             <IconButton icon="zoom_in" onClick={() => handleZoomChange(1.25)} tooltip="Zoom In" className="text-gray-300"/>
             <IconButton icon="fit_screen" onClick={props.onZoomToFit} tooltip="Zoom to Fit" className="text-gray-300"/>
            <div className="relative">
                <input 
                    type="number" 
                    value={zoomInput}
                    onChange={e => setZoomInput(e.target.value)}
                    onBlur={handleZoomInputBlur}
                    onKeyDown={e => { if(e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                    className="w-16 text-xs text-center p-1 bg-gray-700 border border-gray-600 rounded-md outline-none focus:ring-1 focus:ring-blue-500"
                    title="Zoom Percentage"
                />
                <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">%</span>
            </div>
         </div>
      </div>

      <div className="flex items-center gap-3">
         {/* Unsaved-work marker — mirrors the tab-title dot and beforeunload guard.
             Rendered always, opacity-toggled, so clean<->dirty shifts nothing. */}
         <span className={`w-2 h-2 rounded-full bg-amber-400 flex-shrink-0 transition-opacity ${props.dirty ? 'opacity-100' : 'opacity-0'}`} title={props.dirty ? 'Unsaved changes' : undefined} aria-label={props.dirty ? 'Unsaved changes' : undefined} aria-hidden={!props.dirty}/>
         <input type="text" value={props.designName}
            onChange={e => props.dispatch({ type: 'UPDATE_INTERMEDIATE', payload: { name: e.target.value } })}
            onBlur={() => { props.dispatch({ type: 'COMMIT_INTERMEDIATE' }); }}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            className="w-40 p-1 text-center bg-gray-700 rounded-md border border-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
            title="Edit Design Name"/>
        <IconButton icon="save" onClick={props.onSave} tooltip="Save to Browser (Ctrl+S)" className="text-gray-300"/>
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
        <IconButton icon="upload_file" onClick={() => fileInputRef.current?.click()} tooltip="Import from File" className="text-gray-300"/>
        <input type="file" ref={fileInputRef} onChange={onImport} accept=".json" className="hidden" />
        <IconButton icon="download" onClick={props.onExport} tooltip="Export design (JSON)" className="text-gray-300"/>
        {/* Batch P: image exports render through the viewer pipeline — PNG of
            the first label, multi-page PDF, or a ZIP of numbered PNGs (one
            page per printed label, quantity-aware, 300-cap confirmed in App). */}
        <IconButton icon={props.exportingImage === 'png' ? 'hourglass_top' : 'image'} onClick={() => props.onExportImage('png')} disabled={!!props.exportingImage} tooltip={props.exportingImage === 'png' ? 'Rendering…' : 'Export PNG (first label)'} className="text-gray-300"/>
        <IconButton icon={props.exportingImage === 'pdf' ? 'hourglass_top' : 'picture_as_pdf'} onClick={() => props.onExportImage('pdf')} disabled={!!props.exportingImage} tooltip={props.exportingImage === 'pdf' ? 'Rendering…' : 'Export PDF (one page per label)'} className="text-gray-300"/>
        <IconButton icon={props.exportingImage === 'zip' ? 'hourglass_top' : 'folder_zip'} onClick={() => props.onExportImage('zip')} disabled={!!props.exportingImage} tooltip={props.exportingImage === 'zip' ? 'Rendering…' : 'Export ZIP of PNGs (one per label)'} className="text-gray-300"/>
        <IconButton icon="code" onClick={props.onViewIpl} tooltip="View/Import IPL" className="text-gray-300"/>
        <div className="h-6 border-l border-gray-600"></div>
        <IconButton icon="help_outline" onClick={props.onHelp} tooltip="Help & Shortcuts" className="text-gray-300"/>
      </div>
    </header>
  );
};
