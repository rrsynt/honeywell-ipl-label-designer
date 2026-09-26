import React, { useReducer, useEffect, useState, useRef, useCallback } from 'react';
import { TopBar } from './components/TopBar';
import { LeftPanel } from './components/LeftPanel';
import { RightPanel } from './components/RightPanel';
import { Workspace } from './components/Workspace';
import { HelpModal } from './components/HelpModal';
import { IPLViewerModal } from './components/IPLViewerModal';
import { TemplateGallery } from './components/TemplateGallery';
import { StartScreen } from './components/StartScreen';
import { PrintCenter } from './components/PrintCenter';
import { createDefaultDesign, type LabelTemplate } from './services/templates';
import { DialogHost } from './components/DialogHost';
import { requestConfirm, notify } from './services/uiDialogs';
import { ContextMenu } from './components/ContextMenu';
import type { ContextMenuOption } from './components/ContextMenu';
import { getSavedDesigns, saveDesign, loadDesign, deleteDesign } from './services/designManager';
import { getLibraryRecord, saveLibraryRecord, deleteLibraryRecord, migrateLegacyLibrary, serializeLabelFile, parseLabelFile, writeRecovery, readRecovery, clearRecovery, designChecksum, memoryBackend, indexedDbBackend, setLibraryBackend } from './services/libraryStore';
import { getLibraryServerUrl, remoteBackend } from './services/libraryRemoteBackend';
import { loadInstalledFonts } from './services/fontStore';
import { getAxisAlignedBoundingBox } from './services/geometry';
import { expandIdsWithGroups } from './services/dragMath';
import { rebaseImage, conformImages, rederiveAllImages, placeholderImage } from './services/imageField';
import { upsert as upsertDataSource, remove as removeDataSources, unlinkFields } from './services/dataSources';
import { downloadDesignPng, downloadDesignPdf, downloadDesignZip, designJobLabelCount, MAX_BATCH_EXPORT, type ImageExportKind } from './services/designExport';
import type { AppState, Design, Field, WorkspaceState, TextField, Alignment, BarcodeField, FieldDataSource, BoxField, DataSource } from './types';

// Batch L review: the blank template and the app's default design share
// one factory (services/templates.ts) so printer/label defaults can't drift.
const defaultDesign: Design = createDefaultDesign();

const initialState: AppState = {
    history: { past: [], present: defaultDesign, future: [], intermediate: null, baseline: defaultDesign },
    selectedFieldIds: [],
    savedDesigns: getSavedDesigns(),
    clipboard: null,
    originalDesignName: null,
    contextMenu: null,
};

// Migration function to update old design structures
const migrateDesign = (design: any): Design => {
    const migrateField = (field: any): Field => {
        // Batch O: a loaded/imported groupId must be a real finite number to
        // be trusted. Strip the raw key FIRST (all three branches below), so
        // garbage from hand-edited or foreign JSON can neither poison
        // selection nor survive the branch that spreads the whole field.
        const { groupId: rawGroupId, ...fieldRest } = field;
        const groupId = typeof rawGroupId === 'number' && Number.isFinite(rawGroupId) ? rawGroupId : undefined;
        const groupPatch = groupId === undefined ? {} : { groupId };
        const base = { locked: field.locked ?? false, visible: field.visible ?? true };
        // Image fields carry a bitmap, not a data source — nothing to migrate
        // except the visibility/lock defaults. (Falling through would bolt a
        // bogus {type:'fixed'} dataSource onto them.)
        if (field.type === 'image' || field.type === 'ellipse' || field.type === 'polygon' || field.type === 'triangle') {
            return { ...fieldRest, ...base, ...groupPatch } as Field;
        }
        if (field.dataSource && (field.dataSource.type === 'fixed' || field.dataSource.type === 'variable' || field.dataSource.type === 'linked' || field.dataSource.type === 'date' || field.dataSource.type === 'time')) {
             return {
                ...fieldRest,
                ...base,
                ...groupPatch,
            };
        }
        // Old format with isStatic and data properties
        const { isStatic, data, ...rest } = fieldRest;
        const dataSource = isStatic === false // Check for explicit false for variable
            ? { type: 'variable', defaultData: data || '' }
            : { type: 'fixed', data: data || '' };

        return {
            ...rest,
            dataSource,
            ...base,
            ...groupPatch,
        } as Field;
    };
    
    const migratedFields = (design.fields || []).map(migrateField);

    return {
        ...defaultDesign,
        ...design,
        labelSettings: { ...defaultDesign.labelSettings, ...(design.labelSettings || {}) },
        fields: migratedFields,
        dataSources: design.dataSources || [],
        guides: design.guides || { horizontal: [], vertical: [] },
    };
};


// Exported for unit tests (tests/appReducer.test.ts); the app uses it via useReducer.
const MAX_HISTORY = 100;
/** Push a snapshot onto the undo stack, capped: an unbounded `past` array of
 *  full Design clones leaks memory across a long editing session. */
const pushPast = (past: Design[], present: Design): Design[] => {
    const next = [...past, present];
    return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
};
/** For discrete actions (align/distribute) that may fire while a nudge/drag
 *  burst is still uncommitted: NUDGE_BASELINE has already pushed this exact
 *  present, so re-pushing would make the first Undo a visible no-op. Same
 *  identity dedup COMMIT_INTERMEDIATE uses. */
const commitPast = (past: Design[], present: Design): Design[] =>
    past.length > 0 && past[past.length - 1] === present ? past : pushPast(past, present);

/** Clones (Ctrl+D, paste) must NOT inherit their source's groupId — a pasted
 *  copy of a group is its OWN new group, not a silent merge into the original.
 *  Members of a source group that appear only ONCE in the clone set come out
 *  ungrouped instead: a singleton "group" would render as a phantom chip
 *  (same invariant pruneOrphanGroups defends after deletes). Surviving
 *  multi-member groups get one fresh id each from the nextId counter (always
 *  past every issued field id, so a groupId can never collide with an id).
 *  Unit-tested through the reducer (tests/grouping.test.ts). */
const remapGroupIds = <T extends Field>(clones: T[], startId: number): { clones: T[]; nextId: number } => {
    const counts = new Map<number, number>();
    for (const c of clones) if (c.groupId !== undefined) counts.set(c.groupId, (counts.get(c.groupId) ?? 0) + 1);
    const map = new Map<number, number>();
    let next = startId;
    const remapped = clones.map(c => {
        if (c.groupId === undefined) return c;
        if ((counts.get(c.groupId) ?? 0) < 2) {
            const { groupId: _dropped, ...rest } = c;
            return rest as T;
        }
        let gid = map.get(c.groupId);
        if (gid === undefined) { gid = next++; map.set(c.groupId, gid); }
        return { ...c, groupId: gid } as T;
    });
    return { clones: remapped, nextId: next };
};

/** After fields are removed, dissolve groups that dropped below two members:
 *  a leftover groupId on a single field renders as a phantom "group" chip,
 *  and a future field reusing that id would silently merge with the ghost.
 *  Drops the key entirely — same shape UNGROUP produces. Returns the input
 *  array unchanged when nothing is orphaned. */
const pruneOrphanGroups = (fields: Field[]): Field[] => {
    const counts = new Map<number, number>();
    for (const f of fields) if (f.groupId !== undefined) counts.set(f.groupId, (counts.get(f.groupId) ?? 0) + 1);
    let changed = false;
    const out = fields.map(f => {
        if (f.groupId === undefined || (counts.get(f.groupId) ?? 0) >= 2) return f;
        changed = true;
        const { groupId: _orphan, ...rest } = f;
        return rest as Field;
    });
    return changed ? out : fields;
};

/** Unsaved-work flag for the session-safety UI (title asterisk, beforeunload,
 *  confirm-skip). Reference inequality against the immutable baseline — see
 *  AppState.history.baseline. Exported for tests (tests/sessionSafety.test.ts). */
export const isDesignDirty = (state: AppState): boolean =>
    state.history.present !== state.history.baseline;

/** How long the canvas must sit still before the draft is written. Long enough
 *  that a burst of typing or a drag produces one write, short enough that a
 *  crash costs at most this much work. Exported so tests need not sleep. */
