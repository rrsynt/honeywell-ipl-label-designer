// Center-left toolbar: history, clipboard, align, distribute, group.
// Split from TopBar.tsx (layout phase 2); props are TopBar's own, narrowed.
import React from 'react';
import type { Alignment } from '../../types';
import { IconButton, AlignmentButton, Divider } from './ToolbarBits';

export interface EditToolsProps {
    dispatch: React.Dispatch<any>;
    canUndo: boolean;
    canRedo: boolean;
    canCutCopy: boolean;
    canPaste: boolean;
    canAlign: boolean;
    canDistribute: boolean;
    canGroup: boolean;
    canUngroup: boolean;
}

export const EditTools: React.FC<EditToolsProps> = (props) => {
    const handleAlign = (alignment: Alignment) => {
        props.dispatch({ type: 'ALIGN_SELECTED_FIELDS', payload: { alignment } });
    };

    const handleDistribute = (axis: 'horizontal' | 'vertical') => {
        props.dispatch({ type: 'DISTRIBUTE_SELECTED_FIELDS', payload: { axis } });
    };

    return (
        <>
            <IconButton icon="undo" onClick={() => props.dispatch({ type: 'UNDO' })} disabled={!props.canUndo} tooltip="Undo (Ctrl+Z)" className="text-gray-300" />
            <IconButton icon="redo" onClick={() => props.dispatch({ type: 'REDO' })} disabled={!props.canRedo} tooltip="Redo (Ctrl+Y)" className="text-gray-300" />
            <Divider />
            <IconButton icon="content_cut" onClick={() => props.dispatch({ type: 'CUT_FIELD' })} disabled={!props.canCutCopy} tooltip="Cut (Ctrl+X)" className="text-gray-300" />
            <IconButton icon="content_copy" onClick={() => props.dispatch({ type: 'COPY_FIELD' })} disabled={!props.canCutCopy} tooltip="Copy (Ctrl+C)" className="text-gray-300" />
            <IconButton icon="content_paste" onClick={() => props.dispatch({ type: 'PASTE_FIELD' })} disabled={!props.canPaste} tooltip="Paste (Ctrl+V)" className="text-gray-300" />

            {props.canAlign && (
                <>
                    <Divider />
                    <div className="flex items-center gap-1 bg-gray-900 p-1 rounded-md">
                        <AlignmentButton icon="align_horizontal_left" onClick={() => handleAlign('left')} tooltip="Align Left" />
                        <AlignmentButton icon="align_horizontal_center" onClick={() => handleAlign('hcenter')} tooltip="Align Horizontal Center" />
                        <AlignmentButton icon="align_horizontal_right" onClick={() => handleAlign('right')} tooltip="Align Right" />
                        <div className="h-5 border-l border-gray-600 mx-1"></div>
                        <AlignmentButton icon="align_vertical_top" onClick={() => handleAlign('top')} tooltip="Align Top" />
                        <AlignmentButton icon="align_vertical_center" onClick={() => handleAlign('vmiddle')} tooltip="Align Vertical Middle" />
                        <AlignmentButton icon="align_vertical_bottom" onClick={() => handleAlign('bottom')} tooltip="Align Bottom" />
                    </div>
                </>
            )}

            {props.canDistribute && (
                <>
                    <Divider />
                    <div className="flex items-center gap-1 bg-gray-900 p-1 rounded-md">
                        <AlignmentButton icon="arrow_range" onClick={() => handleDistribute('horizontal')} tooltip="Distribute horizontally (even gaps)" />
                        <AlignmentButton icon="height" onClick={() => handleDistribute('vertical')} tooltip="Distribute vertically (even gaps)" />
                    </div>
                </>
            )}

            {(props.canGroup || props.canUngroup) && (
                <>
                    <Divider />
                    <div className="flex items-center gap-1 bg-gray-900 p-1 rounded-md">
                        <AlignmentButton icon="group_work" disabled={!props.canGroup} onClick={() => props.dispatch({ type: 'GROUP_SELECTED_FIELDS' })} tooltip="Group selection (Ctrl+G)" />
                        <AlignmentButton icon="ungroup" disabled={!props.canUngroup} onClick={() => props.dispatch({ type: 'UNGROUP_SELECTED_FIELDS' })} tooltip="Ungroup (Ctrl+Shift+G)" />
                    </div>
                </>
            )}
        </>
    );
};
