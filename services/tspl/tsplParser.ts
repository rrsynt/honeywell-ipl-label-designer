// TSPL (TSC Printer Language) -> the viewer IR.
//
// TSPL is what TSC's own printers speak, and the budget thermal market copies
// it. Like EPL it is line-based and has no sigil:
//
//   SIZE 50 mm,25 mm
//   GAP 3 mm,0
//   CLS
//   TEXT 56,24,"3",0,1,1,"ABC"
//   BARCODE 10,50,"128",100,1,0,2,2,"12345"
//   BOX 60,60,610,210,4
//   PRINT 1,1
//
// Every table and parameter order below comes from the **TSPL/TSPL2
// Programming Manual** (TSC Auto ID, Copyright 2014; the copy this was read
// from lives at github.com/lokingwei/tspl-printer-php under document/). As
// with EPL, writing these from memory would have been wrong in ways that
// matter: TSPL's barcode types are NAMES ("128", "EAN13", "CODA"), not the
// numbers EPL uses, so a from-memory table would have produced the wrong
// symbology on every barcode.
//
// TWO THINGS THIS FILE HAS TO GET RIGHT that the other languages do not:
//
//   1. TSPL's rotation is CLOCKWISE (manual p. 77: "90: degrees, in clockwise
//      direction"), while the IR's quadrant is counter-clockwise. The value is
//      negated here — carrying it across unchanged would mirror every rotated
//      field.
//   2. TSPL's escape is neither ZPL's doubling nor EPL's backslash-quote: a
//      quote is written \[ and a literal backslash \] (manual p. 77, "please
//      change it to \[\]"), and \NN is the ASCII DECIMAL value NNN.
//
// Like the other two parsers this is a SUBSET that names what it cannot draw.

import type {
    BarcodeElement, BoxElement, LineElement, TextElement, ViewerElement, ViewerIssue, ViewerLabel,
} from '../ipl/types';
import { estimateElementSize } from '../ipl/renderer';

/**
 * TSPL's resident fonts, in dots (manual pp. 77-78).
 *
 *   0  Monotype CG Triumvirate Bold Condensed — the scalable one
 *   1  8 x 12     4  24 x 32     7  21 x 27 OCR-B
 *   2  12 x 20    5  32 x 48     8  14 x 25 OCR-A
 *   3  16 x 24    6  14 x 19 OCR-B
 *
 * The .TTF/.EFT/.FNT names (ROMAN.TTF, 1.EFT, A.FNT …) are downloads or
 * emulations of other languages and are reported rather than guessed at.
 */
export const TSPL_FONT_SIZES: Record<string, { width: number; height: number }> = {
    '0': { width: 12, height: 20 }, // scalable; the multipliers carry the real size
    '1': { width: 8, height: 12 },
    '2': { width: 12, height: 20 },
    '3': { width: 16, height: 24 },
    '4': { width: 24, height: 32 },
    '5': { width: 32, height: 48 },
    '6': { width: 14, height: 19 },
    '7': { width: 21, height: 27 },
    '8': { width: 14, height: 25 },
};

/**
 * TSPL barcode type -> the IR symbology the renderer paints.
 *
 * Manual pp. 39-44. The IR ids are IPL's (services/ipl/barcodes.ts): '0'
 * code39, '1' code93, '2' interleaved2of5, '3' industrial2of5, '4' codabar,
 * '5' code11, '6' code128, '7' EAN/UPC (+ eanUpcVersion), '11' postnet,
 * '22' planet, '9' code16k, '10' code49, and '3'/'c2' for the 2-of-5 family.
 */
interface TsplBarcode {
    symbology: string;
    /** For '7' (EAN/UPC), which variant: 1 ean8, 2 ean13, 3 upca, 4 upce. */
    eanUpcVersion?: number;
    /** For '0' (Code 39), the c0 mode: 2 = check a digit the host supplied. */
    code39Mode?: string;
}

