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
import { getObjectBoundingBox, shiftForTextAlign, unsuppressedFields } from '../geometry';
import { resolveLinkedPreview, applyTransform } from '../tableSource';
import { getFormattedDateTime } from '../dateTimeFormat';
import { charsetWarning } from '../charsetRisk';

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
const ZPL_BARCODE: Record<string, (hri: 'Y' | 'N', height: number, e: 'Y' | 'N', qrModel: 1 | 2) => string> = {
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
    // ^BQ o,e,m — the SECOND parameter is the QR MODEL (1 or 2). Pixel-exact
    // against Labelary: ^BQN,1,5 draws nothing here while ^BQN,2,5 draws the
    // symbol, and holding the model at 2 while the third parameter changes
    // scales it (^BQN,2,5 -> 105px, ^BQN,2,6 -> 126px). The generator hardcoded
    // 2, so the designer's "QR Model" control was silently dropped and a Model 1
    // design printed as Model 2.
    '18': (_hri, height, _e, qrModel) => `^BQN,${qrModel},${Math.max(1, Math.round(height / 25))}`, // QR
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

    // The stock is exactly what the settings say: ^PW is the width and ^LL the
    // length, with no landscape transpose. A landscape stock is simply one whose
    // width exceeds its length — the driver leaves the coordinates alone (a
    // `btLandscape` page declares W388 for a 96x48 mm stock, printed where it was
    // authored), and the canvas, IPL and sheet preview all read it that way. This
    // generator used to swap the axes, so a landscape design emitted a label
    // turned a quarter — a field drawn near the right edge landed off the label.
    const { width, height } = design.labelSettings;
    lines.push(`^PW${dots(width)}`, `^LL${dots(height)}`);

    for (const field of unsuppressedFields(design)) {
        const box = getObjectBoundingBox(field, design);
        // `align` on a text block has no stream form — the printer can only move
        // an origin — so a centre/right block is printed by starting it further
        // back along its own text axis, exactly what the designer draws and what
        // IPL already bakes in. Without this the block printed flush-left while
        // the screen showed it centred.
        const origin = shiftForTextAlign(topLeftDots(field, box, dpi), field, dots(box.width));
        const ori = ORIENTATION[field.rotation / 90] ?? 'N';

        if (field.type === 'text') {
            // Size like the designer and the other generators: a BITMAP font is
            // sized by its magnifications (h_mag x w_mag on the cell), an OUTLINE
            // font by its point size. Reading fontSize for both ignored h/w on a
            // bitmap field (the designer hides the point-size editor for those),
            // so a field drawn as 7x18 dots exported at a default 34x34.
            const face = FONT_MAP[field.font];
            const isBitmap = face?.type === 'bitmap';
            const h = isBitmap
                ? Math.max(1, (face.baseHeight ?? 9) * (field.h_mag || 1))
                : dots(field.fontSize * (25.4 / 72));
            const w = isBitmap
                ? Math.max(1, (face.baseWidth ?? 7) * (field.w_mag || 1))
                : h;
            const data = escapeFd(fieldData(field, design));
            lines.push(`^FO${origin.x},${origin.y}`, `^A0${ori},${h},${w}`, `^FD${data}^FS`);
            if (!face) warnings.push(`"${field.name}" uses an uploaded font. ZPL prints it as font 0 at the same size, which a printer may render narrower or wider.`);
            continue;
        }
        if (field.type === 'barcode') {
            const emit = ZPL_BARCODE[field.symbology];
            if (!emit) { warnings.push(`"${field.name}" is barcode type ${field.symbology}, which this ZPL subset cannot draw. It was left off the label.`); continue; }
            const hri = field.humanReadable === 'none' ? 'N' : 'Y';
            // ZPL has no parameter that moves the human-readable line: the HRI
            // flag is Y/N only and the printer always anchors the text below the
            // bars. An "above" request therefore prints below — name it, the way
            // EPL and TSPL do, so it is not a silent difference from the screen.
            if (field.humanReadable === 'above') {
                warnings.push(`"${field.name}" asks for the human-readable line above the bar code. ZPL can only print it below, so it will print below.`);
            }
            // The HEIGHT slot is the BAR height. The field's h_mag is that height
            // in dots; box.height adds the interpretive row on top, which the
            // printer lays outside the bars, so using it would over-tall the
            // symbol by the row. Matrix types size from the whole box.
            const h = field.symbology === '17' || field.symbology === '18'
                ? Math.max(1, dots(box.height))
                : Math.max(1, field.h_mag || 50);
            // Code 39's printer-generated check digit is ^B3's e flag. The ZPL
            // side has no host-verify mode, so 'host-verifies' maps to N — named
            // here the way EPL/TSPL name their analogous gaps, so the vanished
            // verification semantics are not silent (audit FUN-05).
            if (field.symbology === '0' && field.code39_checkDigit === 'host-verifies') {
                warnings.push(`"${field.name}" asks Code 39 for host verification. ZPL ^B3 has no host-verify mode, so it prints as a plain symbol without it.`);
            }
            const e: 'Y' | 'N' = field.symbology === '0' && field.code39_checkDigit === 'printer-generated' ? 'Y' : 'N';
            // QR's error-correction level is not a ^BQ parameter — it is a
            // PREFIX on the field DATA. Probed against Labelary (the ZPL
            // oracle): ^BQN,2,5^FDH,<data> renders different bytes from
            // ^FDL,<data> and from a bare ^FD<data>, while adding a 4th ^BQ
            // parameter changes nothing faithful. The generator wrote no prefix
            // at all, so the designer's "Error Correction" control (qrEcl) was
            // silently dropped and every symbol printed at the printer default.
            const qrEcl = field.symbology === '18' && field.qrEcl ? `${field.qrEcl.toUpperCase()},` : '';
            // Model 1 or 2; the design's field is `1 | 2 | undefined`, default 2.
            const qrModel: 1 | 2 = field.qrModel === 1 ? 1 : 2;
            const fd = `${qrEcl}${fieldData(field, design)}`;
            lines.push(`^FO${origin.x},${origin.y}`, `^BY${Math.max(1, field.w_mag)}`, `${emit(hri, h, e, qrModel)}^FD${escapeFd(fd)}^FS`);
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
        if (field.type === 'ellipse') {
            // ^GE w,h,t, one command for both shapes. The PARSER has drawn ^GE
            // since 6dadfb9 — probing it against Labelary settled the parameter
            // order — but the generator never emitted it, so the designer's
            // ellipse was told "ZPL output does not support yet" by the very
            // language whose parser already understood it.
            //
            // A circle states both axes as its diameter, which is what ^GE
            // takes anyway; ^GC would also work and the parser reads both into
            // the same element, so either round-trips.
            const w = dots(field.width);
            const h = dots(field.height);
            const t = Math.max(1, dots(field.thickness));
            lines.push(`^FO${origin.x},${origin.y}`, `^GE${w},${h},${t}^FS`);
            continue;
        }

        if (field.type === 'image') {
            // ^GFa,totalBytes,bytesTotal,bytesPerRow,<data>.
            //
            // The PARSER has drawn ^GF since a1a49fa, where the parameters were
            // settled by probing the Labelary oracle and the result rendered
            // PIXEL-IDENTICAL to it — the strongest verification this project
            // has. The generator had no image branch at all, so the designer's
            // Image tool exported "ZPL output does not support yet" about the
            // one command here we had proved we understood exactly.
            //
            // From the parser's measured table (zplParser.ts case 'GF'):
            //   p1 is IGNORED by the printer   -> send the byte count anyway
            //   p2 CAPS the data drawn         -> the whole payload
            //   p3 fixes the SHAPE: bytes per row -> ceil(width / 8)
            // and dots run from the HIGH bit of each byte.
            const rows = field.bitmap;
            if (rows.length === 0 || !rows[0]) {
                warnings.push(`"${field.name}" is an image with no bitmap data, so there is nothing to print.`);
                continue;
            }
            const w = rows[0].length;
            const h = rows.length;
            const bytesPerRow = Math.ceil(w / 8);
            // Each row is padded to a whole number of bytes, and a set bit is
            // INK. The padding bits are paper, so a row that is not a multiple
            // of 8 wide does not spill into the byte after it.
            let hex = '';
            for (const row of rows) {
                for (let b = 0; b < bytesPerRow; b++) {
                    let byte = 0;
                    for (let k = 0; k < 8; k++) {
                        const x = b * 8 + k;
                        // Past the row's own width is paper; '1' is ink.
                        if (x < w && row[x] === '1') byte |= 0x80 >> k;
                    }
                    hex += byte.toString(16).toUpperCase().padStart(2, '0');
                }
            }
            const totalBytes = bytesPerRow * h;
            lines.push(`^FO${origin.x},${origin.y}`, `^GFA,${totalBytes},${totalBytes},${bytesPerRow},${hex}^FS`);
            continue;
        }

        warnings.push(`"${field.name}" is a ${field.type}, which ZPL output does not support yet. It was left off the label.`);
    }

    lines.push(`^PQ${Math.max(1, design.printerSettings.quantity)}`, '^XZ');
    const charset = charsetWarning(design, 'zpl');
    if (charset) warnings.push(charset);
    return { zpl: lines.join('\n'), warnings };
};