export const AUTOSAVE_DELAY_MS = 1500;

export function appReducer(state: AppState, action: any): AppState {
    const { history, clipboard, selectedFieldIds } = state;
    const { past, present, future, intermediate } = history;
    const currentDesign = intermediate ?? present;

    switch (action.type) {
        case 'SET_DESIGN': {
             const loadedDesign = migrateDesign(action.payload.design);
            return {
                ...state,
                history: { past: [], present: loadedDesign, future: [], intermediate: null, baseline: loadedDesign },
                selectedFieldIds: [],
                clipboard: null,
                originalDesignName: action.payload.originalDesignName,
            };
        }
        case 'RESTORE_DRAFT': {
            const restored = migrateDesign(action.payload.design);
            // A restored draft is unsaved work BY DEFINITION — the autosave
            // effect is the only thing that ever wrote it. Re-baselining onto
            // it (as SET_DESIGN does) would clear the title asterisk and let
            // the tab close without a word, which is the silent loss this slot
            // exists to prevent. The baseline is left alone, so the design
            // reads dirty until the user saves it deliberately.
            //
            // originalDesignName stays null on purpose: a draft is not proof
            // that the design it is named after still exists, and claiming so
            // would let a rename-and-save delete a library record the user
            // never asked to touch. Saving under the same name replaces it by
            // name anyway, which is the case that matters.
            return {
                ...state,
                history: { past: [], present: restored, future: [], intermediate: null, baseline: history.baseline },
                selectedFieldIds: [],
                clipboard: null,
                originalDesignName: null,
            };
        }
        case 'UPDATE_INTERMEDIATE': {
            const { fields, guides, ...otherUpdates } = action.payload;
            let newFields = currentDesign.fields;
            if (fields) {
                newFields = currentDesign.fields.map(f => {
                    const update = fields.find((u: any) => u.id === f.id);
                    return update ? { ...f, ...update } : f;
                });
            }
            const newGuides = guides ? { ...currentDesign.guides, ...guides } : currentDesign.guides;
            
            return { ...state, history: { ...history, intermediate: { ...currentDesign, ...(otherUpdates as Partial<Design>), fields: newFields, guides: newGuides } } };
        }
        case 'COMMIT_INTERMEDIATE': {
            if (!intermediate) return state;
            if (JSON.stringify(intermediate) === JSON.stringify(present)) {
                 return { ...state, history: { ...history, intermediate: null } };
            }
            // NUDGE_BASELINE may have already pushed this exact present as the
            // burst's undo point; committing must not duplicate it (that would
            // make the first Undo a visible no-op).
            const newPast = past.length > 0 && past[past.length - 1] === present ? past : [...past, present];
            // A drag-resize of an image field moved only mm (cheap hot path);
            // commit rebuilds its dot grid once per gesture.
            const committed = conformImages(intermediate);
            return { ...state, history: { past: newPast, present: committed, future: [], intermediate: null, baseline: history.baseline } };
        }
        case 'NUDGE_BASELINE': {
            // Snapshot the pre-burst design once: the first arrow key of a
            // burst pushes history; subsequent UPDATE_INTERMEDIATEs mutate
            // intermediate without touching past, so a whole held-key run
            // collapses to a single undo step.
            if (intermediate || past[past.length - 1] === present) return state;
            return { ...state, history: { past: pushPast(past, present), present, future: [], intermediate: null, baseline: history.baseline } };
        }
        case 'UPDATE_SETTING': {
            const { settingType, updates } = action.payload; // e.g., settingType: 'labelSettings', updates: { width: 100 }
            let newPresent = {
                ...present,
                [settingType]: { ...present[settingType as 'labelSettings' | 'printerSettings'], ...(updates as object) }
            };
            // An IPL raster is its dots: after a dpi switch, image fields keep
            // the bitmap but their physical mm re-derive.
            if (settingType === 'printerSettings' && (updates as { dpi?: unknown }).dpi !== undefined) {
                newPresent = rederiveAllImages(newPresent);
            }
            if (JSON.stringify(newPresent) === JSON.stringify(present)) {
                return state; // No actual change
            }
            return { ...state, history: { past: pushPast(past, present), present: newPresent, future: [], intermediate: null, baseline: history.baseline } };
        }
        case 'UPDATE_FIELD_PROPERTIES': {
            const { fieldId, updates } = action.payload;
            const newFields = present.fields.map(f =>
                f.id === fieldId ? rebaseImage(f, updates, present) : f
            );
            const newPresent = { ...present, fields: newFields };
             if (JSON.stringify(newPresent.fields.find(f => f.id === fieldId)) === JSON.stringify(present.fields.find(f => f.id === fieldId))) {
                return state; // No actual change
            }
            return { ...state, history: { past: pushPast(past, present), present: newPresent, future: [], intermediate: null, baseline: history.baseline } };
        }
        case 'ADD_DATA_SOURCE':
        case 'UPDATE_DATA_SOURCE':
        case 'DELETE_DATA_SOURCE': {
            // List math happens HERE (on the freshest present), not in the UI:
            // computing the next array from props inside an event handler loses
            // updates when two actions dispatch before the next render.
            let nextSources: DataSource[];
            let nextFields = present.fields;
            if (action.type === 'DELETE_DATA_SOURCE') {
                const id = action.payload.id as string;
                nextSources = removeDataSources(present.dataSources, id);
                // Fields still linked to the deleted source would keep an
                // orphaned sourceId (dropdown shows a selection that isn't in
                // its options); unlink them back to plain variable fields.
                nextFields = unlinkFields(present.fields, id);
            } else {
                nextSources = upsertDataSource(present.dataSources, action.payload.source);
            }
            if (JSON.stringify(nextSources) === JSON.stringify(present.dataSources)
                && nextFields === present.fields) {
                return state; // No actual change
            }
            return { ...state, history: { past: pushPast(past, present), present: { ...present, dataSources: nextSources, fields: nextFields }, future: [], intermediate: null, baseline: history.baseline } };
        }
        case 'UPDATE_MULTIPLE_FIELD_PROPERTIES': {
            const { fieldIds, updates } = action.payload;
            const idSet = new Set(fieldIds);
            const newFields = present.fields.map(f =>
                idSet.has(f.id) ? rebaseImage(f, updates, present) : f
            );
            const newPresent = { ...present, fields: newFields };
            if (JSON.stringify(newPresent) === JSON.stringify(present)) {
                return state;
            }
            return { ...state, history: { past: pushPast(past, present), present: newPresent, future: [], intermediate: null, baseline: history.baseline } };
        }
        case 'TOGGLE_FIELD_LOCK': {
            const { id } = action.payload;
            const newFields = currentDesign.fields.map(f => f.id === id ? { ...f, locked: !f.locked } : f);
            const newPresent = { ...currentDesign, fields: newFields };
            // Locking must drop the field from the selection (same contract as
            // visibility): otherwise Delete/align/nudge keep hitting it while
            // it reads as protected. Commit on `present` so toggling during a
            // drag doesn't swallow the drag's intermediate as history.
            const wasLocked = currentDesign.fields.find(f => f.id === id)?.locked;
            return {
                ...state,
                history: { past: pushPast(past, present), present: newPresent, future: [], intermediate: null, baseline: history.baseline },
                selectedFieldIds: wasLocked ? state.selectedFieldIds : state.selectedFieldIds.filter(sid => sid !== id),
            };
        }
        case 'TOGGLE_FIELD_VISIBILITY': {
            const { id } = action.payload;
            const newFields = currentDesign.fields.map(f => f.id === id ? { ...f, visible: f.visible === false ? true : false } : f);
            const newPresent = { ...currentDesign, fields: newFields };
            const newSelectedIds = newPresent.fields.find(f => f.id === id)?.visible === false
                ? state.selectedFieldIds.filter(sid => sid !== id)
                : state.selectedFieldIds;
            return { ...state, history: { past: pushPast(past, present), present: newPresent, future: [], intermediate: null, baseline: history.baseline }, selectedFieldIds: newSelectedIds };
        }
        case 'UNDO':
            if (past.length === 0) return state;
            const previous = past[past.length - 1];
            const newPast = past.slice(0, past.length - 1);
            return { ...state, history: { past: newPast, present: previous, future: [present, ...future], intermediate: null, baseline: history.baseline }, selectedFieldIds: [] };
        case 'REDO':
            if (future.length === 0) return state;
            const next = future[0];
            const newFuture = future.slice(1);
            return { ...state, history: { past: pushPast(past, present), present: next, future: newFuture, intermediate: null, baseline: history.baseline }, selectedFieldIds: [] };
        case 'ADD_FIELD': {
             const { type } = action.payload || {};
            if (!type) {
                console.error("ADD_FIELD action dispatched with invalid payload:", action.payload);
                return state;
            }
            const newId = currentDesign.nextId;
            let newField: Field;
            const common = { id: newId, name: `${type.charAt(0).toUpperCase() + type.slice(1)} ${newId}`, x: 10, y: 10, rotation: 0 as const, locked: false, visible: true };
            if(type === 'text') newField = { ...common, type: 'text', dataSource: { type: 'variable', defaultData: 'Sample Text' }, font: '25', fontSize: 12, h_mag: 1, w_mag: 1 };
            else if(type === 'barcode') newField = { ...common, type: 'barcode', dataSource: { type: 'variable', defaultData: '1234567890' }, symbology: '6', humanReadable: 'below', h_mag: 50, w_mag: 1, code39_checkDigit: 'none', code128_subset: 'auto', hriFont: '21', hriFontSize: 10 };
            else if(type === 'line') newField = { ...common, type: 'line', length: 50, thickness: 1, lineEnding: 'none' };
            else if(type === 'box') newField = { ...common, type: 'box', width: 30, height: 20, thickness: 1, cornerRadius: 0 };
            // Fase 3 shapes. They print as downloaded rasters (no IPL command
            // exists for them), so a new one starts with a visible stroke.
            else if(type === 'ellipse') newField = { ...common, type: 'ellipse', width: 30, height: 20, thickness: 1 };
            else if(type === 'polygon') newField = { ...common, type: 'polygon', width: 25, height: 25, thickness: 1, sides: 6 };
            else if(type === 'triangle') newField = { ...common, type: 'triangle', width: 25, height: 22, thickness: 1 };
            // A checkerboard stand-in (40x40 dots ~ 5mm): the Image tool can't
            // open a file picker itself, it drops a placeholder and the user
            // picks the real file in the Properties panel.
            else if(type === 'image') { const ph = placeholderImage(currentDesign.printerSettings.dpi); newField = { ...common, type: 'image', bitmap: ph.bitmap, width: ph.width, height: ph.height, threshold: 128 }; }
            else return state; // Should not happen for valid types
            const newPresent = { ...currentDesign, fields: [...currentDesign.fields, newField], nextId: newId + 1 };
            return { ...state, history: { past: pushPast(past, present), present: newPresent, future: [], intermediate: null, baseline: history.baseline }, selectedFieldIds: [newId] };
        }
        case 'DELETE_FIELD': {
            const { id } = action.payload;
            const remaining = currentDesign.fields.filter(f => f.id !== id);
            const newPresent = { ...currentDesign, fields: pruneOrphanGroups(remaining) };
            return { ...state, history: { past: pushPast(past, present), present: newPresent, future: [], intermediate: null, baseline: history.baseline }, selectedFieldIds: state.selectedFieldIds.filter(sid => sid !== id) };
        }
        case 'DUPLICATE_FIELD': { // Duplicates a single field (e.g., from layer panel)
            const { id } = action.payload;
            const fieldToDup = currentDesign.fields.find(f => f.id === id);
            if (!fieldToDup) return state;
            const newId = currentDesign.nextId;
            // A clone gets its OWN group (remapGroupIds), never a silent merge
            // into the original's group.
            const { clones, nextId } = remapGroupIds([{ ...structuredClone(fieldToDup), id: newId, name: `${fieldToDup.name} Copy`, x: fieldToDup.x + 5, y: fieldToDup.y + 5 }], newId + 1);
            const newPresent = { ...currentDesign, fields: [...currentDesign.fields, clones[0]], nextId };
            return { ...state, history: { past: pushPast(past, present), present: newPresent, future: [], intermediate: null, baseline: history.baseline }, selectedFieldIds: [newId] };
        }
        case 'SET_SELECTION': return { ...state, selectedFieldIds: action.payload };
        case 'SELECT_FIELD': {
             const { id, shiftKey } = action.payload;
             const { selectedFieldIds } = state;
             // Clicking any member of a group selects the WHOLE group (Batch O)
             // — same expansion as the Workspace drag path, via dragMath's
             // shared helper, so selection and drag can never disagree.
             // Plain click selects ONLY this field's group (even if it was part
             // of a multi-selection — clicking an already-included member used
             // to be a no-op, so the selection could never collapse to one
             // field). Shift-click toggles membership.
             if (!shiftKey) {
                return { ...state, selectedFieldIds: expandIdsWithGroups(currentDesign.fields, [id]) };
             }
             // Shift-click removes a whole group; adding a member expands to
             // the whole group. (Removal must expand first: dropping only the
             // clicked id would leave its groupmates phantom-selected.)
             const expanded = expandIdsWithGroups(currentDesign.fields, [id]);
             const expandedSet = new Set(expanded);
             const allPresent = expanded.every(gid => selectedFieldIds.includes(gid));
             const toggled = allPresent
                 ? selectedFieldIds.filter(sid => !expandedSet.has(sid))
                 : [...selectedFieldIds, ...expanded.filter(gid => !selectedFieldIds.includes(gid))];
             return { ...state, selectedFieldIds: toggled };
        }
        case 'DELETE_SELECTED_FIELDS': {
            if (state.selectedFieldIds.length === 0) return state;
            // Locked fields are protected even if they linger in the selection
            // (e.g. selected through the Layers panel).
            const deletableIds = currentDesign.fields
                .filter(f => state.selectedFieldIds.includes(f.id) && !f.locked)
                .map(f => f.id);
            if (deletableIds.length === 0) return state;
            const remaining = currentDesign.fields.filter(f => !deletableIds.includes(f.id));
            const newPresent = { ...currentDesign, fields: pruneOrphanGroups(remaining) };
            return { ...state, history: { past: pushPast(past, present), present: newPresent, future: [], intermediate: null, baseline: history.baseline }, selectedFieldIds: state.selectedFieldIds.filter(sid => !deletableIds.includes(sid)) };
        }
        case 'DUPLICATE_SELECTED_FIELDS': {
            const fieldsToDup = currentDesign.fields.filter(f => state.selectedFieldIds.includes(f.id));
            if (fieldsToDup.length === 0) return state;
            let nextId = currentDesign.nextId;
            const cloned = fieldsToDup.map(field => ({ ...structuredClone(field), id: nextId++, name: `${field.name} Copy`, x: field.x + 5, y: field.y + 5 }));
            // Duplicating a whole group yields a new group (own fresh ids);
            // duplicating one member alone yields an ungrouped copy.
            const { clones, nextId: nextIdAfter } = remapGroupIds(cloned, nextId);
            const newPresent = { ...currentDesign, fields: [...currentDesign.fields, ...clones], nextId: nextIdAfter };
            return { ...state, history: { past: pushPast(past, present), present: newPresent, future: [], intermediate: null, baseline: history.baseline }, selectedFieldIds: clones.map(f => f.id) };
        }
        case 'COPY_FIELD': {
            const fieldsToCopy = currentDesign.fields.filter(f => state.selectedFieldIds.includes(f.id));
            return fieldsToCopy.length > 0 ? { ...state, clipboard: structuredClone(fieldsToCopy) } : state;
        }
        case 'CUT_FIELD': {
             // Locked members are protected (same contract as delete): group
             // expansion can put a locked field into the selection, but Cut
             // must not remove it — only the unlocked members are cut, and the
             // locked ones stay selected on the canvas.
             const fieldsToCut = currentDesign.fields.filter(f => state.selectedFieldIds.includes(f.id) && !f.locked);
             if (fieldsToCut.length === 0) return state;
             const cutIds = new Set(fieldsToCut.map(f => f.id));
             const remaining = currentDesign.fields.filter(f => !cutIds.has(f.id));
             const newPresent = { ...currentDesign, fields: pruneOrphanGroups(remaining) };
             return { ...state, history: { past: pushPast(past, present), present: newPresent, future: [], intermediate: null, baseline: history.baseline }, selectedFieldIds: state.selectedFieldIds.filter(sid => !cutIds.has(sid)), clipboard: structuredClone(fieldsToCut) };
        }
        case 'PASTE_FIELD': {
            if (!clipboard || clipboard.length === 0) return state;
            let nextId = currentDesign.nextId;
            // structuredClone (like COPY/DUPLICATE): a shallow copy shared the
            // nested dataSource object between clipboard and pasted field, so
            // editing one's data silently mutated the other's future pastes.
            const cloned = clipboard.map(field => ({ ...structuredClone(field), id: nextId++, name: `${field.name} Copy`, x: field.x + 5, y: field.y + 5, locked: false }));
            const { clones, nextId: nextIdAfter } = remapGroupIds(cloned, nextId);
            const newPresent = { ...currentDesign, fields: [...currentDesign.fields, ...clones], nextId: nextIdAfter };
            return { ...state, history: { past: pushPast(past, present), present: newPresent, future: [], intermediate: null, baseline: history.baseline }, selectedFieldIds: clones.map(f => f.id) };
        }
        case 'GROUP_SELECTED_FIELDS': {
            // Requires 2+ selected UNLOCKED fields — the same pool contract as
            // distribute, and for the same reason: locking one member after a
            // group is made keeps it, so a group may legitimately contain
            // locked members (they just refuse to move with the group).
            const pool = currentDesign.fields.filter(f => selectedFieldIds.includes(f.id) && !f.locked);
            if (pool.length < 2) return state;
            const newGroupId = currentDesign.nextId;
            const poolIds = new Set(pool.map(f => f.id));
            const regrouped = currentDesign.fields.map(f => poolIds.has(f.id) ? { ...f, groupId: newGroupId } : f);
            // Pulling members out of an existing group can leave that group
            // with a single orphan — prune so no phantom singleton chip lingers
            // (same invariant the delete paths enforce).
            const newPresent = { ...currentDesign, fields: pruneOrphanGroups(regrouped), nextId: newGroupId + 1 };
            return { ...state, history: { past: commitPast(past, present), present: newPresent, future: [], intermediate: null, baseline: history.baseline }, selectedFieldIds: [...poolIds] };
        }
        case 'SET_GROUP_SUPPRESS': {
            // Fase 4: one condition for a whole group. An empty string removes
            // the entry rather than storing a blank, so a cleared rule leaves
            // the saved design identical to one that never had one. The math
            // lives here, not in the panel: the panel only reports what was typed.
            const { groupId, condition } = action.payload as { groupId: number; condition: string };
            const next = { ...(currentDesign.groupSuppress ?? {}) };
            const trimmed = condition.trim();
            if (trimmed) next[groupId] = trimmed; else delete next[groupId];
            const groupSuppress = Object.keys(next).length > 0 ? next : undefined;
            const newPresent = { ...currentDesign, groupSuppress };
            return { ...state, history: { past: commitPast(past, present), present: newPresent, future: [], intermediate: null, baseline: history.baseline } };
        }
        case 'UNGROUP_SELECTED_FIELDS': {
            // Dissolves every group touched by the selection — one member
            // selected is enough (Figma's contract: "Ungroup" acts on the
            // group under the cursor, not on the exact pick).
            const touched = new Set(currentDesign.fields.filter(f => selectedFieldIds.includes(f.id) && f.groupId !== undefined).map(f => f.groupId as number));
            if (touched.size === 0) return state;
            const updatedFields = currentDesign.fields.map(f => {
                if (f.groupId === undefined || !touched.has(f.groupId)) return f;
                const { groupId: _gone, ...rest } = f;
                return rest as Field;
            });
            const newPresent = { ...currentDesign, fields: updatedFields };
            return { ...state, history: { past: commitPast(past, present), present: newPresent, future: [], intermediate: null, baseline: history.baseline } };
        }
        case 'SET_SAVED_DESIGNS': return { ...state, savedDesigns: action.payload };
        case 'DESIGN_SAVED':
            // Saving re-baselines: what's on disk now equals what's on screen.
            return { ...state, originalDesignName: state.history.present.name, history: { ...state.history, baseline: state.history.present } };
        case 'DESIGN_DELETED': {
            const { deletedName, newSavedDesigns } = action.payload;
            const newState = { ...state, savedDesigns: newSavedDesigns };
            if (deletedName === state.history.present.name || deletedName === state.originalDesignName) {
                return {
                    ...newState,
                    history: { past: [], present: defaultDesign, future: [], intermediate: null, baseline: defaultDesign },
                    selectedFieldIds: [],
                    clipboard: null,
                    originalDesignName: null,
                };
            }
            return newState;
        }
        case 'ALIGN_SELECTED_FIELDS': {
            const { alignment } = action.payload as { alignment: Alignment };
            // Base on the in-progress design: an uncommitted nudge/drag
            // intermediate must be respected, not silently discarded (review M1).
            const selectedFields = currentDesign.fields.filter(f => state.selectedFieldIds.includes(f.id));
            if (selectedFields.length < 2) return state;

            const selectionAABB = getAxisAlignedBoundingBox(selectedFields, currentDesign);
            const selectionMidX = selectionAABB.minX + (selectionAABB.maxX - selectionAABB.minX) / 2;
            const selectionMidY = selectionAABB.minY + (selectionAABB.maxY - selectionAABB.minY) / 2;

            const updatedFields = currentDesign.fields.map(field => {
                if (!state.selectedFieldIds.includes(field.id) || field.locked) return field;

                const fieldAABB = getAxisAlignedBoundingBox([field], currentDesign);
                const fieldWidth = fieldAABB.maxX - fieldAABB.minX;
                const fieldHeight = fieldAABB.maxY - fieldAABB.minY;
                
                let dx = 0;
                let dy = 0;

                switch (alignment) {
                    case 'left':    dx = selectionAABB.minX - fieldAABB.minX; break;
                    case 'hcenter': dx = selectionMidX - (fieldAABB.minX + fieldWidth / 2); break;
                    case 'right':   dx = selectionAABB.maxX - fieldAABB.maxX; break;
                    case 'top':     dy = selectionAABB.minY - fieldAABB.minY; break;
                    case 'vmiddle': dy = selectionMidY - (fieldAABB.minY + fieldHeight / 2); break;
                    case 'bottom':  dy = selectionAABB.maxY - fieldAABB.maxY; break;
                }
                
                return { ...field, x: field.x + dx, y: field.y + dy };
            });

            const newPresent = { ...currentDesign, fields: updatedFields };
            return { ...state, history: { past: commitPast(past, present), present: newPresent, future: [], intermediate: null, baseline: history.baseline } };
        }
        case 'DISTRIBUTE_SELECTED_FIELDS': {
            // Equalize the gaps between selected, unlocked fields along one
            // axis. The pool's first near edge and last far edge stay pinned;
            // locked fields never move and do not join the pool (gaps are
            // measured across them, same "locked fields are skipped" contract
            // as align/delete). < 3 movable fields has no interior to spread.
            const { axis } = action.payload as { axis: 'horizontal' | 'vertical' };
            const movable = currentDesign.fields.filter(f => selectedFieldIds.includes(f.id) && !f.locked);
            if (movable.length < 3) return state;

            // Own AABB per field (rotation/text-align/HRI-aware) — the exact
            // metric ALIGN uses, via the same getAxisAlignedBoundingBox path.
            const infos = movable.map(f => {
                const bb = getAxisAlignedBoundingBox([f], currentDesign);
                const min = axis === 'horizontal' ? bb.minX : bb.minY;
                const max = axis === 'horizontal' ? bb.maxX : bb.maxY;
                return { field: f, min, extent: max - min };
            }).sort((a, b) => a.min - b.min);

            const last = infos[infos.length - 1];
            const span = (last.min + last.extent) - infos[0].min;
            const totalExtent = infos.reduce((sum, i) => sum + i.extent, 0);
            const gap = (span - totalExtent) / (infos.length - 1);

            const deltas = new Map<number, number>();
            let cursor = infos[0].min;
            for (const info of infos) {
                deltas.set(info.field.id, cursor - info.min);
                cursor += info.extent + gap; // negative gap (heavy overlap) can reverse order — see comment below
            }
            // Already evenly distributed → true no-op, no history entry. Doubles
            // as an auto-repeat guard: re-firing on an even layout lands ~0 deltas.
            if ([...deltas.values()].every(d => Math.abs(d) < 1e-9)) return state;

            const updatedFields = currentDesign.fields.map(field => {
                const delta = deltas.get(field.id);
                if (delta === undefined) return field;
                return axis === 'horizontal' ? { ...field, x: field.x + delta } : { ...field, y: field.y + delta };
            });
            const newPresent = { ...currentDesign, fields: updatedFields };
            return { ...state, history: { past: commitPast(past, present), present: newPresent, future: [], intermediate: null, baseline: history.baseline } };
        }
        case 'BRING_FORWARD': {
            if (selectedFieldIds.length === 0) return state;
            const newFields = [...currentDesign.fields];
            const selectedIds = new Set(selectedFieldIds);
            // Iterate backwards to handle multiple adjacent items correctly
            for (let i = newFields.length - 2; i >= 0; i--) {
                if (selectedIds.has(newFields[i].id) && !selectedIds.has(newFields[i + 1].id)) {
                    [newFields[i], newFields[i + 1]] = [newFields[i + 1], newFields[i]];
                }
            }
            const newPresent = { ...currentDesign, fields: newFields };
            return { ...state, history: { past: pushPast(past, present), present: newPresent, future: [], intermediate: null, baseline: history.baseline } };
        }
        case 'SEND_BACKWARD': {
            if (selectedFieldIds.length === 0) return state;
            const newFields = [...currentDesign.fields];
            const selectedIds = new Set(selectedFieldIds);
            for (let i = 1; i < newFields.length; i++) {
                if (selectedIds.has(newFields[i].id) && !selectedIds.has(newFields[i - 1].id)) {
                    [newFields[i], newFields[i - 1]] = [newFields[i - 1], newFields[i]];
                }
            }
            const newPresent = { ...currentDesign, fields: newFields };
            return { ...state, history: { past: pushPast(past, present), present: newPresent, future: [], intermediate: null, baseline: history.baseline } };
        }
        case 'BRING_TO_FRONT': {
            if (selectedFieldIds.length === 0) return state;
            const selected = currentDesign.fields.filter(f => selectedFieldIds.includes(f.id));
            const unselected = currentDesign.fields.filter(f => !selectedFieldIds.includes(f.id));
            const newPresent = { ...currentDesign, fields: [...unselected, ...selected] };
            return { ...state, history: { past: pushPast(past, present), present: newPresent, future: [], intermediate: null, baseline: history.baseline } };
        }
        case 'SEND_TO_BACK': {
            if (selectedFieldIds.length === 0) return state;
            const selected = currentDesign.fields.filter(f => selectedFieldIds.includes(f.id));
            const unselected = currentDesign.fields.filter(f => !selectedFieldIds.includes(f.id));
            const newPresent = { ...currentDesign, fields: [...selected, ...unselected] };
            return { ...state, history: { past: pushPast(past, present), present: newPresent, future: [], intermediate: null, baseline: history.baseline } };
        }
        case 'REORDER_LAYER': {
            const { draggedId, targetId, position } = action.payload;
            if (draggedId === targetId) return state;

            const fields = [...currentDesign.fields];
            const draggedIndex = fields.findIndex(f => f.id === draggedId);
            let targetIndex = fields.findIndex(f => f.id === targetId);

            if (draggedIndex === -1 || targetIndex === -1) return state;

            const [draggedItem] = fields.splice(draggedIndex, 1);
            
            // After splice, the target's index might have shifted. Re-find it.
            targetIndex = fields.findIndex(f => f.id === targetId);
            if (targetIndex === -1) { // Failsafe if target was the dragged item somehow
                fields.push(draggedItem);
            } else {
                // List is rendered in reverse order of the array.
                // Visually dropping on the 'top' of an item means it should appear *before* it in the reversed list.
                // This means it needs to be *after* it in the actual array.
                const insertIndex = position === 'top' ? targetIndex + 1 : targetIndex;
                fields.splice(insertIndex, 0, draggedItem);
            }

            const newPresent = { ...currentDesign, fields };
            return { ...state, history: { past: pushPast(past, present), present: newPresent, future: [], intermediate: null, baseline: history.baseline } };
        }
        case 'SET_CONTEXT_MENU':
            return { ...state, contextMenu: action.payload };
        default: return state;
    }
}

