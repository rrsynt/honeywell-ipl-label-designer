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
import { buildMaxiCodeScm } from '../ipl/maxiCodeScm';

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
    /** True for '25C', whose mod-10 check digit the PRINTER appends (manual
     *  p. 13). The viewer has no encoder option for it, so it is named rather
     *  than drawn — a plausible-looking wrong check digit is worse than none. */
    checkDigitUndrawn?: boolean;
}

const TSPL_BARCODE_TYPES: Record<string, TsplBarcode> = {
    // Code 128 family.
    '128': { symbology: '6' },
    '128M': { symbology: '6' },
    EAN128: { symbology: '6' },
    EAN128M: { symbology: '6' },
    // 2 of 5 family: bare = interleaved, C = +check digit, S = standard,
    // I = industrial. '25C' has the PRINTER append a mod-10 check digit
    // (manual p. 13), which this encoder cannot do.
    '25': { symbology: '2' },
    '25C': { symbology: '2', checkDigitUndrawn: true },
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
 *
 * A command belongs here only if it cannot change WHERE the ink lands.
 * REFERENCE, SHIFT, OFFSET and MIRROR used to sit in this list, and that put
 * them in the one hole this parser has no other way out of: a line that is
 * neither drawn nor named. A stream that used them previewed a label the
 * printer would not produce, under no message at all. They are cases now,
 * each saying what it does to the image.
 */
const PRINTER_SETTINGS = new Set([
    // BLINEDETECT is how the guide spells it — one D, its own command list at
    // the front of "TSPL Programming Guide" (P1139068-01EN Rev A). The list
    // here carried BLINDDETECT, with two, which could NEVER match: the tokenizer
    // takes the name verbatim and the switch has no such case, so the real
    // command was reported as unrecognized while the misspelling silenced
    // nothing. Both spellings are accepted now — firmware in the wild is known
    // to honour the doubled D, and neither touches the drawn image.
    'GAP', 'GAPDETECT', 'BLINEDETECT', 'BLINDDETECT', 'SPEED', 'DENSITY', 'DIRECTION',
    'CODEPAGE', 'FEED', 'BACKFEED', 'BACKUP',
    'HOME', 'SOUND', 'CUT', 'LIMITFEED', 'EOJ', 'DELAY', 'FORMFEED',
    'SET', 'SETPEEL', 'SETTEAR', 'SETCUTTER', 'SETAUTODUMP', 'SETCOUNTER',
    'SETRIBBON', 'SETPARTIAL_CUTTER', 'SETBACK', 'AUTOBAUD', 'KILL', 'DOWNLOAD',
    // 'ERASE' used to be here. It is in the guide's command list and it CLEARS
    // a rectangular area of the image — the same family as IPL's LE and EPL's
    // LW, both of which this project already reports rather than silences.
    // Sitting here it produced no element AND no issue, so a label whose
    // overprint had been erased previewed with the overprint still on it and
    // nothing said otherwise.
    'FILES', 'MOVE', 'COPY', 'OUT', 'OUTR', 'STATUS', 'WIDTH', 'RUN',
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
        // An underscore is allowed because PRINTER_SETTINGS lists
        // SETPARTIAL_CUTTER, so that name was meant to be recognized and
        // silently ignored like its SET* neighbours. Without it the name failed
        // this test and was reported as "not a command this parser recognizes"
        // — the opposite of the stated intent, and inconsistent with the very
        // list that names it.
        if (name === '' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
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
                // The content is the LAST parameter, not p[6]: an optional
                // alignment may precede it, and reading a fixed index took the
                // alignment as the content — `TEXT 10,10,"2",0,1,1,1,"HELLO"`
                // printed "1" and lost "HELLO" without a word. BARCODE, QRCODE
                // and PDF417 all read the last parameter for this reason; TEXT
                // was the only one that did not.
                const content = p[p.length - 1] ?? '';
                // Anything between the multipliers and the content is the
                // alignment: 0 left, 1 center, 2 right. The renderer has no
                // slot for it, so it is named rather than dropped — the text
                // still prints, just from its own left edge.
                const rawAlign = p.length > 7 ? p[6] : '';
                const align = rawAlign === '' ? NaN : Math.trunc(num(rawAlign, NaN));
                if (align === 1 || align === 2) {
                    once('text-align', 'info', 'tspl-text-align',
                        `TEXT alignment ${align === 1 ? '1 (center)' : '2 (right)'} is not reproduced: the text is drawn from its left edge.`, 'TEXT');
                }
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
                if (mapped.checkDigitUndrawn) {
                    // '25C' makes the printer append a mod-10 check digit; this
                    // viewer draws the field's data without it. Named, not
                    // silently dropped — the same call IPL c2,m1 and EPL 2C make.
                    issue('info', 'tspl-i2of5-check-digit',
                        `Barcode type "${type}" is Interleaved 2 of 5 with a mod-10 check digit the printer appends (TSPL manual p. 13); this preview draws the field's data without it.`, 'BARCODE');
                }
                {
                    // p4 is 0 none / 1 left / 2 center / 3 right. The IR carries
                    // only none/below/above, so centre and right were collapsing
                    // to 1 and the digits drew from the symbol's left edge under
                    // no message. Left (1) is genuinely what this draws, so it
                    // stays silent; the other two are named.
                    const align = (p[4] ?? '').trim();
                    if (align === '2' || align === '3') {
                        issue('info', 'tspl-hri-align',
                            `The human-readable line is aligned ${align === '2' ? 'centre' : 'right'} in the stream; this preview always draws it from the symbol's left edge.`, 'BARCODE');
                    }
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
                    //
                    // The 2 and 3 are horizontal ALIGNMENTS of the line, and
                    // the IR has no slot for them: hri is just none/below/above.
                    // Collapsing them to 1 drew the digits from the symbol's
                    // left edge with no word about it, so the difference is
                    // named instead. Nothing is lost about WHERE the line is —
                    // only its alignment across the symbol.
                    hri: hriMode === 0 ? 0 : 1,
                    ratio: wide / narrow <= 2.2 ? 2 : wide / narrow < 2.8 ? 0 : 1,
                    source: { type: 'fixed', data: content },
                    ...(mapped.eanUpcVersion !== undefined ? { eanUpcVersion: mapped.eanUpcVersion } : {}),
                    ...(mapped.code39Mode !== undefined ? { code39Mode: mapped.code39Mode } : {}),
                };
                elements.push(place(el));
                break;
            }

            case 'ERASE': {
                // ERASE x,y,width,height — clears a rectangular area of the
                // image. This preview paints elements in order onto a white
                // sheet and has no way to clear a region afterwards, so drawing
                // it would be a different label: whatever it was meant to
                // remove would still be there. Reported as a warning, not the
                // generic info, because the label is visibly wrong rather than
                // merely missing a feature — the same call this project made
                // for IPL's LE and EPL's LW.
                if (p.length < 4) {
                    issue('warning', 'tspl-erase-params', `ERASE needs x,y,width,height. Found ${p.length}. Skipped.`, 'ERASE');
                    break;
                }
                const w = Math.max(0, Math.trunc(num(p[2], 0)));
                const h = Math.max(0, Math.trunc(num(p[3], 0)));
                issue('warning', 'tspl-erase-clears',
                    `ERASE clears a ${w}x${h} dot area at ${num(p[0], 0)},${num(p[1], 0)}; this preview cannot remove what is already drawn there, so nothing is erased.`, 'ERASE');
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
                // p4 is the mode: A = automatic, M = manual (it then takes
                // character/data/codeword counts and an optional mask). The
                // encoder here picks the encoding itself, so M is reported
                // rather than carried — the symbol's content is what the
                // stream asked for either way, but the module STREAM can
                // differ, and a mask the user asked for is not applied.
                const mode = (p[4] ?? '').trim().toUpperCase();
                if (mode === 'M') {
                    issue('info', 'tspl-qr-manual-mode',
                        'QRCODE mode M asks the printer to encode from explicit character/data/codeword counts (and an optional mask); this preview chooses the encoding itself, so the symbol may differ from the printed one.', 'QRCODE');
                }
                // The optional tail after the rotation is bracketed in the
                // manual and its members are letter-prefixed:
                //
                //   [justification]  J1-J9, placement only
                //   [model]          M1 original, M2 enhanced — DIFFERENT SYMBOL
                //   [mask]           S0-S8, default S7 — DIFFERENT PATTERN
                //   [area]           Xn, maximum barcode area in dots
                //
                // M1/M2 and S0-S8 both change what is encoded, and none of it
                // was read: measured, M2, S3, J5, X100 and all of them together
                // produced byte-identical elements to the bare command.
                const tail = p.slice(6, -1).map(s => s.trim().toUpperCase()).filter(Boolean);
                const opt = (letter: string): string | undefined => {
                    const hit = tail.find(s => s.startsWith(letter));
                    return hit ? hit.slice(1) : undefined;
                };
                const model = opt('M');
                const mask = opt('S');
                const area = opt('X');
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
                    // TSPL's model letters are its own; the IR numbers models
                    // 1 and 2, so M1 -> '1' and M2 -> '2'.
                    ...(model === '1' || model === '2' ? { qrModel: model } : {}),
                    // Sn maps straight through: both languages number the masks
                    // 0-8 with 0 meaning automatic.
                    ...(mask !== undefined && /^[0-8]$/.test(mask) ? { qrMask: mask } : {}),
                };
                if (model === '1') {
                    // M1 is the original QR model and no encoder here produces
                    // it — the same limitation IPL's c18,m1 documents. Saying so
                    // is the point: passing M1 through silently would draw a
                    // model-2 symbol under a stream asking for model 1.
                    issue('info', 'tspl-qr-model1',
                        'QRCODE model M1 (original) has no encoder here; the symbol is drawn as model M2, which most scanners read.', 'QRCODE');
                } else if (model !== undefined && model !== '2') {
                    issue('info', 'tspl-qr-model', `QRCODE model "${model}" is not M1 or M2 (TSC guide p. 65); the encoder's default is used.`, 'QRCODE');
                }
                if (mask !== undefined && !/^[0-8]$/.test(mask)) {
                    issue('info', 'tspl-qr-mask', `QRCODE mask "S${mask}" is outside S0-S8; the encoder's default is used.`, 'QRCODE');
                }
                if (area !== undefined || opt('J') !== undefined) {
                    // J1-J9 place the symbol and Xn caps its area. This preview
                    // draws from the field's own origin and does not lay the
                    // symbol out within a box, so the two are named.
                    issue('info', 'tspl-qr-placement',
                        `QRCODE ${area !== undefined ? `area X${area}` : ''}${area !== undefined && opt('J') !== undefined ? ' and ' : ''}${opt('J') !== undefined ? `justification J${opt('J')}` : ''} control where the symbol sits within a box; this preview draws it from its own origin.`, 'QRCODE');
                }
                if (!TSPL_QR_ECL[ecc]) {
                    issue('info', 'tspl-qr-ecc', `QR error-correction level "${ecc}" is not L/M/Q/H. The encoder's default is used.`, 'QRCODE');
                }
                elements.push(place(el));
                break;
            }

            case 'MPDF417': {
                // MPDF417 x,y,rotate,[Wn,][Hn,][Cn,]"content" — the TSC
                // manual's own syntax. It is NOT the PDF417 box: there is no
                // positional width or height, and W/H are letter-prefixed
                // module dimensions (defaults 1 and 10).
                //
                // Reading it as PDF417 put the WIDTH where the rotation
                // belongs, so MPDF417 10,10,100,50,0,"DATA" came out rotated
                // 100 quadrants. The round trip did not catch it because the
                // generator wrote the same wrong shape back — two sides agreeing
                // on a reading the manual does not support.
                if (p.length < 3) {
                    issue('warning', 'tspl-mpdf417-params', `MPDF417 needs x,y,rotate. Found ${p.length}. Skipped.`, 'MPDF417');
                    break;
                }
                const content = p[p.length - 1] ?? '';
                if (content === '') {
                    issue('warning', 'tspl-mpdf417-empty', 'A MPDF417 with no data prints nothing.', 'MPDF417');
                    break;
                }
                // The optional module dimensions are letter-prefixed and sit
                // between the rotation and the content.
                const mid = p.slice(3, -1).map(s => s.trim().toUpperCase());
                const dim = (letter: string, fallback: number) => {
                    const hit = mid.find(s => s.startsWith(letter));
                    const v = hit ? Math.trunc(num(hit.slice(1), fallback)) : fallback;
                    return Math.max(1, v);
                };
                // Cn, the column count, is the third optional member. Its
                // domain is 0-4 with 0 meaning automatic, so a value outside
                // that is not a column count and is named rather than passed
                // to an encoder that would refuse the symbol.
                const rawCols = mid.find(s => s.startsWith('C'));
                const colsNum = rawCols !== undefined ? Math.trunc(num(rawCols.slice(1), 0)) : undefined;
                const microCols = colsNum !== undefined && colsNum >= 0 && colsNum <= 4
                    ? String(colsNum) : undefined;
                if (rawCols !== undefined && microCols === undefined) {
                    issue('info', 'tspl-mpdf417-columns',
                        `MPDF417 columns "C${rawCols.slice(1)}" is outside 0-4 (TSC guide p. 60); the printer chooses the column count.`, 'MPDF417');
                }
                const f = quadrantFromClockwise(p[2]);
                const el: BarcodeElement = {
                    kind: 'barcode', id: nextId++,
                    ox: num(p[0], 0), oy: num(p[1], 0), f,
                    symbology: '19',
                    // Hn is the module's height; the IR wants a symbol height,
                    // so the module count is carried as-is and the renderer
                    // measures from moduleDots.
                    heightDots: dim('H', 10),
                    moduleDots: dim('W', 1),
                    ratio: 1,
                    hri: 0,
                    source: { type: 'fixed', data: content },
                    // Cn is "number of columns ... 0: Automode, 1-4 the column
                    // count", the same 0-4 domain as IPL's c19,m1 — and the IR
                    // already carries it for that command. Cn was the one
                    // member of this command's option block still unread, so a
                    // stream fixing the column count got an auto-sized symbol.
                    ...(microCols !== undefined ? { microColumns: microCols } : {}),
                };
                elements.push(place(el));
                break;
            }

            case 'PDF417': {
                // PDF417 x,y,width,height,rotate,[option],"content"
                // (TSC manual p. 56). The option block is letter-prefixed:
                //
                //   P     data compression 0 auto / 1 binary
                //   E     error correction level 0-8
                //   M     centre pattern 0 upper-left / 1 middle
                //   Ux,y,c human readable position and chars per line
                //   W     MODULE WIDTH in dots, 2-9
                //   H     BAR HEIGHT in dots, 4-99
                //   R,C   maximum rows / columns
                //   T     truncation 0 / 1
                //   Lm    expression length
                //
                // These were read past entirely: measured, E3, W4, H80, T1, C5
                // and all of them together produced byte-identical elements to
                // the bare command, under no message. W and H in particular
                // state the symbol's physical size, which is the one thing a
                // size-checking preview must not ignore.
                const which = cmd.name;
                if (p.length < 5) {
                    issue('warning', 'tspl-pdf417-params', `${which} needs x,y,width,height,rotate. Found ${p.length}. Skipped.`, which);
                    break;
                }
                const content = p[p.length - 1] ?? '';
                if (content === '') {
                    issue('warning', 'tspl-pdf417-empty', `A ${which} with no data prints nothing.`, which);
                    break;
                }
                // Everything between the rotation and the content is the option
                // block, one letter-prefixed token each.
                const opts = p.slice(5, -1).map(s => s.trim().toUpperCase()).filter(Boolean);
                const opt = (letter: string): string | undefined => {
                    const hit = opts.find(s => s.startsWith(letter));
                    return hit ? hit.slice(1) : undefined;
                };
                // W and H override the positional width/height. Their ranges —
                // W is 2-9 and H is 4-99 — bound the OPTION only: the manual
                // gives those numbers for the letter-prefixed values, while the
                // positional height is a plain dot count with no such ceiling.
                // Clamping the positional value would silently shrink any
                // stream asking for a taller symbol, which the test below
                // caught at 200 dots becoming 99.
                const wOpt = opt('W');
                const hOpt = opt('H');
                const moduleDots = wOpt !== undefined
                    ? Math.max(2, Math.min(9, Math.trunc(num(wOpt, 2))))
                    : Math.max(1, Math.trunc(num(p[2], 2) / 10) || 2);
                const barHeight = hOpt !== undefined
                    ? Math.max(4, Math.min(99, Math.trunc(num(hOpt, 10))))
                    : Math.max(1, Math.trunc(num(p[3], 10)));
                const f = quadrantFromClockwise(p[4]);
                const el: BarcodeElement = {
                    kind: 'barcode', id: nextId++,
                    ox: num(p[0], 0), oy: num(p[1], 0), f,
                    symbology: '12',
                    heightDots: Math.max(1, barHeight),
                    moduleDots: Math.max(1, moduleDots),
                    ratio: 1,
                    hri: 0,
                    source: { type: 'fixed', data: content },
                    // Carried through to the encoder, which understands these
                    // three; R/C (max rows/columns) have no IR slot and are
                    // reported below instead of being dropped.
                    ...(opt('E') !== undefined ? { pdfEcLevel: opt('E') } : {}),
                    ...(opt('C') !== undefined ? { pdfColumns: opt('C') } : {}),
                    ...(opt('T') !== undefined ? { pdfTruncate: opt('T') } : {}),
                };
                elements.push(place(el));
                // What this preview cannot apply, said rather than dropped.
                const ignored: string[] = [];
                if (opt('P') !== undefined) ignored.push('P (data compression)');
                if (opt('M') !== undefined) ignored.push('M (centre pattern)');
                if (opt('U') !== undefined) ignored.push('U (human-readable position)');
                if (opt('R') !== undefined) ignored.push('R (maximum rows)');
                if (opt('L') !== undefined) ignored.push('L (expression length)');
                if (ignored.length > 0) {
                    issue('info', 'tspl-pdf417-options',
                        `${which} options not reproduced here: ${ignored.join(', ')}. The symbol is drawn without them.`, which);
                }
                break;
            }

            case 'PRINT': {
                // PRINT copies[,sets] (manual p. 24) — a job concern, but the
                // viewer reads it so a preview can say how many labels.
                settings.quantity = Math.max(1, Math.trunc(num(p[0], 1)));
                break;
            }

            case 'MAXICODE': {
                // MAXICODE x,y,mode,[class,country,post,Lm,]"content" (TSC
                // manual p. 54). Modes 2 and 3 are Structured Carrier Messages:
                // the class, country and postal code are SEPARATE PARAMETERS
                // and the manual spells the postal code for mode 2 as
                // "06810,7317" — a comma inside the field, which the parameter
                // splitter therefore cuts into two. They are reassembled here
                // into the AIM SCM the encoder needs, because a bare payload
                // under those modes makes it throw and the symbol would vanish.
                //
                // The manual's own note: "Mode 6 is not supported in TSPL2
                // printer firmware", even though the mode table lists it.
                const mode = (p[2] ?? '').trim();
                const content = p[p.length - 1] ?? '';
                if (p.length < 4) {
                    issue('warning', 'tspl-maxicode-params', `MAXICODE needs x,y,mode,"content". Found ${p.length}. Skipped.`, 'MAXICODE');
                    break;
                }
                let data = content;
                let maxiMode: string | undefined;
                if (mode === '2' || mode === '3') {
                    maxiMode = mode;
                    // Parameters between the mode and the content. Mode 2's
                    // postal code may be the two-part "99999,9999" the manual
                    // writes, so anything past the third slot that is numeric
                    // and short is the rest of it rather than Lm.
                    const rest = p.slice(3, -1).map(s => s.trim());
                    const [cls, country, ...tail] = rest;
                    let post = tail.shift() ?? '';
                    const numericTail = tail[0] ?? '';
                    if (mode === '2' && /^\d{1,5}$/.test(post) && /^\d{1,4}$/.test(numericTail)) {
                        post = `${post}${numericTail}`;   // "06810,7317" -> 068107317
                        tail.shift();
                    }
                    if (cls === undefined || country === undefined || post === '') {
                        issue('warning', 'tspl-maxicode-scm',
                            `MAXICODE mode ${mode} needs class, country and postal code (TSC manual p. 54). Found ${rest.length} parameter(s); the symbol is drawn from the content alone.`, 'MAXICODE');
                    } else {
                        data = buildMaxiCodeScm({ postcode: post, country, serviceClass: cls, body: content });
                    }
                } else if (mode === '6') {
                    maxiMode = mode;
                    issue('info', 'tspl-maxicode-mode6',
                        'MAXICODE mode 6 is listed in the TSC manual but its own note says TSPL2 firmware does not support it; the symbol is drawn as mode 6 regardless.', 'MAXICODE');
                } else if (mode === '4' || mode === '5') {
                    maxiMode = mode;
                    // Lm (expression length) is the only other parameter these
                    // modes take, and it is a length the printer uses to size
                    // the symbol, not data.
                } else {
                    issue('info', 'tspl-maxicode-mode',
                        `MAXICODE mode "${mode}" is not one of 2, 3, 4 or 5 (TSC manual p. 54); the encoder's automatic selection is used.`, 'MAXICODE');
                }
                if (content === '') {
                    issue('warning', 'tspl-maxicode-empty', 'A MaxiCode with no data prints nothing.', 'MAXICODE');
                    break;
                }
                // Fixed-size symbol: the manual gives it no width, height or
                // module parameter at all, only the start point.
                const el: BarcodeElement = {
                    kind: 'barcode', id: nextId++,
                    ox: num(p[0], 0), oy: num(p[1], 0), f: 0,
                    symbology: '14',
                    heightDots: 101,
                    moduleDots: 1,
                    ratio: 1,
                    hri: 0,
                    source: { type: 'fixed', data },
                    ...(maxiMode !== undefined ? { maxiMode } : {}),
                };
                elements.push(place(el));
                break;
            }

            case 'DMATRIX': {
                // DMATRIX x,y,width,height,[options,]"content" (TSC manual
                // p. 51). The symbol is ECC-200, which is the encoder here, so
                // the DATA is unambiguous; the bare form (the manual's example 1,
                // "DMATRIX 10,110,400,400,"DMATRIX EXAMPLE 1"") is the common
                // one. The bracketed options are the manual's own terse list:
                //
                //   c#  escape control char (how the DATA is escaped — NOT a
                //       symbol property, so it is REPORTED, not guessed)
                //   x#  module size in dots
                //   r#  rotation 0/90/180/270 (clockwise, like every TSPL command)
                //   a#  square (0, default) or rectangle (1)
                //
                // The bare x,y,width,height map to the field's origin, module
                // and height as DMATRIX's positional width/height state the
                // barcode AREA, not the symbol grid.
                if (p.length < 5) {
                    issue('warning', 'tspl-dmatrix-params', `DMATRIX needs x,y,width,height,"content". Found ${p.length}. Skipped.`, 'DMATRIX');
                    break;
                }
                const content = p[p.length - 1] ?? '';
                if (content === '') {
                    issue('warning', 'tspl-dmatrix-empty', 'A Data Matrix with no data prints nothing.', 'DMATRIX');
                    break;
                }
                const opts = p.slice(4, -1).map(s => s.trim().toUpperCase()).filter(Boolean);
                const opt = (letter: string): string | undefined => {
                    const hit = opts.find(s => s.startsWith(letter));
                    return hit ? hit.slice(1) : undefined;
                };
                const moduleDots = Math.max(1, Math.trunc(num(opt('X'), 3)));
                const f = quadrantFromClockwise(opt('R'));
                const rect = (opt('A') ?? '0').trim();
                const el: BarcodeElement = {
                    kind: 'barcode', id: nextId++,
                    ox: num(p[0], 0), oy: num(p[1], 0), f,
                    symbology: '17',
                    heightDots: Math.max(1, Math.trunc(num(p[3], 10))),
                    moduleDots,
                    ratio: 1,
                    hri: 0,
                    source: { type: 'fixed', data: content },
                    // a# selects square or rectangular, the same IR shape the
                    // IPL c17,m2 and EPL v options carry.
                    ...(rect === '1' ? { dmShape: 'rectangle' } : {}),
                };
                elements.push(place(el));
                if (opt('C') !== undefined) {
                    issue('info', 'tspl-dmatrix-escape',
                        'DMATRIX c# sets the escape control character, which changes how the DATA is unescaped, not the symbol; this preview decodes the content as written.', 'DMATRIX');
                }
                if (rect !== '0' && rect !== '1' && opt('A') !== undefined) {
                    issue('info', 'tspl-dmatrix-shape', `DMATRIX a#"${rect}" is not 0 (square) or 1 (rectangle); a square symbol is drawn.`, 'DMATRIX');
                }
                break;
            }

            case 'SHIFT':
            case 'REFERENCE':
            case 'OFFSET':
            case 'MIRROR': {
                // Named, not silenced. Their neighbours in the settings list are
                // sensor and job settings; these four sit in the same family as
                // DIRECTION, which this parser already warns about for exactly
                // this reason — a command that changes WHERE the image lands.
                // Leaving them silent while warning about DIRECTION was an
                // inconsistency in this file, not a judgement about them.
                //
                // Drawing the fields at their own coordinates and saying
                // nothing showed a label the printer would not produce, under a
                // message set that implied everything was fine. ZPL's
                // ^LH/^LT/^LS had the identical defect and the identical answer.
                //
                // NOT PROVEN against a manual: the TSPL manual cited elsewhere
                // in this file is not in the repo, so the precise mechanic of
                // each command is stated as the reason to look, not as a
                // measured result. What IS verified is that this preview does
                // not apply them — so if they move the image, the preview is
                // wrong, and this line is the only thing that says so.
                //
                // Keyed on the values, not the command: a stream of many labels
                // that all shift by the same amount says it once, while a
                // genuinely different value still gets its own line.
                const values = cmd.params.trim();
                const moved = cmd.name === 'MIRROR' || cmd.name === 'OFFSET'
                    ? num(p[0], 0) !== 0
                    : num(p[0], 0) !== 0 || num(p[1], 0) !== 0;
                if (!moved) break;   // where the image already is: nothing to say
                once(`shift-${cmd.name}-${values}`, 'warning', 'tspl-image-shifted',
                    `${cmd.name}${values === '' ? '' : ` (${values})`} changes where the image lands; this preview draws every field at its own coordinates and does not apply it.`,
                    cmd.name);
                break;
            }

            case 'DIRECTION':
                // 0 or 1: whether the label is laid out sideways. The IR has no
                // slot for it, and guessing would move every field — say so.
                once('direction', 'info', 'tspl-direction',
                    'DIRECTION rotates the whole label by 90°. This viewer draws the label as laid out, so the preview is turned compared with the print.', 'DIRECTION');
                break;

            case 'CODEPAGE': {
                // CODEPAGE n selects the international character set (manual
                // p. 17) — the same byte means a different glyph under each
                // (0xE4 is 'ä' in Windows-1252, a box-drawing glyph in 437).
                // The viewer decodes high bytes as Latin-1, so it draws the
                // wrong character for any page other than a Latin-1-compatible
                // one — silent until now, because CODEPAGE sat in
                // PRINTER_SETTINGS with the sensor settings.
                const n = (p[0] ?? '').trim().toUpperCase();
                const latin1ish = n === '' || n === '1252' || n === '8859-1' || n === 'LATIN1' || n === 'LATIN 1';
                if (!latin1ish) {
                    once('codepage', 'info', 'tspl-codepage',
                        `CODEPAGE ${n} selects a character set this viewer does not apply; it decodes high bytes as Latin-1, so characters outside that set may differ from the print.`, 'CODEPAGE');
                }
                break;
            }

            default: {
                if (PRINTER_SETTINGS.has(cmd.name)) break;
                if (cmd.name === 'AZTEC') {
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