const TSPL_BARCODE_TYPES: Record<string, TsplBarcode> = {
    // Code 128 family.
    '128': { symbology: '6' },
    '128M': { symbology: '6' },
    EAN128: { symbology: '6' },
    EAN128M: { symbology: '6' },
    // 2 of 5 family: bare = interleaved, S = standard, I = industrial.
    '25': { symbology: '2' },
    '25C': { symbology: '2' },
    '25S': { symbology: '3' },
    '25I': { symbology: '3' },
    // Code 39, with and without the host check digit.
    '39': { symbology: '0', code39Mode: '0' },
    '39C': { symbology: '0', code39Mode: '2' },
    '93': { symbology: '1' },
    // EAN/UPC. The add-on variants have no separate IR encoder, so they paint
    // as the main symbol — reported so the difference is not silent.
    EAN13: { symbology: '7', eanUpcVersion: 2 },
    'EAN13+2': { symbology: '7', eanUpcVersion: 2 },
    'EAN13+5': { symbology: '7', eanUpcVersion: 2 },
    EAN8: { symbology: '7', eanUpcVersion: 1 },
    'EAN8+2': { symbology: '7', eanUpcVersion: 1 },
    'EAN8+5': { symbology: '7', eanUpcVersion: 1 },
    UPCA: { symbology: '7', eanUpcVersion: 3 },
    'UPCA+2': { symbology: '7', eanUpcVersion: 3 },
    'UPA+5': { symbology: '7', eanUpcVersion: 3 },   // the manual's own spelling
    UPCE: { symbology: '7', eanUpcVersion: 4 },
    'UPCE+2': { symbology: '7', eanUpcVersion: 4 },
    'UPE+5': { symbology: '7', eanUpcVersion: 4 },
    CODA: { symbology: '4' },
    '11': { symbology: '5' },
    POST: { symbology: '11' },
    PLANET: { symbology: '22' },
    CODE49: { symbology: '10' },
};

/** Types the manual lists that this viewer has no encoder for. Named so an
 *  issue says WHICH symbology is missing instead of "unknown type". */
const TSPL_KNOWN_UNENCODED: Record<string, string> = {
    MSI: 'MSI',
    MSIC: 'MSI with check digit',
    PLESSEY: 'Plessey',
    CPOST: 'China Post',
    ITF14: 'ITF-14',
    EAN14: 'EAN-14',
    TELEPEN: 'Telepen',
    TELEPENN: 'Telepen number',
    DPI: 'Deutsche Post Identcode',
    DPL: 'Deutsche Post Leitcode',
};

/** TSPL's QR error-correction letters onto the IR's c18,m2 values. */
const TSPL_QR_ECL: Record<string, string> = { L: 'L', M: 'M', Q: 'Q', H: 'H' };

/**
 * Commands that are printer settings or jobs, not geometry.
 *
 * Expected in a real TSPL program, and they put nothing on the label — so
 * reporting them would drown the issues panel on every ordinary stream.
 */
const PRINTER_SETTINGS = new Set([
    'GAP', 'GAPDETECT', 'BLINDDETECT', 'OFFSET', 'SPEED', 'DENSITY', 'DIRECTION',
    'MIRROR', 'REFERENCE', 'SHIFT', 'CODEPAGE', 'FEED', 'BACKFEED', 'BACKUP',
    'HOME', 'SOUND', 'CUT', 'LIMITFEED', 'EOJ', 'DELAY', 'FORMFEED', 'FORMFEED',
    'SET', 'SETPEEL', 'SETTEAR', 'SETCUTTER', 'SETAUTODUMP', 'SETCOUNTER',
    'SETRIBBON', 'SETPARTIAL_CUTTER', 'SETBACK', 'AUTOBAUD', 'KILL', 'DOWNLOAD',
    'ERASE', 'FILES', 'MOVE', 'COPY', 'OUT', 'OUTR', 'STATUS', 'WIDTH', 'RUN',
    'INPUT', 'PREINPUT', 'POSTINPUT', 'GOTO', 'IF', 'ELSE', 'ENDIF', 'END',
    'RETURN', 'STEP', 'BEep'.toUpperCase(), 'SIZE',
]);

export interface TsplParseResult {
    label: ViewerLabel;
}

