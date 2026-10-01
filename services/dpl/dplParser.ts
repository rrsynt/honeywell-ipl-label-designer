// DPL (Datamax Programming Language) -> the neutral viewer IR.
//
// Every table and field layout here comes from the **Datamax Class Series
// Programmer's Manual** (part 88-2316-01, Rev H, 2007), cross-checked against
// the **Honeywell DPL Command Reference for Fiji Platform Printers**. Both are
// in docs/manuals/. The secondary source in DPL_Reference_Sources/ was NOT
// used for any table — it disagrees with both manuals on the bar code letters
// (see services/dpl/dplBarcodes.ts) and on the font metrics (see dplFonts.ts).
//
// What makes DPL different from the other four languages here, and the reason
// the records are read at fixed offsets rather than by splitting:
//
//   * Records are POSITIONAL, not comma-separated. A label record is
//         a b c d eee ffff gggg [hhhh iiii] jj...j
//     with a=rotation, b=font/bar-code id, c=width mult, d=height mult,
//     eee=bar code height (or font size for font 9), ffff=row, gggg=column,
//     and hhhh/iiii present ONLY for scalable fonts. There is no separator, so
//     a table of offsets is the only way to read it.
//   * The origin is the LOWER-LEFT corner and row counts UPWARD (manual,
//     "Generating Label Formats"). The IR's origin is top-left going down, so
//     every row has to be flipped against the label height — which is why the
//     row flip is done once, at the end, when the page size is known.
//   * A job is <STX>L ... E: STX L enters label formatting, E prints.

import type {
    ViewerLabel, ViewerElement, ViewerIssue, TextElement, BarcodeElement,
    BoxElement, LineElement,
} from '../ipl/types';
import { estimateElementSize } from '../ipl/renderer';
import { DPL_FONTS, DPL_SMOOTH_FONT, dplMultiplierValue } from './dplFonts';
import { dplBarcodeFor } from './dplBarcodes';
import { FONT_MAP } from '../../constants';

/**
 * The IR bitmap fonts, by cell size. DPL's and IPL's cells are different
 * faces of different sizes, so a DPL font is drawn by picking the closest IR
 * cell and letting the multipliers carry the exact ratio.
 *
 * Only CELL-SIZED bitmap ids qualify. FONT_MAP also holds outline faces with
 * high numeric ids (c54 and friends); letting those into the search picked
 * "font 54" for a DPL font 4, which is not a bitmap font at all.
 */
const IR_CELLS: Record<string, { h: number; w: number }> = Object.fromEntries(
    Object.entries(FONT_MAP)
        .filter(([id, f]) => f.type === 'bitmap' && f.baseHeight && f.baseWidth && /^\d$/.test(id))
        .map(([id, f]) => [id, { h: f.baseHeight as number, w: f.baseWidth as number }]),
);

const FALLBACK_DPI_FONT = DPL_FONTS['0'];

const closestIrFont = (heightDots: number): string => {
    let best = '0';
    let bestDelta = Infinity;
    for (const [id, cell] of Object.entries(IR_CELLS)) {
        const d = Math.abs(cell.h - heightDots);
        if (d < bestDelta) { bestDelta = d; best = id; }
    }
    return best;
};

/**
 * The point size of a smooth-font record.
 *
 * Font 9 is sized through `eee`: "000-999, A04-A72" (Table 8-5). The A-form
 * states POINTS directly, and the manual is explicit that points are the
 * portable choice ("To ensure that the data stream is portable to different
 * Datamax printers, specify the font size in points"). The numeric form is
 * the font's I.D. number, not a size, so a numeric eee falls back to the
 * default rather than inventing a point size from an id.
 */
const smoothPointFromSize = (eee: string, _payload: string): number => {
    const m = /^[Aa](\d{2})$/.exec(eee.trim());
    if (m) return Math.max(1, parseInt(m[1], 10));
    return 12;
};