export default function App() {
    const [state, dispatch] = useReducer(appReducer, initialState);
    const { history, selectedFieldIds, savedDesigns, clipboard, contextMenu } = state;
    const activeDesign = history.intermediate ?? history.present;
    const [showHelp, setShowHelp] = useState(false);
    const [showTemplates, setShowTemplates] = useState(false);
    const [showIplViewer, setShowIplViewer] = useState(false);
    const [showLibrary, setShowLibrary] = useState(false);
    const [showPrintCenter, setShowPrintCenter] = useState(false);
    // Bumped after every save/delete so an open library grid re-reads storage.
    const [libraryRevision, setLibraryRevision] = useState(0);

    // A shared library was chosen in an earlier session. Applied BEFORE the
    // migration below, which writes into whatever backend is current — pointed
    // at a server, the old local designs would otherwise be copied onto it.
    // Recovery stays on the local backend: an autosave is unfinished work and
    // must not surface on every other station.
    useEffect(() => {
        const serverUrl = getLibraryServerUrl();
        if (!serverUrl) return;
        const hasIndexedDb = typeof indexedDB !== 'undefined' && indexedDB !== null;
        setLibraryBackend(remoteBackend({ serverUrl, local: hasIndexedDb ? indexedDbBackend() : memoryBackend() }));
    }, []);

    // One-time move of designs saved by older builds (localStorage, ~5 MB cap)
    // into the IndexedDB library. Once per browser; a failure here must not
    // block the editor, the old storage is still readable.
    useEffect(() => {
        migrateLegacyLibrary()
            .then(moved => { if (moved > 0) setLibraryRevision(r => r + 1); })
            .catch(e => console.error('Design library migration failed:', e));
        // Uploaded fonts live in IndexedDB. Re-register them so a design that
        // uses one measures and paints it on the first render, not only after
        // the user re-uploads the file.
        loadInstalledFonts().catch(e => console.error('Installed fonts failed to load:', e));
    }, []);

    // Offer the autosaved draft back after a crash or a closed tab. Writing a
    // draft is only half the feature — nothing read it for a while, so this is
    // the half that makes the recovery real.
    //
    // The ref is the StrictMode guard: dev mounts run this effect twice, and a
    // second requestConfirm would resolve the first as cancelled, clearing the
    // very draft the user is being asked about.
    const draftOfferMadeRef = useRef(false);
    useEffect(() => {
        if (draftOfferMadeRef.current) return;
        draftOfferMadeRef.current = true;
        void (async () => {
            const draft = await readRecovery().catch(() => null);
            if (!draft) return;
            // A draft identical to what is already on the canvas is not worth
            // an interruption — a fresh session autosaves nothing, so this is
            // normally only reachable when the draft was written and the app
            // reloaded without any edit in between.
            if (designChecksum(draft.design) === designChecksum(defaultDesign)) {
                await clearRecovery().catch(() => {});
                return;
            }
            const when = new Date(draft.updatedAt).toLocaleString();
            const accept = await requestConfirm({
                title: 'Restore unsaved draft?',
                message: `"${draft.designName}" has unsaved changes from ${when}. Restore them, or discard the draft and start fresh?`,
                confirmLabel: 'Restore',
                danger: false,
            });
            if (accept) dispatch({ type: 'RESTORE_DRAFT', payload: { design: draft.design } });
            else await clearRecovery().catch(e => console.error('Could not discard the autosave draft:', e));
        })();
    }, []);

    // Fase 1 autosave. Writes the work-in-progress draft to a slot of its own
    // so a crash or a closed tab does not take unsaved edits with it, and so
    // the draft can never be mistaken for — or overwrite — a version the user
    // deliberately saved. `baseline` stays the one source of truth for dirty:
    // this effect never dispatches, so autosaving cannot make a dirty design
    // look saved.
    //
    // Debounced because every keystroke in a text field dispatches, and a
    // design with an image field is far too big to write on each one. The
    // cleanup cancels the pending write on the next edit, which is what makes
    // the delay a debounce rather than a throttle. Depending on the design
    // itself rather than on `state` keeps a mere selection change from
    // restarting the timer.
    useEffect(() => {
        if (activeDesign === history.baseline) return;
        const timer = setTimeout(() => {
            writeRecovery(activeDesign).catch(e => console.error('Autosave failed:', e));
        }, AUTOSAVE_DELAY_MS);
        return () => clearTimeout(timer);
    }, [activeDesign, history.baseline]);
    // Batch P: which image export is running (null = none). The ref guards
    // re-entry synchronously (two clicks in one paint frame); the state only
    // drives the button's "…" label.
    const exportBusyRef = useRef(false);
    const [exportingImage, setExportingImage] = useState<ImageExportKind | null>(null);
    const [workspaceState, setWorkspaceState] = useState<WorkspaceState>({ zoom: 1, pan: { x: 50, y: 50 } });
    const [mouseCoords, setMouseCoords] = useState<{x: number, y: number} | null>(null);
    const [snapSettings, setSnapSettings] = useState({ grid: true, objects: true });
    const canAlign = selectedFieldIds.length >= 2;
    // Distribute needs 3+ MOVABLE fields — with two, "even gaps" is a no-op,
    // and locked selections must not light up a button that cannot act (the
    // reducer guards the same invariant).
    const canDistribute = activeDesign.fields.filter(f => selectedFieldIds.includes(f.id) && !f.locked).length >= 3;
    // Group needs 2+ unlocked selected (the reducer's exact guard); Ungroup
    // lights whenever ANY selected field belongs to a group, even a locked one
    // — dissolving a group isn't editing a locked field's placement.
    const canGroup = activeDesign.fields.filter(f => selectedFieldIds.includes(f.id) && !f.locked).length >= 2;
    const canUngroup = activeDesign.fields.some(f => selectedFieldIds.includes(f.id) && f.groupId !== undefined);
    const dirty = isDesignDirty(state);
    const commitNudgeRef = useRef<number | null>(null);
    const workspaceContainerRef = useRef<HTMLDivElement>(null);
    // The once-mounted key listener must call the LATEST onSave (it closes
    // over history/state) without re-binding: refresh it every render.
    const saveShortcutRef = useRef<() => void>(() => {});

    // Latest-state refs so the key listener mounts once ([]) instead of
    // re-binding on every design change. Re-binding restarted the 500 ms
    // commit timer on each keystroke (deps churn), and — worse — every
    // auto-repeat keydown re-ran the closure, pushing a full history snapshot
    // per pixel of nudging.
    const designRef = useRef(activeDesign);
    const selectionRef = useRef(selectedFieldIds);
    const clipboardRef = useRef(clipboard);
    designRef.current = activeDesign;
    selectionRef.current = selectedFieldIds;
    clipboardRef.current = clipboard;

    // Review MEDIUM (Batch H): a file dropped OUTSIDE a drop zone makes the
    // browser navigate to file:///… and unmount the SPA, losing the design.
    // Neutralize the default at window level; real handlers (CSV importer,
    // IPL viewer drop) call preventDefault themselves and still fire.
    useEffect(() => {
        const preventNav = (e: DragEvent) => {
            // Only when a file drag is actually in progress; stop the
            // default open-file navigation everywhere else.
            if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault();
        };
        window.addEventListener('dragover', preventNav);
        window.addEventListener('drop', preventNav);
        return () => {
            window.removeEventListener('dragover', preventNav);
            window.removeEventListener('drop', preventNav);
        };
    }, []);

    // Session safety: warn the browser it may close with unsaved work. The
    // event only has an effect when preventDefault() runs during a genuine
    // unload — registering it conditionally keeps clean sessions silent.
    useEffect(() => {
        if (!dirty) return;
        const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; }; // returnValue for Safari/older Chromium
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
    }, [dirty]);

    // Tab-title marker: the asterisk survives even when the whole app chrome
    // is hidden behind other tabs (the toolbar dot cannot be seen there).
    useEffect(() => {
        document.title = dirty ? '*IPL Label Designer' : 'IPL Label Designer';
    }, [dirty]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const activeEl = document.activeElement;
            const isEditing = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT');

            // Ctrl/Cmd+S saves even while an input has focus (no text-editing
            // conflict). e.code + !shift so CapsLock can't reroute it and
            // Ctrl+Shift+S is left for the browser. Blur first: an input's
            // commit lives in its focusout handler, and without this the
            // keystrokes of a Ctrl+S-then-close-tab sequence would be saved
            // stale (review MEDIUM).
            if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyS') {
                e.preventDefault();
                if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
                saveShortcutRef.current();
                return;
            }

            // Text-editing shortcuts must reach the focused input: Ctrl+A/C/X/V
            // used to select-all / cut / copy the CANVAS instead of the text.
            if ((e.ctrlKey || e.metaKey) && !isEditing) {
                // Ctrl+Shift+H/V distribute — matched on the PHYSICAL key code
                // with shift required and alt excluded, so CapsLock (which
                // flips e.key case) and AltGr layouts (Ctrl+Alt on Windows)
                // can never reroute or accidentally trigger it (review L1/L2).
                if (e.shiftKey && !e.altKey && (e.code === 'KeyH' || e.code === 'KeyV')) {
                    if (selectionRef.current.length > 0) {
                        e.preventDefault();
                        dispatch({ type: 'DISTRIBUTE_SELECTED_FIELDS', payload: { axis: e.code === 'KeyH' ? 'horizontal' : 'vertical' } });
                    }
                } else if (!e.altKey && e.code === 'KeyG') {
                    // Group / Ungroup (Batch O), matched on the physical code
                    // like distribute so CapsLock/AltGr can't reroute it.
                    // Ctrl+G groups 2+ selected; Ctrl+Shift+G ungroups whatever
                    // is selected (no-op unless a selected field is in a group).
                    if (e.shiftKey) {
                        if (selectionRef.current.length > 0) { e.preventDefault(); dispatch({ type: 'UNGROUP_SELECTED_FIELDS' }); }
                    } else if (selectionRef.current.length > 1) {
                        e.preventDefault();
                        dispatch({ type: 'GROUP_SELECTED_FIELDS' });
                    }
                } else switch (e.key) {
                    case 'z': e.preventDefault(); dispatch({ type: 'UNDO' }); break;
                    case 'y': e.preventDefault(); dispatch({ type: 'REDO' }); break;
                    case 'c': if(selectionRef.current.length > 0) { e.preventDefault(); dispatch({ type: 'COPY_FIELD' }); } break;
                    case 'x': if(selectionRef.current.length > 0) { e.preventDefault(); dispatch({ type: 'CUT_FIELD' }); } break;
                    case 'v': if(clipboardRef.current) { e.preventDefault(); dispatch({ type: 'PASTE_FIELD' }); } break;
                    case 'd': if(selectionRef.current.length > 0) { e.preventDefault(); dispatch({ type: 'DUPLICATE_SELECTED_FIELDS' }); } break;
                    case 'a':
                        e.preventDefault();
                        dispatch({ type: 'SET_SELECTION', payload: designRef.current.fields.map(f => f.id) });
                        break;
                }
            }
            if ((e.key === 'Delete' || e.key === 'Backspace') && selectionRef.current.length > 0 && !isEditing) {
                e.preventDefault();
                dispatch({ type: 'DELETE_SELECTED_FIELDS' });
            }

            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && selectionRef.current.length > 0 && !isEditing) {
                e.preventDefault();
                const nudgeAmount = 0.25;
                const bigNudgeAmount = 1;
                const amount = e.shiftKey ? bigNudgeAmount : nudgeAmount;
                let dx = 0, dy = 0;

                switch(e.key) {
                    case 'ArrowUp': dy = -amount; break;
                    case 'ArrowDown': dy = amount; break;
                    case 'ArrowLeft': dx = -amount; break;
                    case 'ArrowRight': dx = amount; break;
                }

                // First press of a burst takes the undo baseline; auto-repeats
                // only move the intermediate. Whole held-key run = one undo.
                if (!e.repeat) dispatch({ type: 'NUDGE_BASELINE' });

                // Locked fields never move (align/distribute/delete contract).
                // Pre-Batch-O only Ctrl+A could put a locked field in the
                // selection; now a group click does too, so the guard belongs
                // here rather than in every selection path.
                const currentFields = designRef.current.fields.filter(f => selectionRef.current.includes(f.id) && !f.locked);
                if (currentFields.length === 0) return;
                const updatedFields = currentFields.map(field => ({
                    id: field.id,
                    x: field.x + dx,
                    y: field.y + dy,
                }));

                dispatch({ type: 'UPDATE_INTERMEDIATE', payload: { fields: updatedFields } });

                if (commitNudgeRef.current) clearTimeout(commitNudgeRef.current);
                commitNudgeRef.current = window.setTimeout(() => {
                    commitNudgeRef.current = null;
                    dispatch({ type: 'COMMIT_INTERMEDIATE' });
                }, 500);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            if (commitNudgeRef.current) {
                clearTimeout(commitNudgeRef.current);
                commitNudgeRef.current = null;
                dispatch({ type: 'COMMIT_INTERMEDIATE' });
            }
        };
    }, [dispatch]);

    // Canvas-replacing actions ask only when there is unsaved work to lose —
    // a clean design (fresh, or everything saved) is replaced silently.
    const confirmDiscard = async (title: string, what: string): Promise<boolean> => {
        if (!dirty) return true;
        return requestConfirm({
            title,
            message: what + ' Unsaved changes will be lost.',
            confirmLabel: title,
        });
    };

    const appActions = {
        onNew: async () => { if(await confirmDiscard('New design', 'Start a new design?')) dispatch({ type: 'SET_DESIGN', payload: { design: defaultDesign, originalDesignName: null } })},
        onTemplates: () => setShowTemplates(true),
        onPickTemplate: async (template: LabelTemplate) => {
            const proceed = await confirmDiscard('Apply template', 'Replace the current canvas with "' + template.name + '"?');
            if (!proceed) return;
            const design = template.build();
            dispatch({ type: 'SET_DESIGN', payload: { design, originalDesignName: null } });
            setShowTemplates(false);
        },
        onSave: () => {
            // Save what's ON SCREEN, not just what's committed: an in-flight
            // name edit or drag/nudge burst must not be lost when the user
            // hits Ctrl+S and closes the tab (review MEDIUM). COMMIT first so
            // DESIGN_SAVED re-baselines onto exactly what was stored.
            const designToSave = history.intermediate ?? history.present;
            if (state.originalDesignName && state.originalDesignName !== designToSave.name) {
                deleteDesign(state.originalDesignName);
                void deleteLibraryRecord(state.originalDesignName);
            }
            saveDesign(designToSave);
            dispatch({ type: 'COMMIT_INTERMEDIATE' });
            dispatch({ type: 'SET_SAVED_DESIGNS', payload: getSavedDesigns() });
            dispatch({ type: 'DESIGN_SAVED' });
            // The named save is now the newest copy, so the draft would only be
            // an older document offered under the same name. Drop it.
            void clearRecovery().catch(e => console.error('Could not clear the autosave draft:', e));
            // The IndexedDB library is the one the start screen reads. It is
            // async, so the screen refreshes off libraryRevision rather than
            // off the synchronous savedDesigns list above.
            const thumbnail = captureThumbnail();
            saveLibraryRecord(designToSave, thumbnail ? { thumbnail } : {})
                .then(() => setLibraryRevision(r => r + 1))
                .catch(e => notify(`Saved locally, but the design library could not store it: ${e instanceof Error ? e.message : String(e)}`));
        },
        onLoad: async (name: string) => {
            if (!(await confirmDiscard('Load design', `Load "${name}"?`))) return;
            // Prefer the library (it holds image-heavy designs localStorage
            // cannot); fall back to the legacy store for anything not yet
            // migrated.
            const record = await getLibraryRecord(name).catch(() => null);
            const design = record?.design ?? loadDesign(name);
            if (design) {
                dispatch({ type: 'SET_DESIGN', payload: { design, originalDesignName: name } });
                setShowLibrary(false);
            }
        },
        // Importing a design (JSON file, or IPL viewer import) replaces the
        // canvas too — guard it the same way. Returns whether it happened so
        // the IPL modal can decide to close; TopBar ignores the value.
        onImportDesign: async (design: Design): Promise<boolean> => {
            if (await confirmDiscard('Import design', `Replace the current canvas with "${design.name ?? 'imported design'}"?`)) {
                dispatch({ type: 'SET_DESIGN', payload: { design, originalDesignName: null } });
                return true;
            }
            return false;
        },
        onDelete: async (name: string) => {
            if (await requestConfirm({ title: 'Delete design', message: `Are you sure you want to delete "${name}"?`, confirmLabel: 'Delete' })) {
                deleteDesign(name);
                await deleteLibraryRecord(name).catch(e => console.error('Library delete failed:', e));
                const newDesigns = getSavedDesigns();
                dispatch({ type: 'DESIGN_DELETED', payload: { deletedName: name, newSavedDesigns: newDesigns } });
                setLibraryRevision(r => r + 1);
            }
        },
        onExport: () => {
            // Enveloped .label.json: schema version + checksum, so an import can
            // tell a truncated file from a merely old one (see parseLabelFile).
            const blob = new Blob([serializeLabelFile(history.present)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = `${history.present.name}.label.json`;
            a.click(); URL.revokeObjectURL(url);
        },
        // Batch P: image exports (PNG / PDF / ZIP of PNGs) render through the
        // viewer pipeline (generateIPL → parseViewerIPL → streamBatchPages),
        // so an exported file is byte-for-byte what the viewer/printer would
        // produce for this design — one render path, no drift. Exports the
        // SCREEN (intermediate ?? present), same honesty rule as Ctrl+S.
        onExportImage: async (kind: ImageExportKind) => {
            if (exportBusyRef.current) return; // a running render owns the UI
            exportBusyRef.current = true;
            setExportingImage(kind);
            try {
                const design = activeDesign;
                if (kind !== 'png') {
                    const total = await designJobLabelCount(design);
                    if (total > MAX_BATCH_EXPORT) {
                        const proceed = await requestConfirm({
                            title: 'Large batch export',
                            message: `This design prints ${total} labels, but export is capped at ${MAX_BATCH_EXPORT}. Export the first ${MAX_BATCH_EXPORT}?`,
                            confirmLabel: `Export ${MAX_BATCH_EXPORT}`,
                        });
                        if (!proceed) return;
                    }
                }
                const n = kind === 'png'
                    ? await downloadDesignPng(design)
                    : kind === 'pdf'
                        ? await downloadDesignPdf(design)
                        : await downloadDesignZip(design);
                if (n === 0) notify('Nothing to export — the design has no printable content.');
            } catch (e) {
                notify(`Image export failed: ${e instanceof Error ? e.message : String(e)}`);
            } finally {
                exportBusyRef.current = false;
                setExportingImage(null);
            }
        },
        onLibrary: () => setShowLibrary(true),
        onZoomToFit: () => {
            if (!workspaceContainerRef.current) return;
            const PADDING = 50; // pixels
            const { clientWidth, clientHeight } = workspaceContainerRef.current;
            const { width, height } = activeDesign.labelSettings;
            const availableWidth = clientWidth - PADDING * 2;
            const availableHeight = clientHeight - PADDING * 2;

            const zoomX = availableWidth / (width * 4); // PREVIEW_SCALE is 4
            const zoomY = availableHeight / (height * 4);
            const newZoom = Math.min(zoomX, zoomY);
            
            const newPanX = (clientWidth - (width * 4 * newZoom)) / 2;
            const newPanY = (clientHeight - (height * 4 * newZoom)) / 2;
            
            setWorkspaceState({ zoom: newZoom, pan: { x: newPanX, y: newPanY } });
        }
    };
    saveShortcutRef.current = appActions.onSave;

    // Small PNG of the on-screen label for the library grid. Best-effort: the
    // designer canvas is the first <canvas> in the workspace, and a failure
    // (tainted canvas, nothing drawn yet) just means "no thumbnail".
    const captureThumbnail = (): string | null => {
        const source = workspaceContainerRef.current?.querySelector('canvas');
        if (!source || source.width === 0 || source.height === 0) return null;
        try {
            const MAX = 320;
            const scale = Math.min(1, MAX / Math.max(source.width, source.height));
            const thumb = document.createElement('canvas');
            thumb.width = Math.max(1, Math.round(source.width * scale));
            thumb.height = Math.max(1, Math.round(source.height * scale));
            const ctx = thumb.getContext('2d');
            if (!ctx) return null;
            ctx.drawImage(source, 0, 0, thumb.width, thumb.height);
            return thumb.toDataURL('image/png');
        } catch { return null; }
    };
    
     const handleContextMenu = (e: React.MouseEvent, clickedField: Field | null) => {
        e.preventDefault();
        dispatch({ type: 'SET_CONTEXT_MENU', payload: null }); // Close any existing menu
        
        let options: ContextMenuOption[] = [];
        if (clickedField) {
             // If the clicked field isn't already selected (and shift isn't pressed),
             // select it — whole group included (Batch O: the context menu's
             // Cut/Copy/Duplicate/Delete must act on the same set a left-click
             // selected, not just the one right-clicked member).
            if (!selectedFieldIds.includes(clickedField.id) && !e.shiftKey) {
                dispatch({ type: 'SET_SELECTION', payload: expandIdsWithGroups(activeDesign.fields, [clickedField.id]) });
            }

            options = [
                { label: 'Cut', action: () => dispatch({ type: 'CUT_FIELD' }) },
                { label: 'Copy', action: () => dispatch({ type: 'COPY_FIELD' }) },
                { label: 'Paste', action: () => dispatch({ type: 'PASTE_FIELD' }), disabled: !clipboard },
                { separator: true },
                { label: 'Duplicate', action: () => dispatch({ type: 'DUPLICATE_SELECTED_FIELDS' }) },
                { label: 'Delete', action: () => dispatch({ type: 'DELETE_SELECTED_FIELDS' }) },
                { separator: true },
                { label: 'Group', action: () => dispatch({ type: 'GROUP_SELECTED_FIELDS' }), disabled: !canGroup },
                { label: 'Ungroup', action: () => dispatch({ type: 'UNGROUP_SELECTED_FIELDS' }), disabled: !canUngroup },
                { separator: true },
                { label: 'Bring to Front', action: () => dispatch({ type: 'BRING_TO_FRONT' }) },
                { label: 'Bring Forward', action: () => dispatch({ type: 'BRING_FORWARD' }) },
                { label: 'Send Backward', action: () => dispatch({ type: 'SEND_BACKWARD' }) },
                { label: 'Send to Back', action: () => dispatch({ type: 'SEND_TO_BACK' }) },
            ];
        } else {
             options = [
                { label: 'Paste', action: () => dispatch({ type: 'PASTE_FIELD' }), disabled: !clipboard },
                { label: 'Select All', action: () => dispatch({ type: 'SET_SELECTION', payload: activeDesign.fields.map(f => f.id) }) },
             ]
        }
        
        dispatch({ type: 'SET_CONTEXT_MENU', payload: { x: e.clientX, y: e.clientY, options } });
    };

    return (
        <div className="h-screen w-screen flex flex-col bg-gray-900 text-gray-200" onClick={() => dispatch({type: 'SET_CONTEXT_MENU', payload: null})}>
            <TopBar 
              designName={activeDesign.name}
              savedDesigns={savedDesigns}
              dispatch={dispatch}
              onNew={appActions.onNew}
              onTemplates={appActions.onTemplates}
              onLibrary={appActions.onLibrary} 
              onSave={appActions.onSave} 
              onLoad={appActions.onLoad} 
              onDelete={appActions.onDelete}
              onExport={appActions.onExport}
              onExportImage={appActions.onExportImage}
              exportingImage={exportingImage}
              canUndo={history.past.length > 0} 
              canRedo={history.future.length > 0}
              canCutCopy={selectedFieldIds.length > 0} 
              canPaste={!!clipboard && clipboard.length > 0}
              canAlign={canAlign}
              canDistribute={canDistribute}
              canGroup={canGroup}
              canUngroup={canUngroup}
              dirty={dirty}
              onImportDesign={appActions.onImportDesign}
              onHelp={() => setShowHelp(true)}
              onViewIpl={() => setShowIplViewer(true)}
              onPrintCenter={() => setShowPrintCenter(true)}
              workspaceState={workspaceState}
              setWorkspaceState={setWorkspaceState}
              onZoomToFit={appActions.onZoomToFit}
              snapSettings={snapSettings}
              onSnapSettingsChange={setSnapSettings}
            />
            {/* LeftPanel (240px) + RightPanel (288px) are flex-shrink-0 and the
                canvas is flex-1, so below 528px the canvas was squeezed to 0
                wide and the right panel was clipped off-screen with no way to
                reach it. The min-width floor plus x-scroll keeps the canvas
                renderable and every panel reachable on a narrow window. */}
            <main className="flex-1 flex overflow-x-auto overflow-y-hidden">
                <LeftPanel activeDesign={activeDesign} selectedFieldIds={selectedFieldIds} dispatch={dispatch} />
                <div ref={workspaceContainerRef} className="flex-1 flex flex-col bg-gray-900 items-center justify-center workspace-bg min-w-[240px]" style={{'--grid-size': `${25 * workspaceState.zoom}px`} as React.CSSProperties}>
                   <Workspace 
                     design={activeDesign} 
                     selectedFieldIds={selectedFieldIds} 
                     dispatch={dispatch} 
                     workspaceState={workspaceState} 
                     setWorkspaceState={setWorkspaceState} 
                     onContextMenu={handleContextMenu}
                     mouseCoords={mouseCoords}
                     setMouseCoords={setMouseCoords}
                     snapSettings={snapSettings}
                   />
                </div>
                <RightPanel activeDesign={activeDesign} selectedFieldIds={selectedFieldIds} dispatch={dispatch} />
            </main>
            {contextMenu && <ContextMenu {...contextMenu} onClose={() => dispatch({ type: 'SET_CONTEXT_MENU', payload: null })} />}
            <DialogHost />
            {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
            {showTemplates && <TemplateGallery onClose={() => setShowTemplates(false)} onPick={t => void appActions.onPickTemplate(t)} />}
            {showLibrary && <StartScreen
                revision={libraryRevision}
                onRevision={() => setLibraryRevision(r => r + 1)}
                onClose={() => setShowLibrary(false)}
                onNew={() => { setShowLibrary(false); void appActions.onNew(); }}
                onTemplates={() => { setShowLibrary(false); setShowTemplates(true); }}
                onOpen={name => void appActions.onLoad(name)}
            />}
            {showIplViewer && <IPLViewerModal onClose={() => setShowIplViewer(false)} onImportDesign={appActions.onImportDesign} />}
            {/* The job snapshots the SCREEN (intermediate ?? present), the same
                honesty rule Ctrl+S and the image exports follow: what is queued
                is what the user is looking at, not the last saved version. */}
            {showPrintCenter && <PrintCenter design={activeDesign} onClose={() => setShowPrintCenter(false)} />}
        </div>
    );
}
