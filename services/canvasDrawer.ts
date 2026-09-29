import type { Field, Design, WorkspaceState, DragMode, TextField, BarcodeField, FieldDataSource, DataSource, LineField, BoxField, ImageField, EllipseField, PolygonField, TriangleField } from '../types';
import { getFormattedDateTime } from './dateTimeFormat';
import { resolveLinkedPreview, applyTransform, fieldIsSuppressed, groupIsSuppressed } from './tableSource';
import { DPI_MAP, FONT_MAP, FONT_FAMILIES, BARCODE_MAP, POINTS_TO_MM, PREVIEW_SCALE, bitmapTextWidthDots, UNPRINTABLE_MARGIN_MM } from '../constants';
import { validateBarcode } from './validator';
import { measureBarcode, paintBarcode, isBarcodeEngineReady } from './ipl/barcodes';
import { getUploadedFontMetrics } from './ipl/fontMetrics';
import { designerBarcodeRender } from './designerBarcode';
import { paintFixedCellText } from './fixedCellText';

export const HANDLE_SIZE = 8;
export const ROTATION_HANDLE_OFFSET = 20;

// Row-bitmap ('1'/'0' strings) -> transparent-ink raster, cached per bitmap
// array identity (state is immutable, so refs are stable). A 2400-dot logo
// drawn dot-by-dot with fillRect would sink the mousemove hot path; this is
// one putImageData per import and a GPU blit per frame.
const bitmapCanvasCache = new WeakMap<string[], HTMLCanvasElement>();
export const getBitmapCanvas = (rows: string[]): HTMLCanvasElement => {
    let c = bitmapCanvasCache.get(rows);
    if (c) return c;
    const h = rows.length;
    const w = h ? rows[0].length : 0;
    c = document.createElement('canvas');
    c.width = Math.max(1, w);
    c.height = Math.max(1, h);
    const ctx = c.getContext('2d');
    if (ctx && w > 0 && h > 0) {
        const img = ctx.createImageData(w, h);
        for (let y = 0; y < h; y++) {
            const row = rows[y];
            for (let x = 0; x < w; x++) {
                if (row.charCodeAt(x) === 49 /* '1' */) {
                    const i = (y * w + x) * 4;
                    img.data[i + 3] = 255; // black ink; RGB stays 0
                }
            }
        }
        ctx.putImageData(img, 0, 0);
    }
    bitmapCanvasCache.set(rows, c);
    return c;
};

/**
 * Fase 3: the outline of an ellipse, polygon or triangle, in the field's own
 * pixel box. Shared by the screen draw and kept in step with
 * shapeToIplGraphicData (services/iplGenerator.ts) — a vertex straight up, so a
 * square reads as a diamond and a triangle points up. The two must agree or the
 * screen shows a shape the printer will not produce.
 */