export interface DplCommand {
    name: string;
    params: string;
    raw: string;
}

/**
 * Splits a DPL job into commands.
 *
 * Two levels exist and they nest, which is why this is not a plain split:
 * system-level commands are `<STX>x…` and run until a carriage return, while
 * inside label-formatting mode (`<STX>L`) the records are ALSO carriage-return
 * terminated but carry no sigil at all — they are positionally identified by
 * their leading digit. So a record line is kept verbatim and told apart from a
 * command by whether it starts with 1-4 (a rotation) rather than a letter.
 */
export const tokenizeDpl = (source: string): DplCommand[] => {
    const out: DplCommand[] = [];
    // <STX> and <SOH> may arrive as raw bytes or as the literal notation, the
    // same hazard every other language here has. Normalise both to raw.
    const text = source
        .replace(/<STX>/gi, '\x02')
        .replace(/<SOH>/gi, '\x01')
        .replace(/<CR>/gi, '\r')
        .replace(/<ESC>/gi, '\x1b')
        .replace(/<LF>/gi, '\n');
    for (const line of text.split(/\r\n|\r|\n/)) {
        if (line === '') continue;
        const stx = line.indexOf('\x02');
        if (stx >= 0) {
            // A system-level command: <STX> followed by its letter and params.
            const body = line.slice(stx + 1);
            const name = body.slice(0, 1);
            out.push({ name, params: body.slice(1).trim(), raw: line });
            continue;
        }
        out.push({ name: '', params: line.trim(), raw: line });
    }
    return out;
};

const num = (s: string | undefined, fallback: number): number => {
    if (s === undefined || s.trim() === '') return fallback;
    const n = Number(s.trim());
    return Number.isFinite(n) ? n : fallback;
};

/**
 * Rotation: "Valid rotation values are clockwise: 1 (0°), 2 (90°), 3 (180°)
 * and 4 (270°)" (manual p. 133). The IR's quadrant is counter-clockwise, so
 * this is the same negation TSPL needed — 1 means no rotation, 4 means 270.
 */
const quadrantFromDpl = (digit: string | undefined): number => {
    const d = Math.trunc(num(digit, 1));
    const turns = ((d - 1) % 4 + 4) % 4;
    return (4 - turns) % 4;
};

interface PendingShape {
    kind: 'line' | 'box';
    widthDots: number;
    heightDots: number;
    thicknessDots: number;
}

/**
 * Parses a DPL job.
 *
 * `labelLengthDots` is the one thing a DPL stream cannot state about its own
 * page. Every DPL position is measured UP from the label's bottom edge, so
 * turning those rows into the IR's top-down coordinates needs to know where
 * the bottom is — and DPL has no "label length" command. `<STX>M` is a
 * fault-search distance that the manual tells the programmer to set to 2.5-3x
 * the real length, so using it would draw every label too tall; `<STX>c` is a
 * real length but only appears on continuous media.
 *
 * This mirrors the IPL parser, which has the same gap and takes a page height
 * for the same reason (viewerParser.setPage). A caller that knows the stock
 * size passes it; without it the rows are placed against the content's own
 * extent, which is exact whenever some field already sits at the label's top.
 */
