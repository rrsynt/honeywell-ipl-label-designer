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
//      negated here â€” carrying it across unchanged would mirror every rotated
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
 *   0  Monotype CG Triumvirate Bold Condensed â€” the scalable one
 *   1  8 x 12     4  24 x 32     7  21 x 27 OCR-B
 *   2  12 x 20    5  32 x 48     8  14 x 25 OCR-A
 *   3  16 x 24    6  14 x 19 OCR-B
 *
 * The .TTF/.EFT/.FNT names (ROMAN.TTF, 1.EFT, A.FNT â€¦) are downloads or
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
     *  than drawn â€” a plausible-looking wrong check digit is worse than none. */
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
    // as the main symbol â€” reported so the difference is not silent.
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
    // These carried an "unencodable" message while bwip-js had an encoder for
    // every one of them. They were only ever missing an IR id (see the 27-34
    // block in services/ipl/barcodes.ts). MSIC is MSI with the check digit the
    // PRINTER appends, which this encoder cannot reproduce, so it is named
    // rather than silently drawn without it — the same call EPL 2C and TSPL
    // 25C make.
    MSI: { symbology: '27' },
    MSIC: { symbology: '27', checkDigitUndrawn: true },
    PLESSEY: { symbology: '28' },
    DPI: { symbology: '29' },
    DPL: { symbology: '30' },
    TELEPEN: { symbology: '31' },
    TELEPENN: { symbology: '33' },
    ITF14: { symbology: '32' },
};

/** Types the manual lists that this viewer has no encoder for. Named so an
 *  issue says WHICH symbology is missing instead of "unknown type".
 *
 *  Only two are left, and both are absent from the encoder library itself:
 *  China Post and EAN-14 (bwip reports `unknownEncoder` / `ean14badLength` for
 *  the shapes it does ship). The other eight moved to real IR ids — see the
 *  additions in services/ipl/barcodes.ts. */
const TSPL_KNOWN_UNENCODED: Record<string, string> = {
    CPOST: 'China Post',
    EAN14: 'EAN-14',
};

/** TSPL's QR error-correction letters onto the IR's c18,m2 values. */
const TSPL_QR_ECL: Record<string, string> = { L: 'L', M: 'M', Q: 'Q', H: 'H' };

/** BLOCK's alignment numbers (manual p. 80): 0/1 left, 2 centre, 3 right. */
const BLOCK_ALIGN: Record<number, 'left' | 'center' | 'right'> =
    { 0: 'left', 1: 'left', 2: 'center', 3: 'right' };

/**
 * The `RSS` command's symbology names onto the IR's c20,m1 version numbers
 * (TSC manual p. 71). The IR's '20' is the GS1 DataBar family the encoder
 * already produces for IPL and EPL; only the TSPL names were missing.
 *
 * RSSEXP maps to the EXPANDED-STACKED variant (m1=6). The manual gives it a
 * segment width, and that is exactly the parameter m1=6 takes â€” the plain
 * expanded form (m1=5) has no segment control at all, so resolving to 5 would
 * make the sixth parameter unwritable.
 */
const TSPL_RSS_VERSION: Record<string, string> = {
    RSS14: '0',     // omnidirectional
    RSS14T: '1',    // truncated
    RSS14S: '2',    // stacked
    RSS14SO: '3',   // stacked omnidirectional
    RSSLIM: '4',    // limited
    RSSEXP: '6',    // expanded, stacked (takes the segment width)
};

