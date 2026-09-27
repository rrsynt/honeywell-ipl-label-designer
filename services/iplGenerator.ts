import type { Design, Field, TextField, BarcodeField, LineField, BoxField, ImageField, EllipseField, PolygonField, TriangleField, PrinterSettings, FieldDataSource, DataSource, DateFormat, TimeFormat } from '../types';
import { getFormattedDateTime } from './dateTimeFormat';
import { DPI_MAP, FONT_MAP } from '../constants';
import { getObjectBoundingBox } from './geometry';
import { encodeBitmapColumns, encodeColumnsToNibblizedRle } from './ipl/graphics';
import { bitmapRowsToMatrix } from './imageField';
import { resolveLinkedPreview, applyTransform, isSuppressed, suppressionValueFor, groupSuppressionValue } from './tableSource';
import { getUploadedFontMetrics } from './ipl/fontMetrics';
import { widthDelta } from './fontStore';

/**
 * The resident outline font emitted for an uploaded face. One id per family,
 * chosen as the family's plain (non-bold, non-condensed) member: c61 Swiss 721,
 * c28 Dutch Roman, c25 Swiss Mono. A printer has no way to accept the uploaded
 * bytes, so this is the closest it can print.
 */
const RESIDENT_FONT_ID: Record<'sans-serif' | 'serif' | 'monospace', string> = {
    'sans-serif': '61',
    'serif': '28',
    'monospace': '25',
};

/**
 * The `c` parameter to emit for a font reference. A resident id passes through
 * untouched. An uploaded face maps to its nearest resident family — and only
 * here, so the field keeps the uploaded name for the screen renderer.
 */
const emitFontId = (font: string | undefined): string => {
    const metrics = font ? getUploadedFontMetrics(font) : undefined;
    return metrics ? RESIDENT_FONT_ID[metrics.family] : (font ?? '');
};

/**
 * Fase 3: one entry per uploaded font the design uses. The stream itself is
 * unchanged — a printer has no slot for an arbitrary face, so the field is
 * emitted as its nearest resident family — but the caller can show how far that
 * substitution moves the text. `delta` is a fraction of the resident width.
 */
export interface FontSubstitution {
    /** The uploaded font's name, as the field stores it. */
    font: string;
    /** The resident IPL family emitted in its place. */
    resident: 'sans-serif' | 'serif' | 'monospace';
    /** |uploaded − resident| / resident, by average advance. */
    delta: number;
}

export interface BatchData {
    rows: any[][];
    mappings: { [fieldId: number]: number }; // fieldId -> columnIndex
    headers: string[];
}

/**
 * Strip characters that would break IPL frame delimiting when row data is
 * embedded into a <STX>…<ETX> print block: raw control bytes (0x00-0x1F
 * except \t and \n, which the text path converts to <SUB><CR>) and the
 * literal placeholder spellings of the framing controls. CSV cells come
 * from external systems; a stray 0x03 or '<ETX>' must not terminate the
 * frame early and turn the rest of the cell into printer commands.
 */
export const sanitizePrintData = (s: string): string =>
    s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
     .replace(/<\/?(?:STX|ETX|CAN|EOT|ETB|ESC|NUL|SUB|RS|US|FS|GS)>/gi, '');

/** A linked field's transform, applied to a value resolved outside a job (the
 *  canvas preview, the single-label export). A blank expression is a no-op and
 *  a broken one returns the value unchanged — see applyTransform. */
const transformed = (value: string, dataSource: FieldDataSource, design: Design): string =>
    dataSource.type === 'linked' && dataSource.transform
        ? applyTransform(dataSource.transform, value, design).result
        : value;

/**
 * Fase 4: the print-block data for one field on one label. A suppression
 * condition that holds replaces the data with nothing, so the printer draws no
 * ink for it on this label while the field stays defined for the labels where
 * the condition does not hold. `resolved` is the row's cell when there is one;
 * without it the condition is judged on the value the field would print.
 */
/**
 * The value a group's condition is judged against for THIS label. In a batch
 * that is the row's own cell for the group's reference field, so the group can
 * be present on one row and gone on the next; without a row it is the preview
 * value, which is what the canvas uses too.
 */
const groupValueForRow = (groupId: number, design: Design, row?: any[], batch?: BatchData): string => {
    if (row && batch) {
        const ref = design.fields
            .filter(f => f.groupId === groupId && (f.type === 'text' || f.type === 'barcode'))
            .sort((a, b) => a.id - b.id)[0];
        const col = ref ? batch.mappings[ref.id] : undefined;
        if (col !== undefined && col >= 0 && col < row.length) return String(row[col] ?? '');
    }
    return groupSuppressionValue(groupId, design);
};

