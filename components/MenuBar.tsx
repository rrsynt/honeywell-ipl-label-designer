// Menu bar, BarTender-style (File/Edit/Arrange/View), above the toolbar.
// Layout phase 3: every item calls the SAME App callbacks the toolbar buttons
// call — no new state, no parallel paths. Keyboard-first: each item shows its
// shortcut, and the menu is fully operable (arrows + Enter + Esc).
import React, { useState, useEffect, useRef } from 'react';
import type { Alignment } from '../types';

export interface MenuBarProps {
    dispatch: React.Dispatch<any>;
    canUndo: boolean;
    canRedo: boolean;
    canCutCopy: boolean;
    canPaste: boolean;
    canAlign: boolean;
    canDistribute: boolean;
    canGroup: boolean;
    canUngroup: boolean;
    hasSelection: boolean;
    /** All field ids, for Select all (same list the Ctrl+A handler selects). */
    selectAllIds: number[];
    onNew: () => void;
    onTemplates: () => void;
    onLibrary: () => void;
    onSave: () => void;
    onExport: () => void;
    onExportImage: (kind: 'png' | 'pdf' | 'zip') => void;
    exportingImage: 'png' | 'pdf' | 'zip' | null;
    onViewIpl: () => void;
    onPrintCenter: () => void;
    onHelp: () => void;
    onZoomIn: () => void;
    onZoomOut: () => void;
    onZoomToFit: () => void;
    snapSettings: { grid: boolean; objects: boolean };
    onSnapSettingsChange: React.Dispatch<React.SetStateAction<{ grid: boolean; objects: boolean }>>;
}

interface Item {
    label: string;
    shortcut?: string;
    disabled?: boolean;
    checked?: boolean;
    action: () => void;
}

