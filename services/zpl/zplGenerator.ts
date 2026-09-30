// Design -> ZPL.
//
// Fase 5, the other half of the IR. The parser reads ZPL into ViewerElement;
// this writes ZPL from a Design. Both go through the same geometry the screen
// uses (getObjectBoundingBox), so a field prints where it was drawn.
//
// ZPL's ^FO is the visual top-left of a field AFTER rotation, which is the
// opposite of IPL's anchor. getObjectBoundingBox returns the unrotated size, so
// the top-left falls out of it directly:
//   0°   top-left = (x, y)
//   90°  the block hangs left of the anchor: top-left = (x - height, y)
//   180° top-left = (x - width, y - height)
//   270° top-left = (x, y - width)
//
// Scope mirrors the parser: text, the four barcodes the parser reads back
// (^B3 ^BC ^BQ ^BX), boxes and lines (^GB). A field type outside that — an
// image, a shape, a barcode with no ZPL equivalent — is skipped and named in
// the returned warnings rather than emitted as a command no printer here could
// honour. A warning that names the field is the difference between "not
// supported" and "silently missing".

import type { Design, Field, TextField, BarcodeField } from '../../types';
import { DPI_MAP, FONT_MAP } from '../../constants';
import { getObjectBoundingBox } from '../geometry';
import { resolveLinkedPreview, applyTransform } from '../tableSource';
import { getFormattedDateTime } from '../dateTimeFormat';

const ORIENTATION = ['N', 'R', 'I', 'B'] as const;

/** ^FD ends at ^FS, so ^, ~ and \ in the data must be escaped or they truncate it. */
export const escapeFd = (s: string): string =>
    s.replace(/\\/g, '\\\\').replace(/\^/g, '\\^').replace(/~/g, '\\~').replace(/\n/g, '\\&');

export interface ZplGenerateResult {
    zpl: string;
    /** Fields that have no representation in the supported ZPL subset. */
    warnings: string[];
}

/**
 * Barcode symbologies this subset can emit, keyed by the design's symbology id.
 *
 * The 1D commands do NOT share a parameter order:
 *
 *   ^BC / ^B2   o,h,f,g     — HEIGHT second, HRI third
 *   ^B3         o,e,h,f,g   — CHECK DIGIT second, height third, HRI fourth
 *
 * Measured against Labelary, the only ZPL oracle here, by decoding the returned
 * PNG and measuring the ink rows (a NUMBER in the height slot grows the bars; a
 * Y in the HRI slot adds a text row of its own):
 *
 *   ^B2N,60,...      60-dot bars          ^B2N,1,Y,...  1-dot bars + text
 *   ^BCN,60,...      60-dot bars          ^BCN,1,N,...  1-dot bars
 *   ^B3N,N,60,Y,...  60-dot bars + text   (so ^B3 = e, HEIGHT, HRI)
 *
 * An earlier reading of the same probe said the opposite for ^BC/^B2 — "o,h,f,g
 * = orientation, HRI, height" — and the table then wrote the HRI flag into the
 * HEIGHT slot and never wrote the height at all, so every HRI-enabled barcode
 * was emitted as `^B2N,Y,N,N,N`: a request for a ONE-DOT bar height, which
 * prints an invisible symbol. The slots below are the measured ones.
 */
const ZPL_BARCODE: Record<string, (hri: 'Y' | 'N', height: number, e: 'Y' | 'N') => string> = {
    // ^B3 o,e,h,f,g — e is the mod-43 CHECK DIGIT flag, then HEIGHT, then HRI.
    '0': (hri, height, e) => `^B3N,${e},${height},${hri},N`, // Code 39
    // ^B2 o,h,f,g and ^BC o,h,f,g — HEIGHT second, HRI third. The old table put
    // the HRI flag in the height slot and never wrote the height, so an
    // HRI-enabled barcode came out ^B2N,Y,N,N,N — which asks the printer for a
    // ONE-DOT bar height and prints an invisible symbol. Measured against
    // Labelary: ^B2N,60,... gives 60-dot bars, ^B2N,1,Y,... gives 1-dot bars
    // plus a text row.
    '2': (hri, height) => `^B2N,${height},${hri},N,N`, // Interleaved 2 of 5
    '6': (hri, height) => `^BCN,${height},${hri},N,N`, // Code 128
    '17': (_hri, height) => `^BXN,${Math.max(1, Math.round(height / 10))},200`, // DataMatrix
    '18': (_hri, height) => `^BQN,2,${Math.max(1, Math.round(height / 25))}`,   // QR
};