const traceShape = (ctx: CanvasRenderingContext2D, field: EllipseField | PolygonField | TriangleField, w: number, h: number): void => {
    ctx.beginPath();
    if (field.type === 'ellipse') {
        ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    } else if (field.type === 'triangle') {
        ctx.moveTo(w / 2, 0);
        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.closePath();
    } else {
        const sides = Math.max(3, Math.round(field.sides));
        for (let i = 0; i < sides; i++) {
            const a = -Math.PI / 2 + (i * 2 * Math.PI) / sides;
            const px = w / 2 + (w / 2) * Math.cos(a);
            const py = h / 2 + (h / 2) * Math.sin(a);
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
    }
};

/** Resolve a FontDef family key to its shared CSS stack (constants.ts:
 * Liberation-first so the designer preview, the viewer and golden renders
 * measure the same face on every host). */
const cssFontStack = (family: string): string =>
    FONT_FAMILIES[family as keyof typeof FONT_FAMILIES] ?? family;

const getLineHeight = (ctx: CanvasRenderingContext2D, field: TextField, dpi: Design['printerSettings']['dpi'], zoom: number): number => {
    const dotSizePx = (PREVIEW_SCALE / DPI_MAP[dpi]) * zoom;
    const fontInfo = FONT_MAP[field.font];
    const isBitmap = fontInfo?.type === 'bitmap';
    if (isBitmap) {
        const baseHeight = fontInfo.baseHeight || 9;
        return baseHeight * dotSizePx * field.h_mag;
    } else {
        // Batch V: outline leading unified with the viewer print path
        // (renderer.ts lineH = hPx × 1.15; real Liberation hhea metrics are
        // 1.11–1.13em). The old 1.35 drew multi-line text ~17% looser on
        // screen than it prints.
        const fontSize = field.fontSize * POINTS_TO_MM * PREVIEW_SCALE * zoom;
        return fontSize * 1.15;
    }
};


const getFieldData = (field: TextField | BarcodeField, design: Design): string => {
    const { dataSource } = field;
    if (dataSource.type === 'fixed') return dataSource.data;
    if (dataSource.type === 'variable') return dataSource.defaultData;
     if (dataSource.type === 'date' || dataSource.type === 'time') {
        return getFormattedDateTime(dataSource.type, dataSource.format);
    }
    if (dataSource.type === 'linked') {
        const source = design.dataSources.find(ds => ds.id === dataSource.sourceId);
        const resolved = resolveLinkedPreview(source, dataSource, field.name);
        if (resolved === null) return '[unlinked]';
        return dataSource.transform ? applyTransform(dataSource.transform, resolved, design).result : resolved;
    }
    return '';
};

const getHriAboveOffset = (field: BarcodeField, design: Design, zoom: number): number => {
    const data = getFieldData(field, design);
    const validationError = validateBarcode(data, field.symbology);
    if (field.humanReadable !== 'above' || validationError) {
        return 0;
    }
    const { dpi } = design.printerSettings;
    const dotSizePx = (PREVIEW_SCALE / DPI_MAP[dpi]) * zoom;
    
    const hriFontSize = (field.hriFontSize || 10) * POINTS_TO_MM * PREVIEW_SCALE * zoom;
    const hriOffset = 2 * dotSizePx;

    return hriFontSize + hriOffset;
};


export const getFieldBoundingBox = (ctx: CanvasRenderingContext2D, field: Field, design: Design, zoom: number): { width: number; height: number } => {
    const { printerSettings: { dpi } } = design;
    const dotSizePx = (PREVIEW_SCALE / DPI_MAP[dpi]) * zoom;
    let width = 0, height = 0;
    const scale = PREVIEW_SCALE * zoom;

    switch (field.type) {
        case 'text': {
            const data = getFieldData(field as TextField, design);
            const lines = data.split('\n');
            const fontInfo = FONT_MAP[(field as TextField).font];
            const isBitmap = fontInfo?.type === 'bitmap';
            
            const lineHeight = getLineHeight(ctx, field as TextField, dpi, zoom);
            height = lines.length > 0 ? (lines.length * lineHeight) - (lineHeight * 0.2) : lineHeight; // Adjust for better fit

            if (isBitmap) {
                let maxChars = 0;
                lines.forEach(line => {
                    maxChars = Math.max(maxChars, line.length);
                });
                // Advance-based width (cell + gap, last gap dropped) — the same
                // formula the viewer renderer and geometry.ts use (audit T1).
                width = bitmapTextWidthDots((field as TextField).font, maxChars, (field as TextField).w_mag) * dotSizePx;
            } else { // Outline font
                // An uploaded face is stored under its own name, which FONT_MAP
                // does not know, so it resolves to the stack it was registered
                // under rather than to a resident family.
                const uploaded = getUploadedFontMetrics((field as TextField).font);
                const fontFamily = uploaded?.cssFamily || fontInfo?.family || 'sans-serif';
                const fontSize = (field as TextField).fontSize * POINTS_TO_MM * PREVIEW_SCALE * zoom;
                ctx.font = `normal ${fontSize}px ${cssFontStack(fontFamily)}`;
                // `c n,m` widens the run by m dots per GAP (n − 1 of them), so
                // the box has to include them — the draw path applies the same
                // spacing per glyph.
                const gapPx = ((field as TextField).intercharGapDots ?? 0) * dotSizePx;
                let maxWidth = 0;
                lines.forEach(line => {
                    const measuredWidth = line.length > 0 ? ctx.measureText(line).width : 0;
                    maxWidth = Math.max(maxWidth, measuredWidth + gapPx * Math.max(0, line.length - 1));
                });
                width = maxWidth;
            }
            break;
        }
        case 'barcode': {
            const data = getFieldData(field as BarcodeField, design);
            const barHeight = (field as BarcodeField).h_mag * dotSizePx;
            const validationError = validateBarcode(data, (field as BarcodeField).symbology);

            if (validationError || !data || !isBarcodeEngineReady()) {
                width = Math.max(100 * zoom, ((field as BarcodeField).w_mag * 50) * dotSizePx);
                height = barHeight;
            } else {
                // Batch D: measure with the shared encoder — the designer box
                // is now exactly the viewer's rendered extent (per-symbology
                // sizing rules in designerBarcodeRender).
                const r = designerBarcodeRender(field as BarcodeField, data);
                const measure = measureBarcode(r.symbology, r.data, r.params);
                if (measure) {
                    width = measure.widthModules * Math.max(1, r.moduleDots) * dotSizePx;
                    height = (measure.isMatrix
                        ? Math.max(r.heightDots, measure.heightPx * Math.max(1, r.moduleDots))
                        : r.heightDots) * dotSizePx;
                } else {
                    // Invalid data with the engine up: keep the same minimum
                    // as the not-ready fallback so the error box never
                    // collapses narrower than its own text.
                    width = Math.max(100 * zoom, ((field as BarcodeField).w_mag * 50) * dotSizePx);
                    height = barHeight;
                }
            }
             if ((field as BarcodeField).humanReadable !== 'none' && !validationError) {
                const hriFontSize = ((field as BarcodeField).hriFontSize || 10) * POINTS_TO_MM * PREVIEW_SCALE * zoom;
                const hriOffset = 2 * dotSizePx;
                height += hriFontSize + hriOffset;
            }
            break;
        }
        case 'line': width = (field as LineField).length * scale; height = (field as LineField).thickness * scale; break;
        case 'box':
            width = (field as BoxField).width * scale;
            height = (field as BoxField).height * scale;
            break;
        case 'ellipse':
        case 'polygon':
        case 'triangle':
            width = (field as EllipseField).width * scale;
            height = (field as EllipseField).height * scale;
            break;
        case 'image':
            width = (field as ImageField).width * scale;
            height = (field as ImageField).height * scale;
            break;
    }
    return { width, height };
};

/** Screen position of a field's anchor. drawElements translates the whole
 *  scene by the canvas pan before painting and the mouse handlers pass raw
 *  screen points, so the pan belongs here too — without it every click lands
 *  pan.x/pan.y (50px at the default) off the pixels under the cursor. */
const fieldOriginPx = (field: Field, workspace: WorkspaceState) => ({
    fieldX: field.x * PREVIEW_SCALE * workspace.zoom + workspace.pan.x,
    fieldY: field.y * PREVIEW_SCALE * workspace.zoom + workspace.pan.y,
});

export const isPointInRotatedRect = (ctx: CanvasRenderingContext2D, field: Field, design: Design, px: number, py: number, workspace: WorkspaceState): boolean => {
    const { zoom } = workspace;
    const box = getFieldBoundingBox(ctx, field, design, zoom);

    const { fieldX, fieldY } = fieldOriginPx(field, workspace);
    
    // Translate point to be relative to the field's origin
    const translatedPx = px - fieldX;
    const translatedPy = py - fieldY;
    
    // Rotate the point in the opposite direction of the field's rotation.
    // Batch W: the field frame rotates CCW (ctx.rotate(-r)) to match the
    // printer's f-semantics, so the inverse is +r.
    const angle = field.rotation * Math.PI / 180;
    const rotatedPx = translatedPx * Math.cos(angle) - translatedPy * Math.sin(angle);
    const rotatedPy = translatedPx * Math.sin(angle) + translatedPy * Math.cos(angle);

    let localYStart = 0;
    if (field.type === 'barcode' && (field as BarcodeField).humanReadable === 'above') {
        localYStart = -getHriAboveOffset(field as BarcodeField, design, zoom);
    }
    
    let localXStart = 0;
    if (field.type === 'text') {
        const align = (field as TextField).align || 'left';
        if (align === 'center') localXStart = -box.width / 2;
        if (align === 'right') localXStart = -box.width;
    }


    // Check if the rotated point is within the unrotated bounding box
    return rotatedPx >= localXStart && rotatedPx <= localXStart + box.width && rotatedPy >= localYStart && rotatedPy <= localYStart + box.height;
};

export const getHandleAtPos = (ctx: CanvasRenderingContext2D, field: Field, design: Design, px: number, py: number, workspace: WorkspaceState): DragMode => {
    const { zoom } = workspace;
    const box = getFieldBoundingBox(ctx, field, design, zoom);

    const { fieldX, fieldY } = fieldOriginPx(field, workspace);
    
    // Transform the mouse coordinates into the local, unrotated space of the
    // rectangle. Batch W: inverse of the CCW draw frame (ctx.rotate(-r)) is +r.
    const angle = field.rotation * Math.PI / 180;
    const translatedPx = px - fieldX;
    const translatedPy = py - fieldY;
    const rotatedPx = translatedPx * Math.cos(angle) - translatedPy * Math.sin(angle);
    const rotatedPy = translatedPx * Math.sin(angle) + translatedPy * Math.cos(angle);

    let localYStart = 0;
    if (field.type === 'barcode' && (field as BarcodeField).humanReadable === 'above') {
        localYStart = -getHriAboveOffset(field as BarcodeField, design, zoom);
    }
    
    let localXStart = 0;
    if (field.type === 'text') {
        const align = (field as TextField).align || 'left';
        if (align === 'center') localXStart = -box.width / 2;
        if (align === 'right') localXStart = -box.width;
    }


    // Check for resize handle (bottom-right corner)
    if (rotatedPx > localXStart + box.width - HANDLE_SIZE && rotatedPx < localXStart + box.width + HANDLE_SIZE && rotatedPy > localYStart + box.height - HANDLE_SIZE && rotatedPy < localYStart + box.height + HANDLE_SIZE) {
        return 'resize-br';
    }

    // Check for rotation handle. Everything else in this local space is in
    // screen px (box, localXStart, HANDLE_SIZE), so ROTATION_HANDLE_OFFSET has
    // to be scaled once, not the whole sum — and drawSelectionBox translates by
    // (localXStart, localYStart) before painting the circle at
    // -OFFSET*zoom, which this must match.
    const rotHandleY = localYStart - ROTATION_HANDLE_OFFSET * zoom;
    if (Math.hypot(rotatedPx - (localXStart + box.width / 2), rotatedPy - rotHandleY) < HANDLE_SIZE * 1.5) {
        return 'rotate';
    }

    return null;
};

const drawSelectionBox = (ctx: CanvasRenderingContext2D, box: { width: number; height: number }, zoom: number) => {
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)'; // blue-500
    ctx.lineWidth = 1 / zoom;
    ctx.setLineDash([4 / zoom, 2 / zoom]);
    ctx.strokeRect(0, 0, box.width, box.height);
    ctx.setLineDash([]);
    
    const handleSize = HANDLE_SIZE;
    ctx.fillStyle = 'rgba(59, 130, 246, 0.9)';
    ctx.fillRect(box.width - handleSize / 2, box.height - handleSize / 2, handleSize, handleSize);

    const rotHandleY = -ROTATION_HANDLE_OFFSET;
    ctx.beginPath();
    ctx.moveTo(box.width / 2, 0);
    ctx.lineTo(box.width / 2, rotHandleY * zoom);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(box.width / 2, rotHandleY * zoom, handleSize / 2, 0, 2 * Math.PI);
    ctx.fill();
};