/** One parsed line: its command and its parameters. */
interface TsplCommand {
    name: string;
    /** The parameter text with any quoted payload removed. */
    params: string;
    /** The quoted payloads, unescaped, in order. */
    quoted: string[];
    /** The whole line, for issues that quote what they skipped. */
    raw: string;
}

/**
 * Resolve TSPL's escapes (manual p. 77 and the \NN rule).
 *
 *   \[   -> "       (a double quote inside the data)
 *   \]   -> \       (a literal backslash)
 *   \NN  -> the ASCII character with DECIMAL code NN
 *
 * Note this is neither ZPL's doubled quote nor EPL's backslash-quote. Getting
 * it wrong mangles every label whose data contains a quote or an accent.
 */
export const unescapeTspl = (s: string): string => {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        if (s[i] !== '\\') { out += s[i]; continue; }
        const next = s[i + 1];
        if (next === '[') { out += '"'; i++; continue; }
        if (next === ']') { out += '\\'; i++; continue; }
        // \NN is a two-digit decimal ASCII value. Anything else after a
        // backslash is left alone rather than eating the character.
        const two = s.slice(i + 1, i + 3);
        if (/^\d{2}$/.test(two)) {
            out += String.fromCharCode(Number(two));
            i += 2;
            continue;
        }
        out += s[i];
    }
    return out;
};

/**
 * Split TSPL source into commands, one per non-empty line.
 *
 * A command's parameters and its payload share one comma-separated list, and
 * the payload is QUOTED — so a comma inside the quotes is data, exactly as in
 * EPL. The quoted runs are lifted out first (replaced by placeholders) so the
 * remaining text can be split on commas without a state machine, then the
 * payloads are put back in order.
 */
export const tokenizeTspl = (source: string): TsplCommand[] => {
    const out: TsplCommand[] = [];
    for (const rawLine of String(source ?? '').split(/\r?\n/)) {
        const line = rawLine.replace(/\r$/, '').trim();
        if (line === '') continue;
        // `;` starts a comment in TSPL, and only outside quotes.
        //
        // Two separate passes, and the order matters. A scan finds where each
        // quoted run ENDS, working on the RAW text where the only special thing
        // is the backslash pair that keeps a quote inside the data. Only then
        // is the payload unescaped. Doing it in one pass — unescaping while
        // still looking for the closing quote — cannot work: \[ turns into a
        // real ", which is indistinguishable from the delimiter and truncates
        // the field (that bug produced `say "hi\` for `say \[hi\]`).
        const quoted: string[] = [];
        let params = '';
        let i = 0;
        while (i < line.length) {
            const ch = line[i];
            if (ch === '"') {
                let j = i + 1;
                let raw = '';
                while (j < line.length && line[j] !== '"') {
                    // An escaped pair (\[ or \]) is data, not a delimiter.
                    if (line[j] === '\\' && (line[j + 1] === '[' || line[j + 1] === ']')) {
                        raw += line[j] + line[j + 1];
                        j += 2;
                        continue;
                    }
                    raw += line[j];
                    j++;
                }
                quoted.push(unescapeTspl(raw));
                params += '\u0000';   // placeholder, so commas inside survive
                i = j + 1;
                continue;
            }
            if (ch === ';') break;    // comment to end of line
            params += ch;
            i++;
        }
        // The command name is the leading token, up to the first whitespace —
        // NOT a run of letters. TSPL names may contain digits (`PDF417`), so a
        // letters-only rule read that line as a command called "PDF" with a
        // parameter "417 10,10,…" and drew nothing. Every TSPL command in the
        // manual is written with a space before its parameters, which is what
        // makes "up to the first space" the right rule here (EPL needs the
        // opposite, because its names never carry digits).
        const head = params.trim();
        const space = head.search(/\s/);
        const name = space < 0 ? head : head.slice(0, space);
        const rest = space < 0 ? '' : head.slice(space);
        if (name === '' || !/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
            out.push({ name: '', params: '', quoted, raw: line });
            continue;
        }
        out.push({
            name: name.toUpperCase(),
            params: rest.trim().replace(/^,|,$/g, '').trim(),
            quoted,
            raw: line,
        });
    }
    return out;
};

