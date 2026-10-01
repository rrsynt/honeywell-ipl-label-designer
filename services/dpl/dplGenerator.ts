// The Design model -> DPL, following the same shape as the EPL and TSPL
// generators: one record per field, wrapped in <STX>L ... E.
//
// The one thing that makes this generator different from its siblings: DPL
// positions are measured UP from the label's BOTTOM edge, while the designer
// measures DOWN from the top. Every row therefore has to be flipped, and the
// label length the flip needs is the stock height — which the design knows and
// a DPL stream cannot say (see dplParser).

import type { Design, Field, TextField, BarcodeField, PolygonField, TriangleField } from '../../types';
import { DPI_MAP } from '../../constants';
import { getObjectBoundingBox } from '../geometry';
import { resolveLinkedPreview, applyTransform } from '../tableSource';
import { getFormattedDateTime } from '../dateTimeFormat';
import { dplMultiplier } from './dplFonts';
import { DPL_BARCODES } from './dplBarcodes';
import { charsetWarning } from '../charsetRisk';

export interface DplGenerateResult {
    dpl: string;
    warnings: string[];
}

/** Rotation: 1 = 0°, 2 = 90°, 3 = 180°, 4 = 270°, all CLOCKWISE (p. 133). */
const dplRotation = (rotation: number): number => {
    const q = ((Math.round(rotation / 90) % 4) + 4) % 4;
    return ((4 - q) % 4) + 1;
};

/**
 * The DPL bar code letter for an IR symbology, choosing the case by whether a
 * human-readable line is wanted: "Values A through T (uppercase) will print bar
 * codes with human-readable interpretations. Values a through z (lowercase)
 * will print bar codes only" (p. 133).
 */
const DPL_LETTER_FOR: Record<string, { letter: string; wId?: string; name: string }> = {
    '0': { letter: 'A', name: 'Code 39' },
    '2': { letter: 'D', name: 'Interleaved 2 of 5' },
    '4': { letter: 'I', name: 'Codabar' },
    '6': { letter: 'E', name: 'Code 128' },
    // '7' (EAN/UPC) is NOT here: B/C/F/G are one id in the IR, so the letter is
    // derived from the data length in bFieldFor, not fixed.
    '11': { letter: 'P', name: 'Postnet' },
    '12': { letter: 'Z', name: 'PDF417', wId: 'W1Z' },
    '14': { letter: 'U', name: 'UPS MaxiCode' },
    '17': { letter: 'C', name: 'DataMatrix', wId: 'W1C' },
    '18': { letter: 'D', name: 'QR Code', wId: 'W1D' },
    '23': { letter: 'F', name: 'Aztec', wId: 'W1F' },
};

/**
 * The EAN/UPC family's DPL letter is chosen by the DATA LENGTH: B/C/F/G are
 * four different symbols that all share the IR's symbology id '7' (the DPL
 * parser's `DPL_BARCODES` reads exactly this back, carrying `eanVariant`).
 * The same rule the EPL and TSPL generators use.
 *
 * Emitting 'B' for all of them exported an EAN-13 as UPC-A — and the printer
 * draws the symbol the LETTER names, so a 13-digit payload under `B` is a
 * wrong-symbol bar code, silently, exactly the class this project fights.
 */
const dplEanLetter = (data: string): { letter: string; name: string } | null => {
    switch (data.replace(/\D/g, '').length) {
        case 13: return { letter: 'F', name: 'EAN-13' };
        case 12: return { letter: 'B', name: 'UPC-A' };
        case 8: return { letter: 'G', name: 'EAN-8' };
        case 7: return { letter: 'C', name: 'UPC-E' };
        default: return null;
    }
};

/**
 * DPL's `Wxx` two-character IDs are addressed through the SAME b field that
 * normally holds one letter, so the record header shifts by two characters
 * when one is used — a generator that pads them to one letter would produce a
 * stream the printer reads as a completely different record.
 */
