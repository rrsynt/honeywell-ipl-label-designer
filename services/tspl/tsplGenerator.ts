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
import { parseMaxiCodeScm } from '../ipl/maxiCodeScm';
import { charsetWarning } from '../charsetRisk';

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
/**
 * The IR's c20,m1 GS1 DataBar version onto the `RSS` command's symbology name
 * (TSC manual p. 71), and the bar height the printer computes for each.
 *
 * m1=5 (plain expanded) has no TSPL name of its own: the manual's RSSEXP is the
 * one that takes a segment width, which is the expanded-STACKED parameter.
 * Emitting 'RSSEXP' for m1=5 therefore prints a stacked symbol where an
 * expanded one was asked for, so that case is named rather than silently
 * turned into a different shape.
 */
const TSPL_RSS_NAME: Record<string, string> = {
    '0': 'RSS14', '1': 'RSS14T', '2': 'RSS14S', '3': 'RSS14SO', '4': 'RSSLIM', '6': 'RSSEXP',
};
const RSS_HEIGHT_FOR: Record<string, number> = {
    RSS14: 33, RSS14T: 13, RSS14S: 13, RSS14SO: 33, RSSLIM: 13, RSSEXP: 33,
};

const TSPL_2D_COMMAND: Record<string, string> = {
    '17': 'DMATRIX',
    '18': 'QRCODE',
    '12': 'PDF417',
    '19': 'MPDF417',
    '14': 'MAXICODE',
    '23': 'AZTEC',
    '24': 'CODABLOCK',
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

        // TSPL has a NATIVE ellipse command, so a design ellipse is emitted as
        // one instead of going through the rasterize-and-download path the
        // other languages need — a circle and an ellipse are separate commands
        // (manual pp. 48-49), told apart by their two axes.
        if (field.type === 'ellipse') {
            const e = field as unknown as { width: number; height: number; thickness: number };
            const w = Math.max(1, dots(e.width));
            const h = Math.max(1, dots(e.height));
            const t = Math.max(1, dots(e.thickness));
            lines.push(w === h ? `CIRCLE ${x},${y},${w},${t}` : `ELLIPSE ${x},${y},${w},${h},${t}`);
            continue;
        }

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
            // table (manual pp. 51, 56, 65). MaxiCode is left to TSPL_2D_MISSING
            // below; every symbol in TSPL_2D_COMMAND is emitted.
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
                } else if (cmd === 'DMATRIX') {
                    // DMATRIX x,y,width,height,[x#,r#][,a#],"content" (TSC
                    // manual p. 51). Positional width/height are the barcode
                    // AREA; x# is the module size, r# the rotation. ECC-200 is
                    // the only correction the command supports, which is the
                    // encoder here. The rectangle option matches the IR's
                    // dmShape, from the design's own rectangle request.
                    const w = Math.max(1, dots(box.width));
                    const h = Math.max(1, dots(box.height));
                    const mod = Math.max(1, Math.round(field.w_mag ?? 3));
                    const rot = (field.rotation / 90) * 90 % 360;
                    lines.push(`DMATRIX ${x},${y},${w},${h},x${mod},r${rot},"${escapeTsplData(data)}"`);
                } else if (cmd === 'AZTEC') {
                    // AZTEC x,y,rotate,[size,]ecp,]flg,]menu,]multi,]rev,]"content"
                    // (TSC manual p. 59). The parameters after the rotation are
                    // POSITIONAL and optional, so an unset `size` still has to
                    // be written if `ecp` is present — a gap in a positional
                    // list shifts every later value.
                    const size = Math.max(1, Math.min(20, Math.round(field.w_mag ?? 6) || 6));
                    const ecp = (field as { aztecEcp?: string }).aztecEcp;
                    const head = ecp === undefined || ecp === '' ? '' : `${size},${ecp},`;
                    lines.push(`AZTEC ${x},${y},${rotation},${head}"${escapeTsplData(data)}"`);
                } else if (cmd === 'CODABLOCK') {
                    // CODABLOCK x,y,rotation,[row height,]module width,]"content"
                    // (TSC manual p. 50). Row height is written only when a
                    // module width follows it, because the two are positional.
                    const modW = Math.max(1, Math.round(field.w_mag ?? 2) || 2);
                    const rowH = (field as { codablockRowHeight?: string }).codablockRowHeight;
                    const head = rowH === undefined || rowH === '' ? '' : `${rowH},`;
                    lines.push(`CODABLOCK ${x},${y},${rotation},${head}${modW},"${escapeTsplData(data)}"`);
                } else if (cmd === 'MAXICODE') {
                    // MAXICODE x,y,mode,[class,country,post,]\"content\" (TSC
                    // manual p. 54). The symbol is FIXED SIZE — the command has
                    // no width, height or module parameter at all, only the
                    // start point — so the design's box does not appear here.
                    //
                    // Modes 2 and 3 carry the class, country and postal code as
                    // PARAMETERS, while the design holds them inside the data
                    // as the AIM SCM every encoder here expects. They have to be
                    // taken back apart; emitting the SCM as the content would
                    // put the whole message in the body field and print a
                    // different symbol than the preview drew.
                    const mode = field.maxiMode === undefined ? undefined : String(field.maxiMode);
                    if (mode === '2' || mode === '3') {
                        const scm = parseMaxiCodeScm(data);
                        if (!scm) {
                            warnings.push(`"${field.name}" is a MaxiCode mode ${mode}, whose class, country and postal code TSPL writes as separate parameters. The data does not carry a structured carrier message, so the fields could not be written and the bar code was left off the label.`);
                            continue;
                        }
                        lines.push(`MAXICODE ${x},${y},${mode},${scm.serviceClass},${scm.country},${scm.postcode},"${escapeTsplData(scm.body)}"`);
                    } else if (mode === '4' || mode === '5' || mode === '6') {
                        lines.push(`MAXICODE ${x},${y},${mode},"${escapeTsplData(data)}"`);
                    } else {
                        // TSPL has no "automatic selection": the mode is a
                        // required parameter, and unlike EPL it documents no
                        // fallback. A design with no mode therefore cannot be
                        // written as authored — mode 4 is the standard symbol
                        // that carries a plain message, which is what such a
                        // design's data is.
                        warnings.push(`"${field.name}" is a MaxiCode with no mode set; TSPL has no automatic selection, so it prints as mode 4 (standard symbol).`);
                        lines.push(`MAXICODE ${x},${y},4,"${escapeTsplData(data)}"`);
                    }
                } else {
                    const w = Math.max(1, dots(box.width));
                    const h = Math.max(1, dots(box.height));
                    lines.push(`PDF417 ${x},${y},${w},${h},${rotation},"${escapeTsplData(data)}"`);
                }
                continue;
            }
            if (sym === '20') {
                // GS1 DataBar has its OWN command in TSPL (RSS, manual p. 71),
                // not a BARCODE type — and this generator used to leave it off
                // the label under "type 20, which this TSPL subset cannot
                // draw", a claim the manual's own section disproves. The
                // encoder has produced it for IPL and EPL all along.
                const name = TSPL_RSS_NAME[String(field.rssVersion ?? '2')];
                if (!name) {
                    warnings.push(`"${field.name}" is a GS1 DataBar variant (${field.rssVersion}) with no TSPL name. It was left off the label.`);
                    continue;
                }
                const pixMult = Math.max(1, Math.min(10, Math.round(field.w_mag ?? 2) || 2));
                // The printer computes the bar height from the type and pixMult,
                // so the design's own height is not something this command can
                // state. Name the difference rather than drop it in silence.
                const expected = (RSS_HEIGHT_FOR[name] ?? 33) * pixMult;
                if (Math.abs((field.h_mag ?? expected) - expected) > 1) {
                    warnings.push(`"${field.name}" is a GS1 DataBar ${name}, whose bar height TSPL computes from the module width (${RSS_HEIGHT_FOR[name] ?? 33} × ${pixMult} = ${expected} dots). The design asks for ${field.h_mag}; the printer's figure is used.`);
                }
                const sepHt = name === 'RSS14S' || name === 'RSS14SO' ? Math.max(1, Math.min(2, Number(field.rssSepHeight ?? 1) || 1)) : undefined;
                const seg = name === 'RSSEXP' ? Number(field.rssSegments ?? 0) : NaN;
                const extras = [
                    sepHt !== undefined ? String(sepHt) : null,
                    Number.isInteger(seg) && seg >= 2 && seg <= 22 ? String(seg) : null,
                ].filter((v): v is string => v !== null);
                const mid = [String(pixMult), ...extras].join(',');
                lines.push(`RSS ${x},${y},"${name}",${rotation},${mid},"${escapeTsplData(data)}"`);
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
            // BARCODE's height is the BAR height (manual p. 38), and the HRI line is a
            // separate parameter. The field's h_mag IS that bar height; box.height
            // adds the interpretive row on top, so using it over-tallened the
            // symbol by one text row whenever the HRI was on.
            const heightDots = Math.max(1, field.h_mag || 50);
            // TSPL's human readable is 0 none / 1 left / 2 center / 3 right —
            // ALL below the bar, and there is no above at all. A design asking
            // for "above" gets it below WITH a warning: dropping it would lose
            // the digits, which is worse than moving them. TSPL is the ONE
            // language here whose BARCODE carries the horizontal alignment, so
            // a centre/right hriAlign is emitted (2/3) rather than lost.
            const hri = field.humanReadable === 'none' ? 0
                : field.hriAlign === 'center' ? 2
                : field.hriAlign === 'right' ? 3
                : 1;
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

        if (field.type === 'image') {
            // TSPL's BITMAP carries its dots as RAW BINARY bytes after the
            // last comma (manual p. 45) — unlike DPL's `<STX>I F` and ZPL's
            // `^GF`, which send the same pixels as ASCII hex. Every path this
            // app sends on is UTF-8 text (the bridge posts text/plain, the
            // server says charset=utf-8), and UTF-8 turns any byte ≥ 0x80 into
            // more than one byte, so a raw-binary BITMAP would reach the
            // printer corrupted — a logo that comes out as garbage, not an
            // error. TSPL has no hex image form to fall back on, so the image
            // is NAMED rather than sent wrong.
            warnings.push(`"${field.name}" is an image, and TSPL's BITMAP sends its dots as raw binary, which the text transport to the printer would corrupt. TSPL has no hex image form, so the image was left off the label.`);
            continue;
        }

        warnings.push(`"${field.name}" is a ${field.type}, which TSPL output does not support yet. It was left off the label.`);
    }

    // PRINT copies,sets — the copies come from the printer settings, exactly as
    // the ZPL generator's ^PQ and the EPL one's P do.
    lines.push(`PRINT ${Math.max(1, design.printerSettings.quantity)},1`);
    const charset = charsetWarning(design, 'tspl');
    if (charset) warnings.push(charset);
    return { tspl: lines.join('\n'), warnings };
};
