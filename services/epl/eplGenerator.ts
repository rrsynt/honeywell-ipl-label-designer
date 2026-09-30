// Design -> EPL.
//
// The other direction of services/epl/eplParser.ts, and the third member of
// the same family as generateIPL and generateZPL: a SUBSET that NAMES what it
// cannot draw instead of emitting a command no printer would honour.
//
// Positions go through the same geometry the screen uses (getObjectBoundingBox
// + topLeftDots), so a field prints where it was drawn — EPL's `A`/`B` x,y is
// the visual top-left after rotation, exactly like ZPL's ^FO, which is why the
// shared topLeftDots table applies unchanged.
//
// Parameter orders are from the EPL2 Programmer's Manual (Zebra P/N
// 980352-001 Rev. D): `A` p. 3-4, `B` p. 3-11, `LO` p. 3-69, `X` p. 3-120,
// `q` p. 3-89, `Q` p. 3-91, `P` p. 3-87.

import type { Design, Field, TextField, BarcodeField } from '../../types';
import { DPI_MAP } from '../../constants';
import { getObjectBoundingBox } from '../geometry';
import { resolveLinkedPreview, applyTransform } from '../tableSource';
import { getFormattedDateTime } from '../dateTimeFormat';

/**
 * Escape EPL print data (manual p. 3-5).
 *
 * Quotes and backslashes are the two characters EPL treats specially, and the
 * escape is a BACKSLASH — not the doubled quote ZPL and TSPL use:
 *
 *   to print   "        enter   \"
 *   to print   \        enter   \\
 *
 * A newline inside the data would start a new command line, so it becomes a
 * space rather than truncating the field at the printer.
 */
export const escapeEplData = (s: string): string =>
    String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ');

export interface EplGenerateResult {
    epl: string;
    /** Fields that have no representation in the supported EPL subset. */
    warnings: string[];
}

/** The EPL `A` font for a design font id, or null when it is not a resident face. */
const EPL_FONT_FOR: Record<string, number> = {
    '0': 1,  // 7x9  -> EPL 1 (8x12)
    '2': 2,  // 10x14 -> EPL 2 (10x16)
    '1': 3,  // 7x11 OCR -> EPL 3 (12x20)
};

/**
 * Design symbology -> the EPL `b` command's type LETTER (manual pp. 3-20,
 * 3-25, 3-29). EPL2 defines exactly these three 2D symbols — there is no QR.
 */
const EPL_2D_LETTER: Record<string, string> = {
    '17': 'D',   // Data Matrix
    '14': 'M',   // MaxiCode
    '12': 'P',   // PDF417
};

/** EAN/UPC variants, by the DATA LENGTH — which is how EPL's letters map. */
const eplEanType = (data: string): string | null => {
    switch (data.replace(/\D/g, '').length) {
        case 13: return 'E30'; // EAN-13
        case 8: return 'E80';  // EAN-8
        case 12: return 'UA0'; // UPC-A
        case 7: return 'UE0';  // UPC-E
        default: return null;
    }
};

/**
 * Design barcode symbology (IPL c-codes) -> the EPL `B` type letter.
 *
 * The reverse of the parser's table, and it must stay the reverse: if the two
 * ever disagree, a design saved and reloaded changes symbology silently. The
 * IPL id '7' means "EAN/UPC" with the variant carried by the data, so it is
 * resolved separately below.
 */