const drawHoverHighlight = (ctx: CanvasRenderingContext2D, box: { width: number; height: number }, zoom: number) => {
    ctx.strokeStyle = 'rgba(96, 165, 250, 0.7)'; // blue-400
    ctx.lineWidth = 1.5 / zoom;
    ctx.strokeRect(0, 0, box.width, box.height);
}

const drawSnappingGuides = (ctx: CanvasRenderingContext2D, guides: { x: number | null; y: number | null }) => {
    if (guides.x === null && guides.y === null) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0); 
    ctx.strokeStyle = 'rgba(236, 72, 153, 0.8)'; // pink-500
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 3]);

    if (guides.x !== null) {
        ctx.beginPath();
        ctx.moveTo(guides.x, 0);
        ctx.lineTo(guides.x, ctx.canvas.height);
        ctx.stroke();
    }
    if (guides.y !== null) {
        ctx.beginPath();
        ctx.moveTo(0, guides.y);
        ctx.lineTo(ctx.canvas.width, guides.y);
        ctx.stroke();
    }
    ctx.restore();
};

const drawMarquee = (ctx: CanvasRenderingContext2D, marquee: { x: number; y: number; width: number; height: number } | null) => {
    if (!marquee) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(59, 130, 246, 0.1)';
    ctx.fillRect(marquee.x, marquee.y, marquee.width, marquee.height);
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.8)';
    ctx.lineWidth = 1;
    ctx.strokeRect(marquee.x, marquee.y, marquee.width, marquee.height);
    ctx.restore();
}