export const MenuBar: React.FC<MenuBarProps> = (props) => {
    const [open, setOpen] = useState<string | null>(null);
    const [focusIdx, setFocusIdx] = useState(0);
    const barRef = useRef<HTMLDivElement>(null);

    // Click elsewhere closes; Escape closes and returns focus to the bar.
    useEffect(() => {
        if (!open) return;
        const onDown = (e: PointerEvent) => {
            if (barRef.current && !barRef.current.contains(e.target as Node)) setOpen(null);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(null);
        };
        window.addEventListener('pointerdown', onDown);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('pointerdown', onDown);
            window.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const align = (a: Alignment) => () => props.dispatch({ type: 'ALIGN_SELECTED_FIELDS', payload: { alignment: a } });

    const menus: { name: string; items: (Item | null)[] }[] = [
        {
            name: 'File',
            items: [
                { label: 'New label…', shortcut: 'Ctrl+N', action: props.onNew },
                { label: 'From template…', action: props.onTemplates },
                { label: 'Open library…', action: props.onLibrary },
                null,
                { label: 'Save design', shortcut: 'Ctrl+S', action: props.onSave },
                { label: 'Export .label.json…', action: props.onExport },
                { label: 'Export PNG', action: () => props.onExportImage('png'), disabled: !!props.exportingImage },
                { label: 'Export PDF', action: () => props.onExportImage('pdf'), disabled: !!props.exportingImage },
                { label: 'Export ZIP of PNGs', action: () => props.onExportImage('zip'), disabled: !!props.exportingImage },
                null,
                { label: 'View / import code…', action: props.onViewIpl },
                { label: 'Print Center…', shortcut: 'Ctrl+P', action: props.onPrintCenter },
            ],
        },
        {
            name: 'Edit',
            items: [
                { label: 'Undo', shortcut: 'Ctrl+Z', disabled: !props.canUndo, action: () => props.dispatch({ type: 'UNDO' }) },
                { label: 'Redo', shortcut: 'Ctrl+Y', disabled: !props.canRedo, action: () => props.dispatch({ type: 'REDO' }) },
                null,
                { label: 'Cut', shortcut: 'Ctrl+X', disabled: !props.canCutCopy, action: () => props.dispatch({ type: 'CUT_FIELD' }) },
                { label: 'Copy', shortcut: 'Ctrl+C', disabled: !props.canCutCopy, action: () => props.dispatch({ type: 'COPY_FIELD' }) },
                { label: 'Paste', shortcut: 'Ctrl+V', disabled: !props.canPaste, action: () => props.dispatch({ type: 'PASTE_FIELD' }) },
                { label: 'Duplicate', shortcut: 'Ctrl+D', disabled: !props.canCutCopy, action: () => props.dispatch({ type: 'DUPLICATE_SELECTED_FIELDS' }) },
                { label: 'Delete', shortcut: 'Del', disabled: !props.canCutCopy, action: () => props.dispatch({ type: 'DELETE_SELECTED_FIELDS' }) },
                { label: 'Select all', shortcut: 'Ctrl+A', action: () => props.dispatch({ type: 'SET_SELECTION', payload: props.selectAllIds }) },
                null,
                { label: 'Group', shortcut: 'Ctrl+G', disabled: !props.canGroup, action: () => props.dispatch({ type: 'GROUP_SELECTED_FIELDS' }) },
                { label: 'Ungroup', shortcut: 'Ctrl+Shift+G', disabled: !props.canUngroup, action: () => props.dispatch({ type: 'UNGROUP_SELECTED_FIELDS' }) },
            ],
        },
        {
            name: 'Arrange',
            items: [
                { label: 'Align left', disabled: !props.canAlign, action: align('left') },
                { label: 'Align center', disabled: !props.canAlign, action: align('hcenter') },
                { label: 'Align right', disabled: !props.canAlign, action: align('right') },
                { label: 'Align top', disabled: !props.canAlign, action: align('top') },
                { label: 'Align middle', disabled: !props.canAlign, action: align('vmiddle') },
                { label: 'Align bottom', disabled: !props.canAlign, action: align('bottom') },
                null,
                { label: 'Distribute horizontally', shortcut: 'Ctrl+Shift+H', disabled: !props.canDistribute, action: () => props.dispatch({ type: 'DISTRIBUTE_SELECTED_FIELDS', payload: { axis: 'horizontal' } }) },
                { label: 'Distribute vertically', shortcut: 'Ctrl+Shift+V', disabled: !props.canDistribute, action: () => props.dispatch({ type: 'DISTRIBUTE_SELECTED_FIELDS', payload: { axis: 'vertical' } }) },
                null,
                { label: 'Bring to front', disabled: !props.hasSelection, action: () => props.dispatch({ type: 'BRING_TO_FRONT' }) },
                { label: 'Bring forward', disabled: !props.hasSelection, action: () => props.dispatch({ type: 'BRING_FORWARD' }) },
                { label: 'Send backward', disabled: !props.hasSelection, action: () => props.dispatch({ type: 'SEND_BACKWARD' }) },
                { label: 'Send to back', disabled: !props.hasSelection, action: () => props.dispatch({ type: 'SEND_TO_BACK' }) },
            ],
        },
        {
            name: 'View',
            items: [
                { label: 'Zoom in', shortcut: 'Ctrl+=', action: props.onZoomIn },
                { label: 'Zoom out', shortcut: 'Ctrl+-', action: props.onZoomOut },
                { label: 'Zoom to fit', shortcut: 'Ctrl+0', action: props.onZoomToFit },
                null,
                {
                    label: 'Snap to grid', checked: props.snapSettings.grid,
                    action: () => props.onSnapSettingsChange(s => ({ ...s, grid: !s.grid })),
                },
                {
                    label: 'Smart guides', checked: props.snapSettings.objects,
                    action: () => props.onSnapSettingsChange(s => ({ ...s, objects: !s.objects })),
                },
                null,
                { label: 'Help & shortcuts', action: props.onHelp },
            ],
        },
    ];

    const fire = (item: Item) => {
        setOpen(null);
        item.action();
    };

    return (
        <div ref={barRef} className="flex items-stretch bg-gray-900 border-b border-gray-700 text-sm flex-shrink-0 select-none" role="menubar" aria-label="Main menu">
            {menus.map(menu => {
                const items = menu.items.filter((i): i is Item => i !== null);
                const isOpen = open === menu.name;
                return (
                    <div key={menu.name} className="relative">
                        <button
                            role="menuitem"
                            aria-haspopup="true"
                            aria-expanded={isOpen}
                            onClick={() => { setOpen(isOpen ? null : menu.name); setFocusIdx(0); }}
                            onMouseEnter={() => { if (open) { setOpen(menu.name); setFocusIdx(0); } }}
                            className={`px-3 py-1.5 ${isOpen ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-800'}`}
                        >
                            {menu.name}
                        </button>
                        {isOpen && (
                            <div
                                role="menu"
                                aria-label={menu.name}
                                className="absolute left-0 top-full min-w-56 bg-gray-800 border border-gray-600 rounded-md shadow-2xl py-1 z-50"
                                onKeyDown={e => {
                                    if (e.key === 'ArrowDown') { e.preventDefault(); setFocusIdx(i => (i + 1) % items.length); }
                                    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocusIdx(i => (i - 1 + items.length) % items.length); }
                                    else if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        const item = items[focusIdx];
                                        if (item && !item.disabled) fire(item);
                                    }
                                }}
                            >
                                {menu.items.map((item, idx) =>
                                    item === null ? (
                                        <div key={`sep-${idx}`} className="my-1 border-t border-gray-700" role="separator" />
                                    ) : (
                                        <button
                                            key={item.label}
                                            role="menuitem"
                                            disabled={item.disabled}
                                            onClick={() => fire(item)}
                                            onMouseEnter={() => setFocusIdx(items.indexOf(item))}
                                            className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed ${focusIdx === items.indexOf(item) && !item.disabled ? 'bg-blue-600 text-white' : 'hover:bg-gray-700'}`}
                                        >
                                            <span className="w-4 text-center">{item.checked ? '✓' : ''}</span>
                                            <span className="flex-1">{item.label}</span>
                                            {item.shortcut && <kbd className="text-[11px] text-gray-400">{item.shortcut}</kbd>}
                                        </button>
                                    ),
                                )}
                            </div>
                        )}
                    </div>
                );
            })}
            <div className="flex-1" />
            <span className="px-3 py-1.5 text-xs text-gray-500 self-center hidden lg:block" title="Every menu item calls the same action as its toolbar button">
                IPL Designer
            </span>
        </div>
    );
};