const fieldData = (field: TextField | BarcodeField, design: Design): string => {
    const ds = field.dataSource;
    if (ds.type === 'fixed') return ds.data;
    if (ds.type === 'variable') return ds.defaultData;
    if (ds.type === 'date' || ds.type === 'time') return getFormattedDateTime(ds.type, ds.format);
    if (ds.type === 'linked') {
        const source = design.dataSources.find(s => s.id === ds.sourceId);
        const resolved = resolveLinkedPreview(source, ds, field.name) ?? '';
        return ds.transform ? applyTransform(ds.transform, resolved, design).result : resolved;
    }
    return '';
};

/**
 * The visual top-left of a field in dots. `box` is the unrotated size in
 * millimetres; rotation is in quarter turns CCW, matching the designer's `f`.
 */
const topLeftDots = (field: Field, box: { width: number; height: number }, dpi: number): { x: number; y: number } => {
    const dots = (mm: number) => Math.round(mm * DPI_MAP[dpi]);
    const w = dots(box.width);
    const h = dots(box.height);
    const q = field.rotation / 90;
    switch (q) {
        case 1: return { x: dots(field.x) - h, y: dots(field.y) };
        case 2: return { x: dots(field.x) - w, y: dots(field.y) - h };
        case 3: return { x: dots(field.x), y: dots(field.y) - w };
        default: return { x: dots(field.x), y: dots(field.y) };
    }
};

export const generateZPL = (design: Design): ZplGenerateResult => {
    const dpi = design.printerSettings.dpi;
    const dots = (mm: number) => Math.round(mm * DPI_MAP[dpi]);
    const warnings: string[] = [];
    const lines: string[] = ['^XA', '^CI28'];

    const { width, height, orientation } = design.labelSettings;
    const landscape = orientation === 'landscape';
    lines.push(`^PW${dots(landscape ? height : width)}`, `^LL${dots(landscape ? width : height)}`);

    for (const field of design.fields) {
        const box = getObjectBoundingBox(field, design);
        const origin = topLeftDots(field, box, dpi);
        const ori = ORIENTATION[field.rotation / 90] ?? 'N';

        if (field.type === 'text') {
            const h = dots(field.fontSize * (25.4 / 72));
            const data = escapeFd(fieldData(field, design));
            lines.push(`^FO${origin.x},${origin.y}`, `^A0${ori},${h},${h}`, `^FD${data}^FS`);
            if (!FONT_MAP[field.font]) warnings.push(`"${field.name}" uses an uploaded font. ZPL prints it as font 0 at the same size, which a printer may render narrower or wider.`);
            continue;
        }
        if (field.type === 'barcode') {
            const emit = ZPL_BARCODE[field.symbology];
            if (!emit) { warnings.push(`"${field.name}" is barcode type ${field.symbology}, which this ZPL subset cannot draw. It was left off the label.`); continue; }
            const hri = field.humanReadable === 'none' ? 'N' : 'Y';
            // The HEIGHT slot is the BAR height. The field's h_mag is that height
            // in dots; box.height adds the interpretive row on top, which the
            // printer lays outside the bars, so using it would over-tall the
            // symbol by the row. Matrix types size from the whole box.
            const h = field.symbology === '17' || field.symbology === '18'
                ? Math.max(1, dots(box.height))
                : Math.max(1, field.h_mag || 50);
            // Code 39's printer-generated check digit is ^B3's e flag. The ZPL
            // side has no host-verify mode, so 'host-verifies' maps to N.
            const e: 'Y' | 'N' = field.symbology === '0' && field.code39_checkDigit === 'printer-generated' ? 'Y' : 'N';
            lines.push(`^FO${origin.x},${origin.y}`, `^BY${Math.max(1, field.w_mag)}`, `${emit(hri, h, e)}^FD${escapeFd(fieldData(field, design))}^FS`);
            continue;
        }
        if (field.type === 'box') {
            const w = dots(field.width);
            const h = dots(field.height);
            const t = Math.max(1, dots(field.thickness));
            const radius = field.cornerRadius ? Math.min(8, Math.max(1, Math.round((field.cornerRadius / Math.min(field.width, field.height)) * 16))) : 0;
            lines.push(`^FO${origin.x},${origin.y}`, `^GB${w},${h},${t}${radius ? `,,${radius}` : ''}^FS`);
            continue;
        }
        if (field.type === 'line') {
            const len = dots(field.length);
            const t = Math.max(1, dots(field.thickness));
            // A line along the field's length. Rotated 90°/270° it runs downward.
            const vertical = field.rotation === 90 || field.rotation === 270;
            lines.push(`^FO${origin.x},${origin.y}`, `^GB${vertical ? t : len},${vertical ? len : t},${t}^FS`);
            continue;
        }
        warnings.push(`"${field.name}" is a ${field.type}, which ZPL output does not support yet. It was left off the label.`);
    }

    lines.push(`^PQ${Math.max(1, design.printerSettings.quantity)}`, '^XZ');
    return { zpl: lines.join('\n'), warnings };
};