/**
 * Commands that are printer settings or jobs, not geometry.
 *
 * Expected in a real TSPL program, and they put nothing on the label â€” so
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
    // BLINEDETECT is how the guide spells it â€” one D, its own command list at
    // the front of "TSPL Programming Guide" (P1139068-01EN Rev A). The list
    // here carried BLINDDETECT, with two, which could NEVER match: the tokenizer
    // takes the name verbatim and the switch has no such case, so the real
    // command was reported as unrecognized while the misspelling silenced
    // nothing. Both spellings are accepted now â€” firmware in the wild is known
    // to honour the doubled D, and neither touches the drawn image.
    'GAP', 'GAPDETECT', 'BLINEDETECT', 'BLINDDETECT', 'SPEED', 'DENSITY', 'DIRECTION',
    'CODEPAGE', 'FEED', 'BACKFEED', 'BACKUP',
    'HOME', 'SOUND', 'CUT', 'LIMITFEED', 'EOJ', 'DELAY', 'FORMFEED',
    'SET', 'SETPEEL', 'SETTEAR', 'SETCUTTER', 'SETAUTODUMP', 'SETCOUNTER',
    'SETRIBBON', 'SETPARTIAL_CUTTER', 'SETBACK', 'AUTOBAUD', 'KILL', 'DOWNLOAD',
    // 'ERASE' used to be here. It is in the guide's command list and it CLEARS
    // a rectangular area of the image â€” the same family as IPL's LE and EPL's
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
 * the payload is QUOTED â€” so a comma inside the quotes is data, exactly as in
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
        // is the payload unescaped. Doing it in one pass â€” unescaping while
        // still looking for the closing quote â€” cannot work: \[ turns into a
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
        // The command name is the leading token, up to the first whitespace â€”
        // NOT a run of letters. TSPL names may contain digits (`PDF417`), so a
        // letters-only rule read that line as a command called "PDF" with a
        // parameter "417 10,10,â€¦" and drew nothing. Every TSPL command in the
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
        // â€” the opposite of the stated intent, and inconsistent with the very
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
    // how big the label is â€” without them the preview has no canvas.
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
                // writes "SIZE 50 mm,25 mm" â€” a SPACE before the unit.
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
                // quoted runs put back where they were â€” so p[2] IS the font
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
                // alignment as the content â€” `TEXT 10,10,"2",0,1,1,1,"HELLO"`
                // printed "1" and lost "HELLO" without a word. BARCODE, QRCODE
                // and PDF417 all read the last parameter for this reason; TEXT
                // was the only one that did not.
                const content = p[p.length - 1] ?? '';
                // Anything between the multipliers and the content is the
                // alignment: 0 left, 1 center, 2 right. The renderer has no
                // slot for it, so it is named rather than dropped â€” the text
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
                // The IR font is the EXACT INVERSE of the generator's
                // TSPL_FONT_FOR, by cell-height RANK (the only order both tables
                // can agree on, as EPL's map is): design 0 (7x9) < 1 (7x11) <
                // 2 (10x14) = TSPL 1 (8x12) < 2 (12x20) < 3 (16x24). So TSPL
                // 1->0, 2->1, 3->2. This used to read `fontName === '1' ? '0'
                // : '2'`, which sent TSPL 2/3 to design 2 — so a design font 1
                // (which the generator writes as TSPL 2 under the inverse map)
                // reloaded as font 2. TSPL 4/5 have no design font of their own
                // and fall back to 2, matching EPL.
                const TSPL_FONT_TO_IR: Record<string, string> = { '1': '0', '2': '1', '3': '2', '4': '2', '5': '2' };
                const irFont = TSPL_FONT_TO_IR[fontName] ?? '2';
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
                // BAR x,y,width,height (manual p. 37) â€” a filled bar.
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
                    // silently dropped â€” the same call IPL c2,m1 and EPL 2C make.
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
                    // 3 right, ALL below the bar â€” the IR's 1 means "below",
                    // and there is no above in TSPL at all.
                    //
                    // The 2 and 3 are horizontal ALIGNMENTS of the line, and
                    // the IR has no slot for them: hri is just none/below/above.
                    // Collapsing them to 1 drew the digits from the symbol's
                    // left edge with no word about it, so the difference is
                    // named instead. Nothing is lost about WHERE the line is â€”
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
                // ERASE x,y,width,height â€” clears a rectangular area of the
                // image. This preview paints elements in order onto a white
                // sheet and has no way to clear a region afterwards, so drawing
                // it would be a different label: whatever it was meant to
                // remove would still be there. Reported as a warning, not the
                // generic info, because the label is visibly wrong rather than
                // merely missing a feature â€” the same call this project made
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
                // rather than carried â€” the symbol's content is what the
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
                //   [model]          M1 original, M2 enhanced â€” DIFFERENT SYMBOL
                //   [mask]           S0-S8, default S7 â€” DIFFERENT PATTERN
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
                    // it â€” the same limitation IPL's c18,m1 documents. Saying so
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

            case 'BLOCK': {
                // BLOCK x,y,width,height,"font",rotation,x-mul,y-mul,[space,]
                // [align,][fit,]"content" (TSC manual p. 80). It is a PARAGRAPH
                // laid out inside a box: the text WRAPS at the box width, which
                // an ordinary TEXT field never does. Reading it as TEXT would
                // draw one long line running off the label.
                //
                // The trailing options are positional AND optional, so they are
                // read from the END towards the content: content is last, and
                // whatever sits between y-mul and it is the optional tail.
                if (p.length < 9) {
                    issue('warning', 'tspl-block-params', `BLOCK needs x,y,width,height,"font",rotation,x-mul,y-mul,"content". Found ${p.length}. Skipped.`, 'BLOCK');
                    break;
                }
                const content = p[p.length - 1] ?? '';
                if (content === '') {
                    issue('warning', 'tspl-block-empty', 'A text block with no content prints nothing.', 'BLOCK');
                    break;
                }
                const font = (p[4] ?? '0').trim();
                const rotation = quadrantFromClockwise(p[5]);
                const xmul = Math.max(1, Math.trunc(num(p[6], 1) || 1));
                const ymul = Math.max(1, Math.trunc(num(p[7], 1) || 1));
                // The optional tail is [space,] [align,] [fit,] â€” it sits in
                // FIXED POSITIONS 9, 10 and 11, and can only be omitted from
                // the END (you cannot write `fit` without `space` and `align`).
                // So the slots are read positionally with their documented
                // defaults, which is what the manual's own two examples show:
                // one with no tail at all, one with `20,2` = space + align.
                //
                // Reading them from the END instead mis-assigned `20,2`: two
                // values made it think `20` was an alignment, fail its 0-3
                // test, and drop the leading silently.
                const spaceRaw = p[8];
                const alignRaw = p[9];
                const fitRaw = p[10];
                const spaceDots = spaceRaw !== undefined && spaceRaw !== '' && Number.isFinite(Number(spaceRaw))
                    ? Math.trunc(Number(spaceRaw)) : undefined;
                const align = alignRaw !== undefined && /^[0-3]$/.test(alignRaw.trim())
                    ? Number(alignRaw.trim()) : undefined;
                const fit = fitRaw !== undefined && fitRaw !== '' ? fitRaw.trim() === '1' : undefined;
                const blockFont = (TSPL_FONT_SIZES[font] ? font : '2');
                if (!TSPL_FONT_SIZES[font] && !font.endsWith('.TTF') && !font.endsWith('.FNT') && !font.endsWith('.EFT')) {
                    issue('info', 'tspl-block-font', `BLOCK font "${font}" is not one of the resident fonts; resident font 2 is drawn instead.`, 'BLOCK');
                }
                elements.push(place({
                    kind: 'text', id: nextId++,
                    ox: num(p[0], 0), oy: num(p[1], 0), f: rotation,
                    font: blockFont,
                    hMag: ymul, wMag: xmul,
                    source: { type: 'fixed', data: content },
                    wrapDots: Math.max(1, Math.trunc(num(p[2], 100))),
                    boxHeightDots: Math.max(1, Math.trunc(num(p[3], 20))),
                    ...(spaceDots !== undefined ? { spaceDots } : {}),
                    // BLOCK numbers the alignments 0/1 left, 2 centre, 3 right
                    // (manual p. 80) â€” NOT the 0 left, 1 centre, 2 right its own
                    // TEXT command uses. Carried as a NAME so the two cannot be
                    // confused for one another.
                    ...(align !== undefined ? { align: BLOCK_ALIGN[align] } : {}),
                    ...(fit === true ? { fit: true } : {}),
                } as TextElement));
                if (fit === true) {
                    issue('info', 'tspl-block-fit', 'BLOCK fit=1 shrinks the text until the paragraph fits the box; this preview wraps it without shrinking.', 'BLOCK');
                }
                break;
            }

            case 'REVERSE': {
                // REVERSE x_start,y_start,x_width,y_height (TSC manual p. 75).
                // It INVERTS the region of the image buffer, so it is its own
                // element rather than a fill: a white fill would leave black
                // ink under it and claim to have erased it.
                if (p.length < 4) {
                    issue('warning', 'tspl-reverse-params', `REVERSE needs x,y,width,height. Found ${p.length}. Skipped.`, 'REVERSE');
                    break;
                }
                const rw = Math.max(0, Math.trunc(num(p[2], 0)));
                const rh = Math.max(0, Math.trunc(num(p[3], 0)));
                if (rw === 0 || rh === 0) {
                    issue('info', 'tspl-reverse-empty', 'A REVERSE region with no width or height changes nothing.', 'REVERSE');
                    break;
                }
                elements.push(place({
                    kind: 'reverse', id: nextId++,
                    ox: num(p[0], 0), oy: num(p[1], 0), f: 0,
                    widthDots: rw, heightDots: rh,
                } as ViewerElement));
                break;
            }

            case 'DIAGONAL': {
                // DIAGONAL x1,y1,x2,y2,thickness (TSC manual p. 76). Both ends
                // are FREE POINTS, so it is not a rotated line of a given
                // length unless one of the axes happens to match. It is drawn
                // as a pair of points on its own element.
                if (p.length < 4) {
                    issue('warning', 'tspl-diagonal-params', `DIAGONAL needs x1,y1,x2,y2. Found ${p.length}. Skipped.`, 'DIAGONAL');
                    break;
                }
                const th = Math.max(1, Math.trunc(num(p[4], 1) || 1));
                elements.push({
                    kind: 'diagonal', id: nextId++,
                    ox: num(p[0], 0), oy: num(p[1], 0), f: 0,
                    ex: num(p[2], 0), ey: num(p[3], 0),
                    thicknessDots: th,
                } as ViewerElement);
                break;
            }

            case 'CIRCLE':
            case 'ELLIPSE': {
                // CIRCLE x,y,diameter,thickness (p. 48)
                // ELLIPSE x,y,width,height,thickness (p. 49)
                // Both give the UPPER-LEFT corner of the bounding box, not the
                // centre, which is the one thing about them that is easy to get
                // backwards â€” the manual says "x-coordinate of upper left
                // corner" for both.
                const isCircle = cmd.name === 'CIRCLE';
                if (p.length < 4) {
                    issue('warning', 'tspl-shape-params', `${cmd.name} needs ${isCircle ? 'x,y,diameter' : 'x,y,width,height'}. Found ${p.length}. Skipped.`, cmd.name);
                    break;
                }
                const ew = Math.max(0, Math.trunc(num(p[2], 0)));
                const eh = isCircle ? ew : Math.max(0, Math.trunc(num(p[3], 0)));
                const thick = Math.max(1, Math.trunc(num(p[isCircle ? 3 : 4], 1) || 1));
                if (ew === 0 || eh === 0) {
                    issue('info', 'tspl-shape-empty', `A ${cmd.name} with no width or height draws nothing.`, cmd.name);
                    break;
                }
                elements.push(place({
                    kind: 'ellipse', id: nextId++,
                    ox: num(p[0], 0), oy: num(p[1], 0), f: 0,
                    widthDots: ew, heightDots: eh, thicknessDots: thick,
                } as ViewerElement));
                break;
            }

            case 'AZTEC': {
                // AZTEC x,y,rotate,[size,]ecp,]flg,]menu,]multi,]rev,] "content"
                // (TSC manual p. 59). Every parameter after the rotation is
                // OPTIONAL and its meaning is POSITIONAL â€” the manual's own
                // example is `AZTEC 10,10,0,"ABCDâ€¦"` with none of them.
                //
                // `ecp` is not a preference: it selects the symbol FORMAT
                // (compact / full-range / rune) as well as the correction
                // level, so reading it as only a percentage would draw a
                // full-range symbol where a compact one was asked for. The
                // three forms are three different bwip encoders.
                if (p.length < 3) {
                    issue('warning', 'tspl-aztec-params', `AZTEC needs x,y,rotate. Found ${p.length}. Skipped.`, 'AZTEC');
                    break;
                }
                const azContent = p[p.length - 1] ?? '';
                if (azContent === '') {
                    issue('warning', 'tspl-aztec-empty', 'An Aztec symbol with no data prints nothing.', 'AZTEC');
                    break;
                }
                const azOpts = p.slice(3, -1).map(s => s.trim());
                const azSize = Math.max(1, Math.min(20, Math.trunc(num(azOpts[0], 6) || 6)));
                const ecpRaw = azOpts[1];
                const ecp = ecpRaw === undefined || ecpRaw === '' ? undefined : String(Math.trunc(num(ecpRaw, 0)));
                elements.push(place({
                    kind: 'barcode', id: nextId++,
                    ox: num(p[0], 0), oy: num(p[1], 0),
                    f: quadrantFromClockwise(p[2]),
                    symbology: '23',
                    // Aztec is a matrix: `size` is the module size and the grid
                    // is the encoder's own business, so a nominal multiple keeps
                    // the anchor sane without pretending to know the layer count.
                    heightDots: azSize * 21,
                    moduleDots: azSize,
                    ratio: 1,
                    hri: 0,
                    source: { type: 'fixed', data: azContent },
                    ...(ecp !== undefined ? { aztecEcp: ecp } : {}),
                } as BarcodeElement));
                if (azOpts[2] !== undefined && azOpts[2] !== '' && azOpts[2] !== '0') {
                    // "1: input uses <Esc>n for FLG(n), <Esc><Esc> for <Esc>" â€”
                    // it changes how the DATA is unescaped, not the symbol.
                    issue('info', 'tspl-aztec-flg',
                        'AZTEC flg=1 makes the printer read "<Esc>n" sequences in the data (FLG(n) / literal <Esc>); this preview decodes the content as written.', 'AZTEC');
                }
                if (azOpts[3] !== undefined && azOpts[3] !== '' && azOpts[3] !== '0') {
                    issue('info', 'tspl-aztec-menu', 'AZTEC menu=1 makes the symbol indicate that a menu accompanies it; this preview draws the symbol itself.', 'AZTEC');
                }
                if (azOpts[4] !== undefined && azOpts[4] !== '' && azOpts[4] !== '0') {
                    issue('info', 'tspl-aztec-multi', `AZTEC multi=${azOpts[4]} splits long data across several symbols; this preview draws a single symbol.`, 'AZTEC');
                }
                if (azOpts[5] !== undefined && azOpts[5] !== '' && azOpts[5] !== '0') {
                    // The same limitation as EPL's Data Matrix inverse: the
                    // renderer paints dark modules onto a white sheet, and the
                    // offscreen-flip attempt measured as a no-op, so this is
                    // REPORTED rather than left looking implemented.
                    issue('info', 'tspl-aztec-rev', 'AZTEC rev=1 asks for a reversed (white on black) symbol; this preview draws it black on white.', 'AZTEC');
                }
                if (ecp !== undefined) {
                    const n = Number(ecp);
                    const known = n === 0 || (n >= 1 && n <= 99) || (n >= 101 && n <= 104)
                        || (n >= 201 && n <= 232) || n === 300;
                    if (!known) {
                        issue('info', 'tspl-aztec-ecp', `AZTEC ecp=${ecp} is not one of the documented values (0; 1-99 a correction percentage; 101-104 compact layers; 201-232 full-range layers; 300 a Rune); the encoder's default is used.`, 'AZTEC');
                    }
                }
                break;
            }

            case 'CODABLOCK': {
                // CODABLOCK x,y,rotation,[row height,]module width,]"content"
                // (TSC manual p. 50). Row height defaults to 8 and module width
                // to 2, and the printed row height is their PRODUCT â€” so the
                // two are not interchangeable and both are kept.
                if (p.length < 4) {
                    issue('warning', 'tspl-codablock-params', `CODABLOCK needs x,y,rotation,"content". Found ${p.length}. Skipped.`, 'CODABLOCK');
                    break;
                }
                const cbContent = p[p.length - 1] ?? '';
                if (cbContent === '') {
                    issue('warning', 'tspl-codablock-empty', 'A Codablock F symbol with no data prints nothing.', 'CODABLOCK');
                    break;
                }
                const cbOpts = p.slice(3, -1).map(s => s.trim());
                const rowH = cbOpts[0] === undefined || cbOpts[0] === '' ? '8' : String(Math.trunc(num(cbOpts[0], 8) || 8));
                const modW = cbOpts[1] === undefined || cbOpts[1] === '' ? '2' : String(Math.trunc(num(cbOpts[1], 2) || 2));
                const modNum = Math.max(1, Math.trunc(num(modW, 2)));
                elements.push(place({
                    kind: 'barcode', id: nextId++,
                    ox: num(p[0], 0), oy: num(p[1], 0),
                    f: quadrantFromClockwise(p[2]),
                    symbology: '24',
                    heightDots: Math.max(1, Math.trunc(num(rowH, 8))) * modNum,
                    moduleDots: modNum,
                    ratio: 1,
                    hri: 0,
                    source: { type: 'fixed', data: cbContent },
                    codablockRowHeight: rowH,
                    codablockModuleWidth: modW,
                } as BarcodeElement));
                break;
            }

            case 'RSS': {
                // RSS x,y,"sym",rotate,pixMult,sepHt[,"content"] (TSC manual
                // p. 71). It is NOT a BARCODE type: GS1 DataBar has its own
                // command, and the type is a NAME inside quotes.
                //
                // This command was reported as "not part of the supported TSPL
                // subset" even though services/ipl/barcodes.ts has encoded the
                // IR's '20' as databar for every other language all along â€” the
                // same shape as DMATRIX and MAXICODE. What was missing was only
                // the name table, so the symbol was left off the label under a
                // message implying the language could not draw it.
                //
                // The manual's family is wider than the IR's: UCC128CCA/CCC are
                // composite (linear + CC-A/B/C) and EAN8/EAN13/UPCA/UPCE are the
                // EAN/UPC symbology under another name. Those are resolved to
                // their own IR ids rather than being forced into '20'.
                if (p.length < 4) {
                    issue('warning', 'tspl-rss-params', `RSS needs x,y,"sym",rotate,pixMult. Found ${p.length}. Skipped.`, 'RSS');
                    break;
                }
                const sym = (p[2] ?? '').trim().toUpperCase();
                const content = p[p.length - 1] ?? '';
                const pixMult = Math.max(1, Math.min(10, Math.trunc(num(p[4], 2) || 2)));
                const sepHt = p.length > 6 ? Math.max(1, Math.min(2, Math.trunc(num(p[5], 1) || 1))) : undefined;
                // The 6th slot means a different thing per variant (manual p. 71):
                // segment width for RSSEXP, linear height for the composites,
                // absent otherwise. Content is always the LAST parameter, so the
                // slot only exists when more than one parameter follows sepHt.
                const sixth = p.length > 7 ? p[6] : undefined;
                const f = quadrantFromClockwise(p[3]);
                const base = {
                    kind: 'barcode' as const, id: nextId++,
                    ox: num(p[0], 0), oy: num(p[1], 0), f,
                    ratio: 1, hri: 0 as const, moduleDots: pixMult,
                    source: { type: 'fixed' as const, data: content },
                };
                // The manual gives a printer-computed bar height per type
                // ("RSS14 33 x pixMult", "RSSLIM 13 x pixMult", â€¦), stored in
                // dots so the preview draws the documented size.
                const heights: Record<string, number> = {
                    RSS14: 33, RSS14T: 13, RSS14S: 13, RSS14SO: 33, RSSLIM: 13, RSSEXP: 33,
                    EAN8: 60, EAN13: 74, UPCA: 74, UPCE: 74,
                };
                const irVersion = TSPL_RSS_VERSION[sym];
                if (irVersion !== undefined) {
                    const seg = sixth === undefined ? NaN : Math.trunc(num(sixth, 0));
                    elements.push(place({
                        ...base,
                        symbology: '20',
                        heightDots: (heights[sym] ?? 33) * pixMult,
                        rssVersion: irVersion,
                        // sepHt is the separator row of the STACKED variants;
                        // the encoder takes it only for those (see barcodes.ts).
                        ...(sepHt !== undefined && (sym === 'RSS14S' || sym === 'RSS14SO' || sym === 'RSSEXP') ? { rssSepHeight: String(sepHt) } : {}),
                        // RSSEXP's sixth parameter is the segment width, and the
                        // encoder takes it only for the expanded-stacked variant
                        // (m1=6), which is the one this preview draws.
                        ...(sym === 'RSSEXP' && irVersion === '6'
                            && Number.isInteger(seg) && seg >= 2 && seg <= 22 && seg % 2 === 0
                            ? { rssSegments: String(seg) } : {}),
                    } as BarcodeElement));
                } else if (sym === 'EAN8' || sym === 'EAN13' || sym === 'UPCA' || sym === 'UPCE') {
                    // The same symbol under the EAN/UPC command's name; the IR
                    // resolves the variant from the data length.
                    elements.push(place({
                        ...base,
                        symbology: '7',
                        heightDots: (heights[sym] ?? 74) * pixMult,
                    } as BarcodeElement));
                } else if (sym === 'UCC128CCA' || sym === 'UCC128CCC') {
                    // EAN/UCC-128 with a CC-A/B or CC-C composite component.
                    // The manual's sixth parameter is the LINEAR height; the CC
                    // half is its own encoder input this subset does not carry.
                    issue('info', 'tspl-rss-composite',
                        `RSS "${sym}" is a composite (EAN/UCC-128 plus CC-${sym.endsWith('A') ? 'A/B' : 'C'}); this preview draws the linear component only.`, 'RSS');
                    elements.push(place({
                        ...base,
                        symbology: '6',
                        heightDots: Math.max(1, Math.trunc(num(sixth, 100))) * Math.max(1, pixMult),
                    } as BarcodeElement));
                } else {
                    issue('info', 'tspl-rss-type', `RSS symbology "${sym}" is not one of the types on TSC manual p. 71 (RSS14, RSS14T, RSS14S, RSS14SO, RSSLIM, RSSEXP, UPCA, UPCE, EAN13, EAN8, UCC128CCA, UCC128CCC); nothing is drawn for it.`, 'RSS');
                    break;
                }
                break;
            }

            case 'MPDF417': {
                // MPDF417 x,y,rotate,[Wn,][Hn,][Cn,]"content" â€” the TSC
                // manual's own syntax. It is NOT the PDF417 box: there is no
                // positional width or height, and W/H are letter-prefixed
                // module dimensions (defaults 1 and 10).
                //
                // Reading it as PDF417 put the WIDTH where the rotation
                // belongs, so MPDF417 10,10,100,50,0,"DATA" came out rotated
                // 100 quadrants. The round trip did not catch it because the
                // generator wrote the same wrong shape back â€” two sides agreeing
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
                    // count", the same 0-4 domain as IPL's c19,m1 â€” and the IR
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
                // W and H override the positional width/height. Their ranges â€”
                // W is 2-9 and H is 4-99 â€” bound the OPTION only: the manual
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
                // PRINT copies[,sets] (manual p. 24) â€” a job concern, but the
                // viewer reads it so a preview can say how many labels.
                settings.quantity = Math.max(1, Math.trunc(num(p[0], 1)));
                break;
            }

            case 'MAXICODE': {
                // MAXICODE x,y,mode,[class,country,post,Lm,]"content" (TSC
                // manual p. 54). Modes 2 and 3 are Structured Carrier Messages:
                // the class, country and postal code are SEPARATE PARAMETERS
                // and the manual spells the postal code for mode 2 as
                // "06810,7317" â€” a comma inside the field, which the parameter
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
                //   c#  escape control char (how the DATA is escaped â€” NOT a
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
                // this reason â€” a command that changes WHERE the image lands.
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
                // not apply them â€” so if they move the image, the preview is
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
                // slot for it, and guessing would move every field â€” say so.
                once('direction', 'info', 'tspl-direction',
                    'DIRECTION rotates the whole label by 90Â°. This viewer draws the label as laid out, so the preview is turned compared with the print.', 'DIRECTION');
                break;

            case 'CODEPAGE': {
                // CODEPAGE n selects the international character set (manual
                // p. 17) â€” the same byte means a different glyph under each
                // (0xE4 is 'Ã¤' in Windows-1252, a box-drawing glyph in 437).
                // The viewer decodes high bytes as Latin-1, so it draws the
                // wrong character for any page other than a Latin-1-compatible
                // one â€” silent until now, because CODEPAGE sat in
                // PRINTER_SETTINGS with the sensor settings.
                const n = (p[0] ?? '').trim().toUpperCase();
                const latin1ish = n === '' || n === '1252' || n === '8859-1' || n === 'LATIN1' || n === 'LATIN 1';
                if (!latin1ish) {
                    once('codepage', 'info', 'tspl-codepage',
                        `CODEPAGE ${n} selects a character set this viewer does not apply; it decodes high bytes as Latin-1, so characters outside that set may differ from the print.`, 'CODEPAGE');
                }
                break;
            }

            case 'BITMAP': {
                // BITMAP x,y,width,height,mode,<bitmap data> (TSC manual p. 45):
                //   width  = image width IN BYTES  (so * 8 gives the dots)
                //   height = image height IN DOTS  (the row count)
                //   mode   = 0 OVERWRITE / 1 OR / 2 XOR â€” a compositing mode,
                //            which this viewer does not model; the ink is drawn.
                // The data is RAW BINARY, one byte per 8 dots, MSB (bit 7)
                // leftmost and top row first. The manual's own hex dump (p. 46)
                // is `00 00 00 00 00 07 FF 03 FF ...` and the 16 rows it lists
                // read left-to-right from the high bit â€” the exact shape the
                // renderer's `graphic` element already reads for ZPL's ^GF.
                //
                // This REPLACED a claim that was false: "the tokenizer reads
                // parameters, not binary tails, so the bitmap is not captured."
                // tokenizeTspl keeps the whole line up to the newline â€” the
                // binary tail never goes through the quote/comment logic the
                // message blamed â€” so the bytes were present all along and the
                // parser simply never read them (PUTBMP, below, is the one that
                // is genuinely a file name).
                const wBytes = Math.max(0, Math.trunc(num(p[2], 0)));
                const hDots = Math.max(0, Math.trunc(num(p[3], 0)));
                if (wBytes === 0 || hDots === 0) {
                    issue('info', 'tspl-bitmap-empty', 'BITMAP with no width or height draws nothing.', 'BITMAP');
                    break;
                }
                // The tail is read from the RAW line, not from splitParams:
                // splitParams cut the payload on every comma, and a bitmap byte
                // CAN be 0x2C â€” rejoining would be lossy for that byte and the
                // ';'/'"' handling would have mangled the run before we saw it.
                // The raw line holds the bytes exactly as sent. Skip the name
                // and the five parameters (the sixth comma field is the data).
                const afterName = cmd.raw.slice(cmd.raw.search(/\s/) + 1);
                let cut = -1;
                for (let c = 0; c < 5; c++) cut = afterName.indexOf(',', cut + 1);
                const tail = cut >= 0 ? afterName.slice(cut + 1) : '';
                const rows: string[] = [];
                for (let r = 0; r < hDots; r++) {
                    let row = '';
                    for (let b = 0; b < wBytes; b++) {
                        // A short tail pads with paper; charCodeAt past the end
                        // is NaN, and `NaN & 0xFF` is 0.
                        row += String.fromCharCode(tail.charCodeAt(r * wBytes + b) & 0xFF);
                    }
                    rows.push(row);
                }
                elements.push({
                    kind: 'graphic', id: nextId++, graphicId: nextId++,
                    ox: num(p[0], 0), oy: num(p[1], 0), f: 0,
                    widthDots: wBytes * 8, heightDots: hDots,
                    rows,
                } as ViewerElement);
                break;
            }

            default: {
                if (PRINTER_SETTINGS.has(cmd.name)) break;
                // Each of these says WHAT the command is and WHY it cannot be
                // drawn. A generic "not part of the supported subset" reads as
                // "this app chose not to", which was wrong for DMATRIX,
                // MAXICODE, RSS, AZTEC and CODABLOCK in turn â€” every one of
                // them turned out to be drawable. The remaining ones are
                // genuinely outside what a stream can express here.
                if (cmd.name === 'PUTBMP' || cmd.name === 'PUTPCX') {
                    issue('info', 'tspl-bitmap-unsupported',
                        `${cmd.name} tells the printer to load an image FILE by name from its own storage (manual pp. 61-63). The file is not in the stream, so there is nothing to draw.`, cmd.name);
                } else if (cmd.name === 'TLC39') {
                    issue('info', 'tspl-tlc39-unsupported',
                        'TLC39 is a composite symbol â€” Code 39 carrying a MicroPDF417 (manual p. 44) â€” and no encoder here produces that pairing, so it is not drawn.', 'TLC39');
                } else {
                    issue('info', 'tspl-unsupported', `${cmd.name} is not part of the supported TSPL subset, so it has no effect here.`, cmd.name);
                }
            }
        }
    }

    return { widthDots, heightDots, elements, issues, settings };
};