/**
 * WHICH rule hides this field on this label, or null when it prints.
 *
 * The one implementation of "is it suppressed". It returns the reason rather
 * than a boolean so a caller can say why (the generator's suppression warnings
 * do), but the point is that the batch loop and the sheet preview's marker ask
 * THIS question. A second copy of the rule would eventually drift, and the
 * drift would be discovered on printed media.
 */
const suppressionReasonFor = (
    field: TextField | BarcodeField,
    design: Design,
    resolved?: string,
    row?: any[],
    batch?: BatchData,
): 'group' | 'field' | null => {
    // A group's condition hides every member. Judged on the row when there is
    // one, so the whole group vanishes together and per label.
    const groupCondition = field.groupId !== undefined ? design.groupSuppress?.[field.groupId] : undefined;
    if (groupCondition && isSuppressed(groupCondition, groupValueForRow(field.groupId as number, design, row, batch)).suppress) return 'group';
    if (field.suppress && isSuppressed(field.suppress, resolved ?? suppressionValueFor(field, design)).suppress) return 'field';
    return null;
};

/** The mapped cell of a batch row for one field, or undefined when the row
 *  has no column for it (unmapped, or a ragged row). Shared with the
 *  suppression predicate so both read the same cell. */
export const rowCellFor = (batch: BatchData, fieldId: number, row: any[]): string | undefined => {
    const col = batch.mappings[fieldId];
    return col !== undefined && col >= 0 && col < row.length ? String(row[col] ?? '') : undefined;
};

const dataOrSuppressed = (field: TextField | BarcodeField, data: string, design: Design, resolved?: string, row?: any[], batch?: BatchData): string =>
    suppressionReasonFor(field, design, resolved, row, batch) ? '' : data;

/**
 * Fase 6: the fields this batch row prints no ink for. Same test the print
 * block uses, in the same order, so the sheet preview's marker cannot claim a
 * field was dropped while the stream still carries its data (or the reverse).
 * Fields without per-label data (shapes, images, lines) are not listed: their
 * suppression is expressed as a whole conditional FORMAT, not as blank data.
 */
export const suppressedFieldIdsForRow = (
    design: Design,
    fields: (TextField | BarcodeField)[],
    row: any[],
    batch: BatchData,
): number[] =>
    fields
        .filter(field => suppressionReasonFor(field, design, rowCellFor(batch, field.id, row), row, batch) !== null)
        .map(field => field.id);

/**
 * Which stored format this label prints. Format 1 is the base; a conditional
 * group whose condition does NOT hold adds its own format (the base plus that
 * group's static members). Two such groups both showing at once cannot be
 * represented — a format is one or the other — so the lowest group id wins and
 * the rest are named in the returned warnings.
 */
const formatForLabel = (design: Design, conditionalGroupIds: number[], row?: any[], batch?: BatchData): { formatId: number; warnings: string[] } => {
    const shown = conditionalGroupIds.filter(id => {
        const condition = design.groupSuppress?.[id];
        return !!condition && !isSuppressed(condition, groupValueForRow(id, design, row, batch)).suppress;
    });
    const warnings = shown.slice(1).map(id => `Group ${id} overlaps another conditional group on this label, so only group ${shown[0]} is printed.`);
    return { formatId: shown.length === 0 ? 1 : conditionalGroupIds.indexOf(shown[0]) + 2, warnings };
};

export const mmToDots = (mm: number, dpi: 203 | 300 | 406): number => {
    return Math.round(mm * DPI_MAP[dpi]);
}

const boxToIplGraphicData = (field: BoxField, dpi: number): { data: string[], width: number, height: number } | null => {
    const mmPerDot = 25.4 / dpi;
    const width = Math.round(field.width / mmPerDot);
    const height = Math.round(field.height / mmPerDot);
    const thickness = Math.round(field.thickness / mmPerDot);
    const cornerRadius = Math.round((field.cornerRadius || 0) / mmPerDot);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'black';
    ctx.lineWidth = thickness;
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(thickness / 2, thickness / 2, width - thickness, height - thickness, cornerRadius);
    } else {
         ctx.rect(thickness / 2, thickness / 2, width - thickness, height - thickness);
    }
    ctx.stroke();

    const imageData = ctx.getImageData(0, 0, width, height);
    const monoBitmap: number[][] = Array.from({ length: height }, () => new Array(width).fill(0));
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const r = imageData.data[i];
            const alpha = imageData.data[i + 3];
            if (alpha > 0 && r < 255) {
                monoBitmap[y][x] = 1;
            }
        }
    }
    return { data: encodeBitmapColumns(monoBitmap), width, height };
};

type ShapeField = EllipseField | PolygonField | TriangleField;

/**
 * Fase 3: rasterize an ellipse, polygon or triangle the same way a rounded box
 * is rasterized — draw it on an offscreen canvas at the printer's dpi, then
 * threshold to a mono bitmap. IPL has no command for these shapes, so this is
 * how they print: as a downloaded graphic (G/U), never as an invented command.
 * A zero thickness fills the shape; a positive one strokes it inside the box.
 */