const bFieldFor = (sym: string, hri: boolean, data = ''): { field: string; warning?: string } | null => {
    let entry = DPL_LETTER_FOR[sym];
    if (sym === '7') {
        // B/C/F/G are one symbology id in the IR; the length picks the letter.
        const ean = dplEanLetter(data);
        if (!ean) return null;
        entry = { letter: ean.letter, name: ean.name };
    }
    if (!entry) return null;
    if (entry.wId) {
        // "The column labeled..." — the W forms carry their own case rule:
        // W1C (upper C) prints human readable, W1c does not.
        const field = hri ? entry.wId : entry.wId.slice(0, 2) + entry.wId[2].toLowerCase();
        return { field };
    }
    // Postnet, MaxiCode and PDF417 have no human-readable form at all, so the
    // lowercase letter is the ONLY valid spelling; asking for text would give
    // the printer a letter the manual says is invalid.
    const noHri = sym === '11' || sym === '14' || sym === '12';
    const letter = hri && !noHri ? entry.letter : entry.letter.toLowerCase();
    return {
        field: letter,
        ...(hri && noHri
            ? { warning: `DPL's ${entry.name} has no human-readable form, so the line is not printed.` }
            : {}),
    };
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
 * The vertices of a designer shape, in MILLIMETRES relative to the field's
 * own top-left corner — the same figure `traceShape` (canvasDrawer.ts) puts on
 * screen and `shapeToIplGraphicData` (iplGenerator.ts) rasterizes. The three
 * must agree or the label prints a shape the designer never showed.
 */
const shapeVertices = (field: PolygonField | TriangleField): { x: number; y: number }[] => {
    const { width: w, height: h } = field;
    if (field.type === 'triangle') {
        return [{ x: w / 2, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
    }
    // A regular polygon with one vertex straight up, so a square reads as a
    // diamond — the arrangement the screen draws.
    const sides = Math.max(3, Math.round(field.sides));
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < sides; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / sides;
        out.push({ x: w / 2 + (w / 2) * Math.cos(a), y: h / 2 + (h / 2) * Math.sin(a) });
    }
    return out;
};

/**
 * A point in the field's own box -> absolute millimetres on the label.
 *
 * The rotation is applied the way the designer draws it: counterclockwise
 * about the field's top-left corner (canvasDrawer's `ctx.rotate(-rotation)`),
 * so the ink lands exactly where the screen showed it. A DPL polygon record
 * states every vertex, so it can carry the rotation itself — and it must,
 * because the record has no rotation of its own (Table 8-13: "must be 1").
 */
const rotateAbout = (field: Field, u: number, v: number): { x: number; y: number } => {
    const theta = -field.rotation * Math.PI / 180;
    return {
        x: field.x + u * Math.cos(theta) - v * Math.sin(theta),
        y: field.y + u * Math.sin(theta) + v * Math.cos(theta),
    };
};

export const generateDPL = (design: Design): DplGenerateResult => {
    const dpi = design.printerSettings.dpi;
    const dots = (mm: number) => Math.round(mm * DPI_MAP[dpi]);
    const warnings: string[] = [];
    const lines: string[] = [];

    const { width, height, orientation } = design.labelSettings;
    const landscape = orientation === 'landscape';
    // The label LENGTH as the printer sees it: the feed direction.
    const labelLengthDots = dots(landscape ? width : height);

    /**
     * Millimetres from the TOP of the label -> DPL rows counting UP from the
     * bottom, in hundredths of an inch (imperial is DPL's default mode; the
     * generator stays in it so the stream needs no <STX>m).
     */
    const rowFor = (mmFromTop: number): number => {
        const fromBottom = (landscape ? width : height) - mmFromTop;
        return Math.max(0, Math.min(9999, Math.round((fromBottom / 25.4) * 100)));
    };
    const colFor = (mmFromLeft: number): number =>
        Math.max(0, Math.min(9999, Math.round((mmFromLeft / 25.4) * 100)));

    // ---- Image downloads ------------------------------------------------
    // An image is not a label record; it is DOWNLOADED first and then printed
    // by name, so every image gets a `<STX>I` block ahead of `<STX>L` and a
    // `Y` record in the label (Table 8-11). The PARSER has drawn images since
    // it read `<STX>I` (dplParser, "Image (b = Y)"); this side had nothing, so
    // the designer's Image tool exported "DPL output does not support yet"
    // about a shape the same language's reader already understood.
    //
    // The Datamax 7-bit ASCII file (Appendix O) is a list of dot-row records
    // `80nndd...d`, nn being the byte count in ASCII hex, terminated by
    // `FFFF`. It is the ONLY format whose bytes are printable characters, so
    // it needs no `<SOH>D` — "If any of the 8-bit input formats are to be used,
    // it is necessary to disable the Immediate Command interpreter" (p. 20),
    // and 7-bit ASCII is not one of them.
    const imageName = new Map<number, string>();
    const imageSkipReason = new Map<number, string>();
    let imageSeq = 0;
    for (const field of design.fields) {
        if (field.type !== 'image') continue;
        const rows = field.bitmap;
        if (rows.length === 0 || !rows[0]) {
            imageSkipReason.set(field.id, `"${field.name}" is an image with no bitmap data, so there is nothing to print.`);
            continue;
        }
        // A dot-row record counts its bytes in one hex byte, so it carries at
        // most 255 of them — 2040 dots. Wider than that has no record form.
        const bytesPerRow = Math.ceil(rows[0].length / 8);
        if (bytesPerRow > 255) {
            imageSkipReason.set(field.id, `"${field.name}" is ${bytesPerRow * 8} dots wide, but a DPL dot-row record carries at most 2040 dots, so the image was left off the label.`);
            continue;
        }
        const name = `IMG${imageSeq++}`;
        imageName.set(field.id, name);
        // a = bank (D, the manual's own <STX>IDpTest), b omitted, f = F (7-bit
        // Datamax image file), then the name up to <CR>.
        lines.push(`\x02I1F${name}`);
        for (const row of rows) {
            // MSB-first, one set bit is ink, each row padded to whole bytes —
            // the same convention the parser reads back (`imageRowToBytes`),
            // and a row that is not a multiple of 8 wide does not spill.
            let hex = '';
            for (let b = 0; b < bytesPerRow; b++) {
                let byte = 0;
                for (let k = 0; k < 8; k++) {
                    const x = b * 8 + k;
                    if (x < row.length && row[x] === '1') byte |= 0x80 >> k;
                }
                hex += byte.toString(16).toUpperCase().padStart(2, '0');
            }
            lines.push(`80${bytesPerRow.toString(16).toUpperCase().padStart(2, '0')}${hex}`);
        }
        lines.push('FFFF');
    }

    lines.push(`\x02L`);
    // Density and speed are printer commands with the same letters as the
    // label-level ones; D11 is the dot-size multiplier every example uses.
    lines.push(`D11`);

    for (const field of design.fields) {
        const box = getObjectBoundingBox(field, design);
        const row = rowFor(field.y + box.height);
        const col = colFor(field.x);
        const rot = dplRotation(field.rotation);
        const rowStr = String(row).padStart(4, '0');
        const colStr = String(col).padStart(4, '0');

        if (field.type === 'text') {
            const data = fieldData(field, design);
            // Font 9 (smooth/scalable) needs the two extra size fields; the
            // bitmap fonts 0-8 must NOT carry them or the record shifts.
            const smooth = field.fontSize >= 14;
            const b = smooth ? '9' : '2';
            if (smooth) {
                const pts = String(Math.max(4, Math.min(72, Math.round(field.fontSize))));
                lines.push(`${rot}${b}${dplMultiplier(field.w_mag)}${dplMultiplier(field.h_mag)}A${pts.padStart(2, '0')}${rowStr}${colStr}P${pts.padStart(3, '0')}P${pts.padStart(3, '0')}${data}`);
            } else {
                lines.push(`${rot}${b}${dplMultiplier(field.w_mag)}${dplMultiplier(field.h_mag)}000${rowStr}${colStr}${data}`);
            }
            continue;
        }

        if (field.type === 'barcode') {
            const data = fieldData(field, design);
            const wantHri = field.humanReadable !== 'none';
            const bf = bFieldFor(field.symbology, wantHri, data);
            if (!bf) {
                if (field.symbology === '7') {
                    // B/C/F/G are told apart by the digit count; a length none of
                    // them takes cannot be written as any EAN/UPC member.
                    warnings.push(`"${field.name}" is an EAN/UPC bar code whose data is ${data.replace(/\D/g, '').length} digits, which is not a length DPL recognizes (12 UPC-A, 7 UPC-E, 13 EAN-13 or 8 EAN-8). It was left off the label.`);
                } else {
                    warnings.push(`"${field.name}" is barcode type ${field.symbology}, which has no DPL equivalent. It was left off the label.`);
                }
                continue;
            }
            if (bf.warning) warnings.push(`"${field.name}": ${bf.warning}`);
            // eee is the symbol height, also in hundredths of an inch.
            const heightUnits = Math.max(1, Math.min(999, Math.round((field.h_mag / dpi / 25.4) * 100 * 100) || 40));
            // c is the wide bar, d the narrow bar; for module-based codes the
            // manual requires them to match.
            const narrow = dplMultiplier(Math.max(1, field.w_mag));
            lines.push(`${rot}${bf.field}${narrow}${narrow}${String(heightUnits).padStart(3, '0')}${rowStr}${colStr}${data}`);
            continue;
        }

        if (field.type === 'box') {
            const w = Math.round((field.width / 25.4) * 100);
            const h = Math.round((field.height / 25.4) * 100);
            const t = Math.max(1, Math.round((field.thickness / 25.4) * 100));
            // "BOX***: Bhhhvvvbbbsss" — width, height, top/bottom thickness,
            // side thickness, all three digits.
            const obj = `B${String(w).padStart(3, '0')}${String(h).padStart(3, '0')}${String(t).padStart(3, '0')}${String(t).padStart(3, '0')}`;
            lines.push(`1X11000${rowStr}${colStr}${obj}`);
            continue;
        }

        if (field.type === 'ellipse') {
            // Only a CIRCLE can be written. DPL's circle record — "1 X 11 fff
            // rrrr cccc C ppp bbbb rrrr", Table 8-14 — carries ONE radius and
            // has no way to state two axes, which is why the PARSER already
            // maps it to an equal-axis ellipse. The gap was on this side: the
            // parser drew a circle DPL sends, and the generator never sent one.
            //
            // An ellipse is therefore printed as a circle of the smaller axis
            // and the difference is NAMED — a wrong shape drawn without comment
            // is the failure mode this project exists to prevent.
            const w = Math.round((field.width / 25.4) * 100);
            const h = Math.round((field.height / 25.4) * 100);
            if (w !== h) {
                warnings.push(`"${field.name}" is an ellipse, but a DPL circle carries a single radius, so it prints as a circle of its smaller axis.`);
            }
            const r = Math.max(1, Math.round(Math.min(w, h) / 2));
            // The header's ffff/gggg are the CENTRE, not a corner: the parser
            // reads them that way, and every manual sample agrees.
            const cy = rowFor(field.y + field.height / 2);
            const cx = colFor(field.x + field.width / 2);
            // The FILL PATTERN is `fff` IN THE HEADER — Table 8-14 lists it
            // beside `rrrr`, and `001` inside the data field is a FIXED VALUE
            // like the `0001` next to it. The manual's four graphic samples
            // prove both halves: pattern 4's record carries `004` in the
            // HEADER, and every one of them carries `001` after the letter
            // whatever its fill.
            //
            // `thickness: 0` fills the shape on screen (canvasDrawer fills the
            // path at zero line width), so it is pattern 1, "Solid Black";
            // anything else is an outline, which is pattern 0, "No Pattern".
            // Writing `000` unconditionally printed a solid ellipse as a hollow
            // one and said nothing.
            const fill = field.thickness <= 0 ? 1 : 0;
            // Data field: `C` + the FIXED `001` + the FIXED `0001` + the radius.
            // The manual's own sample, spaces removed, is
            // `1X1100001000100C00100010025` — `C` `001` `0001` `0025` — and the
            // parser takes the radius as `body.slice(7, 11)` for exactly that
            // reason. Emitting `C000` + radius left the radius three characters
            // short, and a round-trip came back with none.
            lines.push(`1X11${String(fill).padStart(3, '0')}${String(cy).padStart(4, '0')}${String(cx).padStart(4, '0')}C0010001${String(r).padStart(4, '0')}`);
            continue;
        }

        if (field.type === 'polygon' || field.type === 'triangle') {
            // "1 X 11 ppp rrrr cccc P 001 0001 rrrr cccc rrrr cccc …" (Table
            // 8-13, p. 140): "Polygons are created by defining the positions of
            // the corners… The points must be specified in the order to be
            // drawn; the last point specified is automatically connected to the
            // first." The first point is the RECORD'S OWN row/column, so it is
            // emitted in the header and left out of the tail.
            //
            // This branch was missing while the PARSER drew P records and the
            // manual defined them — the same asymmetry the ellipse above had:
            // the language could print it, our export said it could not.
            const vertices = shapeVertices(field).map(p => rotateAbout(field, p.x, p.y));
            // The vertices are absolute millimetres; DPL wants hundredths of an
            // inch counting UP from the bottom edge, which rowFor/colFor do.
            const pts = vertices.map(p => ({ r: rowFor(p.y), c: colFor(p.x) }));
            const fill = field.thickness <= 0 ? 1 : 0;
            const first = pts[0];
            const tail = pts.slice(1)
                .map(p => `${String(p.r).padStart(4, '0')}${String(p.c).padStart(4, '0')}`)
                .join('');
            // Rotation "must be 1": the vertices carry the orientation instead.
            lines.push(`1X11${String(fill).padStart(3, '0')}${String(first.r).padStart(4, '0')}${String(first.c).padStart(4, '0')}P0010001${tail}`);
            continue;
        }

        if (field.type === 'line') {
            const vertical = field.rotation === 90 || field.rotation === 270;
            const len = Math.round((field.length / 25.4) * 100);
            const th = Math.max(1, Math.round((field.thickness / 25.4) * 100));
            // "LINE*: Lhhhvvv" — a line is a filled box, so one dimension is
            // the thickness.
            const w = vertical ? th : len;
            const h = vertical ? len : th;
            const obj = `L${String(w).padStart(3, '0')}${String(h).padStart(3, '0')}`;
            lines.push(`1X11000${rowStr}${colStr}${obj}`);
            continue;
        }

        if (field.type === 'image') {
            const skip = imageSkipReason.get(field.id);
            if (skip) { warnings.push(skip); continue; }
            // Table 8-11: `a b c d eee ffff gggg jj...j` where a=1 fixed,
            // b=Y the image record, c/d the width/height multipliers, eee=000
            // fixed, ffff/gggg the Row/Column of the image's LOWER-LEFT corner,
            // jj...j the downloaded name. "Images can be printed only in
            // Rotation 1" — a DPL image record has no rotation of its own, so
            // the digit is always 1 and a rotated image is named rather than
            // silently mis-placed.
            if (field.rotation % 360 !== 0) {
                warnings.push(`"${field.name}" is rotated, but a DPL image prints in Rotation 1 only, so it prints upright.`);
            }
            // The bitmap is one dot per cell, so a 1x1 multiplier prints it at
            // its own grid size. rowFor/colFor state where the bitmap's bottom
            // edge sits, which is what the record's Row names.
            const name = imageName.get(field.id) ?? '';
            lines.push(`1Y11000${rowStr}${colStr}${name}`);
            continue;
        }

        // Unreachable today — every FieldType is handled above — but kept so
        // a future field type is NAMED rather than silently dropped.
        const leftover = field as Field;
        warnings.push(`"${leftover.name}" is a ${leftover.type}, which DPL output does not support yet. It was left off the label.`);
    }

    // Q is the label count, E terminates and prints (manual pp. 118, 113).
    lines.push(`Q${String(Math.max(1, design.printerSettings.quantity)).padStart(4, '0')}`);
    lines.push('E');

    const charset = charsetWarning(design, 'dpl');
    if (charset) warnings.push(charset);
    return { dpl: lines.join('\r') + '\r', warnings };
};