const EPL_BARCODE_FOR: Record<string, string> = {
    '0': '3',   // Code 39
    '6': '1',   // Code 128
    '2': '2',   // Interleaved 2 of 5
    '1': '9',   // Code 93
    '4': 'K',   // Codabar
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
 * The visual top-left of a field in dots. Mirrors the ZPL generator: EPL's
 * `A`/`B` origin is also the top-left AFTER rotation, so the same quarter-turn
 * table applies. `box` is the unrotated size in millimetres.
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

export const generateEPL = (design: Design): EplGenerateResult => {
    const dpi = design.printerSettings.dpi;
    const dots = (mm: number) => Math.round(mm * DPI_MAP[dpi]);
    const warnings: string[] = [];
    const lines: string[] = ['N'];

    const { width, height, orientation } = design.labelSettings;
    const landscape = orientation === 'landscape';
    // q sets the label WIDTH, Q the form LENGTH (manual pp. 3-89, 3-91).
    lines.push(`q${dots(landscape ? height : width)}`);
    lines.push(`Q${dots(landscape ? width : height)},${Math.max(0, Math.round((design.printerSettings.mediaSenseMode === 'continuous' ? 0 : 3)))}`);

    for (const field of design.fields) {
        const box = getObjectBoundingBox(field, design);
        const origin = topLeftDots(field, box, dpi);
        const rot = field.rotation / 90;

        if (field.type === 'text') {
            const eplFont = EPL_FONT_FOR[field.font];
            if (eplFont === undefined) {
                // An outline font, an uploaded face, or anything else with no
                // resident equivalent. Font 1 is the smallest resident cell, so
                // the text stays on the label instead of vanishing.
                warnings.push(`"${field.name}" uses a font with no EPL equivalent. It prints with resident font 1, which is a different size and shape.`);
            }
            const data = escapeEplData(fieldData(field, design));
            // p7 is the reverse flag. The designer has no reverse-text control,
            // so it is always 'N' — EPL prints black on white.
            lines.push(`A${origin.x},${origin.y},${rot},${eplFont ?? 1},${Math.max(1, Math.round(field.h_mag ?? 1))},${Math.max(1, Math.round(field.w_mag ?? 1))},N,"${data}"`);
            continue;
        }

        if (field.type === 'barcode') {
            const sym = field.symbology;
            const data = fieldData(field, design);

            // 2D symbols go through the `b` command, whose p3 LETTER names the
            // symbology (manual pp. 3-20 to 3-29). EPL2 has Data Matrix,
            // MaxiCode and PDF417 — and NO QR CODE, so a QR design genuinely
            // has no EPL representation and says so.
            if (EPL_2D_LETTER[sym]) {
                const moduleSize = Math.max(1, Math.round(field.w_mag ?? 5));
                const letter = EPL_2D_LETTER[sym];
                if (letter === 'P') {
                    // PDF417 is the one with a POSITIONAL tail: the manual gives
                    // "bp1,p2,p3,p4,p5[,p6][,p7]" where p4 (www) is the maximum
                    // print width in dots and p5 (hhh) the maximum height, and
                    // only then come the prefixed p6 (s, error correction) and
                    // p7 (c, compression). Emitting the h-prefix form used for
                    // Data Matrix and MaxiCode put a prefixed option where a
                    // bare dot count belongs.
                    //
                    // No s or c is written: the design model has no PDF417
                    // error-correction or compression field, so there is nothing
                    // to state. The printer picks its own defaults, which is
                    // what the manual describes for an omitted parameter.
                    const w = Math.max(1, dots(box.width));
                    const h = Math.max(1, dots(box.height));
                    lines.push(`b${origin.x},${origin.y},P,${w},${h},"${escapeEplData(data)}"`);
                    continue;
                }
                if (letter === 'M') {
                    // MaxiCode's mode is the positional p4, and the manual's own
                    // spellings are mixed case: M2, M3 (structured carrier) and
                    // m4, m6 (standard / reader programming). No p4 at all is
                    // the documented default — automatic selection.
                    const mode = field.maxiMode;
                    const p4 = mode === 2 || mode === 3 ? `,M${mode}`
                        : mode === 4 || mode === 6 ? `,m${mode}`
                        : '';
                    lines.push(`b${origin.x},${origin.y},M${p4},h${moduleSize},"${escapeEplData(data)}"`);
                    continue;
                }
                lines.push(`b${origin.x},${origin.y},${letter},h${moduleSize},"${escapeEplData(data)}"`);
                continue;
            }
            if (sym === '18') {
                warnings.push(`"${field.name}" is a QR code, which EPL does not have: the language's 2D command covers Data Matrix, MaxiCode and PDF417 only. It was left off the label.`);
                continue;
            }
            // The IPL id '7' is "EAN/UPC" and the printer infers the variant
            // from the data length; EPL spells the variant out in its type
            // letter, so it is resolved the same way the printer would.
            const eplType = sym === '7' ? eplEanType(data) : EPL_BARCODE_FOR[sym];
            if (!eplType) {
                warnings.push(sym === '7'
                    ? `"${field.name}" is an EAN/UPC bar code whose data is ${data.replace(/\D/g, '').length} digits, which is not a length EPL recognizes (7, 8, 12 or 13). It was left off the label.`
                    : `"${field.name}" is barcode type ${sym}, which this EPL subset cannot draw. It was left off the label.`);
                continue;
            }
            const heightDots = Math.max(1, dots(box.height));
            // IPL: 0 none, 1 below, 2 above. EPL has only below or none, so an
            // "above" request prints below WITH a warning. Emitting 'N' instead
            // would silently DROP the human-readable line, which is worse than
            // moving it — the reader still gets the digits.
            const hri = field.humanReadable === 'none' ? 'N' : 'B';
            if (field.humanReadable === 'above') {
                warnings.push(`"${field.name}" asks for the human-readable line above the bar code. EPL can only print it below, so it will print below.`);
            }
            const wide = Math.max(1, Math.round(field.w_mag ?? 1));
            lines.push(`B${origin.x},${origin.y},${rot},${eplType},${wide},${wide + 1},${heightDots},${hri},"${escapeEplData(data)}"`);
            continue;
        }

        if (field.type === 'box') {
            // X takes two opposite CORNERS plus the line thickness: p4/p5 are
            // the far corner, not a width and height.
            const w = dots(field.width);
            const h = dots(field.height);
            const t = Math.max(1, dots(field.thickness));
            if (field.cornerRadius) {
                warnings.push(`"${field.name}" has rounded corners, which EPL's box command cannot draw. It prints as a square box.`);
            }
            lines.push(`X${origin.x},${origin.y},${t},${origin.x + w},${origin.y + h}`);
            continue;
        }

        if (field.type === 'line') {
            // LO p3/p4 are the horizontal and vertical LENGTHS; a straight line
            // sets the one it does not run along to 0 (manual p. 3-69).
            const len = Math.max(1, dots(field.length));
            const t = Math.max(1, dots(field.thickness));
            const vertical = field.rotation === 90 || field.rotation === 270;
            lines.push(`LO${origin.x},${origin.y},${vertical ? t : len},${vertical ? len : t}`);
            continue;
        }

        warnings.push(`"${field.name}" is a ${field.type}, which EPL output does not support yet. It was left off the label.`);
    }

    // P copies (manual p. 3-87). The copy count is a job concern, so it comes
    // from the printer settings exactly as the ZPL generator's ^PQ does.
    lines.push(`P${Math.max(1, design.printerSettings.quantity)}`);
    return { epl: lines.join('\n'), warnings };
};