const shapeToIplGraphicData = (field: ShapeField, dpi: number): { data: string[], width: number, height: number } | null => {
    const mmPerDot = 25.4 / dpi;
    const width = Math.max(1, Math.round(field.width / mmPerDot));
    const height = Math.max(1, Math.round(field.height / mmPerDot));
    const thickness = Math.max(0, Math.round(field.thickness / mmPerDot));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, width, height);

    ctx.beginPath();
    if (field.type === 'ellipse') {
        ctx.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    } else if (field.type === 'triangle') {
        ctx.moveTo(width / 2, 0);
        ctx.lineTo(width, height);
        ctx.lineTo(0, height);
        ctx.closePath();
    } else {
        // Regular polygon, one vertex straight up, so a square reads as a diamond.
        // Below 3 sides there is no polygon. The caller (the graphic loop)
        // refuses to rasterize those, so this only ever sees a drawable one;
        // the clamp stays as a backstop for a caller that forgets.
        const sides = Math.max(3, Math.round(field.sides));
        for (let i = 0; i < sides; i++) {
            const a = -Math.PI / 2 + (i * 2 * Math.PI) / sides;
            const px = width / 2 + (width / 2) * Math.cos(a);
            const py = height / 2 + (height / 2) * Math.sin(a);
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
    }

    if (thickness <= 0) {
        ctx.fillStyle = 'black';
        ctx.fill();
    } else {
        // Inset the stroke by half its width so it stays inside the declared
        // box — the same rule the box stroke follows (measured INSIDE l×h).
        ctx.strokeStyle = 'black';
        ctx.lineWidth = thickness;
        ctx.lineJoin = 'miter';
        ctx.stroke();
    }

    const imageData = ctx.getImageData(0, 0, width, height);
    const monoBitmap: number[][] = Array.from({ length: height }, () => new Array(width).fill(0));
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (imageData.data[i + 3] > 0 && imageData.data[i] < 255) monoBitmap[y][x] = 1;
        }
    }
    return { data: encodeBitmapColumns(monoBitmap), width, height };
};


const sanitizeFieldName = (name: string): string => {
    return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/\s+/g, '_');
};


/**
 * The uploaded fonts this design prints through a substitute, de-duplicated by
 * font. Empty unless the user installed a face and a field uses it — resident
 * ids are not in the uploaded-font registry, so an ordinary design reports
 * nothing here.
 */
export const fontSubstitutions = (design: Design): FontSubstitution[] => {
    const seen = new Set<string>();
    const out: FontSubstitution[] = [];
    for (const field of design.fields) {
        if (field.type !== 'text' && field.type !== 'barcode') continue;
        const name = field.type === 'text' ? field.font : field.hriFont;
        if (!name || seen.has(name)) continue;
        const metrics = getUploadedFontMetrics(name);
        if (!metrics) continue;
        seen.add(name);
        out.push({ font: name, resident: metrics.family, delta: widthDelta(metrics.advances, metrics.family) });
    }
    return out;
};

/**
 * Fase 4: suppression conditions that did nothing. A condition that doesn't
 * parse never suppresses (a typo must not delete a field from every label), so
 * the only way the user learns their rule was ignored is this list. Judged on
 * the value the field prints right now — the wording of the failure doesn't
 * depend on the data.
 */
export const suppressionWarnings = (design: Design): string[] => {
    const out: string[] = [];
    // A label can print only one conditional group's static members. When two
    // such groups would both show, the generator keeps the lowest id and the
    // rest are lost — say which.
    const conditionalIds = Object.keys(design.groupSuppress ?? {}).map(Number)
        .filter(id => design.fields.some(f => f.groupId === id && !['text', 'barcode'].includes(f.type)))
        .sort((a, b) => a - b);
    out.push(...formatForLabel(design, conditionalIds).warnings);
    for (const field of design.fields) {
        if (!field.suppress || field.suppress.trim() === '') continue;
        const value = (field.type === 'text' || field.type === 'barcode')
            ? suppressionValueFor(field, design) : '';
        const { warning } = isSuppressed(field.suppress, value);
        if (warning) out.push(`"${field.name}": ${warning.message}`);
    }
    return out;
};