export const parseDPL = (code: string, labelLengthDots?: number): ViewerLabel => {
    const issues: ViewerIssue[] = [];
    const elements: ViewerElement[] = [];
    let nextId = 1;

    const issue = (level: ViewerIssue['level'], code_: string, message: string, command?: string) =>
        issues.push({ level, code: code_, message, command });

    const settings: ViewerLabel['settings'] = {};

    // ---- Page geometry -------------------------------------------------
    // Rows come from the printer and count UP from the bottom, so they cannot
    // be placed until the page height is known. Everything is collected in
    // printer coordinates first and flipped in one pass at the end.
    let metric = false;                    // <STX>m metric, <STX>n imperial
    // <STX>M is the distance the printer will travel SEARCHING for top-of-form
    // before declaring a paper fault, and the manual says to set it "2.5 to 3
    // times the actual label length". It is therefore NOT the label length, and
    // using it as the page height would stretch every label to three times its
    // size. It is recorded only so the row flip can fall back to it when the
    // stream states nothing else — and even then the content bounds are the
    // better answer, so it is the LAST resort.
    let maxTravelUnits: number | null = null;       // <STX>M
    let continuousLengthUnits: number | null = null; // <STX>c

    // Label-formatting state.
    let inFormat = false;
    let columnOffset = 0;                  // C command, additive to every gggg
    let rowOffset = 0;                     // R command
    let barMagnification = 1;              // B command, multiplies bar code dots
    let dotWidth = 1;                      // D command
    let dotHeight = 1;
    let quantity = 1;                      // Q command
    let currentAttribute = 2;              // A command; 5 is inverse
    let inverseField = false;              // set when A5 is in effect

    // A graphics record (b = X) describes its object in the DATA field rather
    // than in the header, so it is built when the record is read.
    let pendingShape: PendingShape | null = null;

    /** DPL position units -> dots. Hundredths of an inch, or tenths of a mm. */
    const positionToDots = (units: number, dpi: number): number =>
        metric ? (units / 10) * (dpi / 25.4) : (units / 100) * dpi;

    const elementsBefore = () => elements.length;

    for (const cmd of tokenizeDpl(code)) {
        // ---- System-level commands ----
        if (cmd.name !== '') {
            const letter = cmd.name;
            if (letter === 'L') { inFormat = true; continue; }
            if (letter === 'm') { metric = true; continue; }
            if (letter === 'n') { metric = false; continue; }
            if (letter === 'M') { maxTravelUnits = num(cmd.params, 0); continue; }
            if (letter === 'c') { continuousLengthUnits = num(cmd.params, 0); continue; }
            if (letter === 'Q') {
                // "Clear All Modules" is STX Q, but quantity is the label-level
                // `Q` command read below; STX Q takes no parameters.
                if (cmd.params === '') continue;
            }
            continue;
        }

        const line = cmd.params;
        if (line === '') continue;

        // ---- Label-formatting commands (a leading letter, no digits) ----
        if (!/^\d/.test(line)) {
            const letter = line[0];
            const rest = line.slice(1).trim();
            switch (letter) {
                case 'A': currentAttribute = Math.trunc(num(rest, 2)); break;
                case 'B': barMagnification = Math.max(1, Math.trunc(num(rest, 1))); break;
                case 'C': columnOffset = Math.trunc(num(rest, 0)); break;
                case 'R': rowOffset = Math.trunc(num(rest, 0)); break;
                case 'D': {
                    // Dwh, dot width and height multipliers of 1 or 2.
                    dotWidth = Math.max(1, Math.trunc(num(rest.slice(0, 1), 1)));
                    dotHeight = Math.max(1, Math.trunc(num(rest.slice(1, 2), 1)));
                    break;
                }
                case 'Q': quantity = Math.max(1, Math.trunc(num(rest, 1))); break;
                case 'H': settings.darknessAdjust = Math.trunc(num(rest, 0)); break;
                case 'P': settings.printSpeed = Math.trunc(num(rest, 0)); break;
                case 'X': inFormat = false; break;   // terminate without printing
                case 'E':
                    inFormat = false;
                    // Terminate-and-print; nothing more to read for this label.
                    break;
                default:
                    // A format command this subset does not model. Named, never
                    // dropped in silence — the contract every parser here keeps.
                    if (!'cdefgJmnpRSszTUVy'.includes(letter)) {
                        issue('info', 'dpl-command', `DPL label command "${letter}" is not part of the supported subset; it has no effect on the preview.`, letter);
                    }
                    break;
            }
            continue;
        }

        // ---- A format RECORD: fixed-width, positional ----
        //   a b c d eee ffff gggg [hhhh iiii] jj...j
        // a is one digit, b one letter (or W + two chars), c and d one char
        // each, then three 3-digit and two 4-digit fields.
        const rotationDigit = line[0];
        let cursor = 1;
        const bChar = line[cursor] ?? '';
        const isW = bChar.toUpperCase() === 'W';
        const bField = isW ? line.slice(cursor, cursor + 3) : bChar;
        cursor += bField.length;
        const cChar = line[cursor] ?? '1';
        const dChar = line[cursor + 1] ?? '1';
        cursor += 2;
        const eee = line.slice(cursor, cursor + 3);
        cursor += 3;
        const ffff = line.slice(cursor, cursor + 4);
        cursor += 4;
        const gggg = line.slice(cursor, cursor + 4);
        cursor += 4;
        let payload = line.slice(cursor);

        // hhhh/iiii exist ONLY for the scalable-font form (b = 9 with an S/u
        // specifier in eee). Their presence is decided by the header, not by
        // guessing at the payload — a wrong guess eats 8 characters of data.
        const scalable = bChar === DPL_SMOOTH_FONT && /^[SUu]/.test(eee);
        if (scalable && payload.length >= 8) {
            payload = payload.slice(8);
        } else if (bChar === DPL_SMOOTH_FONT && payload.length >= 8 && /^\d{4}/.test(payload)) {
            // A smooth font sized in dots: the manual's second form, where
            // hhhh and iiii are numeric. Same eight characters either way.
            payload = payload.slice(8);
        }

        const row = positionToDots(num(ffff, 0) + rowOffset, 203);
        const col = positionToDots(num(gggg, 0) + columnOffset, 203);
        const rot = quadrantFromDpl(rotationDigit);
        elementsBefore();

        // --- Graphic object (b = X): the DATA field describes the shape ---
        if (bChar === 'X') {
            const shape = payload.trim();
            const head = shape[0];
            // "LINE*: Lhhhvvv", "BOX***: Bhhhvvvbbbsss" (manual p. 139). The
            // lowercase forms take four-digit fields instead of three.
            const isUpperForm = head === 'L' || head === 'B';
            const wLen = isUpperForm ? 3 : 4;
            const hLen = isUpperForm ? 3 : 4;
            const w = num(shape.slice(1, 1 + wLen), 0);
            const h = num(shape.slice(1 + wLen, 1 + wLen + hLen), 0);
            if (head === 'L' || head === 'l') {
                pendingShape = { kind: 'line', widthDots: positionToDots(w, 203), heightDots: positionToDots(h, 203), thicknessDots: Math.max(1, dotHeight) };
            } else if (head === 'B' || head === 'b') {
                const tIdx = 1 + wLen + hLen;
                const top = num(shape.slice(tIdx, tIdx + wLen), 1);
                pendingShape = { kind: 'box', widthDots: positionToDots(w, 203), heightDots: positionToDots(h, 203), thicknessDots: Math.max(1, positionToDots(top, 203)) };
            } else {
                issue('info', 'dpl-graphic', `DPL graphics object "${head}" (polygon, circle or arc) is not part of the supported subset; nothing is drawn for it.`, 'X');
            }
            const sh = pendingShape;
            pendingShape = null;
            if (sh) {
                // The shape's row is its BOTTOM (lower-left origin), so the
                // top-left the IR wants is row + height.
                if (sh.kind === 'line') {
                    elements.push({
                        kind: 'line', id: nextId++, ox: col, oy: row, f: rot,
                        lengthDots: Math.round(sh.widthDots),
                        thicknessDots: Math.round(sh.heightDots) || Math.round(sh.thicknessDots),
                    } as LineElement);
                } else {
                    elements.push({
                        kind: 'box', id: nextId++, ox: col, oy: row, f: rot,
                        widthDots: Math.round(sh.widthDots),
                        heightDots: Math.round(sh.heightDots),
                        thicknessDots: Math.round(sh.thicknessDots),
                    } as BoxElement);
                }
            }
            continue;
        }

        // --- Bar code (b = a letter A-Z / a-z, or Wxx) ---
        const bc = dplBarcodeFor(bField);
        if (bc) {
            // Field c is the WIDE bar (numerator) and d the NARROW bar
            // (denominator) for ratio-based codes; for module-based codes d is
            // the module size and the manual says c and d must match.
            // eee is the symbol height in hundredths of an inch / tenths of mm.
            const heightDots = Math.max(1, Math.round(positionToDots(num(eee, 0), 203))) * barMagnification;
            const moduleDots = Math.max(1, dplMultiplierValue(dChar)) * dotWidth;
            const wideRatio = dplMultiplierValue(cChar);
            elements.push({
                kind: 'barcode', id: nextId++, ox: col, oy: row, f: rot,
                symbology: bc.type.symbology,
                heightDots,
                moduleDots,
                // The IR's ratio codes: 0 = 2.5:1, 1 = 3:1, 2 = 2:1. A wide-bar
                // value at or below the narrow one is the 1:1 module case, which
                // the IR expresses as the default.
                ratio: wideRatio <= moduleDots ? 1 : wideRatio <= moduleDots * 2 ? 2 : 1,
                hri: bc.hri,
                source: { type: 'fixed', data: payload.trim() },
            } as BarcodeElement);
            continue;
        }

        // --- Text: b = 0-8 internal bitmap, or 9 smooth/scalable ---
        if (/^[0-8]$/.test(bChar) || bChar === DPL_SMOOTH_FONT) {
            const text = payload;
            if (text === '') {
                issue('info', 'dpl-empty-text', 'A text record with an empty data field prints nothing.', bChar);
                continue;
            }
            const isSmooth = bChar === DPL_SMOOTH_FONT;
            const wMult = dplMultiplierValue(cChar) * dotWidth;
            const hMult = dplMultiplierValue(dChar) * dotHeight;
            if (isSmooth) {
                elements.push({
                    kind: 'text', id: nextId++, ox: col, oy: row, f: rot,
                    // Font 9 is the AGFA smooth/scalable face, drawn through the
                    // IR's outline path (c25) so the point size can be honoured.
                    font: '25', hMag: hMult, wMag: wMult,
                    pointSize: smoothPointFromSize(eee, payload),
                    source: { type: 'fixed', data: text },
                } as TextElement);
                issue('info', 'dpl-smooth-font',
                    'DPL font 9 is the scalable CG Triumvirate; the preview draws it with the outline face, so glyph shapes differ from the printer\'s.', bChar);
                continue;
            }
            const metric = DPL_FONTS[bChar] ?? FALLBACK_DPI_FONT;
            // The IR's bitmap fonts are IPL's cells, which are not DPL's. Pick
            // the closest by HEIGHT and let the multipliers carry the exact
            // ratio, the way the EPL parser does — leaving every DPL font on c0
            // would draw font 6 at a fifth of its size.
            const pick = closestIrFont(metric.height);
            const cell = IR_CELLS[pick];
            elements.push({
                kind: 'text', id: nextId++, ox: col, oy: row, f: rot,
                font: pick,
                // Round rather than truncate: a ratio of 1.87 is 2x magnification
                // on a cell that is nearly the right one, not 1x of a wrong one.
                hMag: Math.max(1, Math.round(hMult * (metric.height / cell.h))),
                wMag: Math.max(1, Math.round(wMult * (metric.width / cell.w))),
                source: { type: 'fixed', data: text },
            } as TextElement);
            continue;
        }

        issue('info', 'dpl-record', `DPL record "${line.slice(0, 12)}" has a font/bar-code field this subset does not know; nothing is drawn for it.`, bChar);
    }

    // ---- Row flip and extent ------------------------------------------
    // Printer rows count up from the bottom; the IR counts down from the top.
    // The page height has to come from somewhere: <STX>M is the maximum label
    // length the printer will feed, and <STX>c the continuous length. With
    // neither, the content's own extent is used, which is what the other
    // parsers here do — and the flip then becomes a no-op for a label whose
    // content already spans the page.
    let contentMaxRow = 0;
    for (const el of elements) {
        const sz = estimateElementSize(el, 203);
        contentMaxRow = Math.max(contentMaxRow, el.oy + sz.crossDots);
    }
    // DPL states no label WIDTH in the stream at all, and its one length
    // command is a fault-search distance rather than the media size — the
    // manual tells the programmer to set <STX>M to "2.5 to 3 times the actual
    // label length", so treating it as the page height would draw every label
    // two to three times too tall.
    const statedDots = continuousLengthUnits && continuousLengthUnits > 0
        ? Math.ceil(positionToDots(continuousLengthUnits, 203))
        : 0;
    const supplied = labelLengthDots && labelLengthDots > 0 ? Math.round(labelLengthDots) : 0;
    // The page height has to be an INDEPENDENT fact. Deriving it from the
    // content would be circular: the content's rows are measured from the
    // label's bottom edge, which is exactly what the page height decides. With
    // no stock size and no continuous length, the best available anchor is the
    // topmost row the stream references — so the drawing is placed relative to
    // itself and every field keeps its position relative to the others.
    const pageDots = Math.max(supplied, statedDots, Math.ceil(contentMaxRow), 1);
    if (supplied === 0 && statedDots === 0) {
        issue('info', 'dpl-no-label-length',
            'A DPL stream does not state the label length, and every DPL position is measured up from the label\'s bottom edge. The preview has anchored the page to the topmost row in the stream, so fields keep their positions relative to one another; set the paper size to place them against the real media.', 'L');
    }
    if (maxTravelUnits && maxTravelUnits > 0) {
        issue('info', 'dpl-max-travel',
            'The stream sets a maximum label-travel distance — the Datamax fault-search figure, normally two to three times the label length. It is not the media size, so the preview does not use it as the page height.', 'M');
    }

    // The row field names the object's BOTTOM (home is the lower-left corner),
    // and the IR positions from the TOP. So a row is flipped against the page
    // height AND the object's own height subtracted — without that second part
    // every field sits one object-height too low.
    const flipped: ViewerElement[] = elements.map((el) => {
        const sz = estimateElementSize(el, 203);
        return { ...el, oy: Math.max(0, pageDots - el.oy - sz.crossDots) };
    });

    // ---- Inverse mode (A5) --------------------------------------------
    // "This mode allows inverse (white on black) printing" (manual p. 110,
    // Table 6-1). It is a page attribute rather than a per-field one, so the
    // whole label is drawn reversed — expressed as a reverse region over the
    // page, which is the same element TSPL's REVERSE and ZPL's ^FR use.
    if (currentAttribute === 5 && flipped.length > 0) {
        const maxX = flipped.reduce((m, el) => {
            const sz = estimateElementSize(el, 203);
            return Math.max(m, el.ox + sz.lengthDots);
        }, 0);
        issue('info', 'dpl-inverse-mode',
            'A5 selects Inverse Mode, so the printer prints this label white on black; the preview applies the same inversion over the label area.', 'A');
        flipped.push({
            kind: 'reverse', id: nextId++, ox: 0, oy: 0, f: 0,
            widthDots: Math.max(1, Math.ceil(maxX)),
            heightDots: Math.max(1, Math.ceil(pageDots)),
        } as ViewerElement);
    }

    settings.quantity = quantity;

    return {
        elements: flipped,
        issues,
        settings,
        // DPL states the label LENGTH, not a width — the printhead width is a
        // printer attribute (<STX>KC reports it), not something the stream
        // carries. So the height is known and the width is null, which lets the
        // extent follow the content exactly as a stream without <SI>W does in IPL.
        widthDots: null,
        heightDots: Math.ceil(pageDots),
    };
};