const drawRulerGuides = (ctx: CanvasRenderingContext2D, design: Design, workspace: WorkspaceState) => {
    const { guides } = design;
    const { zoom } = workspace;
    const scale = PREVIEW_SCALE * zoom;

    ctx.save();
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.7)'; // cyan-400
    ctx.lineWidth = 1 / zoom;
    
    guides.vertical.forEach(xPos => {
        const canvasX = xPos * scale;
        ctx.beginPath();
        ctx.moveTo(canvasX, 0);
        ctx.lineTo(canvasX, ctx.canvas.height / zoom); // Draw across the entire panned area
        ctx.stroke();
    });

    guides.horizontal.forEach(yPos => {
        const canvasY = yPos * scale;
        ctx.beginPath();
        ctx.moveTo(0, canvasY);
        ctx.lineTo(ctx.canvas.width / zoom, canvasY); // Draw across the entire panned area
        ctx.stroke();
    });
    ctx.restore();
};

/**
 * Fase 3: the band along each edge the print head cannot reach, as a dashed
 * rectangle inset from the label edge. Drawn inside the label clip, so the
 * hatching stops at the stock. A model with no published head (Generic) has a
 * zero inset and draws nothing.
 */
const drawUnprintableMargin = (ctx: CanvasRenderingContext2D, design: Design, workspace: WorkspaceState) => {
    const insetMm = UNPRINTABLE_MARGIN_MM[design.printerSettings.model] ?? 0;
    if (insetMm <= 0) return;
    const { width, height, columns, rows } = design.labelSettings;
    const scale = PREVIEW_SCALE * workspace.zoom;
    const labelW = (width / (columns || 1)) * scale;
    const labelH = (height / (rows || 1)) * scale;
    const inset = insetMm * scale;
    // A label smaller than twice the inset has no printable area left to mark.
    if (labelW <= inset * 2 || labelH <= inset * 2) return;

    ctx.save();
    ctx.strokeStyle = 'rgba(251, 146, 60, 0.9)'; // orange-400
    ctx.lineWidth = 1 / workspace.zoom;
    ctx.setLineDash([4 / workspace.zoom, 3 / workspace.zoom]);
    ctx.strokeRect(inset, inset, labelW - inset * 2, labelH - inset * 2);
    ctx.restore();
};

