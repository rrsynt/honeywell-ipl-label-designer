import type { Field, Design, TextField, BarcodeField, LineField, BoxField, EllipseField } from '../types';
import { getFormattedDateTime } from './dateTimeFormat';
import { resolveLinkedPreview, applyTransform } from './tableSource';
import { FONT_MAP, FONT_FAMILIES, POINTS_TO_MM, DPI_MAP, bitmapTextWidthDots } from '../constants';
import { measureBarcode, isBarcodeEngineReady } from './ipl/barcodes';
import { designerBarcodeRender } from './designerBarcode';

// Offscreen canvas for measurements
let measurementCanvas: HTMLCanvasElement | null = null;
let measurementCtx: CanvasRenderingContext2D | null = null;

function getMeasurementContext(): CanvasRenderingContext2D {
    if (!measurementCanvas) {
        measurementCanvas = document.createElement('canvas');
        measurementCtx = measurementCanvas.getContext('2d');
    }
    return measurementCtx!;
}


const getFieldData = (field: TextField | BarcodeField, design: Design): string => {
    const { dataSource } = field;
    if (dataSource.type === 'fixed') return dataSource.data;
    if (dataSource.type === 'variable') return dataSource.defaultData;
    if (dataSource.type === 'date' || dataSource.type === 'time') {
        return getFormattedDateTime(dataSource.type, dataSource.format);
    }
    // Linked fields measure against the source's live preview value — same
    // resolution as canvasDrawer's getFieldData. Returning '' here zeroed the
    // bounding box, and resize then divided by it (newWidth/0 = Infinity).
    if (dataSource.type === 'linked') {
        const source = design.dataSources.find(ds => ds.id === dataSource.sourceId);
        const resolved = resolveLinkedPreview(source, dataSource, field.name);
        if (resolved === null) return '[unlinked]';
        return dataSource.transform ? applyTransform(dataSource.transform, resolved, design).result : resolved;
    }
    return '';
};


/**
 * The horizontal shift, in the field's own text direction (dots), that a text
 * block's `align` bakes into its origin — the same rule the designer canvas
 * draws (`blockX = −W/2 / −W`) and IPL already bakes into the print origin.
 *
 * No printer language here has a per-line alignment for ordinary text; the only
 * lever is moving the origin, so a centre/right block is printed by starting it
 * further left. Returns 0 for left/undefined.
 */
export const textAlignShiftDots = (field: Field, boxWidthDots: number): number => {
    if (field.type !== 'text') return 0;
    const align = (field as TextField).align;
    // Half a block width is not always a whole dot, and ^FO/`o` take integers —
    // a fractional origin (`220.5`) is not a coordinate those commands accept.
    if (align === 'center') return -Math.round(boxWidthDots / 2);
    if (align === 'right') return -Math.round(boxWidthDots);
    return 0;
};

/**
 * Applies a text-align shift to a visual top-left, riding the block's own text
 * axis so a rotated field shifts where the designer drew it. Mirrors the
 * per-rotation table IPL uses (f0 +x, f1 −y, f2 −x, f3 +y).
 */
export const shiftForTextAlign = (
    origin: { x: number; y: number },
    field: Field,
    boxWidthDots: number,
): { x: number; y: number } => {
    const s = textAlignShiftDots(field, boxWidthDots);
    if (s === 0) return origin;
    const q = ((Math.round(field.rotation / 90) % 4) + 4) % 4;
    switch (q) {
        case 1: return { x: origin.x, y: origin.y - s };
        case 2: return { x: origin.x - s, y: origin.y };
        case 3: return { x: origin.x, y: origin.y + s };
        default: return { x: origin.x + s, y: origin.y };
    }
};

/**
 * Calculates the UNROTATED bounding box of a single field in millimeters.
 * This is the core measurement function, independent of zoom or rotation.
 */
