import React, { useRef, useState, useEffect, useCallback, useLayoutEffect } from 'react';
import type { Design, WorkspaceState, DragMode, EditingState, Field, BoxField, TextField, BarcodeField, Alignment } from '../types';
import { PREVIEW_SCALE, SNAP_THRESHOLD, FONT_MAP, POINTS_TO_MM, DPI_MAP, GRID_SPACING_MM } from '../constants';
import { drawElements, getFieldBoundingBox, getHandleAtPos, isPointInRotatedRect } from '../services/canvasDrawer';
import { ensureBarcodesReady } from '../services/ipl/barcodes';
import { Rulers } from './Rulers';
import { getAxisAlignedBoundingBox, getObjectBoundingBox } from '../services/geometry';
import { isTurned, labelToScreen, screenToLabel, screenToLabelDelta } from '../services/stockFrame';
import { computeDragSelectionIds, snapRotation, expandIdsWithGroups, guideMmFromRuler } from '../services/dragMath';

const RULER_SIZE = 30;


export const Workspace: React.FC<{
    design: Design;
    selectedFieldIds: number[];
    dispatch: React.Dispatch<any>;
    workspaceState: WorkspaceState;
    setWorkspaceState: React.Dispatch<React.SetStateAction<WorkspaceState>>;
    onContextMenu: (e: React.MouseEvent, clickedField: Field | null) => void;
    mouseCoords: {x: number, y: number} | null;
    setMouseCoords: React.Dispatch<React.SetStateAction<{x: number, y: number} | null>>;
    snapSettings: { grid: boolean, objects: boolean };
}> = ({ design, selectedFieldIds, dispatch, workspaceState, setWorkspaceState, onContextMenu, mouseCoords, setMouseCoords, snapSettings }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const workspaceRef = useRef<HTMLDivElement>(null);
    const textInputRef = useRef<HTMLTextAreaElement>(null);
    
    const [dragMode, setDragMode] = useState<DragMode>(null);
    const [initialDragState, setInitialDragState] = useState<any>(null);
    const [editingState, setEditingState] = useState<EditingState | null>(null);
    const [snappingGuides, setSnappingGuides] = useState<{ x: number | null, y: number | null }>({ x: null, y: null });
    const [isSpaceDown, setIsSpaceDown] = useState(false);
    const [marquee, setMarquee] = useState<{ x: number, y: number, width: number, height: number } | null>(null);
    const [hoveredFieldId, setHoveredFieldId] = useState<number | null>(null);
    
    const [tick, setTick] = useState(0);
    const forceUpdate = useCallback(() => setTick(t => t + 1), []);

    const redrawCanvas = useCallback(() => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;
        const parent = canvas.parentElement;
        if (parent) {
            canvas.width = parent.clientWidth;
            canvas.height = parent.clientHeight;
        }
        drawElements(ctx, design, selectedFieldIds, workspaceState, snappingGuides, marquee, hoveredFieldId, forceUpdate);
    }, [design, selectedFieldIds, workspaceState, snappingGuides, marquee, hoveredFieldId, forceUpdate]);
    
    // `tick` is a dep on purpose: forceUpdate() changes no other input, so
    // without it the engine-ready redraw (Batch D) and any other
    // forceUpdate-triggered repaint would never re-run this effect.
    useLayoutEffect(() => { redrawCanvas() }, [redrawCanvas, tick]);

    // redrawCanvas only runs on design/state changes, so without this the
    // canvas keeps the size it had at mount and clips the design after a
    // window resize. The ref keeps the observer stable across re-renders, and
    // the size guard stops it from oscillating with the scrollbar it creates.
    const redrawCanvasRef = useRef(redrawCanvas);
    useEffect(() => { redrawCanvasRef.current = redrawCanvas; }, [redrawCanvas]);
    useEffect(() => {
        const parent = canvasRef.current?.parentElement;
        if (!parent) return;
        const observer = new ResizeObserver(() => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            if (canvas.width !== parent.clientWidth || canvas.height !== parent.clientHeight) {
                redrawCanvasRef.current();
            }
        });
        observer.observe(parent);
        return () => observer.disconnect();
    }, []);

    // Batch D: barcodes paint through the lazily-loaded bwip engine. Once it
    // resolves, force one redraw so placeholder boxes become real rasters
    // without waiting for the next interaction.
    useEffect(() => {
        let alive = true;
        ensureBarcodesReady().then(() => { if (alive) forceUpdate(); });
        return () => { alive = false; };
    }, [forceUpdate]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.code === 'Space' && !e.repeat) {
                if (document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
                    setIsSpaceDown(true);
                    e.preventDefault();
                }
            }
        };
        const handleKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space') setIsSpaceDown(false); };
        window.addEventListener('keydown', handleKeyDown); window.addEventListener('keyup', handleKeyUp);
        return () => { window.removeEventListener('keydown', handleKeyDown); window.removeEventListener('keyup', handleKeyUp); };
    }, []);

    useEffect(() => { 
        if (editingState && textInputRef.current) { 
            const textarea = textInputRef.current;
            textarea.focus(); 
            textarea.select();
            textarea.style.height = 'auto';
            textarea.style.height = `${textarea.scrollHeight}px`;
        } 
    }, [editingState]);

    const getMousePos = (e: React.MouseEvent<HTMLDivElement> | MouseEvent) => {
        const workspace = workspaceRef.current;
        if (!workspace) return { x: 0, y: 0 };
        const rect = workspace.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    
    // Mouse position is already in the same space the scene is painted in:
    // drawElements translates by the pan, it does not scroll the div, so
    // subtracting the pan here shifted every hit pan.x/pan.y (50px at the
    // default) away from the pixels under the cursor.
    const screenToCanvas = (pos: {x:number, y:number}) => ({ x: pos.x, y: pos.y });
    const canvasToMm = (pos: number) => pos / (PREVIEW_SCALE * workspaceState.zoom);
    const mmToCanvas = (pos: number) => pos * PREVIEW_SCALE * workspaceState.zoom;

    /**
     * Which orientation the stock is drawn in. The canvas turns a landscape
     * label a quarter (drawElements draws it through a 90° CCW context), so
     * every hit-test, marquee and drag delta has to be read in the same turned
     * frame or the pointer lands on the wrong field.
     */
    const stockIsTurned = (): boolean => isTurned(design.labelSettings);

    const stockSizePx = () => {
        const { width, height, orientation } = design.labelSettings;
        const landscape = orientation === 'landscape';
        return { w: mmToCanvas(landscape ? height : width), h: mmToCanvas(landscape ? width : height) };
    };

    /** A screen point as label-frame pixels (origin at the label's own top-left,
     *  no pan). This is the frame a field's x/y and the ruler read-out use, so
     *  points outside the label map outside its box — what a hit-test wants. */
    const stockPointPx = (canvasPos: {x:number, y:number}): {x:number, y:number} => {
        const { h } = stockSizePx();
        return screenToLabel(canvasPos, workspaceState.pan, stockIsTurned(), h);
    };

    /**
     * The same point in the frame `isPointInRotatedRect`/`getHandleAtPos`
     * expect. Those helpers locate a field's origin with `fieldOriginPx`, which
     * ALREADY adds the pan, so the point handed to them must carry it too —
     * passing a pan-less point subtracts the pan twice and every click misses.
     */
    const hitTestPoint = (canvasPos: {x:number, y:number}): {x:number, y:number} => {
        const p = stockPointPx(canvasPos);
        return { x: p.x + workspaceState.pan.x, y: p.y + workspaceState.pan.y };
    };


    const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
        if (e.button === 2) return; // Let context menu handle it
        if (editingState) return;
        workspaceRef.current?.focus();
        const mousePos = getMousePos(e);
        
        if (e.button === 1 || (e.button === 0 && isSpaceDown)) {
            setDragMode('pan');
            setInitialDragState({ pan: workspaceState.pan, mouseX: mousePos.x, mouseY: mousePos.y });
            e.preventDefault();
            return;
        }
        
        const canvasPos = screenToCanvas(mousePos);
        const stockPos = stockPointPx(canvasPos);
        const hitPos = hitTestPoint(canvasPos);
        const { zoom } = workspaceState;

        // Guide clicks. Guides are painted inside the panned transform
        // (canvasDrawer), so their screen position is mmToCanvas(pos) + pan.
        const clickThreshold = 5 / zoom;
        for (let i = 0; i < design.guides.vertical.length; i++) {
            if (Math.abs(canvasPos.x - (mmToCanvas(design.guides.vertical[i]) + workspaceState.pan.x)) < clickThreshold) {
                setDragMode('drag-guide-v');
                setInitialDragState({ index: i, initialPos: design.guides.vertical[i], mouseOffset: canvasToMm(canvasPos.x) - design.guides.vertical[i] });
                return;
            }
        }
        for (let i = 0; i < design.guides.horizontal.length; i++) {
            if (Math.abs(canvasPos.y - (mmToCanvas(design.guides.horizontal[i]) + workspaceState.pan.y)) < clickThreshold) {
                setDragMode('drag-guide-h');
                setInitialDragState({ index: i, initialPos: design.guides.horizontal[i], mouseOffset: canvasToMm(canvasPos.y) - design.guides.horizontal[i] });
                return;
            }
        }
        
        const ctx = canvasRef.current?.getContext('2d');
        if (!ctx) return;

        if (selectedFieldIds.length === 1) {
            const selectedField = design.fields.find(f => f.id === selectedFieldIds[0]);
            if (selectedField && !selectedField.locked) {
                const handle = getHandleAtPos(ctx, selectedField, design, hitPos.x, hitPos.y, workspaceState);
                if (handle) {
                    setDragMode(handle);
                    setInitialDragState({ field: structuredClone(selectedField), mouseX: mousePos.x, mouseY: mousePos.y });
                    return;
                }
            }
        }
        
        let clickedField = null;
        for (let i = design.fields.length - 1; i >= 0; i--) {
            const field = design.fields[i];
            if(field.visible !== false && isPointInRotatedRect(ctx, field, design, hitPos.x, hitPos.y, workspaceState)){
                clickedField = field;
                break;
            }
        }

        if (clickedField) {
            if (clickedField.locked) {
                 if (!e.shiftKey) dispatch({ type: 'SET_SELECTION', payload: [] });
                 return;
            }
            dispatch({ type: 'SELECT_FIELD', payload: { id: clickedField.id, shiftKey: e.shiftKey } });
            // Batch O: clicking any group member picks up the WHOLE group for
            // the drag too (the reducer's SELECT_FIELD expands identically).
            const futureSelectionIds = expandIdsWithGroups(design.fields, computeDragSelectionIds(clickedField.id, selectedFieldIds, e.shiftKey));
            // Batch O: group expansion may pull in LOCKED members (a field can
            // be locked after grouping). Locked fields highlight with the
            // group but never move — same protection contract as align/
            // distribute/delete, and the same reason the reducer's GROUP
            // excludes them from membership.
            const fieldsToDrag = design.fields.filter(f => futureSelectionIds.includes(f.id) && !f.locked);
            // Shift-click deselects the last field → nothing left to drag.
            // Entering 'move' with an empty field list made the next mousemove
            // read initialFields[0].x and crash the React tree.
            if (fieldsToDrag.length === 0) {
                setDragMode(null);
                setInitialDragState(null);
                return;
            }
            setDragMode('move');
            setInitialDragState({ fields: fieldsToDrag.map(f => structuredClone(f)), mouseX: mousePos.x, mouseY: mousePos.y });
            return;
        }

        if (!e.shiftKey) dispatch({ type: 'SET_SELECTION', payload: [] });
        setDragMode('marquee');
        setInitialDragState({ x: mousePos.x, y: mousePos.y });
    };
    
    const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
        const mousePos = getMousePos(e);
        const canvasPos = screenToCanvas(mousePos);
        const stockPos = stockPointPx(canvasPos);
        const hitPos = hitTestPoint(canvasPos);
        const { zoom, pan } = workspaceState;
        const scale = PREVIEW_SCALE * zoom;
        const { width, height, orientation } = design.labelSettings;
        const isLandscape = orientation === 'landscape';
        const displayWidth = isLandscape ? height : width;
        const displayHeight = isLandscape ? width : height;

        // The whole stock is the label: the printer gets one label of this size
        // (`<SI>W` sets the LABEL width, PRM p.131) and IPL has no ganging
        // command, so the canvas must not divide by Grid Columns/Rows — doing so
        // made the hit-test and the edge-snap targets a fraction of what prints.
        const templateWidth = displayWidth;
        const templateHeight = displayHeight;

        // Read through the stock frame, so the read-out matches the field
        // coordinates shown in the property panel rather than the turned pixels.
        const labelX = stockPos.x;
        const labelY = stockPos.y;
        if (labelX >= 0 && labelX <= templateWidth * scale && labelY >= 0 && labelY <= templateHeight * scale) {
            setMouseCoords({ x: canvasToMm(labelX), y: canvasToMm(labelY) });
        } else {
            setMouseCoords(null);
        }


        const ctx = canvasRef.current?.getContext('2d');
        const workspaceEl = workspaceRef.current;
        
        // Update cursor and hover state when not dragging
        if (!dragMode && ctx && workspaceEl) {
            let newCursor = isSpaceDown ? 'grabbing' : 'default';
            let fieldUnderCursor: Field | null = null;

            for (let i = design.fields.length - 1; i >= 0; i--) {
                const field = design.fields[i];
                if (field.visible !== false && isPointInRotatedRect(ctx, field, design, hitPos.x, hitPos.y, workspaceState)) {
                    fieldUnderCursor = field;
                    break;
                }
            }
            
            if (fieldUnderCursor && !fieldUnderCursor.locked) {
                setHoveredFieldId(fieldUnderCursor.id);
                newCursor = 'grab';

                if (selectedFieldIds.length === 1 && selectedFieldIds[0] === fieldUnderCursor.id) {
                     const handle = getHandleAtPos(ctx, fieldUnderCursor, design, hitPos.x, hitPos.y, workspaceState);
                     if (handle === 'rotate') newCursor = 'crosshair';
                     if (handle === 'resize-br') newCursor = 'se-resize';
                }

            } else {
                setHoveredFieldId(null);
            }
            workspaceEl.style.cursor = newCursor;
        }


        if (!dragMode || !initialDragState || !ctx || !workspaceEl) return;
        
        let dx = (mousePos.x - initialDragState.mouseX);
        let dy = (mousePos.y - initialDragState.mouseY);

        if (dragMode === 'pan') {
            setWorkspaceState(prev => ({ ...prev, pan: { x: initialDragState.pan.x + dx, y: initialDragState.pan.y + dy } }));
            return;
        }

        // Below here the DELTAS move things measured in label millimetres, and
        // the label may be drawn turned a quarter for landscape. A screen-right
        // drag has to become a label-down one there, or the field runs away
        // from the cursor. Rotating (dx,dy) by the same 90° CCW the canvas
        // draws with is the whole conversion.
        ({ x: dx, y: dy } = screenToLabelDelta({ x: dx, y: dy }, stockIsTurned()));
        
        if (dragMode === 'drag-guide-h' || dragMode === 'drag-guide-v') {
            const orientation = dragMode === 'drag-guide-h' ? 'horizontal' : 'vertical';
            // mousePos is in screen space (origin at the workspace div, which the
            // rulers share) while a guide's stored position is label millimetres.
            // The scene is painted pan pixels in, so the pan comes off first.
            const newPosMm = canvasToMm(orientation === 'horizontal' ? mousePos.y - pan.y : mousePos.x - pan.x) - initialDragState.mouseOffset;
            
            const guides = { ...design.guides };
            if (orientation === 'horizontal') {
                guides.horizontal = [...guides.horizontal];
                guides.horizontal[initialDragState.index] = newPosMm;
            } else {
                guides.vertical = [...guides.vertical];
                guides.vertical[initialDragState.index] = newPosMm;
            }
            dispatch({ type: 'UPDATE_INTERMEDIATE', payload: { guides } });
            return;
        }

        if (dragMode === 'marquee') {
            const x = Math.min(mousePos.x, initialDragState.x);
            const y = Math.min(mousePos.y, initialDragState.y);
            const width = Math.abs(mousePos.x - initialDragState.x);
            const height = Math.abs(mousePos.y - initialDragState.y);
            setMarquee({ x, y, width, height });
            return;
        }

        if (dragMode === 'move') {
            workspaceEl.style.cursor = 'grabbing';
            const { fields: initialFields } = initialDragState;
            
            const initialSelectionAABB = getAxisAlignedBoundingBox(initialFields, design);

            let finalDx = dx;
            let finalDy = dy;
            let guideX: number | null = null;
            let guideY: number | null = null;

            if (snapSettings.objects) {
                const staticFields = design.fields.filter(f => !selectedFieldIds.includes(f.id) && f.visible !== false);
                const labelEdgeField: BoxField = { id: -1, name: 'label', type: 'box', x: 0, y: 0, rotation: 0, width: templateWidth, height: templateHeight, thickness: 0 };
                const allTargets = [...staticFields, labelEdgeField];

                const targetSnapLines: { x: number[], y: number[] } = { x: [], y: [] };
                allTargets.forEach(target => {
                    const aabb = getAxisAlignedBoundingBox([target], design);
                    targetSnapLines.x.push(aabb.minX, aabb.minX + (aabb.maxX - aabb.minX) / 2, aabb.maxX);
                    targetSnapLines.y.push(aabb.minY, aabb.minY + (aabb.maxY - aabb.minY) / 2, aabb.maxY);
                });
                design.guides.vertical.forEach(g => targetSnapLines.x.push(g));
                design.guides.horizontal.forEach(g => targetSnapLines.y.push(g));

                const potentialAABB = {
                    minX: initialSelectionAABB.minX + dx / scale,
                    minY: initialSelectionAABB.minY + dy / scale,
                    maxX: initialSelectionAABB.maxX + dx / scale,
                    maxY: initialSelectionAABB.maxY + dy / scale,
                };
                const draggedSnapPoints = {
                    x: [potentialAABB.minX, (potentialAABB.minX + potentialAABB.maxX) / 2, potentialAABB.maxX],
                    y: [potentialAABB.minY, (potentialAABB.minY + potentialAABB.maxY) / 2, potentialAABB.maxY],
                };
                
                let minDiffX = canvasToMm(SNAP_THRESHOLD);
                 targetSnapLines.x.forEach(lineX => {
                     draggedSnapPoints.x.forEach(pointX => {
                         const diff = Math.abs(pointX - lineX);
                         if (diff < minDiffX) {
                             minDiffX = diff;
                             finalDx = dx + mmToCanvas(lineX - pointX);
                             guideX = mmToCanvas(lineX);
                         }
                     });
                 });
                 
                 let minDiffY = canvasToMm(SNAP_THRESHOLD);
                 targetSnapLines.y.forEach(lineY => {
                     draggedSnapPoints.y.forEach(pointY => {
                         const diff = Math.abs(pointY - lineY);
                         if (diff < minDiffY) {
                             minDiffY = diff;
                             finalDy = dy + mmToCanvas(lineY - pointY);
                             guideY = mmToCanvas(lineY);
                         }
                     });
                 });
            }
            
            if (snapSettings.grid) {
                const potentialX = initialFields[0].x + finalDx / scale;
                const potentialY = initialFields[0].y + finalDy / scale;

                if (guideX === null) {
                    const snappedX = Math.round(potentialX / GRID_SPACING_MM) * GRID_SPACING_MM;
                    if (Math.abs(potentialX - snappedX) < canvasToMm(SNAP_THRESHOLD)) {
                        finalDx = (snappedX - initialFields[0].x) * scale;
                    }
                }
                 if (guideY === null) {
                    const snappedY = Math.round(potentialY / GRID_SPACING_MM) * GRID_SPACING_MM;
                    if (Math.abs(potentialY - snappedY) < canvasToMm(SNAP_THRESHOLD)) {
                        finalDy = (snappedY - initialFields[0].y) * scale;
                    }
                }
            }

            setSnappingGuides({ x: guideX, y: guideY });

            const updatedFields = initialFields.map((field: Field) => ({
                id: field.id,
                x: field.x + finalDx / scale,
                y: field.y + finalDy / scale,
            }));
            dispatch({ type: 'UPDATE_INTERMEDIATE', payload: { fields: updatedFields } });

        } else if (dragMode === 'rotate') {
             const { field: initialField } = initialDragState;
             const aabb = getAxisAlignedBoundingBox([initialField], design);
             // The centre is computed in the LABEL's frame, so it must go
             // through the same quarter turn the canvas draws with before it
             // meets pointer coordinates — `+ pan` alone leaves the pivot off
             // by the label's height on a landscape canvas, and the drag then
             // measures its angle about a point that is not on the field.
             const centre = labelToScreen(
                 {
                     x: mmToCanvas(aabb.minX + (aabb.maxX - aabb.minX) / 2),
                     y: mmToCanvas(aabb.minY + (aabb.maxY - aabb.minY) / 2),
                 },
                 pan,
                 stockIsTurned(),
                 stockSizePx().h,
             );
             const fieldCenterX = centre.x;
             const fieldCenterY = centre.y;

             const startAngle = Math.atan2(initialDragState.mouseY - fieldCenterY, initialDragState.mouseX - fieldCenterX);
             const currentAngle = Math.atan2(mousePos.y - fieldCenterY, mousePos.x - fieldCenterX);
             
             let angleDiff = (currentAngle - startAngle) * 180 / Math.PI;
             // atan2 in a y-down screen measures CW-positive; rotation is now
             // stored CCW (Batch W), so negate — the handle follows the mouse.
             angleDiff = -angleDiff;
             // 90° steps only: IPL's f parameter is 0-3 (Field.rotation type),
             // 45° snapping emitted f0.5 which firmware rejects (audit T6).
             const updates = { rotation: snapRotation(initialField.rotation, angleDiff) };
             dispatch({ type: 'UPDATE_INTERMEDIATE', payload: { fields: [{ id: initialField.id, ...updates }] } });
        } else if (dragMode === 'resize-br') {
            const { field: initialField } = initialDragState;
            let updates: Partial<Field> = {};
            // Batch W: inverse of the CCW draw frame (ctx.rotate(-r)) is +r.
            const angle = initialField.rotation * Math.PI / 180;
            const rotatedDx = dx * Math.cos(angle) - dy * Math.sin(angle);
            const rotatedDy = dx * Math.sin(angle) + dy * Math.cos(angle);
            const initialBox = getObjectBoundingBox(initialField, design);

            const newWidthMm = Math.max(1, initialBox.width + rotatedDx / scale);
            const newHeightMm = Math.max(1, initialBox.height + rotatedDy / scale);
            
            switch (initialField.type) {
                case 'box':
                case 'ellipse':
                case 'polygon':
                case 'triangle': updates = { width: newWidthMm, height: newHeightMm }; break;
                // Images move mm only while dragging (cheap); the commit
                // re-samples the bitmap to the new dot grid once.
                case 'image': updates = { width: newWidthMm, height: newHeightMm }; break;
                case 'line': updates = { length: newWidthMm }; break;
                case 'text':
                    const isBitmap = FONT_MAP[(initialField as TextField).font]?.type === 'bitmap';
                    if (isBitmap) {
                         const h_mag = Math.max(1, Math.round((initialField as TextField).h_mag * (newHeightMm / initialBox.height)));
                         const w_mag = Math.max(1, Math.round((initialField as TextField).w_mag * (newWidthMm / initialBox.width)));
                         updates = { h_mag, w_mag };
                    } else {
                        const fontSize = Math.max(1, (initialField as TextField).fontSize * (newHeightMm / initialBox.height));
                        updates = { fontSize };
                    }
                    break;
                case 'barcode':
                     const w_mag = Math.max(1, Math.round((initialField as BarcodeField).w_mag * (newWidthMm / initialBox.width)));
                     const h_mag = Math.max(1, Math.round((initialField as BarcodeField).h_mag * (newHeightMm / initialBox.height)));
                     updates = { w_mag, h_mag };
                    break;
            }
             dispatch({ type: 'UPDATE_INTERMEDIATE', payload: { fields: [{ id: initialField.id, ...updates }] } });
        }
    };
    
    const handleMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
        if (e.button === 2) return;
        if (dragMode === 'marquee' && marquee) {
            // The marquee box is drawn in screen space but the fields it is
            // tested against live in the stock's own frame — which is turned a
            // quarter for landscape. Map the SCREEN corners of the box into
            // that frame (not the box's min/max, which a quarter turn swaps)
            // and compare in one space.
            const screenA = { x: marquee.x, y: marquee.y };
            const screenB = { x: marquee.x + marquee.width, y: marquee.y + marquee.height };
            const a = stockPointPx(screenA);
            const b = stockPointPx(screenB);
            const selRect = {
                x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
                w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y),
            };
            const ctx = canvasRef.current?.getContext('2d');
            if (ctx) {
                // Batch O: a marquee that catches any group member catches the
                // whole group (even the member outside the box). Locked and
                // hidden fields are excluded from the marquee pool by the
                // filter above, so a group can still be marquee-selected by
                // picking up its visible unlocked members.
                const rawIds = design.fields.filter(field => {
                    if (field.locked || field.visible === false) return false;
                    const aabb = getAxisAlignedBoundingBox([field], design);
                    const fieldRect = { x: mmToCanvas(aabb.minX), y: mmToCanvas(aabb.minY), width: mmToCanvas(aabb.maxX - aabb.minX), height: mmToCanvas(aabb.maxY - aabb.minY) };
                    return fieldRect.x < selRect.x + selRect.w && fieldRect.x + fieldRect.width > selRect.x && fieldRect.y < selRect.y + selRect.h && fieldRect.y + fieldRect.height > selRect.y;
                }).map(f => f.id);
                const idsToSelect = expandIdsWithGroups(design.fields, rawIds);
                dispatch({ type: 'SET_SELECTION', payload: e.shiftKey ? [...selectedFieldIds, ...idsToSelect.filter(id => !selectedFieldIds.includes(id))] : idsToSelect });
            }
        } else if (dragMode === 'drag-guide-h' || dragMode === 'drag-guide-v') {
            const orientation = dragMode === 'drag-guide-h' ? 'horizontal' : 'vertical';
            const mousePos = getMousePos(e);
            const isOverRuler = (orientation === 'horizontal' && mousePos.y < RULER_SIZE) || (orientation === 'vertical' && mousePos.x < RULER_SIZE);
            if (isOverRuler) {
                const newGuides = { ...design.guides };
                const guideArray = [...newGuides[orientation]];
                guideArray.splice(initialDragState.index, 1);
                newGuides[orientation] = guideArray;
                dispatch({ type: 'UPDATE_INTERMEDIATE', payload: { guides: newGuides }});
            }
             dispatch({ type: 'COMMIT_INTERMEDIATE' });
        } else if(dragMode && dragMode !== 'pan' && dragMode !== 'marquee') {
             dispatch({ type: 'COMMIT_INTERMEDIATE' });
        }
        setDragMode(null);
        setInitialDragState(null);
        setSnappingGuides({ x: null, y: null });
        setMarquee(null);
    };

    const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
        const mousePos = getMousePos(e);
        const canvasPos = screenToCanvas(mousePos);
        const stockPos = stockPointPx(canvasPos);
        const hitPos = hitTestPoint(canvasPos);
        const ctx = canvasRef.current?.getContext('2d');
        if (!ctx) return;
        for (let i = design.fields.length - 1; i >= 0; i--) {
            const field = design.fields[i];
            if (field.visible !== false && !field.locked && (field.type === 'text' || field.type === 'barcode') && isPointInRotatedRect(ctx, field, design, hitPos.x, hitPos.y, workspaceState)) {
                
                const dataSource = (field as TextField | BarcodeField).dataSource;
                if (dataSource.type === 'linked' || dataSource.type === 'date' || dataSource.type === 'time') return;
                
                let dataToEdit: string;
                if (dataSource.type === 'fixed') {
                    dataToEdit = dataSource.data;
                } else { 
                    dataToEdit = dataSource.defaultData;
                }

                dispatch({ type: 'SET_SELECTION', payload: [field.id] });
                const box = getFieldBoundingBox(ctx, field, design, workspaceState.zoom);
                setEditingState({ id: field.id, data: dataToEdit, x: field.x, y: field.y, width: box.width, height: box.height, rotation: field.rotation });
                return;
            }
        }
    };
    
    const handleTextEditCommit = (newData: string | null) => {
        if (editingState && newData !== null) {
            const field = design.fields.find(f => f.id === editingState.id) as TextField | BarcodeField | undefined;
            if (field) {
                 const currentDataSource = field.dataSource;
                 if (currentDataSource.type === 'fixed') {
                     dispatch({ type: 'UPDATE_INTERMEDIATE', payload: { fields: [{ id: editingState.id, dataSource: { ...currentDataSource, data: newData } }] } });
                 } else if (currentDataSource.type === 'variable') {
                     dispatch({ type: 'UPDATE_INTERMEDIATE', payload: { fields: [{ id: editingState.id, dataSource: { ...currentDataSource, defaultData: newData } }] } });
                 }
                 dispatch({ type: 'COMMIT_INTERMEDIATE' });
            }
        }
        setEditingState(null);
    };

    const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const { x, y } = getMousePos(e);
            const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
            const newZoom = Math.max(0.1, Math.min(10, workspaceState.zoom * zoomFactor));
            const mouseX_before_zoom = (x - workspaceState.pan.x) / workspaceState.zoom;
            const mouseY_before_zoom = (y - workspaceState.pan.y) / workspaceState.zoom;
            const newPanX = x - mouseX_before_zoom * newZoom;
            const newPanY = y - mouseY_before_zoom * newZoom;
            setWorkspaceState({ zoom: newZoom, pan: { x: newPanX, y: newPanY } });
        } else {
            // Pan with touchpad scroll
            e.preventDefault();
            setWorkspaceState(prev => ({ ...prev, pan: { x: prev.pan.x - e.deltaX, y: prev.pan.y - e.deltaY } }));
        }
    };

    const handleGuideDragStart = (orientation: 'horizontal' | 'vertical', e: React.MouseEvent<HTMLDivElement>) => {
        const mousePos = getMousePos(e);
        // Rulers.tsx paints its ticks RULER_SIZE further along than the canvas
        // paints the same millimetre, so a guide pulled off the ruler lands
        // RULER_SIZE away from its tick unless that width comes off first
        // (guideMmFromRuler).
        const alongRuler = orientation === 'horizontal' ? mousePos.y : mousePos.x;
        const panPx = orientation === 'horizontal' ? workspaceState.pan.y : workspaceState.pan.x;
        const position = guideMmFromRuler(alongRuler, panPx, RULER_SIZE, PREVIEW_SCALE * workspaceState.zoom);
        
        const newGuides = { ...design.guides };
        const guideArray = [...newGuides[orientation], position];
        guideArray.sort((a, b) => a - b);
        newGuides[orientation] = guideArray;
        const newIndex = newGuides[orientation].findIndex(p => p === position);

        dispatch({ type: 'UPDATE_INTERMEDIATE', payload: { guides: newGuides }});
        
        setDragMode(orientation === 'horizontal' ? 'drag-guide-h' : 'drag-guide-v');
        setInitialDragState({
            index: newIndex,
            initialPos: position,
            mouseOffset: 0
        });
    };

    const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        const mousePos = getMousePos(e);
        const canvasPos = screenToCanvas(mousePos);
        const stockPos = stockPointPx(canvasPos);
        const hitPos = hitTestPoint(canvasPos);
        const ctx = canvasRef.current?.getContext('2d');
        if (!ctx) return;
        let clickedField: Field | null = null;
         for (let i = design.fields.length - 1; i >= 0; i--) {
            const field = design.fields[i];
            if(field.visible !== false && isPointInRotatedRect(ctx, field, design, hitPos.x, hitPos.y, workspaceState)){
                clickedField = field;
                break;
            }
        }
        onContextMenu(e, clickedField);
    };

    return (
        <div className="relative w-full h-full flex flex-col">
            <Rulers workspaceState={workspaceState} rulerSize={RULER_SIZE} onGuideDragStart={handleGuideDragStart} />
            <div 
                ref={workspaceRef} tabIndex={-1}
                className="relative w-full h-full overflow-hidden outline-none"
                onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={(e) => { handleMouseUp(e); setHoveredFieldId(null); setMouseCoords(null); }} onWheel={handleWheel}
                onDoubleClick={handleDoubleClick}
                onContextMenu={handleContextMenu}
            >
                <canvas ref={canvasRef} />
                {editingState && (() => {
                    const field = design.fields.find(f => f.id === editingState.id);
                    if (!field || (field.type !== 'text' && field.type !== 'barcode')) return null;
                    const { zoom, pan } = workspaceState;
                    const ctx = canvasRef.current!.getContext('2d')!;
                    const box = getFieldBoundingBox(ctx, field, design, zoom);
                    let fieldRenderY = (field.y * PREVIEW_SCALE * zoom) + pan.y;
                    let isBitmap = false;
                    let fontSize = 14; 
                    let fontFamily = 'sans-serif';
                    if (field.type === 'text') {
                        const fontInfo = FONT_MAP[field.font];
                        isBitmap = fontInfo?.type === 'bitmap';
                        fontFamily = isBitmap ? 'monospace' : (fontInfo?.family || 'sans-serif');
                        if (isBitmap) {
                            const baseHeight = fontInfo.baseHeight || 9;
                            fontSize = (baseHeight * (PREVIEW_SCALE / DPI_MAP[design.printerSettings.dpi]) * zoom * field.h_mag);
                        } else {
                            fontSize = (field.fontSize * POINTS_TO_MM * PREVIEW_SCALE * zoom);
                        }
                    }
                    return (
                        <textarea
                            ref={textInputRef}
                            defaultValue={editingState.data}
                            onInput={(e) => { const textarea = e.currentTarget; textarea.style.height = 'auto'; textarea.style.height = `${textarea.scrollHeight}px`; }}
                            onBlur={(e) => handleTextEditCommit(e.target.value)}
                            onKeyDown={e => {
                               if (e.key === 'Escape') handleTextEditCommit(null);
                               else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur(); }
                            }}
                            style={{
                                position: 'absolute', left: `${(field.x * PREVIEW_SCALE * zoom) + pan.x}px`, top: `${fieldRenderY}px`,
                                width: `${Math.max(40, box.width + 4)}px`, minHeight: `${box.height}px`,
                                transform: `rotate(${-field.rotation}deg)`, transformOrigin: 'top left', border: '1px dashed #3b82f6',
                                outline: 'none', resize: 'none', zIndex: 10, background: 'rgba(30, 41, 59, 0.9)',
                                color: '#e5e7eb', font: `normal ${fontSize}px ${fontFamily}`, padding: 0, margin: 0,
                                overflow: 'hidden', whiteSpace: 'pre-wrap', lineHeight: 1.2
                            }}
                        />
                    );
                })()}
                 {mouseCoords && (
                    <div className="absolute top-2 right-2 bg-gray-900/50 text-white text-xs px-2 py-1 rounded-md pointer-events-none tabular-nums">
                        X: {mouseCoords.x.toFixed(1)}mm, Y: {mouseCoords.y.toFixed(1)}mm
                    </div>
                 )}
                 {(() => {
                    // Fase 3: the alignment actions live in the reducer already
                    // (and in the top bar). This puts the same actions next to
                    // the selection they act on, so a multi-select doesn't make
                    // the user hunt up to the header. Hidden for one field,
                    // because alignment needs at least two.
                    if (selectedFieldIds.length < 2) return null;
                    const selected = design.fields.filter(f => selectedFieldIds.includes(f.id));
                    if (selected.length < 2) return null;
                    const box = getAxisAlignedBoundingBox(selected, design);
                    const { zoom, pan } = workspaceState;
                    const left = box.minX * PREVIEW_SCALE * zoom + pan.x;
                    const top = box.minY * PREVIEW_SCALE * zoom + pan.y;
                    const right = box.maxX * PREVIEW_SCALE * zoom + pan.x;
                    const cx = (left + right) / 2;
                    const unlocked = selected.filter(f => !f.locked).length;
                    const btn = (icon: string, title: string, action: () => void, disabled = false) => (
                        <button key={title} type="button" title={title} disabled={disabled} onMouseDown={e => e.stopPropagation()} onClick={action}
                            className="p-1 rounded hover:bg-gray-700 disabled:opacity-30 disabled:hover:bg-transparent">
                            <span className="material-icons text-base leading-none">{icon}</span>
                        </button>
                    );
                    const align = (alignment: Alignment) => dispatch({ type: 'ALIGN_SELECTED_FIELDS', payload: { alignment } });
                    const distribute = (axis: 'horizontal' | 'vertical') => dispatch({ type: 'DISTRIBUTE_SELECTED_FIELDS', payload: { axis } });
                    return (
                        <div role="toolbar" aria-label="Align selection"
                            onMouseDown={e => e.stopPropagation()}
                            className="absolute z-20 flex items-center gap-0.5 bg-gray-800 border border-gray-600 rounded-md shadow-lg p-0.5 text-gray-200"
                            style={{ left: `${cx}px`, top: `${top}px`, transform: 'translate(-50%, calc(-100% - 8px))' }}>
                            {btn('align_horizontal_left', 'Align Left', () => align('left'))}
                            {btn('align_horizontal_center', 'Align Horizontal Center', () => align('hcenter'))}
                            {btn('align_horizontal_right', 'Align Right', () => align('right'))}
                            <span className="h-4 border-l border-gray-600 mx-0.5" />
                            {btn('align_vertical_top', 'Align Top', () => align('top'))}
                            {btn('align_vertical_center', 'Align Vertical Middle', () => align('vmiddle'))}
                            {btn('align_vertical_bottom', 'Align Bottom', () => align('bottom'))}
                            <span className="h-4 border-l border-gray-600 mx-0.5" />
                            {btn('arrow_range', 'Distribute horizontally (needs 3)', () => distribute('horizontal'), unlocked < 3)}
                            {btn('height', 'Distribute vertically (needs 3)', () => distribute('vertical'), unlocked < 3)}
                        </div>
                    );
                 })()}
            </div>
        </div>
    );
};