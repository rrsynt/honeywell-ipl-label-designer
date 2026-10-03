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
import { getObjectBoundingBox, shiftForTextAlign, printableFields } from '../geometry';
import { resolveLinkedPreview, applyTransform } from '../tableSource';
import { getFormattedDateTime } from '../dateTimeFormat';
import { parseMaxiCodeScm } from '../ipl/maxiCodeScm';
import { charsetWarning } from '../charsetRisk';

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
/**
 * Design font -> EPL resident font (1-5, manual pp. 3-4/3-5). This MUST be the
 * exact reverse of the parser's cell table, and the two keep the RANK order:
 * the designer's bitmap fonts grow 0 (7x9) < 1 (7x11) < 2 (10x14), and EPL's
 * grow 1 (8x12) < 2 (10x16) < 3 (12x20), so 0->1, 1->2, 2->3. The table used
 * to send font 1 -> EPL 3 and font 2 -> EPL 2, which swapped the middle two and
 * broke the round trip: a saved design's font 1 reloaded as font 2 and back.
 * (EPL has no cell that is 7 dots wide, so width cannot drive the choice; the
 * height rank is what both tables can agree on.)
 */
const EPL_FONT_FOR: Record<string, number> = {
    '0': 1,  // 7x9   -> EPL 1 (8x12)
    '1': 2,  // 7x11  -> EPL 2 (10x16)
    '2': 3,  // 10x14 -> EPL 3 (12x20)
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
    '11': 'P',  // Postnet
    '22': 'PL', // Planet
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

    // The stock is exactly what the settings say: q is the label WIDTH and Q the
    // form LENGTH (manual pp. 3-89, 3-91), with no landscape transpose. A
    // landscape stock is simply one whose width exceeds its length — the driver
    // leaves the coordinates alone, and the canvas, IPL and sheet preview all
    // read it that way. This generator used to swap the axes, so a landscape
    // design emitted a label turned a quarter — a field drawn near the right
    // edge landed off the label.
    const { width, height } = design.labelSettings;
    lines.push(`q${dots(width)}`);
    lines.push(`Q${dots(height)},${Math.max(0, Math.round((design.printerSettings.mediaSenseMode === 'continuous' ? 0 : 3)))}`);

    for (const field of printableFields(design)) {
        const box = getObjectBoundingBox(field, design);
        // A text block's `align` has no EPL parameter — the printer only moves
        // origins — so a centre/right block starts further back along its text
        // axis, matching the designer canvas and IPL's baked origin.
        const origin = shiftForTextAlign(topLeftDots(field, box, dpi), field, dots(box.width));
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
            // p5 is the HORIZONTAL multiplier and p6 the VERTICAL one (manual
            // p. 3-4). Emitting h_mag into p5 applied the height to the width,
            // so a "wide" text printed tall and a "tall" one printed wide —
            // the same swap the parser already documents fixing on its side.
            // The parser reads p5 -> w_mag and p6 -> h_mag, so this is the
            // symmetric write. p7 is the reverse flag, always 'N' (the designer
            // has no reverse-text control; EPL prints black on white).
            lines.push(`A${origin.x},${origin.y},${rot},${eplFont ?? 1},${Math.max(1, Math.round(field.w_mag ?? 1))},${Math.max(1, Math.round(field.h_mag ?? 1))},N,"${data}"`);
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
                    // MaxiCode's positional p4 is the mode, and the manual's
                    // spellings are mixed case: M2, M3 (structured carrier) and
                    // m4, m6 (standard / reader programming). No p4 at all is
                    // the documented default — automatic selection.
                    //
                    // MaxiCode has NO module-size parameter. Its p5 is "x,y",
                    // the associated-symbol numbering (manual p. 3-25), so the
                    // `,h<size>` copied from the Data Matrix form was a
                    // malformed parameter the printer does not define there —
                    // a MaxiCode is a fixed-size symbol. Dropped.
                    const mode = field.maxiMode;
                    const p4 = mode === 2 || mode === 3 ? `,M${mode}`
                        : mode === 4 || mode === 6 ? `,m${mode}`
                        : '';
                    // Modes 2 and 3 write the class, country and postal code as
                    // the leading fields of the DATA, not as parameters (manual
                    // p. 3-26: "cl,co,pc,lpm"). The design carries them inside
                    // an AIM SCM, so they are taken apart again — emitting the
                    // SCM as-is would put the whole message where the postal
                    // code belongs.
                    let out = data;
                    if (mode === 2 || mode === 3) {
                        const scm = parseMaxiCodeScm(data);
                        if (!scm) {
                            warnings.push(`"${field.name}" is a MaxiCode mode ${mode}, whose data EPL writes as "class,country,postal code,message" (manual p. 3-26). The data does not carry a structured carrier message, so the fields could not be written and the bar code was left off the label.`);
                            continue;
                        }
                        out = `${scm.serviceClass},${scm.country},${scm.postcode},${scm.body}`;
                    }
                    lines.push(`b${origin.x},${origin.y},M${p4},"${escapeEplData(out)}"`);
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
            // Code 39's host-verified check digit is EPL type '3C' (manual
            // Table 2-1, p. 3-12). Emitting plain '3' for it dropped the check
            // digit in one direction while the parser reads '3C' back as
            // host-verifies — a design saved and reloaded changed its bar code
            // silently, the exact drift the reverse-table comment forbids.
            const code39HostChecked = sym === '0' && field.code39_checkDigit === 'host-verifies';
            // Code 128's forced start subset is EPL type '1A'/'1B'/'1C' (manual
            // Table 2-1); '1' is the automatic default. Emitting plain '1' for a
            // forced subset lost it, while the parser reads the letter back.
            const c128 = sym === '6' && (field.code128_subset === 'a' || field.code128_subset === 'b' || field.code128_subset === 'c')
                ? `1${field.code128_subset.toUpperCase()}`
                : undefined;
            const eplType = sym === '7' ? eplEanType(data) : (code39HostChecked ? '3C' : (c128 ?? EPL_BARCODE_FOR[sym]));
            if (field.code39_checkDigit === 'printer-generated' && sym === '0') {
                // EPL has no "printer enters the check digit" Code 39 type — '3C'
                // is the host-verified one. The nearest honest form is plain '3',
                // which prints the data as given (the digit the designer asked the
                // printer to compute is not added). Named so it is not silent.
                warnings.push(`"${field.name}" asks Code 39 to have the printer add its check digit. EPL has no such type ('3C' verifies a digit the host supplied), so the bar code prints without it.`);
            }
            if (!eplType) {
                warnings.push(sym === '7'
                    ? `"${field.name}" is an EAN/UPC bar code whose data is ${data.replace(/\D/g, '').length} digits, which is not a length EPL recognizes (7, 8, 12 or 13). It was left off the label.`
                    : `"${field.name}" is barcode type ${sym}, which this EPL subset cannot draw. It was left off the label.`);
                continue;
            }
            // The height parameter is the BAR height ("p7 = Bar code height in dots",
// manual p. 3-11), and the human-readable row is drawn separately (p8). The
// field's h_mag IS that bar height; box.height adds the interpretive row on
// top, so using it over-tallened the symbol by one text row whenever the HRI
// was on.
            const heightDots = Math.max(1, field.h_mag || 50);
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

        if (field.type === 'image') {
            // EPL's GW sends its dots as RAW BINARY glued to the fourth
            // parameter (manual p. 3-62) — the same shape as TSPL's BITMAP,
            // and unlike DPL's `<STX>I F` or ZPL's `^GF`, which send hex ASCII.
            // Every path this app sends on is UTF-8 text, which corrupts any
            // byte >= 0x80; EPL has no hex image form, so the image is NAMED
            // rather than sent wrong.
            warnings.push(`"${field.name}" is an image, and EPL's GW sends its dots as raw binary, which the text transport to the printer would corrupt. EPL has no hex image form, so the image was left off the label.`);
            continue;
        }

        warnings.push(`"${field.name}" is a ${field.type}, which EPL output does not support yet. It was left off the label.`);
    }

    // P copies (manual p. 3-87). The copy count is a job concern, so it comes
    // from the printer settings exactly as the ZPL generator's ^PQ does.
    lines.push(`P${Math.max(1, design.printerSettings.quantity)}`);
    const charset = charsetWarning(design, 'epl');
    if (charset) warnings.push(charset);
    return { epl: lines.join('\n'), warnings };
};