/** Split a parameter list on commas, putting the quoted payloads back. */
const splitParams = (cmd: TsplCommand): string[] => {
    let k = 0;
    return cmd.params
        .split(',')
        .map(part => {
            const t = part.trim();
            if (t === '\u0000' || t.includes('\u0000')) {
                // Rebuild any placeholder run in order.
                return t.replace(/\u0000/g, () => cmd.quoted[k++] ?? '');
            }
            return t;
        });
};

const num = (s: string | undefined, fallback: number): number => {
    if (s === undefined || s.trim() === '') return fallback;
    const n = Number(s.trim());
    return Number.isFinite(n) ? n : fallback;
};

/**
 * TSPL rotation is CLOCKWISE (manual p. 77); the IR quadrant is
 * counter-clockwise. So the quadrant is 4 - deg/90 (mod 4), and carrying the
 * value across unchanged would mirror every rotated field. 0 and 180 are their
 * own inverses, which is why this is easy to miss on a simple test label.
 */
const quadrantFromClockwise = (deg: string | undefined): number => {
    const d = Math.trunc(num(deg, 0));
    const turns = ((d % 360) + 360) % 360 / 90;
    return (4 - turns) % 4;
};

/** MM or IN suffix on a SIZE/GAP value (manual p. 1: dots are the default). */
const lengthToDots = (value: string | undefined, dpi: number): number => {
    const text = String(value ?? '').trim().toLowerCase();
    const number = Number(text.replace(/[^0-9.+-]/g, ''));
    if (!Number.isFinite(number)) return 0;
    if (text.includes('mm')) return Math.round(number * (dpi / 25.4));
    if (text.includes('in')) return Math.round(number * dpi);
    return Math.round(number);   // bare numbers are dots
};

