// Design -> TSPL.
//
// The other direction of services/tspl/tsplParser.ts, and the fourth member of
// the family alongside generateIPL, generateZPL and generateEPL: a SUBSET that
// NAMES what it cannot draw rather than emitting a command no printer would
// honour.
//
// Positions go through the same geometry the screen uses (getObjectBoundingBox
// + topLeftDots), so a field prints where it was drawn. TSPL's TEXT and BARCODE
// x,y is the upper-left of the field after rotation, exactly like ZPL's ^FO,
// which is why the shared topLeftDots table applies unchanged.
//
// TWO TSPL-SPECIFIC FACTS (TSPL/TSPL2 Programming Manual, TSC Auto ID):
//
//   * Rotation is CLOCKWISE (p. 77), so the design's counter-clockwise
//     rotation is negated on the way out. Getting this backwards mirrors every
//     rotated field — and 0/180 look fine either way, which is what makes it
//     easy to ship unnoticed.
//   * A quote in the data is written \[ and a backslash \] (p. 77). That is
//     neither ZPL's doubling nor EPL's backslash-quote.
//
// Parameter orders: TEXT p. 77, BARCODE p. 38, BOX p. 47, BAR p. 37,
// SIZE p. 1, PRINT p. 24.

import type { Design, Field, TextField, BarcodeField } from '../../types';
import { DPI_MAP } from '../../constants';
import { getObjectBoundingBox } from '../geometry';
import { resolveLinkedPreview, applyTransform } from '../tableSource';
import { getFormattedDateTime } from '../dateTimeFormat';

/**
 * Escape TSPL print data (manual p. 77).
 *
 *   a double quote  ->  \[
 *   a backslash     ->  \]
 *
 * A newline inside the data would start a new command line, so it becomes a
 * space rather than truncating the field at the printer.
 */