export const generateIPL = async (design: Design, batchData?: BatchData): Promise<string> => {
    if (!design) return "";
    const { printerSettings, labelSettings, fields, dataSources } = design;
    const { dpi, quantity, mediaSenseMode, mediaType, printSpeed, darkness, directGraphics } = printerSettings;
    const { width, height, orientation } = labelSettings;
    const EOL = '\n';
    
    const isLandscape = orientation === 'landscape';
    // Swap dimensions for the printer in landscape mode
    const printerLabelWidthMm = isLandscape ? height : width;

    const commands: string[] = [];
    
    // --- 1. Initial Printer Setup ---
    commands.push(`<STX>R<ETX>`);
    commands.push(`<STX><ESC>C<SI>W${mmToDots(printerLabelWidthMm, dpi)}<ETX>`);
    // Maximum label length (feed direction). Swapped for landscape, same as width.
    commands.push(`<STX><SI>L${mmToDots(isLandscape ? width : height, dpi)}<ETX>`);
    
    const mediaModeMap = { gap: '1', reflective: '2', continuous: '0' };
    commands.push(`<STX><SI>T${mediaModeMap[mediaSenseMode]}<ETX>`);
    const mediaTypeMap = { 'direct-thermal': '0', 'thermal-transfer': '1' };
    commands.push(`<STX><SI>g${mediaTypeMap[mediaType]}<ETX>`);
    commands.push(`<STX><SI>S${printSpeed * 10}<ETX>`);
    commands.push(`<STX><SI>d${Math.round(darkness - 10)}<ETX>`);
    commands.push(`<STX><SI>l13<ETX>`);

    const visibleFields = fields.filter(f => f.visible !== false);

    // Fase 4: a group's condition hides every member of it, but a line, box,
    // shape or image has no per-label data to blank — it is part of the format
    // definition, which is written once. So a group whose condition hides such a
    // member cannot share a format with the labels where it shows. Each such
    // group gets a format of its own and the job picks one per row. Groups made
    // only of text and barcodes stay in the shared format: their data can be
    // emptied per row, which is what the printer actually wants.
    const STATIC_TYPES = ['line', 'box', 'ellipse', 'polygon', 'triangle', 'image'];
    const conditionalGroupIds = [...new Set(visibleFields
        .filter(f => f.groupId !== undefined && design.groupSuppress?.[f.groupId] && visibleFields.some(m => m.groupId === f.groupId && STATIC_TYPES.includes(m.type)))
        .map(f => f.groupId as number))];
    /** The format a field belongs to: its group's own, or the shared one. */
    const formatOf = (field: Field): number => {
        const idx = field.groupId !== undefined ? conditionalGroupIds.indexOf(field.groupId) : -1;
        return idx === -1 ? 0 : idx + 1;
    };
    const formatCount = conditionalGroupIds.length + 1;
    const roundedBoxFields = visibleFields.filter(f => f.type === 'box' && (f as BoxField).cornerRadius && (f as BoxField).cornerRadius > 0) as BoxField[];
    // Ellipse, polygon and triangle have no IPL command of their own, so every
    // one of them is a downloaded graphic — the rounded-box treatment, applied
    // unconditionally rather than only past a radius threshold.
    const shapeFields = visibleFields.filter(f => f.type === 'ellipse' || f.type === 'polygon' || f.type === 'triangle') as ShapeField[];

    const processedImages: { fieldId: number; graphicId: number; graphicData: { data: string[]; width: number; height: number; } }[] = [];
    // fieldId -> graphic resource id. A Map, not a (field as any)._graphicId
    // write-back: mutating state objects reached in from React leaks the
    // private property into the store, undo history and saved JSON.
    const boxGraphicIds = new Map<number, number>();
    let graphicIdCounter = 1;

    for (const field of [...roundedBoxFields, ...shapeFields]) {
        // A polygon needs 3 sides to enclose anything. Emitting a graphic for
        // fewer would print a shape the user cannot see on screen either, so
        // the field is dropped from the stream instead.
        if (field.type === 'polygon' && field.sides < 3) continue;
        const graphicData = field.type === 'box' ? boxToIplGraphicData(field, dpi) : shapeToIplGraphicData(field, dpi);
        if (graphicData) {
            const graphicId = graphicIdCounter++;
            boxGraphicIds.set(field.id, graphicId);
            processedImages.push({ fieldId: field.id, graphicId, graphicData });
        }
    }
    // Image fields ARE rasters. With "Direct Graphics" on they become
    // nibblized <ESC>g1 payloads emitted at print time (below); otherwise they
    // pack into the classic column-major 6-bit strips the printer downloads
    // (PRM p.186).
    const directGraphicImages: { field: ImageField; hex: string }[] = [];
    for (const field of visibleFields) {
        if (field.type !== 'image') continue;
        if (field.bitmap.length === 0 || !field.bitmap[0]) continue;
        if (directGraphics) {
            const bitmap = bitmapRowsToMatrix(field.bitmap);
            const labelHeightDots = mmToDots(isLandscape ? width : height, dpi);
            // Landscape rotates the whole label, so the graphic's origin moves
            // with it: new X is the distance from the portrait label's right
            // edge, new Y the distance from its top (same rule as fields below).
            const oxDots = mmToDots(isLandscape ? height - field.y - field.height : field.x, dpi);
            const oyDots = mmToDots(isLandscape ? field.x : field.y, dpi);
            directGraphicImages.push({
                field,
                hex: encodeColumnsToNibblizedRle(bitmap, oxDots, oyDots, labelHeightDots),
            });
            continue;
        }
        const graphicData = {
            data: encodeBitmapColumns(bitmapRowsToMatrix(field.bitmap)),
            width: field.bitmap[0].length,
            height: field.bitmap.length,
        };
        const graphicId = graphicIdCounter++;
        boxGraphicIds.set(field.id, graphicId);
        processedImages.push({ fieldId: field.id, graphicId, graphicData });
    }
    
    // --- 2. Program Mode & Format Definition ---
    commands.push(`<STX><ESC>P<ETX>`);
    
    if (processedImages.length > 0) {
        for (const { fieldId, graphicId, graphicData } of processedImages) {
            const field = fields.find(f => f.id === fieldId)!;
            const graphicCommands = [
                `G${graphicId},${sanitizeFieldName(field.name)}`,
                `x${graphicData.width}`,
                `y${graphicData.height}`,
                // u indices are 1-based per the manual (PRM p.186, range 1–999);
                // printers reject u0.
                ...graphicData.data.map((colData, index) => `u${index + 1},${colData}`)
            ];
            commands.push(`<STX>${graphicCommands.join(';')}<ETX>`);
        }
    }

    if (visibleFields.length === 0 && processedImages.length === 0 && directGraphicImages.length === 0) {
        commands.push(`<STX>E1;F1<ETX>`);
        commands.push(`<STX>R<ETX>`);
        commands.push(`<STX><ESC>E1<CAN><ETB><FF><ETX>`);
        return commands.join(EOL);
    }
    
    const variableFieldsForPrint: { field: TextField | BarcodeField, source?: DataSource }[] = [];
    /** I<n> commands waiting for their B<n> to be written (see the barcode case). */
    const pendingInterpretive: string[] = [];

    // One stored format per variant. Format 1 is the base (everything not in a
    // conditional group); each conditional group adds a format that is the base
    // plus that group's static members. Written as separate E/F blocks so the
    // printer holds all of them and the job selects one per label.
    for (let formatId = 1; formatId <= formatCount; formatId++) {
    commands.push(`<STX>E${formatId};F${formatId}<ETX>`);

    visibleFields.filter(field => formatOf(field) === 0 || formatOf(field) === formatId - 1).forEach(field => {
        let { x: x_mm, y: y_mm, rotation } = field;
        
        if (isLandscape) {
            const original_x = x_mm;
            const original_y = y_mm;
            x_mm = height - original_y; // New X is distance from right edge of portrait label
            y_mm = original_x; // New Y is distance from top edge of portrait label
            rotation = (rotation + 90) % 360 as Field['rotation'];
        }
        
        let final_ox_mm = x_mm;
        let final_oy_mm = y_mm;
        
        const unrotatedBoxMm = getObjectBoundingBox(field, design);

        // Batch W: NO shift needed. The manual (DevGuide p.27) states the
        // field origin stays at the same corner after CCW rotation. This
        // means the designer's (x,y) = unrotated TL = the printer's f1 BL /
        // f2 BR / f3 TR anchors directly — applyFieldTransform agrees. The
        // old width/height subtraction table only bridged our earlier CW
        // drawing; it made rotated fields print elsewhere than they were
        // shown (probe showed designer [140,163] vs print [127,60] for f1).
        // No transform required; identity is the one convention where screen,
        // stream and printer coincide.

        // Batch W: text align baked into the print origin. IPL has no
        // alignment — the printer can only move origins — so center/right
        // must shift the block along its text direction, exactly what the
        // designer draws (canvasDrawer block at local x = −W/2 / −W) and
        // what the hit-test/selection/AABB already assume. After the anchor
        // table above the origin IS the rotated block's top-left, so the
        // shift rides the text axis: f0/f2 along x, f1/f3 along y.
        // (Import reads the shifted origin back as a plain left-aligned
        // field at that spot — visually identical; align is designer-only
        // and has no stream representation, by printer design.)
        if (field.type === 'text' && field.align && field.align !== 'left') {
            const alignShiftMm = field.align === 'center' ? -unrotatedBoxMm.width / 2 : -unrotatedBoxMm.width;
            // Text reading direction in printer space rotates CCW with f:
            // f0 +x, f90 −y, f180 −x, f270 +y (screen y-down). The block's
            // TL sits at local (alignShift, 0) → printer offset is
            // R_ccw(f)·(alignShift, 0) = (s·cos f, −s·sin f).
            if (rotation === 0) final_ox_mm += alignShiftMm;
            else if (rotation === 90) final_oy_mm -= alignShiftMm;
            else if (rotation === 180) final_ox_mm -= alignShiftMm;
            else final_oy_mm += alignShiftMm;
        }
        
        const rounded_ox = mmToDots(final_ox_mm, dpi);
        const rounded_oy = mmToDots(final_oy_mm, dpi);
        const rotationCmd = rotation / 90;
        
        const processDataSource = (field: TextField | BarcodeField) => {
            const dataSource = field.dataSource;
            if (dataSource.type === 'fixed') return `d3,${dataSource.data.replace(/\n/g, '<SUB><CR>')}`;
            // Date/time have no IPL command: `dn` documents only n=0..3
            // (PRM p.184 "Field Data, Define Source"), so the old d4/d5 output
            // was undefined data on a real printer, and our own viewer answered
            // it with a placeholder. Bake the current value as fixed text:
            // every printer prints that correctly, and re-generating refreshes
            // it. The designer keeps its live preview either way.
            if (dataSource.type === 'date' || dataSource.type === 'time') {
                return `d3,${getFormattedDateTime(dataSource.type, dataSource.format)}`;
            }
            
            // Registered once. A field that lives in more than one format (the
            // base) is visited once per format, and pushing it each time would
            // emit its data twice in every print block.
            if (!variableFieldsForPrint.some(v => v.field.id === field.id)) {
                if (dataSource.type === 'linked') {
                    const source = dataSources.find(ds => ds.id === dataSource.sourceId);
                    variableFieldsForPrint.push({ field, source });
                } else { // variable
                    variableFieldsForPrint.push({ field, source: undefined });
                }
            }
            return `d0,255`;
        };

        let commandString = '';
        switch (field.type) {
            case 'text':
            case 'barcode': {
                const fieldId = `H${field.id}`;
                const barcodeId = `B${field.id}`;
                let params: string[] = [`o${rounded_ox},${rounded_oy}`, `f${rotationCmd}`];
                if (field.type === 'text') {
                    const fontInfo = FONT_MAP[emitFontId(field.font)];
                    // c n[,m] — the gap is emitted only when the field carries
                    // one, so a design that never set it regenerates byte-
                    // identically to before.
                    params.push(field.intercharGapDots === undefined
                        ? `c${emitFontId(field.font)}`
                        : `c${emitFontId(field.font)},${field.intercharGapDots}`);
                    if (fontInfo?.type === 'bitmap') { 
                        params.push(`h${field.h_mag}`, `w${field.w_mag}`); 
                    } else { // Outline font
                        params.push(`b0`);
                        params.push(`k${field.fontSize}`);
                    }
                } else { // Barcode
                     let symbologyCmd = field.symbology;
                     if (field.symbology === '0' && field.code39_checkDigit && field.code39_checkDigit !== 'none') {
                        const checkDigitMap = { 'printer-generated': '1', 'host-verifies': '2' };
                        symbologyCmd += `,${checkDigitMap[field.code39_checkDigit]}`;
                     } else if (field.symbology === '6') {
                        const subsetMap = { 'auto': '0', 'a': '1', 'b': '2', 'c': '3' };
                        symbologyCmd = `6,0,0,${subsetMap[field.code128_subset || 'auto']}`;
                     } else {
                        // Batch C: carry symbology modifiers positionally so
                        // an imported stream regenerates identically. Earlier
                        // slots are filled with the PRM default when a later
                        // modifier is set (c-syntax has no named params).
                        const pos = (values: (number | string | undefined)[], defaults: (number | string)[]): string => {
                            let last = -1;
                            values.forEach((v, i) => { if (v !== undefined) last = i; });
                            if (last < 0) return '';
                            let out = '';
                            for (let i = 0; i <= last; i++) out += `,${values[i] ?? defaults[i]}`;
                            return out;
                        };
                        switch (field.symbology) {
                            case '8': case '16':
                                symbologyCmd += pos([field.hibcMode], [0]); break;
                            case '14':
                                symbologyCmd += pos([field.maxiMode], []); break; // no mode = auto
                            case '18':
                                symbologyCmd += pos([field.qrModel, field.qrEcl, field.qrMask], [2, 'M', 8]); break;
                            case '19':
                                symbologyCmd += pos([field.microColumns, field.microRows], [0, 0]); break;
                            case '20':
                                symbologyCmd += pos([field.rssVersion, field.rssSepHeight, field.rssSegments], [2, 1, 2]); break;
                        }
                     }
                     params.push(`c${symbologyCmd}`);
                     const hriMap = { 'none': 'i0', 'below': 'i1', 'above': 'i2' };
                     // POSTNET (c11) reads h/w as CELL MAGNIFICATIONS, not dot
                     // dimensions (PRM p.156): convert the designer's dot height
                     // back (13 dots per magnification unit). Planet (c22) and
                     // MaxiCode (c14) are fixed-size — emitting h/w there only
                     // triggers the viewer's "ignored" info (PRM pp.159, 171),
                     // so omit them.
                     if (field.symbology === '22' || field.symbology === '14') {
                        params.push(hriMap[field.humanReadable]);
                     } else if (field.symbology === '11') {
                        params.push(`h${Math.max(1, Math.min(10, Math.round(field.h_mag / 13)))}`, `w${Math.max(1, Math.min(10, field.w_mag))}`, hriMap[field.humanReadable]);
                     } else {
                        params.push(`h${field.h_mag}`, `w${field.w_mag}`, hriMap[field.humanReadable]);
                     }
                }
                const dsCmd = processDataSource(field);
                if (dsCmd) params.push(dsCmd);
                commandString = [field.type === 'text' ? fieldId : barcodeId, ...params].join(';');
                if (field.type === 'barcode' && field.humanReadable !== 'none') {
                    const hriParams = [];
                    const hriFont = emitFontId(field.hriFont || '21');
                    const hriFontSize = field.hriFontSize || 10;
                    const fontInfo = FONT_MAP[hriFont];

                    if (fontInfo?.type === 'bitmap') {
                        hriParams.push(`c${hriFont}`);
                    } else { // Outline font
                        hriParams.push(`c${hriFont}`, `k${hriFontSize}`);
                    }

                    if (hriParams.length > 0) {
                        // Emitted AFTER the bar code field is written, below.
                        // The interpretive field binds to a bar code by id, so
                        // it must follow that bar code's definition — pushing it
                        // here put I<n> before B<n> in every stream, and the
                        // viewer rightly reported "references bar code field N,
                        // which has not been defined".
                        pendingInterpretive.push(`I${field.id};${hriParams.join(';')}`);
                    }
                }
                break;
            }
            case 'line': {
                commandString = [`L${field.id}`, `o${rounded_ox},${rounded_oy}`, `f${rotationCmd}`, `l${mmToDots(field.length, dpi)}`, `w${mmToDots(field.thickness, dpi)}`].join(';');
                break;
            }
            case 'box': {
                const graphicId = boxGraphicIds.get(field.id);
                if (graphicId) {
                     const params: string[] = [`o${rounded_ox},${rounded_oy}`, `f${rotationCmd}`, `c${graphicId}`];
                     commandString = [`U${field.id}`, ...params].join(';');
                } else {
                    commandString = [`W${field.id}`, `o${rounded_ox},${rounded_oy}`, `f${rotationCmd}`, `l${mmToDots(field.width, dpi)}`, `h${mmToDots(field.height, dpi)}`, `w${mmToDots(field.thickness, dpi)}`].join(';');
                }
                break;
            }
            case 'ellipse':
            case 'polygon':
            case 'triangle': {
                // No native command: the shape was rasterized into a downloaded
                // graphic above, so it is placed exactly like an image field.
                // A polygon with fewer than 3 sides never produced one, and a
                // field with no graphic is simply omitted rather than emitting
                // a command that references nothing.
                const shapeGraphicId = boxGraphicIds.get(field.id);
                if (shapeGraphicId) {
                    commandString = [`U${field.id}`, `o${rounded_ox},${rounded_oy}`, `f${rotationCmd}`, `c${shapeGraphicId}`].join(';');
                }
                break;
            }
            case 'image': {
                // Direct Graphics mode places the image from its own payload
                // (emitted after the format), so it needs no format field.
                if (directGraphics) break;
                // U placement carries only o/f/c — the raster's own x/y header
                // defines its size (PRM p.186/189), matching how the printer
                // treats any downloaded graphic.
                const graphicId = boxGraphicIds.get(field.id);
                if (graphicId) {
                    commandString = [`U${field.id}`, `o${rounded_ox},${rounded_oy}`, `f${rotationCmd}`, `c${graphicId}`].join(';');
                }
                break;
            }
        }
        if (commandString) commands.push(`<STX>${commandString}<ETX>`);
        // Now that this field is defined, its interpretive may follow it.
        while (pendingInterpretive.length > 0) {
            commands.push(`<STX>${pendingInterpretive.shift()}<ETX>`);
        }
    });

    commands.push(`<STX>R<ETX>`);
    } // end of the per-format loop

    // Direct Graphics image straight into the printer's image bands, so they
    // belong to the print stream rather than the stored format. One <ESC>g1
    // region per image: the hex is pure ASCII, which is the whole point of
    // mode 1 — the stream survives clipboard paste and UTF-8 transport.
    for (const { hex } of directGraphicImages) {
        commands.push(`<STX><ESC>g1<ETX>`);
        commands.push(`<STX>${hex}<ETX>`);
    }

    // --- 3. Print Job Execution ---
    if (batchData) {
        // One print invocation per data row: the standard IPL pattern for
        // feeding variable data from a table — each row prints its own label,
        // so quantity is implicit (RS 1). Columns map to field ids via
        // batchData.mappings; unmapped (or ragged-row) fields print their
        // default — for LINKED fields that means the data source's sample
        // value / counter start, mirroring the non-batch path below.
        const dataByField = new Map<number, string>();
        const fieldById = new Map<number, TextField | BarcodeField>();
        variableFieldsForPrint.forEach(({ field, source }) => {
            let data = '';
            if (source) {
                if (source.type === 'variable') data = source.sampleData;
                else if (source.type === 'counter') data = source.start.toString().padStart(source.padding, '0');
                else data = transformed(resolveLinkedPreview(source, field.dataSource as Extract<typeof field.dataSource, { type: 'linked' }>, field.name) ?? '', field.dataSource, design);
            } else if (field.dataSource.type === 'variable') {
                data = field.dataSource.defaultData;
            }
            dataByField.set(field.id, data);
            fieldById.set(field.id, field);
        });
        const sortedFieldIds = variableFieldsForPrint.map(v => v.field.id).sort((a, b) => a - b);
        for (const row of batchData.rows) {
            // Only the fields the chosen format actually defines get data.
            // Sending <ESC>F for a field that lives in another format makes the
            // printer substitute a blank of its own, which hides the mistake.
            const { formatId } = formatForLabel(design, conditionalGroupIds, row, batchData);
            const idsForFormat = sortedFieldIds.filter(id => {
                const f = design.fields.find(field => field.id === id);
                return f !== undefined && (formatOf(f) === 0 || formatOf(f) === formatId - 1);
            });
            const dataForPrintBlock = idsForFormat.map(id => {
                const cell = rowCellFor(batchData, id, row);
                const raw = dataOrSuppressed(fieldById.get(id)!, cell ?? (dataByField.get(id) ?? ''), design, cell, row, batchData);
                const field = fieldById.get(id)!;
                const data = field.type === 'text'
                    ? sanitizePrintData(raw).replace(/\r?\n/g, '<SUB><CR>')
                    : sanitizePrintData(raw);
                return `<ESC>F${id}<NUL>${data}`;
            });
            commands.push(`<STX><ESC>E${formatId}<CAN>${dataForPrintBlock.join('')}<RS>1<ETB><FF><ETX>`);
        }
    } else {
        let printJobBlock = '';
        const dataForPrintBlock: string[] = [];
        // Batch Q: printer-side serial odometer. IPL advances <FS>…<FS>
        // (numeric) regions of entered data by the job's <ESC>In step after
        // EVERY printed label (PRM pp.98-99,104,111) — so quantity N prints
        // start, start+step, … without the host resending. The step is
        // job-level (one per stream), so if several serial counters disagree
        // the first one (lowest field id) wins; the viewer's
        // resolveLabelAtBatch simulates the same advance for preview/export.
        let serialStep: number | null = null;

        variableFieldsForPrint.sort((a,b) => a.field.id - b.field.id).forEach(({ field, source }) => {
            let data = '';
            let serialWrap = false;
            const fieldDataSource = field.dataSource;

            if (source) {
                 if (source.type === 'variable') {
                    data = source.sampleData;
                } else if (source.type === 'table') {
                    data = transformed(resolveLinkedPreview(source, fieldDataSource as Extract<typeof fieldDataSource, { type: 'linked' }>, field.name) ?? '', fieldDataSource, design);
                } else if (source.type === 'counter') {
                    data = source.start.toString().padStart(source.padding, '0');
                    if (source.serial && source.step !== 0) {
                        serialWrap = true; // numeric region (PRM p.111)
                        if (serialStep === null) serialStep = source.step;
                    }
                }
            } else if (fieldDataSource.type === 'variable') {
                data = fieldDataSource.defaultData;
            }

            // Batch R: the print block is <RS>/<ETB>/<FF>-terminated, so
            // control-notation text in variable data would truncate the block
            // and hijack the job command that follows it (the batch path has
            // always sanitized; the non-batch path silently didn't).
            data = sanitizePrintData(dataOrSuppressed(field, data, design));

            // The sanitizer strips <FS> too — odometer markers go on LAST.
            if (serialWrap) data = `<FS>${data}<FS>`;

            if (field.type === 'text') {
                data = data.replace(/\n/g, '<SUB><CR>');
            }

            dataForPrintBlock.push(`<ESC>F${field.id}<NUL>${data}`);
        });

        const { formatId } = formatForLabel(design, conditionalGroupIds);
        let printCommands = `<ESC>E${formatId}<CAN>`;
        if (dataForPrintBlock.length > 0) {
            printCommands += dataForPrintBlock.join('');
        }
        if (serialStep !== null) {
            printCommands += serialStep > 0 ? `<ESC>I${serialStep}` : `<ESC>D${Math.abs(serialStep)}`;
        }
        if (quantity > 1) {
            printCommands += `<RS>${quantity}`;
        }
        printCommands += `<ETB><FF>`;
        printJobBlock = `<STX>${printCommands}<ETX>`;
        commands.push(printJobBlock);
    }

    return commands.filter(Boolean).join(EOL);
};