export const parseTSPL = (code: string): ViewerLabel => {
    const issues: ViewerIssue[] = [];
    const elements: ViewerElement[] = [];
    const settings: ViewerLabel['settings'] = {};
    let nextId = 1;
    // SIZE/GAP are printer settings, but they are also what tells the viewer
    // how big the label is — without them the preview has no canvas.
    let widthDots: number | null = null;
    let heightDots: number | null = null;
    const dpi = 203;   // TSPL states its 200-dpi dot math; the viewer labels it.

    const issue = (level: ViewerIssue['level'], code_: string, message: string, command?: string) =>
        issues.push({ level, code: code_, message, command });

    const saidOnce = new Set<string>();
    const once = (key: string, level: ViewerIssue['level'], code_: string, message: string, command?: string) => {
        if (saidOnce.has(key)) return;
        saidOnce.add(key);
        issue(level, code_, message, command);
    };

    /** IR anchor for a field whose visual top-left is (x, y). Mirrors the ZPL
     *  and EPL parsers: the renderer measures the size, so the anchor comes
     *  from its measurement rather than from an estimate of our own. */
    const anchor = (x: number, y: number, f: number, length: number, cross: number): { ox: number; oy: number } => {
        switch (f) {
            case 1: return { ox: x, oy: y + length };
            case 2: return { ox: x + length, oy: y + cross };
            case 3: return { ox: x + cross, oy: y };
            default: return { ox: x, oy: y };
        }
    };

    const place = <T extends ViewerElement>(el: T): T => {
        const sz = estimateElementSize(el, dpi);
        Object.assign(el, anchor(el.ox, el.oy, el.f, sz.lengthDots, sz.crossDots));
        return el;
    };

    for (const cmd of tokenizeTspl(code)) {
        const p = splitParams(cmd);
        if (cmd.name === '') {
            issue('warning', 'tspl-unreadable', `"${cmd.raw}" is not a command this parser recognizes. It has no effect here.`);
            continue;
        }

        switch (cmd.name) {
            case 'SIZE': {
                // SIZE <width>,<height> (manual p. 1). The manual's own example
                // writes "SIZE 50 mm,25 mm" — a SPACE before the unit.
                widthDots = lengthToDots(p[0], dpi) || widthDots;
                heightDots = lengthToDots(p[1], dpi) || heightDots;
                break;
            }

            case 'CLS':
                // Clear image buffer: starts a form. Nothing has accumulated
                // mid-parse, so this is a no-op beyond marking the boundary.
                break;

            case 'TEXT': {
                // TEXT x,y,"font",rotation,x-multiply,y-multiply,[alignment,]"content"
                // (manual p. 77). The font is a QUOTED string, which is what
                // makes the quoted-payload handling load-bearing here.
                //
                // Positions are read straight off `p`, which already has the
                // quoted runs put back where they were — so p[2] IS the font
                // and p[3] IS the rotation. An earlier version filtered the
                // quoted values out and then indexed the remainder, which
                // forgot that x and y are in the list too: the rotation was
                // read as 10 (the y coordinate) and every field came out
                // turned by 3.89 quadrants.
                if (p.length < 6) {
                    issue('warning', 'tspl-text-params', `TEXT needs x,y,font,rotation,multipliers. Found ${p.length}. Skipped.`, 'TEXT');
                    break;
                }
                const fontName = (p[2] ?? '').trim();
                const content = p[6] ?? '';
                if (fontName === '') {
                    issue('warning', 'tspl-text-params', 'TEXT has no quoted font name. Skipped.', 'TEXT');
                    break;
                }
                const face = TSPL_FONT_SIZES[fontName];
                if (!face) {
                    once(`font-${fontName}`, 'warning', 'tspl-font-download',
                        `Font "${fontName}" is a downloaded or emulated face (a .TTF/.EFT/.FNT), which is not available here. Drawn with resident font 2 instead.`, 'TEXT');
                }
                const size = face ?? TSPL_FONT_SIZES['2'];
                const xMul = Math.max(1, Math.trunc(num(p[4], 1)));
                const yMul = Math.max(1, Math.trunc(num(p[5], 1)));
                const f = quadrantFromClockwise(p[3]);
                // The IR font is chosen so the renderer measures the cell TSPL
                // describes: font 1 is its 8x12, which is IPL's c0; 2/3/4 are
                // closest to c2's 10x14 cell with the multiplier making up the
                // rest. The outline path would ignore the multipliers.
                const irFont = fontName === '1' ? '0' : '2';
                const el: TextElement = {
                    kind: 'text', id: nextId++,
                    ox: num(p[0], 0), oy: num(p[1], 0), f,
                    font: irFont,
                    hMag: yMul, wMag: xMul,
                    pointSize: Math.max(1, Math.round(size.height * yMul * 72 / dpi)),
                    source: { type: 'fixed', data: content },
                };
                elements.push(place(el));
                break;
            }

            case 'BAR': {
                // BAR x,y,width,height (manual p. 37) — a filled bar.
                if (p.length < 4) { issue('warning', 'tspl-bar-params', `BAR needs x,y,width,height. Found ${p.length}. Skipped.`, 'BAR'); break; }
                const w = Math.max(1, Math.trunc(num(p[2], 1)));
                const h = Math.max(1, Math.trunc(num(p[3], 1)));
                // A bar wider than it is tall and a bar taller than it is wide
                // are the same element at different quadrants in the IR.
                const el: LineElement = {
                    kind: 'line', id: nextId++,
                    ox: num(p[0], 0), oy: num(p[1], 0),
                    f: w >= h ? 0 : 1,
                    lengthDots: Math.max(w, h), thicknessDots: Math.min(w, h),
                };
                elements.push(place(el));
                break;
            }

            case 'BARCODE': {
                // BARCODE X,Y,"code type",height,human readable,rotation,
                //         narrow,wide,[alignment,]"content"  (manual p. 38)
                // Same indexing note as TEXT: read the positions off `p`, in
                // which the quoted runs are already back in their places.
                const type = (p[2] ?? '').trim().toUpperCase();
                const content = p[p.length - 1] ?? '';
                if (type === '') {
                    issue('warning', 'tspl-barcode-params', 'BARCODE has no quoted code type. Skipped.', 'BARCODE');
                    break;
                }
                const mapped = TSPL_BARCODE_TYPES[type];
                if (!mapped) {
                    const named = TSPL_KNOWN_UNENCODED[type];
                    issue('info', 'tspl-barcode-unencoded',
                        named
                            ? `Barcode type "${type}" is ${named}, which this viewer has no encoder for. Nothing is drawn for it.`
                            : `Barcode type "${type}" is not one this viewer knows. Nothing is drawn for it.`,
                        'BARCODE');
                    break;
                }
                if (content === '') {
                    issue('warning', 'tspl-barcode-empty', 'A barcode with no data prints nothing.', 'BARCODE');
                    break;
                }
                if (type.includes('+')) {
                    issue('info', 'tspl-addon-ignored',
                        `"${type}" carries a printed add-on, which this viewer draws as the main symbol only.`, 'BARCODE');
                }
                const heightDots = Math.max(1, Math.trunc(num(p[3], 1)));
                const hriMode = Math.trunc(num(p[4], 0));
                const f = quadrantFromClockwise(p[5]);
                const narrow = Math.max(1, Math.trunc(num(p[6], 1)));
                const wide = Math.max(1, Math.trunc(num(p[7], narrow)));
                const el: BarcodeElement = {
                    kind: 'barcode', id: nextId++,
                    ox: num(p[0], 0), oy: num(p[1], 0), f,
                    symbology: mapped.symbology,
                    heightDots, moduleDots: narrow,
                    // TSPL's human readable is 0 none / 1 left / 2 center /
                    // 3 right, ALL below the bar — the IR's 1 means "below",
                    // and there is no above in TSPL at all.
                    hri: hriMode === 0 ? 0 : 1,
                    ratio: wide / narrow <= 2.2 ? 2 : wide / narrow < 2.8 ? 0 : 1,
                    source: { type: 'fixed', data: content },
                    ...(mapped.eanUpcVersion !== undefined ? { eanUpcVersion: mapped.eanUpcVersion } : {}),
                    ...(mapped.code39Mode !== undefined ? { code39Mode: mapped.code39Mode } : {}),
                };
                elements.push(place(el));
                break;
            }

            case 'BOX': {
                // BOX x,y,x_end,y_end,line thickness[,radius] (manual p. 47).
                // Two CORNERS, not a width and height.
                if (p.length < 5) { issue('warning', 'tspl-box-params', `BOX needs x,y,x_end,y_end,thickness. Found ${p.length}. Skipped.`, 'BOX'); break; }
                const x1 = num(p[0], 0);
                const y1 = num(p[1], 0);
                const x2 = num(p[2], x1);
                const y2 = num(p[3], y1);
                const t = Math.max(1, Math.trunc(num(p[4], 1)));
                const radius = Math.max(0, Math.trunc(num(p[5], 0)));
                const el: BoxElement = {
                    kind: 'box', id: nextId++,
                    ox: Math.min(x1, x2), oy: Math.min(y1, y2), f: 0,
                    widthDots: Math.max(1, Math.abs(x2 - x1)),
                    heightDots: Math.max(1, Math.abs(y2 - y1)),
                    thicknessDots: t,
                    ...(radius > 0 ? { radiusDots: radius } : {}),
                };
                elements.push(place(el));
                break;
            }

            case 'QRCODE': {
                // QRCODE x,y,ECC Level,cell width,mode,rotation,
                //        [justification,][model,][mask,][area,] "content"
                // (manual p. 65). ECC is L/M/Q/H, cell width 1-10, mode A/M.
                if (p.length < 6) {
                    issue('warning', 'tspl-qrcode-params', `QRCODE needs x,y,ECC,cell width,mode,rotation. Found ${p.length}. Skipped.`, 'QRCODE');
                    break;
                }
                const ecc = (p[2] ?? 'M').trim().toUpperCase();
                const content = p[p.length - 1] ?? '';
                if (content === '') {
                    issue('warning', 'tspl-qrcode-empty', 'A QR code with no data prints nothing.', 'QRCODE');
                    break;
                }
                const f = quadrantFromClockwise(p[5]);
                const el: BarcodeElement = {
                    kind: 'barcode', id: nextId++,
                    ox: num(p[0], 0), oy: num(p[1], 0), f,
                    symbology: '18',   // the IR's QR id
                    // QR is a matrix: its size comes from the cell count and the
                    // cell width, not from a bar height. The IR measures matrix
                    // symbols from moduleDots, so a nominal height keeps the
                    // anchor sane without pretending to know the grid size.
                    heightDots: Math.max(1, Math.trunc(num(p[3], 3))) * 21,
                    moduleDots: Math.max(1, Math.trunc(num(p[3], 3))),
                    ratio: 1,
                    hri: 0,            // QR never carries a human-readable line
                    source: { type: 'fixed', data: content },
                    ...(TSPL_QR_ECL[ecc] ? { qrEcl: TSPL_QR_ECL[ecc] } : {}),
                };
                if (!TSPL_QR_ECL[ecc]) {
                    issue('info', 'tspl-qr-ecc', `QR error-correction level "${ecc}" is not L/M/Q/H. The encoder's default is used.`, 'QRCODE');
                }
                elements.push(place(el));
                break;
            }

            case 'PDF417': {
                // PDF417 x,y,width,height,rotate,[option], "content"
                // (manual p. 56). The option block carries letter-prefixed
                // settings (P/E/M/U/W/H/R/C/T/Lm) which this subset reads past.
                if (p.length < 5) {
                    issue('warning', 'tspl-pdf417-params', `PDF417 needs x,y,width,height,rotate. Found ${p.length}. Skipped.`, 'PDF417');
                    break;
                }
                const content = p[p.length - 1] ?? '';
                if (content === '') {
                    issue('warning', 'tspl-pdf417-empty', 'A PDF417 with no data prints nothing.', 'PDF417');
                    break;
                }
                const f = quadrantFromClockwise(p[4]);
                const el: BarcodeElement = {
                    kind: 'barcode', id: nextId++,
                    ox: num(p[0], 0), oy: num(p[1], 0), f,
                    symbology: '12',   // the IR's PDF417 id
                    heightDots: Math.max(1, Math.trunc(num(p[3], 10))),
                    moduleDots: Math.max(1, Math.trunc(num(p[2], 2) / 10) || 2),
                    ratio: 1,
                    hri: 0,
                    source: { type: 'fixed', data: content },
                };
                elements.push(place(el));
                break;
            }

            case 'PRINT': {
                // PRINT copies[,sets] (manual p. 24) — a job concern, but the
                // viewer reads it so a preview can say how many labels.
                settings.quantity = Math.max(1, Math.trunc(num(p[0], 1)));
                break;
            }

            case 'DIRECTION':
                // 0 or 1: whether the label is laid out sideways. The IR has no
                // slot for it, and guessing would move every field — say so.
                once('direction', 'info', 'tspl-direction',
                    'DIRECTION rotates the whole label by 90°. This viewer draws the label as laid out, so the preview is turned compared with the print.', 'DIRECTION');
                break;

            default: {
                if (PRINTER_SETTINGS.has(cmd.name)) break;
                if (cmd.name === 'MAXICODE') {
                    issue('info', 'tspl-maxicode-unsupported', 'TSPL MAXICODE is not part of this viewer yet.', 'MAXICODE');
                } else if (cmd.name === 'AZTEC') {
                    issue('info', 'tspl-aztec-unsupported', 'TSPL AZTEC is not part of this viewer yet.', 'AZTEC');
                } else if (cmd.name === 'PUTBMP' || cmd.name === 'PUTPCX') {
                    issue('info', 'tspl-bitmap-unsupported', `TSPL graphics (${cmd.name}) are not part of this viewer yet.`, cmd.name);
                } else if (cmd.name === 'BLOCK') {
                    issue('info', 'tspl-block-unsupported', 'TSPL BLOCK (multi-line text) is not part of this viewer yet.', 'BLOCK');
                } else {
                    issue('info', 'tspl-unsupported', `${cmd.name} is not part of the supported TSPL subset, so it has no effect here.`, cmd.name);
                }
            }
        }
    }

    return { widthDots, heightDots, elements, issues, settings };
};
