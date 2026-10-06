// Center-right toolbar: smart guides, grid snap, zoom. Split from TopBar.tsx
// (layout phase 2).
import React, { useState, useEffect } from 'react';
import type { WorkspaceState } from '../../types';
import { IconButton, Divider } from './ToolbarBits';

export interface ViewToolsProps {
    workspaceState: WorkspaceState;
    setWorkspaceState: React.Dispatch<React.SetStateAction<WorkspaceState>>;
    onZoomToFit: () => void;
    snapSettings: { grid: boolean; objects: boolean; };
    onSnapSettingsChange: React.Dispatch<React.SetStateAction<{ grid: boolean; objects: boolean; }>>;
}

export const ViewTools: React.FC<ViewToolsProps> = (props) => {
    const [zoomInput, setZoomInput] = useState('100');

    useEffect(() => {
        setZoomInput(Math.round(props.workspaceState.zoom * 100).toString());
    }, [props.workspaceState.zoom]);

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
        <>
            <Divider className="h-6 border-l border-gray-600 mx-3" />
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

            <Divider />

            <div className="flex items-center gap-1">
                <IconButton icon="zoom_out" onClick={() => handleZoomChange(0.8)} tooltip="Zoom Out" className="text-gray-300" />
                <IconButton icon="zoom_in" onClick={() => handleZoomChange(1.25)} tooltip="Zoom In" className="text-gray-300" />
                <IconButton icon="fit_screen" onClick={props.onZoomToFit} tooltip="Zoom to Fit" className="text-gray-300" />
                <div className="relative">
                    <input
                        type="number"
                        value={zoomInput}
                        onChange={e => setZoomInput(e.target.value)}
                        onBlur={handleZoomInputBlur}
                        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                        className="w-16 text-xs text-center p-1 bg-gray-700 border border-gray-600 rounded-md outline-none focus:ring-1 focus:ring-blue-500"
                        title="Zoom Percentage"
                    />
                    <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">%</span>
                </div>
            </div>
        </>
    );
};