export function getObjectBoundingBox(field: Field, design: Design): { width: number, height: number } {
    const ctx = getMeasurementContext();
    const { dpi } = design.printerSettings;
    const mmPerDot = 25.4 / dpi;
    let width = 0, height = 0;

    switch (field.type) {
        case 'text': {
            const data = getFieldData(field, design);
            const lines = data.split('\n').length > 0 ? data.split('\n') : [''];
            const fontInfo = FONT_MAP[field.font];
            const isBitmap = fontInfo?.type === 'bitmap';

            if (isBitmap) {
                const baseHeight = fontInfo.baseHeight || 9;
                const lineHeightMm = (baseHeight * field.h_mag) * mmPerDot;
                height = lines.length * lineHeightMm;

                let maxChars = 0;
                lines.forEach(line => { maxChars = Math.max(maxChars, line.length); });
                // Same advance (cell + gap, last gap dropped) the viewer
                // renderer paints with — cell-only width made the designer
                // under-measure by 1-2 dots per char (audit T1).
                width = bitmapTextWidthDots(field.font, maxChars, field.w_mag) * mmPerDot;

            } else { // Outline font
                const fontSizePx = (field.fontSize * POINTS_TO_MM) * dpi / 25.4;
                const fontFamily = fontInfo?.family || 'sans-serif';
                // Batch W: measure with the registered FONT_FAMILIES stack,
                // not the raw family name. The generic 'monospace' resolves
                // to a HOST font (narrow in node, arbitrary in browsers),
                // silently under-measuring c25 by ~35% — which the align-bake
                // in iplGenerator then baked into the print origin. The
                // vendored Liberation fonts are metric-matched to the viewer
                // table (Batch U); only via the stack do all three agree.
                ctx.font = `normal ${fontSizePx}px ${FONT_FAMILIES[fontFamily as keyof typeof FONT_FAMILIES] ?? fontFamily}`;
                
                const lineHeightMm = (fontSizePx * 1.15) * mmPerDot; // Match canvasDrawer (Batch V: unified with the viewer print path)
                height = (lines.length * lineHeightMm) - (lineHeightMm * 0.2); // Match canvasDrawer
                
                let maxWidth = 0;
                lines.forEach(line => {
                    const measuredWidth = ctx.measureText(line).width;
                    maxWidth = Math.max(maxWidth, measuredWidth);
                });
                width = maxWidth * mmPerDot;
            }
            break;
        }
        case 'barcode': {
            const data = getFieldData(field, design);
            // Batch D: measure through the shared bwip encoder (same raster
            // as the viewer). measureBarcode caches per (symbology, data,
            // params) so the mousemove hot path stays cheap; the engine's
            // lazy load degrades to the old estimate until it is ready.
            const r = designerBarcodeRender(field, data);
            height = r.heightDots * mmPerDot;
            if (isBarcodeEngineReady() && r.data) {
                const measure = measureBarcode(r.symbology, r.data, r.params);
                if (measure) {
                    width = measure.widthModules * Math.max(1, r.moduleDots) * mmPerDot;
                } else {
                    width = (field.w_mag * 50) * mmPerDot; // invalid data fallback
                }
            } else {
                width = (field.w_mag * 50) * mmPerDot; // fallback
            }
            if (field.humanReadable !== 'none') {
                const hriFontSizeMm = (field.hriFontSize || 10) * POINTS_TO_MM;
                const hriOffsetMm = 2 * mmPerDot;
                height += hriFontSizeMm + hriOffsetMm;
            }
            break;
        }
        case 'line':
            width = field.length;
            height = field.thickness;
            break;
        case 'box':
            width = field.width;
            height = field.height;
            break;
        case 'ellipse':
        case 'polygon':
        case 'triangle':
            width = (field as EllipseField).width;
            height = (field as EllipseField).height;
            break;
        case 'image':
            width = field.width;
            height = field.height;
            break;
    }
    return { width, height };
}

/**
 * Calculates the axis-aligned bounding box (AABB) of a set of fields,
 * accounting for their individual rotations and alignments.
 * Returns the box in millimeters: { minX, minY, maxX, maxY }.
 */
export function getAxisAlignedBoundingBox(fields: Field[], design: Design): { minX: number, minY: number, maxX: number, maxY: number } {
    let allPoints: {x: number, y: number}[] = [];

    fields.forEach(field => {
        const { width, height } = getObjectBoundingBox(field, design);
        const { x, y, rotation } = field;
        // Batch W: CCW — the printer rotates fields counterclockwise (the
        // designer now draws with ctx.rotate(-r)); the AABB corners must use
        // the same frame. Screen y-down: R(−r) = [cos, sin; −sin, cos].
        const rad = -rotation * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        let localOriginY = 0;
        if (field.type === 'barcode' && (field as BarcodeField).humanReadable === 'above') {
            const { dpi } = design.printerSettings;
            const mmPerDot = 25.4 / dpi;
            const hriFontSizeMm = ((field as BarcodeField).hriFontSize || 10) * POINTS_TO_MM;
            const hriOffsetMm = 2 * mmPerDot;
            localOriginY = -(hriFontSizeMm + hriOffsetMm);
        }
        
        let xOffset = 0;
        if(field.type === 'text') {
            const align = field.align || 'left';
            if (align === 'center') xOffset = -width / 2;
            else if (align === 'right') xOffset = -width;
        }
        
        const cornersInLocalSpace = [
            { x: xOffset, y: localOriginY },
            { x: xOffset + width, y: localOriginY },
            { x: xOffset + width, y: localOriginY + height },
            { x: xOffset, y: localOriginY + height },
        ];
        
        const rotatedAndTranslatedCorners = cornersInLocalSpace.map(corner => ({
            x: x + (corner.x * cos - corner.y * sin),
            y: y + (corner.x * sin + corner.y * cos),
        }));

        allPoints = allPoints.concat(rotatedAndTranslatedCorners);
    });

    if (allPoints.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    
    return allPoints.reduce((acc, point) => ({
        minX: Math.min(acc.minX, point.x),
        minY: Math.min(acc.minY, point.y),
        maxX: Math.max(acc.maxX, point.x),
        maxY: Math.max(acc.maxY, point.y),
    }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}