export const escapeTsplData = (s: string): string =>
    String(s).replace(/\\/g, '\\]').replace(/"/g, '\\[').replace(/\r?\n/g, ' ');

export interface TsplGenerateResult {
    tspl: string;
    /** Fields that have no representation in the supported TSPL subset. */
    warnings: string[];
}

/** Design font id -> the TSPL resident font number. */
const TSPL_FONT_FOR: Record<string, number> = {
    '0': 1,  // 7x9  -> TSPL 1 (8x12)
    '2': 2,  // 10x14 -> TSPL 2 (12x20)
    '1': 3,  // 7x11 OCR -> TSPL 3 (16x24)
};

/**
 * Design barcode symbology (IPL c-codes) -> the TSPL type NAME.
 *
 * TSPL's types are names, not the numbers EPL uses, and the inverse must stay
 * the inverse of the parser's table: if the two disagree, a design saved and
 * reloaded changes symbology silently.
 */
const TSPL_BARCODE_FOR: Record<string, string> = {
    '0': '39',
    '1': '93',
    '2': '25',
    '3': '25S',
    '4': 'CODA',
    '5': '11',
    '6': '128',
    '10': 'CODE49',
    '11': 'POST',
    '22': 'PLANET',
};

/**
 * Design symbology -> the TSPL 2D command that draws it (manual pp. 56, 65).
 *
 * MPDF417 is in the guide's own command list (TSPL Programming Guide,
 * P1139068-01EN Rev A), and services/ipl/barcodes.ts has encoded '19' as
 * micropdf417 for every other language all along — so omitting it here dropped
 * a symbol this app can draw, under a warning that named its IPL id instead of
 * the symbology.
 */
const TSPL_2D_COMMAND: Record<string, string> = {
    '18': 'QRCODE',
    '12': 'PDF417',
    '19': 'MPDF417',
};

/**
 * 2D symbols the design can hold that this subset does not emit, each with the
 * reason. The reason is per-symbol because it is not the same one.
 *
 * `reason` is 'language' when TSPL genuinely has no such command, and
 * 'viewer' when TSPL HAS the command but this app cannot encode the symbol.
 * Reporting the second as the first is a claim the guide disproves:
 * docs/manuals/TSPL_Programming_Guide_P1139068-01EN_outline.txt lists MAXICODE
 * among the supported commands (and its encoder exists in
 * services/ipl/barcodes.ts as '14'), so "TSPL does not have it" was never true
 * of MaxiCode — only "this viewer cannot draw it yet" was.
 */
const TSPL_2D_MISSING: Record<string, { name: string; reason: 'language' | 'viewer' }> = {
    '17': { name: 'Data Matrix', reason: 'language' },
    '14': { name: 'MaxiCode', reason: 'viewer' },
};

/** EAN/UPC variants, by the DATA LENGTH — which is how TSPL's names map. */
const tsplEanType = (data: string): string | null => {
    switch (data.replace(/\D/g, '').length) {
        case 13: return 'EAN13';
        case 8: return 'EAN8';
        case 12: return 'UPCA';
        case 7: return 'UPCE';
        default: return null;
    }
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
 * The visual top-left of a field in dots, and the rotation to emit.
 *
 * `box` is the unrotated size in millimetres. TSPL turns CLOCKWISE, so the
 * design's counter-clockwise quarter turns are negated here — the same
 * conversion the parser applies in the other direction.
 */
const placeField = (
    field: Field,
    box: { width: number; height: number },
    dpi: number,
): { x: number; y: number; rotation: number } => {
    const dots = (mm: number) => Math.round(mm * DPI_MAP[dpi]);
    const w = dots(box.width);
    const h = dots(box.height);
    const q = field.rotation / 90;
    const x = dots(field.x);
    const y = dots(field.y);
    switch (q) {
        case 1: return { x: x - h, y, rotation: 270 };
        case 2: return { x: x - w, y: y - h, rotation: 180 };
        case 3: return { x, y: y - w, rotation: 90 };
        default: return { x, y, rotation: 0 };
    }
};

export const generateTSPL = (design: Design): TsplGenerateResult => {
    const dpi = design.printerSettings.dpi;
    const dots = (mm: number) => Math.round(mm * DPI_MAP[dpi]);
    const warnings: string[] = [];
    const lines: string[] = [];

    const { width, height, orientation } = design.labelSettings;
    const landscape = orientation === 'landscape';
    // SIZE takes millimetres with an explicit unit (manual p. 1). Writing mm
    // rather than dots keeps the label correct if the dpi ever changes.
    const mm = (d: number) => Math.round((d / (DPI_MAP[dpi])) * 10) / 10;
    lines.push(`SIZE ${mm(dots(landscape ? height : width))} mm,${mm(dots(landscape ? width : height))} mm`);
    lines.push('GAP 3 mm,0');
    lines.push('CLS');

    for (const field of design.fields) {
        const box = getObjectBoundingBox(field, design);
        const { x, y, rotation } = placeField(field, box, dpi);

        if (field.type === 'text') {
            const tsplFont = TSPL_FONT_FOR[field.font];
            if (tsplFont === undefined) {
                warnings.push(`"${field.name}" uses a font with no TSPL equivalent. It prints with resident font 2, which is a different size and shape.`);
            }
            const data = escapeTsplData(fieldData(field, design));
            lines.push(`TEXT ${x},${y},"${tsplFont ?? 2}",${rotation},${Math.max(1, Math.round(field.w_mag ?? 1))},${Math.max(1, Math.round(field.h_mag ?? 1))},"${data}"`);
            continue;
        }

        if (field.type === 'barcode') {
            const sym = field.symbology;
            const data = fieldData(field, design);

            // The 2D symbols have their own commands, not the BARCODE type
            // table (manual pp. 56, 65). DataMatrix and MaxiCode are NOT in the
            // language, so those warn rather than emitting something a TSC
            // printer would ignore.
            if (TSPL_2D_COMMAND[sym]) {
                const cmd = TSPL_2D_COMMAND[sym];
                const cell = Math.max(1, Math.round(field.w_mag ?? 3));
                if (cmd === 'QRCODE') {
                    const ecc = field.qrEcl ?? 'M';
                    lines.push(`QRCODE ${x},${y},${ecc},${cell},A,${rotation},"${escapeTsplData(data)}"`);
                } else if (cmd === 'MPDF417') {
                    // NOT the same shape as PDF417. The TSC manual gives
                    //   MPDF417 x,y,rotate,[Wn,][Hn,][Cn,]"content"
                    // — there is no positional width or height. Wn and Hn are
                    // the module's width and height (defaults 1 and 10), and
                    // Cn is the column count. Writing the PDF417 box here put
                    // the width where the rotation belongs, so a printer would
                    // have rotated the symbol by 150 degrees.
                    const w = Math.max(1, Math.round(field.w_mag ?? 1));
                    const h = Math.max(1, Math.round(field.h_mag ?? 10));
                    lines.push(`MPDF417 ${x},${y},${rotation},W${w},H${h},"${escapeTsplData(data)}"`);
                } else {
                    const w = Math.max(1, dots(box.width));
                    const h = Math.max(1, dots(box.height));
                    lines.push(`PDF417 ${x},${y},${w},${h},${rotation},"${escapeTsplData(data)}"`);
                }
                continue;
            }
            if (TSPL_2D_MISSING[sym]) {
                const { name, reason } = TSPL_2D_MISSING[sym];
                warnings.push(reason === 'language'
                    ? `"${field.name}" is a ${name} symbol, which TSPL does not have. It was left off the label.`
                    : `"${field.name}" is a ${name} symbol. TSPL has the command, but this TSPL output does not draw it yet, so it was left off the label.`);
                continue;
            }

            // The IPL id '7' is "EAN/UPC" and the printer infers the variant
            // from the data length; TSPL spells the variant out in its name.
            // Code 39's host-verified check digit is type '39C' (manual p. 13);
            // emitting plain '39' for it dropped the digit in one direction
            // while the parser reads '39C' back as code39Mode '2'.
            const code39HostChecked = sym === '0' && field.code39_checkDigit === 'host-verifies';
            const type = sym === '7' ? tsplEanType(data) : (code39HostChecked ? '39C' : TSPL_BARCODE_FOR[sym]);
            if (field.code39_checkDigit === 'printer-generated' && sym === '0') {
                // TSPL has no "printer adds the code" Code 39 type — '39C' is the
                // host-supplied+verified one. Plain '39' prints the data as given,
                // so the digit the designer asked the printer to compute is not
                // added. Named rather than silent.
                warnings.push(`"${field.name}" asks Code 39 to have the printer add its check digit. TSPL has no such type ('39C' verifies a digit the host supplied), so the bar code prints without it.`);
            }
            if (!type) {
                warnings.push(sym === '7'
                    ? `"${field.name}" is an EAN/UPC bar code whose data is ${data.replace(/\D/g, '').length} digits, which is not a length TSPL recognizes (7, 8, 12 or 13). It was left off the label.`
                    : `"${field.name}" is barcode type ${sym}, which this TSPL subset cannot draw. It was left off the label.`);
                continue;
            }
            const heightDots = Math.max(1, dots(box.height));
            // TSPL's human readable is 0 none / 1 left / 2 center / 3 right —
            // ALL below the bar, and there is no above at all. A design asking
            // for "above" gets it below WITH a warning: dropping it would lose
            // the digits, which is worse than moving them.
            const hri = field.humanReadable === 'none' ? 0 : 1;
            if (field.humanReadable === 'above') {
                warnings.push(`"${field.name}" asks for the human-readable line above the bar code. TSPL can only print it below, so it will print below.`);
            }
            const narrow = Math.max(1, Math.round(field.w_mag ?? 1));
            lines.push(`BARCODE ${x},${y},"${type}",${heightDots},${hri},${rotation},${narrow},${narrow + 1},"${escapeTsplData(data)}"`);
            continue;
        }

        if (field.type === 'box') {
            // BOX takes two opposite CORNERS plus the line thickness, so the
            // far corner is origin + size, not a width and height.
            const w = dots(field.width);
            const h = dots(field.height);
            const t = Math.max(1, dots(field.thickness));
            // TSPL boxes DO take a corner radius (manual p. 47), so a rounded
            // box survives here — unlike EPL, where it had to be warned about.
            const radius = field.cornerRadius ? Math.max(1, dots(field.cornerRadius)) : 0;
            lines.push(`BOX ${x},${y},${x + w},${y + h},${t}${radius ? `,${radius}` : ''}`);
            continue;
        }

        if (field.type === 'line') {
            // BAR takes a width and height and fills the rectangle between
            // them, so a line is one dimension set to the thickness.
            const len = Math.max(1, dots(field.length));
            const t = Math.max(1, dots(field.thickness));
            const vertical = field.rotation === 90 || field.rotation === 270;
            lines.push(`BAR ${x},${y},${vertical ? t : len},${vertical ? len : t}`);
            continue;
        }

        warnings.push(`"${field.name}" is a ${field.type}, which TSPL output does not support yet. It was left off the label.`);
    }

    // PRINT copies,sets — the copies come from the printer settings, exactly as
    // the ZPL generator's ^PQ and the EPL one's P do.
    lines.push(`PRINT ${Math.max(1, design.printerSettings.quantity)},1`);
    return { tspl: lines.join('\n'), warnings };
};