export const drawElements = (
    ctx: CanvasRenderingContext2D,
    design: Design,
    selectedFieldIds: number[],
    workspace: WorkspaceState,
    snappingGuides: { x: number | null; y: number | null },
    marquee: { x: number; y: number; width: number; height: number } | null,
    hoveredFieldId: number | null,
    redrawCanvas?: () => void
) => {
    const { fields, labelSettings, printerSettings } = design;
    const { dpi } = printerSettings;
    const { zoom, pan } = workspace;

    ctx.clearRect(0,0, ctx.canvas.width, ctx.canvas.height);
    
    ctx.save();
    ctx.translate(pan.x, pan.y);

    const { width, height, columns, rows } = labelSettings;

    const templateWidth = width / (columns || 1);
    const templateHeight = height / (rows || 1);
    const labelWidthPx = templateWidth * PREVIEW_SCALE * zoom;
    const labelHeightPx = templateHeight * PREVIEW_SCALE * zoom;

    ctx.fillStyle = 'white';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 15 * zoom;
    ctx.fillRect(0, 0, labelWidthPx, labelHeightPx);
    ctx.shadowColor = 'transparent';

    ctx.save();
    // Clip drawing to the label boundaries
    ctx.beginPath();
    ctx.rect(0, 0, labelWidthPx, labelHeightPx);
    ctx.clip();
    
    drawRulerGuides(ctx, design, workspace);
    drawUnprintableMargin(ctx, design, workspace);
    
    fields.forEach(field => {
        if (field.visible === false) return;
        // Fase 4: a field whose suppression condition holds prints nothing, so
        // the preview must show nothing too. The field stays selectable — the
        // selection outline is drawn separately — so it can still be edited.
        if (fieldIsSuppressed(field, design) || groupIsSuppressed(field.groupId, design)) return;
        
        ctx.save();
        ctx.translate(field.x * PREVIEW_SCALE * zoom, field.y * PREVIEW_SCALE * zoom);
        // Batch W: CCW — the printer rotates fields counterclockwise (DevGuide
        // p.27), and the viewer's applyFieldTransform agrees; the designer's
        // former CW draw made rotated fields print elsewhere than displayed.
        ctx.rotate(-field.rotation * Math.PI / 180);
        const dotSizePx = (PREVIEW_SCALE / DPI_MAP[dpi]) * zoom;

        switch (field.type) {
            case 'text': {
                const data = getFieldData(field, design);
                const fontInfo = FONT_MAP[field.font];
                const isBitmap = fontInfo?.type === 'bitmap';
                const baseHeight = isBitmap ? (fontInfo.baseHeight || 9) : 0;
                const fontFamily = isBitmap ? 'monospace' : (getUploadedFontMetrics(field.font)?.cssFamily || fontInfo?.family || 'sans-serif');
                const fontSize = isBitmap ? (baseHeight * dotSizePx * field.h_mag) : (field.fontSize * POINTS_TO_MM * PREVIEW_SCALE * zoom);
                ctx.font = `normal ${fontSize}px ${cssFontStack(fontFamily)}`;
                ctx.fillStyle = 'black';
                ctx.textBaseline = 'top';
                
                const align = field.align || 'left';
                ctx.textAlign = 'left'; // Always draw from left, we calculate the offset
                const box = getFieldBoundingBox(ctx, field, design, zoom);
                // Batch W: align shifts the whole text BLOCK relative to the
                // anchor — exactly what isPointInRotatedRect, the selection
                // overlay and getAxisAlignedBoundingBox already assume, and
                // what the generator bakes into the print origin. Lines stay
                // flush-left inside the block: IPL has no alignment, the
                // printer can only move origins, so per-line centering (the
                // old draw) was a screen-only illusion the export broke.
                const blockX = align === 'center' ? -box.width / 2 : align === 'right' ? -box.width : 0;

                const lines = data.split('\n');
                const lineHeight = getLineHeight(ctx, field, dpi, zoom);

                lines.forEach((line, index) => {
                    const yPos = index * lineHeight;
                    const drawX = blockX;

                     if (isBitmap) {
                        // The printer's cell pitch, not the host face's own
                        // advance — shared with the viewer renderer so the
                        // screen and the print cannot drift apart again
                        // (services/fixedCellText.ts).
                        ctx.save();
                        ctx.translate(drawX, yPos);
                        paintFixedCellText(
                            ctx, [line],
                            (fontInfo?.baseWidth ?? 7) * field.w_mag * dotSizePx,
                            ((fontInfo?.baseWidth ?? 7) + (field.intercharGapDots ?? fontInfo?.gapWidth ?? 2)) * field.w_mag * dotSizePx,
                            lineHeight,
                        );
                        ctx.restore();
                    } else if (field.intercharGapDots !== undefined) {
                        // `c n,m` on an outline face: m dots between glyphs,
                        // measured with the same helper the field's own box
                        // uses so the screen matches the print (and the
                        // selection box).
                        const gapPx = field.intercharGapDots * dotSizePx;
                        let cx = drawX;
                        for (const ch of line) {
                            ctx.fillText(ch, cx, yPos);
                            cx += ctx.measureText(ch).width + gapPx;
                        }
                    } else {
                        ctx.fillText(line, drawX, yPos);
                    }
                });
                break;
            }
            case 'barcode': {
                const data = getFieldData(field, design);
                const validationError = validateBarcode(data, field.symbology);

                let barcodeWidth = 0;
                let barcodeHeight = 0;

                ctx.save();
                let yOffset = 0;
                if (field.humanReadable === 'above' && !validationError) {
                    yOffset = getHriAboveOffset(field, design, zoom);
                    ctx.translate(0, yOffset);
                }

                // Batch D: paint through the shared bwip encoder (identical
                // raster to the viewer). designerBarcodeRender mirrors the
                // PRM sizing rules (POSTNET magnification, fixed-size codes).
                if (!validationError && data && isBarcodeEngineReady()) {
                    const r = designerBarcodeRender(field, data);
                    const measure = measureBarcode(r.symbology, r.data, r.params);
                    if (measure) {
                        const painted = paintBarcode(ctx, r.symbology, r.data, 0, 0, dotSizePx, r.moduleDots, r.heightDots, r.params);
                        if (painted) {
                            barcodeWidth = measure.widthModules * Math.max(1, r.moduleDots) * dotSizePx;
                            barcodeHeight = (measure.isMatrix
                                ? Math.max(r.heightDots, measure.heightPx * Math.max(1, r.moduleDots))
                                : r.heightDots) * dotSizePx;
                        }
                    }
                }
                
                if (barcodeWidth === 0) { // Fallback for invalid data or no data
                    const box = getFieldBoundingBox(ctx, field, design, zoom);
                    barcodeWidth = box.width;
                    barcodeHeight = field.h_mag * dotSizePx; // Only barcode height
                    ctx.save();
                    ctx.strokeStyle = '#ef4444'; // red-500
                    ctx.lineWidth = 1.5 / zoom;
                    ctx.strokeRect(0, 0, barcodeWidth, barcodeHeight);
                    ctx.beginPath();
                    ctx.moveTo(0, 0); ctx.lineTo(barcodeWidth, barcodeHeight);
                    ctx.moveTo(barcodeWidth, 0); ctx.lineTo(0, barcodeHeight);
                    ctx.stroke();
                    
                    ctx.fillStyle = '#ef4444';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    const errorFontSize = Math.min(barcodeHeight * 0.2, 12 * zoom);
                    ctx.font = `bold ${errorFontSize}px sans-serif`;

                    if (validationError) {
                        ctx.fillText('Invalid Data', barcodeWidth / 2, barcodeHeight / 2);
                    } else { 
                        const symbologyName = BARCODE_MAP[field.symbology] || `Symbology ${field.symbology}`;
                        ctx.fillText(`Unsupported:`, barcodeWidth / 2, barcodeHeight / 2 - errorFontSize * 0.6);
                        ctx.fillText(symbologyName, barcodeWidth / 2, barcodeHeight / 2 + errorFontSize * 0.6);
                    }
                    ctx.restore();
                }
                ctx.restore(); // Restore from HRI offset

                // Manually draw HRI for better WYSIWYG
                if (field.humanReadable !== 'none' && !validationError && data) {
                    const hriFontSize = (field.hriFontSize || 10) * POINTS_TO_MM * PREVIEW_SCALE * zoom;
                    const hriOffset = 2 * dotSizePx;
                    ctx.font = `${hriFontSize}px monospace`;
                    ctx.fillStyle = 'black';
                    
                    // An IPL interpretive field is ALWAYS left justified (PRM
                    // p.200), and that is what the viewer and the printed label
                    // do. Defaulting to 'center' here drew the HRI half a text
                    // width right of where it prints.
                    const hriAlign = field.hriAlign || 'left';
                    ctx.textAlign = hriAlign;
                    
                    let drawX = 0;
                    if(hriAlign === 'center') drawX = barcodeWidth / 2;
                    if(hriAlign === 'right') drawX = barcodeWidth;

                    if(field.humanReadable === 'below') {
                        ctx.textBaseline = 'top';
                        ctx.fillText(data, drawX, barcodeHeight + yOffset + hriOffset);
                    } else { // 'above'
                        ctx.textBaseline = 'bottom';
                        ctx.fillText(data, drawX, yOffset-hriOffset);
                    }
                }
                break;
            }
            case 'line': {
                const scale = PREVIEW_SCALE * zoom;
                const length = field.length * scale;
                const thickness = field.thickness * scale;
                ctx.fillStyle = 'black';
                ctx.fillRect(0, 0, length, thickness);
                
                if (field.lineEnding === 'arrow') {
                    const arrowSize = Math.max(5 * zoom, thickness * 2);
                    ctx.beginPath();
                    ctx.moveTo(length, thickness / 2);
                    ctx.lineTo(length - arrowSize, thickness / 2 - arrowSize / 2);
                    ctx.lineTo(length - arrowSize, thickness / 2 + arrowSize / 2);
                    ctx.closePath();
                    ctx.fill();
                }
                break;
            }
            case 'box': {
                const scale = PREVIEW_SCALE * zoom;
                const boxWidth = field.width * scale;
                const boxHeight = field.height * scale;
                const lineWidth = field.thickness * scale;
                const cornerRadius = (field.cornerRadius || 0) * scale;
                ctx.strokeStyle = 'black';
                ctx.lineWidth = lineWidth;
                
                ctx.beginPath();
                if (cornerRadius > 0 && ctx.roundRect) {
                     ctx.roundRect(lineWidth / 2, lineWidth / 2, boxWidth - lineWidth, boxHeight - lineWidth, cornerRadius);
                } else {
                    ctx.rect(lineWidth / 2, lineWidth / 2, boxWidth - lineWidth, boxHeight - lineWidth);
                }
                ctx.stroke();
                break;
            }
            case 'ellipse':
            case 'polygon':
            case 'triangle': {
                const scale = PREVIEW_SCALE * zoom;
                const w = field.width * scale;
                const h = field.height * scale;
                const lineWidth = field.thickness * scale;
                traceShape(ctx, field, w, h);
                if (lineWidth <= 0) {
                    ctx.fillStyle = 'black';
                    ctx.fill();
                } else {
                    ctx.strokeStyle = 'black';
                    ctx.lineWidth = lineWidth;
                    ctx.lineJoin = 'miter';
                    ctx.stroke();
                }
                break;
            }
            case 'image': {
                const scale = PREVIEW_SCALE * zoom;
                // Smoothing off: the dot grid is the asset — preview and print
                // must show the same crisp dots, never a blurred resample.
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(getBitmapCanvas(field.bitmap), 0, 0, field.width * scale, field.height * scale);
                ctx.imageSmoothingEnabled = true;
                break;
            }
        }
        ctx.restore();
    });

    ctx.restore(); // Restore from clipping

    const selectedFields = fields.filter(f => selectedFieldIds.includes(f.id));
    selectedFields.forEach(selectedField => {
       if (selectedField.visible === false) return;
       const box = getFieldBoundingBox(ctx, selectedField, design, zoom);
       
       ctx.save();
       ctx.translate(selectedField.x * PREVIEW_SCALE * zoom, selectedField.y * PREVIEW_SCALE * zoom);
       ctx.rotate(-selectedField.rotation * Math.PI / 180); // Batch W: CCW, see drawElements

        let localXStart = 0;
        if (selectedField.type === 'text') {
            const align = selectedField.align || 'left';
            if (align === 'center') localXStart = -box.width / 2;
            if (align === 'right') localXStart = -box.width;
        }

        let localYStart = 0;
        if (selectedField.type === 'barcode' && (selectedField as BarcodeField).humanReadable === 'above') {
           localYStart = -getHriAboveOffset(selectedField as BarcodeField, design, zoom);
        }

       ctx.translate(localXStart, localYStart);
       drawSelectionBox(ctx, box, zoom);
       ctx.restore();
    });

    if (hoveredFieldId && !selectedFieldIds.includes(hoveredFieldId)) {
        const hoveredField = fields.find(f => f.id === hoveredFieldId);
        if (hoveredField && hoveredField.visible !== false) {
             const box = getFieldBoundingBox(ctx, hoveredField, design, zoom);
             ctx.save();
             ctx.translate(hoveredField.x * PREVIEW_SCALE * zoom, hoveredField.y * PREVIEW_SCALE * zoom);
             ctx.rotate(-hoveredField.rotation * Math.PI / 180); // Batch W: CCW, see drawElements

            let localXStart = 0;
             if (hoveredField.type === 'text') {
                const align = hoveredField.align || 'left';
                if (align === 'center') localXStart = -box.width / 2;
                if (align === 'right') localXStart = -box.width;
            }

            let localYStart = 0;
             if (hoveredField.type === 'barcode' && (hoveredField as BarcodeField).humanReadable === 'above') {
                localYStart = -getHriAboveOffset(hoveredField as BarcodeField, design, zoom);
             }
             ctx.translate(localXStart, localYStart);
             drawHoverHighlight(ctx, box, zoom);
             ctx.restore();
        }
    }
    
    // Snapping guides are drawn relative to the canvas, not the panned workspace
    if (selectedFields.length > 0) {
      const snappedGuidesInCanvasSpace = {
        x: snappingGuides.x !== null ? snappingGuides.x + pan.x : null,
        y: snappingGuides.y !== null ? snappingGuides.y + pan.y : null,
      }
      drawSnappingGuides(ctx, snappedGuidesInCanvasSpace);
    }
    
    ctx.restore();
    drawMarquee(ctx, marquee);
};