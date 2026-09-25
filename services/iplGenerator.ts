import type { Design, Field, TextField, BarcodeField, LineField, BoxField, ImageField, PrinterSettings, FieldDataSource, DataSource, DateFormat, TimeFormat } from '../types';
import { getFormattedDateTime } from './dateTimeFormat';
import { DPI_MAP, FONT_MAP } from '../constants';
import { getObjectBoundingBox } from './geometry';
import { encodeBitmapColumns, encodeColumnsToNibblizedRle } from './ipl/graphics';
import { bitmapRowsToMatrix } from './imageField';

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


const sanitizeFieldName = (name: string): string => {
    return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/\s+/g, '_');
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
    const roundedBoxFields = visibleFields.filter(f => f.type === 'box' && (f as BoxField).cornerRadius && (f as BoxField).cornerRadius > 0) as BoxField[];

    const processedImages: { fieldId: number; graphicId: number; graphicData: { data: string[]; width: number; height: number; } }[] = [];
    // fieldId -> graphic resource id. A Map, not a (field as any)._graphicId
    // write-back: mutating state objects reached in from React leaks the
    // private property into the store, undo history and saved JSON.
    const boxGraphicIds = new Map<number, number>();
    let graphicIdCounter = 1;

    for (const field of roundedBoxFields) {
        const graphicData = boxToIplGraphicData(field, dpi);
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
    
    const formatId = 1;
    commands.push(`<STX>E${formatId};F${formatId}<ETX>`);
    
    const variableFieldsForPrint: { field: TextField | BarcodeField, source?: DataSource }[] = [];
    /** I<n> commands waiting for their B<n> to be written (see the barcode case). */
    const pendingInterpretive: string[] = [];


    visibleFields.forEach(field => {
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
            
            if (dataSource.type === 'linked') {
                const source = dataSources.find(ds => ds.id === dataSource.sourceId);
                variableFieldsForPrint.push({ field, source });
            } else { // variable
                variableFieldsForPrint.push({ field, source: undefined });
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
                    const fontInfo = FONT_MAP[field.font];
                    params.push(`c${field.font}`);
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
                    const hriFont = field.hriFont || '21';
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
            } else if (field.dataSource.type === 'variable') {
                data = field.dataSource.defaultData;
            }
            dataByField.set(field.id, data);
            fieldById.set(field.id, field);
        });
        const sortedFieldIds = variableFieldsForPrint.map(v => v.field.id).sort((a, b) => a - b);
        for (const row of batchData.rows) {
            const dataForPrintBlock = sortedFieldIds.map(id => {
                const col = batchData.mappings[id];
                const raw = col !== undefined && col >= 0 && col < row.length ? String(row[col] ?? '') : (dataByField.get(id) ?? '');
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
            data = sanitizePrintData(data);

            // The sanitizer strips <FS> too — odometer markers go on LAST.
            if (serialWrap) data = `<FS>${data}<FS>`;

            if (field.type === 'text') {
                data = data.replace(/\n/g, '<SUB><CR>');
            }

            dataForPrintBlock.push(`<ESC>F${field.id}<NUL>${data}`);
        });

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