// Top toolbar shell: document set, edit tools, view tools, document tools.
// The groups live in components/toolbar/ (split from this file, layout
// phase 2) — this file owns the bar layout and nothing else.
import React from 'react';
import type { Design, WorkspaceState } from '../types';
import { btnClasses } from './toolbar/ToolbarBits';
import { EditTools } from './toolbar/EditTools';
import { ViewTools } from './toolbar/ViewTools';
import { DocTools } from './toolbar/DocTools';

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
  onLibrary: () => void;
  onSave: () => void;
  onLoad: (name: string) => void;
  onDelete: (name: string) => void;
  onExport: () => void;
  onExportImage: (kind: 'png' | 'pdf' | 'zip') => void;
  exportingImage: 'png' | 'pdf' | 'zip' | null;
  onViewIpl: () => void;
  /** Fase 6: sheet preview, print queue and print log. */
  onPrintCenter: () => void;
  savedDesigns: string[];
  workspaceState: WorkspaceState;
  setWorkspaceState: React.Dispatch<React.SetStateAction<WorkspaceState>>;
  onZoomToFit: () => void;
  snapSettings: { grid: boolean; objects: boolean; };
  onSnapSettingsChange: React.Dispatch<React.SetStateAction<{ grid: boolean; objects: boolean; }>>;
}> = (props) => {
  return (
    // The three groups need ~1790px together (measured in the browser; the
    // Fase 6 Print Center button added 36px). Without the x-scroll the header's
    // overflow was clipped by the page's `overflow-hidden`, so on a 1440px
    // laptop the PDF/ZIP/View IPL/Print/Help buttons could not be reached at
    // all. Flex items keep their min-content width, so the bar scrolls rather
    // than crushing the buttons; at wide widths nothing changes.
    <header className="bg-gray-800 border-b border-gray-700 shadow-md p-2 flex items-center justify-between z-10 flex-shrink-0 h-14 overflow-x-auto overflow-y-hidden">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-bold text-blue-400 pl-2">IPL Designer</h1>
        <button onClick={props.onNew} className={`${btnClasses} bg-blue-600 hover:bg-blue-700`} title="Start a new label design">New</button>
        <button onClick={props.onTemplates} className={`${btnClasses} bg-gray-700 hover:bg-gray-600`} title="Start from a ready-made template">Templates</button>
        <button onClick={props.onLibrary} className={`${btnClasses} bg-gray-700 hover:bg-gray-600`} title="Open a saved design">Library</button>
      </div>

      <div className="flex-1 flex justify-center items-center gap-1">
        <EditTools
          dispatch={props.dispatch}
          canUndo={props.canUndo} canRedo={props.canRedo}
          canCutCopy={props.canCutCopy} canPaste={props.canPaste}
          canAlign={props.canAlign} canDistribute={props.canDistribute}
          canGroup={props.canGroup} canUngroup={props.canUngroup}
        />
        <ViewTools
          workspaceState={props.workspaceState} setWorkspaceState={props.setWorkspaceState}
          onZoomToFit={props.onZoomToFit}
          snapSettings={props.snapSettings} onSnapSettingsChange={props.onSnapSettingsChange}
        />
      </div>

      <DocTools
        designName={props.designName} dispatch={props.dispatch} dirty={props.dirty}
        onSave={props.onSave} onLoad={props.onLoad} onDelete={props.onDelete}
        savedDesigns={props.savedDesigns}
        onImportDesign={props.onImportDesign}
        onExport={props.onExport} onExportImage={props.onExportImage} exportingImage={props.exportingImage}
        onViewIpl={props.onViewIpl} onPrintCenter={props.onPrintCenter} onHelp={props.onHelp}
      />
    </header>
  );
};
