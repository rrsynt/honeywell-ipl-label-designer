// EPL (Eltron Programming Language) -> the viewer IR.
//
// EPL2 is the line-based language of Zebra's EPL desktop printers and of the
// budget thermal printers (TSC, Argox, Godex) that copy it. Unlike ZPL it has
// no sigil: one command per LINE, plain ASCII, e.g.
//
//   N
//   A50,30,0,3,1,1,N,"Hello"
//   B60,60,0,3,2,2,60,B,"12345"
//   LO50,200,400,20
//   X20,240,4,140,300
//   P1
//
// Every table and parameter order below comes from the **EPL2 Programmer's
// Manual (Zebra P/N 980352-001 Rev. D)**, cross-checked against labelize's
// `src/parsers/epl_parser.rs`. That process mattered: a first pass written
// from memory had the barcode type letters completely wrong (`1`=Code 39,
// `3`=Code 128), which would have printed every barcode as the wrong
// symbology. When this file and the manual disagree, the manual wins.
//
// Like the ZPL parser this is a SUBSET that says what it cannot do. A command
// outside the subset becomes a ViewerIssue naming it, so a label that will not
// look right says so instead of quietly losing a field.

import type {
    BarcodeElement, BoxElement, LineElement, TextElement, ViewerElement, ViewerIssue, ViewerLabel,
} from '../ipl/types';
import { estimateElementSize } from '../ipl/renderer';

/**
 * EPL's resident fonts, in dots. Manual p. 3-4 (the `A` command's p4 table):
 *
 *   font  203 dpi    300 dpi
 *   1     8 x 12     12 x 20
 *   2     10 x 16    16 x 28
 *   3     12 x 20    20 x 36
 *   4     14 x 24    24 x 44
 *   5     32 x 48    48 x 80
 *   A-Z   reserved for soft fonts
 *
 * There is NO font 0, and "Fonts 1-5 are fixed pitch" (manual A-1) — which is
 * what decides the IR mapping below: a fixed cell with integer multipliers is
 * the IR's BITMAP path, not its outline path.
 */
export const EPL_FONT_SIZES: Record<number, { width: number; height: number }> = {
    1: { width: 8, height: 12 },
    2: { width: 10, height: 16 },
    3: { width: 12, height: 20 },
    4: { width: 14, height: 24 },
    5: { width: 32, height: 48 },
};

const FALLBACK_FONT = EPL_FONT_SIZES[1];

/** Documented horizontal multipliers (manual p. 3-4): 1,2,3,4,5,6,8. */
const H_MULTIPLIERS = new Set([1, 2, 3, 4, 5, 6, 8]);

/**
 * EPL barcode type (the `B` command's p4) -> the IR symbology the renderer
 * paints. Manual Table 2-1, p. 3-12.
 *
 * The IR ids are IPL's (`services/ipl/barcodes.ts`): '0' code39, '2'
 * interleaved2of5, '6' code128, '7' EAN/UPC with an `eanUpcVersion`
 * (1 ean8, 2 ean13, 3 upca, 4 upce). Reusing them means EPL barcodes paint
 * through the same encoder as every other language.
 */
interface EplBarcode {
    symbology: string;
    /** For '7' (EAN/UPC), which variant. */
    eanUpcVersion?: number;
    /** For '0' (Code 39), the c0 mode: 2 = check a digit the host supplied. */
    code39Mode?: string;
}

const EPL_BARCODE_TYPES: Record<string, EplBarcode> = {
    // Code 39 (manual p. 3-12). '3C' validates a check digit already in the data.
    '3': { symbology: '0', code39Mode: '0' },
    '3C': { symbology: '0', code39Mode: '2' },
    // Code 128: '1' is auto A/B/C, '1A'/'1B'/'1C' force a subset, '0' is
    // UCC/SSCC, '1E' is UCC/EAN 128. All paint as code128 here.
    '0': { symbology: '6' },
    '1': { symbology: '6' },
    '1A': { symbology: '6' },
    '1B': { symbology: '6' },
    '1C': { symbology: '6' },
    '1E': { symbology: '6' },
    // 2 of 5. '2C' is +mod10, '2D' is +human-readable check.
    '2': { symbology: '2' },
    '2C': { symbology: '2' },
    '2D': { symbology: '2' },
    // EAN/UPC, by the version the renderer already understands.
    'E30': { symbology: '7', eanUpcVersion: 2 },
    'E80': { symbology: '7', eanUpcVersion: 1 },
    'UA0': { symbology: '7', eanUpcVersion: 3 },
    'UE0': { symbology: '7', eanUpcVersion: 4 },
};

/**
 * Types EPL defines but this renderer cannot encode. Recognized so an issue
 * can NAME the symbology instead of saying "unknown type" — the difference
 * between a user knowing what is missing and having to look it up.
 */
const EPL_KNOWN_UNENCODED: Record<string, string> = {
    '9': 'Code 93',
    K: 'Codabar',
    P: 'POSTNET',
    PL: 'Planet',
    J: 'Japanese POSTNET',
    L: 'Plessey (MSI-1)',
    M: 'MSI-3',
    '2G': 'German Post Code',
    '2U': 'UPC Interleaved 2 of 5',
    E32: 'EAN-13 with a 2-digit add-on',
    E35: 'EAN-13 with a 5-digit add-on',
    E82: 'EAN-8 with a 2-digit add-on',
    E85: 'EAN-8 with a 5-digit add-on',
    UA2: 'UPC-A with a 2-digit add-on',
    UA5: 'UPC-A with a 5-digit add-on',
    UE2: 'UPC-E with a 2-digit add-on',
    UE5: 'UPC-E with a 5-digit add-on',
};

/**
 * Printer settings, jobs and hardware commands — not geometry.
 *
 * These are EXPECTED in a real EPL program. A printer acts on them, but they
 * put nothing on the label, so reporting them as "unsupported" would drown
 * the issues panel on every ordinary stream. They are listed so the panel
 * stays about things that actually changed what is drawn.
 */
const PRINTER_SETTINGS = new Set([
    'Q', 'q', 'S', 'D', 'P', 'PA', 'Z',             // size, speed, density, print
    // 'oW' used to be here. It is Customize Bar Code Parameters (manual
    // p. 3-82): p1..p5 are the narrow white, narrow black, wide white, wide
    // black and gap widths for EVERY bar code printed after it. It does not
    // touch a printer setting the preview can ignore — it changes the printed
    // bar widths, which is exactly what the preview draws. Reported now.
    'I', 'oR', 'oB', 'oE', 'oH', 'oM', 'O',   // code page, options
    'M', 'U', 'UA', 'UB', 'UE', 'UF', 'UG', 'UI', 'UM', 'UN', 'UP', 'UQ', 'US', 'U$', 'U%',
    'V', 'C', 'TD', 'TT', 'TS', 'r', 'JB', 'JF', 'FE', 'FS', 'FK', 'FR', 'EK',
    'GM', 'GI', 'W',
    // 'LD', 'H', 'K' and 'e' used to be here, and NONE of them is a command in
    // the EPL2 Programmer's Manual. Checked against the manual's own command
    // list: 'LD' appears nowhere at all, and 'H' and 'K' are only ever the
    // tails of 'oH' (Macro PDF Offset) and 'EK' (Delete Soft Font) — a
    // search for a definition finds those, not these. 'e' is not a command
    // either; 'eR' is (User Defined Error/Status Character, p. 3-42).
    //
    // EPL is CASE-SENSITIVE and the tokenizer takes names verbatim, so 'e' is
    // not 'eR' and never was — the same mistake the lowercase 'a' entry made,
    // in this same list. All four silenced an unrecognized command instead of
    // naming it; they now report like anything else.
    //
    // 'GG' used to be here. It is Print Graphics (manual p. 3-57) — it DRAWS a
    // PCX image, by name, from the printer's own memory — so it is not a
    // printer setting and silence was never right for it. The graphic is not in
    // the stream, so it still cannot be drawn; it is now named in the default
    // branch instead of vanishing.
    //
    // 'LE' used to be here. It is Line Draw Exclusive OR (manual p. 3-68) — a
    // DRAWING command that inverts every dot it crosses — so it belongs with
    // LO/LW/LS, not with the sensor and job settings this list exists for. In
    // here it produced no element and no issue, which is the one outcome this
    // parser is built to avoid: even an unsupported command names itself.
    // 'a' used to be here as `'A'.toLowerCase()`. EPL is CASE-SENSITIVE — the
    // tokenizer takes the command name verbatim (`/^([A-Za-z$%]+)/`) and the
    // switch matches 'A' for text — so 'a' is not the text command and never
    // was: it is an unrecognized command that got silenced instead of named.
    // A lowercase 'a' line now reports like any other unknown command.
]);

export interface EplParseResult {
    label: ViewerLabel;
}

/** One parsed line: its command, its parameters, and its data field. */
interface EplCommand {
    name: string;
    /** The comma-separated parameters, as written. */
    params: string;
    /** The literal text from the quoted part of the data field, if any. */
    data: string | null;
    /** Variable/counter/date tokens found in the data field (V01, C2, TT, TD). */
    tokens: string[];
    /** The whole line as written, for issues that quote what they skipped. */
    raw: string;
}

/**
 * Resolve EPL's escapes.
 *
 * Manual p. 3-5: "Quotes (ASCII 34d) and backslashes (ASCII 92d) must be
 * uniquely handled. The backslash (\) character designates the following
 * character is a literal". So `\"` prints a quote and `\\` prints one
 * backslash — NOT the doubled-quote rule ZPL and TSPL use. Getting this wrong
 * mangles every label whose data contains either character.
 */
export const unescapeEpl = (s: string): string => s.replace(/\\(.)/g, '$1');

/**
 * Split EPL source into commands, one per non-empty line.
 *
 * The parameters are everything BEFORE the first quote and the payload is
 * everything after it, so a comma inside the data cannot split a parameter.
 * That is the single most likely EPL tokenizer bug: the manual's own example
 * `A674,033,1,1,1,1,N,"UNIT 7, SAMPLE PARK, EXAMPLE LANE"` has commas in the
 * address that are data, not separators.
 *
 * A data field may also carry NO quotes at all — the manual substitutes
 * variables, counters and the clock directly (`A50,50,0,2,1,1,N,V01`,
 * `...,C1+2`, `...,TT`, `...,TD`), and may even mix them with literal text
 * (`"Deluxe"V01C2"Combo"TDV01TT`). Those tokens are collected rather than
 * guessed at.
 */
export const tokenizeEpl = (source: string): EplCommand[] => {
    const out: EplCommand[] = [];
    for (const rawLine of String(source ?? '').split(/\r?\n/)) {
        const line = rawLine.replace(/\r$/, '').trim();
        if (line === '') continue;

        // The first UNESCAPED quote starts the payload. Scanning rather than
        // using indexOf matters: `A10,10,0,2,1,1,N,"a\"b,c"` would otherwise
        // treat the escaped quote as the payload's start.
        let payloadStart = -1;
        for (let i = 0; i < line.length; i++) {
            if (line[i] === '\\') { i++; continue; }
            if (line[i] === '"') { payloadStart = i; break; }
        }

        const head = (payloadStart < 0 ? line : line.slice(0, payloadStart)).trim();
        // Command names are LETTERS only. Letting them swallow digits read
        // `A10,10,...` as a command called "A10" and dropped every field;
        // digits belong to parameters (`P1`, `LO20,200,...`), and `E30`/`UA0`
        // are barcode TYPES inside a parameter, never command names.
        const match = /^([A-Za-z$%]+)\s*(.*)$/.exec(head);
        if (!match) {
            out.push({ name: '', params: '', data: null, tokens: [], raw: line });
            continue;
        }

        // The field after the parameters. When the line has no quote at all,
        // this is a token expression; when it does, it is the quoted payload
        // (and possibly tokens after it, per the manual's combined example).
        const field = payloadStart < 0 ? '' : line.slice(payloadStart);
        const quotes = [...field.matchAll(/"((?:\\.|[^"\\])*)"/g)].map(m => unescapeEpl(m[1]));
        const withoutQuotes = field.replace(/"(?:\\.|[^"\\])*"/g, ' ');
        const tokens = [...withoutQuotes.matchAll(/\b(V\d{2}|C\d(?:\+\d+)?|TT|TD)\b/g)].map(m => m[1]);
        // With no quote at all the whole field is the token expression; the
        // `head` split above already removed it, so re-read it from the line.
        const bareField = payloadStart < 0 ? (match[2] ?? '').trim() : '';
        const bareTokens = bareField === '' ? [] : [...bareField.matchAll(/(V\d{2}|C\d(?:\+\d+)?|TT|TD)/g)].map(m => m[1]);

        out.push({
            name: match[1],
            params: match[2].replace(/,\s*$/, '').trim(),
            data: quotes.length > 0 ? quotes.join('') : null,
            tokens: [...tokens, ...bareTokens],
            raw: line,
        });
    }
    return out;
};

const num = (s: string | undefined, fallback: number): number => {
    if (s === undefined || s.trim() === '') return fallback;
    const n = Number(s.trim());
    return Number.isFinite(n) ? n : fallback;
};

/**
 * EPL's rotation is 0/1/2/3 for 0/90/180/270 degrees (manual p. 3-4). The
 * manual never states the SENSE, and the IR's `f` is IPL's quadrant, which is
 * CCW. The value is carried across unchanged as the working assumption.
 *
 * NOT PROVEN. If a printer sweep ever shows EPL turning clockwise where IPL's
 * f1 turns counter-clockwise, the fix is `f = rot % 2 === 0 ? rot : 4 - rot`
 * here and the identical inverse in the generator. Writing a comment claiming
 * EPL is CCW would be a claim without evidence.
 */
const rotation = (s: string | undefined): number => {
    const n = num(s, 0);
    return n >= 0 && n <= 3 ? Math.trunc(n) : 0;
};

export const parseEPL = (code: string): ViewerLabel => {
    const issues: ViewerIssue[] = [];
    const elements: ViewerElement[] = [];
    let nextId = 1;

    const issue = (level: ViewerIssue['level'], code_: string, message: string, command?: string) =>
        issues.push({ level, code: code_, message, command });

    // R sets a reference point that offsets EVERY element that follows it
    // (manual p. 3-96). It is not a geometry command, so a parser that ignores
    // it draws the whole label shifted.
    let refX = 0;
    let refY = 0;

    // Label size in dots: `q` is the width and `Q` the length (manual pp. 3-89,
    // 3-91). Both are needed to state a size — a stream that gives only one is
    // reported as having none, so the viewer falls back to the content bounds
    // rather than drawing a page half of which is invented.
    //
    // This is what makes an EPL landscape label come out as paper instead of a
    // strip of its own ink: 4x2 in at 203 dpi is q812/Q406, and without these
    // the page measured 91x21 mm — the ink bbox.
    //
    // `R` does NOT clear them. The manual's note that the reference point
    // "cancels a previously set width" describes how the head is positioned,
    // not this value; treating it as a reset would drop the size of every
    // stream that sets a reference point, which most do.
    let qWidthDots: number | null = null;
    let qLengthDots: number | null = null;

    // Job settings the viewer reads back, matching what the TSPL parser
    // does with PRINT and what <RS>/<US> carry in IPL.
    const settings: ViewerLabel['settings'] = {};
    // Font and soft-font notes repeat on every field of a large label; the
    // issue list is for the user, so each distinct note is said once.
    const saidOnce = new Set<string>();
    const once = (key: string, level: ViewerIssue['level'], code_: string, message: string, command?: string) => {
        if (saidOnce.has(key)) return;
        saidOnce.add(key);
        issue(level, code_, message, command);
    };

    /** IR anchor for a field whose visual top-left is (x, y). Mirrors the ZPL
     *  parser: the renderer measures the size, so the anchor is derived from
     *  its measurement rather than from an estimate of our own. */
    const anchor = (x: number, y: number, f: number, length: number, cross: number): { ox: number; oy: number } => {
        switch (f) {
            case 1: return { ox: x, oy: y + length };
            case 2: return { ox: x + length, oy: y + cross };
            case 3: return { ox: x + cross, oy: y };
            default: return { ox: x, oy: y };
        }
    };

    const place = <T extends ViewerElement>(el: T): T => {
        const sz = estimateElementSize(el, 203);
        Object.assign(el, anchor(el.ox, el.oy, el.f, sz.lengthDots, sz.crossDots));
        return el;
    };

    /**
     * The data a field prints, plus whether it was a variable rather than
     * literal text.
     *
     * A field that is ONLY a token (`V01`, `TT`) has no value here — the
     * printer fills it at print time. Reporting it as an empty variable is the
     * honest answer; inventing a value would put a wrong string on the label.
     * A field mixing text and tokens keeps the text and names the tokens.
     */
    const fieldContent = (cmd: EplCommand): { text: string; isVariable: boolean } => {
        if (cmd.tokens.length === 0) return { text: cmd.data ?? '', isVariable: false };
        once(`tokens-${cmd.tokens.join(',')}`.slice(0, 40), 'info', 'epl-variable-token',
            `${cmd.tokens.join(', ')} is filled in by the printer at print time${cmd.tokens.some(t => t === 'TT' || t === 'TD') ? ' from its clock' : ''}, so the value shown here is a placeholder.`,
            cmd.name);
        return { text: cmd.data ?? '', isVariable: true };
    };

    for (const cmd of tokenizeEpl(code)) {
        const p = cmd.params === '' ? [] : cmd.params.split(',').map(s => s.trim());
        if (cmd.name === '') {
            issue('warning', 'epl-unreadable', `"${cmd.raw}" is not a command this parser recognizes. It has no effect here.`);
            continue;
        }

        switch (cmd.name) {
            case 'N':
                // Clear image buffer (manual p. 3-73) — starts a form. Nothing
                // has accumulated mid-parse, but the reference point it resets
                // does matter.
                refX = 0;
                refY = 0;
                break;

            case 'R': {
                if (p.length < 2) { issue('warning', 'epl-bad-reference', 'R needs x,y. Ignored.', 'R'); break; }
                refX = num(p[0], 0);
                refY = num(p[1], 0);
                break;
            }

            case 'A': {
                // A p1,p2,p3,p4,p5,p6,p7,"data" — manual p. 3-4
                if (p.length < 7) {
                    issue('warning', 'epl-a-params', `A needs x,y,rotation,font,hMul,wMul,reverse. Found ${p.length}. Skipped.`, 'A');
                    break;
                }
                const content = fieldContent(cmd);
                if (content.text === '' && cmd.tokens.length === 0) break; // prints nothing, by design

                // p4 is 1-5 or a letter for a soft font (manual p. 3-4).
                const rawFont = (p[3] ?? '1').trim();
                const fontNum = Math.trunc(Number(rawFont));
                const isSoftFont = /^[A-Za-z]$/.test(rawFont);
                if (isSoftFont) {
                    once('soft-font', 'warning', 'epl-soft-font',
                        `Font "${rawFont}" is a soft font downloaded to the printer. It is not available here, so the text is drawn with resident font 1.`, 'A');
                } else if (!EPL_FONT_SIZES[fontNum]) {
                    once('bad-font', 'warning', 'epl-font-unknown',
                        `Font "${rawFont}" is not a resident EPL font (1-5). Drawn with font 1.`, 'A');
                }
                const size = EPL_FONT_SIZES[fontNum] ?? FALLBACK_FONT;

                // p5 is the HORIZONTAL multiplier and p6 the VERTICAL one
                // (manual p. 3-4). Reading them the other way round applied a
                // horizontal stretch to the height: measured, A10,10,0,1,4,1,N
                // ("wide") came out 51x24 dots — taller, not wider — while
                // A10,10,0,1,1,4 ("tall") did not change the width at all.
                const wMul = Math.max(1, Math.trunc(num(p[4], 1)));
                const hMul = Math.max(1, Math.trunc(num(p[5], 1)));
                if (!H_MULTIPLIERS.has(wMul)) {
                    once('h-mult', 'info', 'epl-h-multiplier',
                        `Horizontal multiplier ${wMul} is outside the documented values (1,2,3,4,5,6,8). It is used as given.`, 'A');
                }
                const f = rotation(p[2]);
                // The IR font is chosen so the RENDERER measures the same cell
                // EPL describes — the anchor of a rotated or multi-line field is
                // derived from that measurement (estimateElementSize). EPL's
                // fixed cells map onto IPL's bitmap cells by height:
                // 1→c0 (9 dots), 2→c1 (11), 3/4/5→c2 (14) with a multiplier
                // making up the rest. The outline path is NOT used: EPL's fonts
                // are "fixed pitch" (manual A-1), so modelling them as scalable
                // would size the text wrongly.
                const cell: Record<number, { font: string; hMag: number; wMag: number }> = {
                    1: { font: '0', hMag: 1, wMag: 1 },
                    2: { font: '1', hMag: 1, wMag: 1 },
                    3: { font: '2', hMag: 1, wMag: 1 },
                    4: { font: '2', hMag: 2, wMag: 1 },
                    5: { font: '2', hMag: 3, wMag: 3 },
                };
                const face = cell[fontNum] ?? cell[1];
                const el: TextElement = {
                    kind: 'text', id: nextId++,
                    ox: num(p[0], 0) + refX, oy: num(p[1], 0) + refY, f,
                    font: face.font,
                    hMag: hMul * face.hMag, wMag: wMul * face.wMag,
                    pointSize: Math.max(1, Math.round(size.height * hMul * 72 / 203)),
                    source: content.isVariable ? { type: 'variable', data: content.text } : { type: 'fixed', data: content.text },
                };
                // p7 is the reverse flag: 'R' prints the text white on a black
                // background. Nothing in this renderer READS ElementBase.reverse
                // — the flag was set here and then ignored, so the label drew as
                // ordinary black text with no word about it. Reported instead,
                // because the difference is ink the printer lays down and this
                // preview does not.
                if ((p[6] ?? '').toUpperCase() === 'R') {
                    issue('info', 'epl-reverse-text',
                        `A field with the reverse flag (p7=R) prints white text on a black background; this preview draws it as ordinary black text.`,
                        'A');
                }
                elements.push(place(el));
                break;
            }

            case 'B': {
                // B p1,p2,p3,p4,p5,p6,p7,p8,"data" — manual p. 3-11
                if (p.length < 8) {
                    issue('warning', 'epl-b-params', `B needs x,y,rotation,type,narrow,wide,height,hri. Found ${p.length}. Skipped.`, 'B');
                    break;
                }
                const type = (p[3] ?? '').toUpperCase();
                const content = fieldContent(cmd);
                const f = rotation(p[2]);
                const heightDots = Math.max(1, Math.trunc(num(p[6], 1)));
                const narrow = Math.max(1, Math.trunc(num(p[4], 1)));
                const wide = Math.max(1, Math.trunc(num(p[5], 1)));
                // EPL's p8 is `B` (human-readable line BELOW the bar code) or
                // `N`. There is no "above" — unlike IPL's 0/1/2.
                const hri: 0 | 1 = (p[7] ?? '').toUpperCase() === 'B' ? 1 : 0;

                const mapped = EPL_BARCODE_TYPES[type];
                if (!mapped) {
                    const named = EPL_KNOWN_UNENCODED[type];
                    issue('info', 'epl-barcode-unencoded',
                        named
                            ? `Barcode type "${type}" is ${named}, which this viewer has no encoder for. Nothing is drawn for it.`
                            : `Barcode type "${type}" is not one this viewer knows. Nothing is drawn for it.`,
                        'B');
                    break;
                }
                if (content.text === '' && cmd.tokens.length === 0) {
                    issue('warning', 'epl-barcode-empty', 'A barcode with no data prints nothing.', 'B');
                    break;
                }
                // EPL gives wide:narrow as module counts; the IR wants a code.
                const ratio = wide / narrow <= 2.2 ? 2 : wide / narrow < 2.8 ? 0 : 1;
                const el: BarcodeElement = {
                    kind: 'barcode', id: nextId++,
                    ox: num(p[0], 0) + refX, oy: num(p[1], 0) + refY, f,
                    symbology: mapped.symbology,
                    heightDots, moduleDots: narrow, ratio, hri,
                    source: content.isVariable ? { type: 'variable', data: content.text } : { type: 'fixed', data: content.text },
                    ...(mapped.eanUpcVersion !== undefined ? { eanUpcVersion: mapped.eanUpcVersion } : {}),
                    ...(mapped.code39Mode !== undefined ? { code39Mode: mapped.code39Mode } : {}),
                };
                elements.push(place(el));
                break;
            }

            case 'LO':
            case 'LW': {
                // LO p1,p2,p3,p4 — manual p. 3-69: x, y, HORIZONTAL LENGTH,
                // VERTICAL LENGTH. One parameter is normally 0, which is what
                // makes it a line rather than a filled rectangle.
                if (p.length < 4) {
                    issue('warning', 'epl-lo-params', `${cmd.name} needs x,y,horizontal,vertical. Found ${p.length}. Skipped.`, cmd.name);
                    break;
                }
                const w = Math.max(0, Math.trunc(num(p[2], 0)));
                const h = Math.max(0, Math.trunc(num(p[3], 0)));
                if (w > 0 && h > 0) {
                    // Both non-zero is a filled rectangle, which the IR's line
                    // element cannot express. Drawn as its longer run, and said.
                    issue('info', 'epl-lo-rectangle',
                        `${cmd.name} has both a horizontal and a vertical length, which draws a filled rectangle. Drawn as a line here.`, cmd.name);
                }
                const length = Math.max(1, Math.max(w, h));
                const thickness = Math.max(1, Math.min(w || h, h || w));
                const el: LineElement = {
                    kind: 'line', id: nextId++,
                    ox: num(p[0], 0) + refX, oy: num(p[1], 0) + refY,
                    // A vertical run is the horizontal one turned a quadrant.
                    f: w >= h ? 0 : 1,
                    lengthDots: length, thicknessDots: thickness,
                    // LW is the WHITE line (manual p. 3-71): it ERASES the ink
                    // under it. The renderer paints it white, which is the
                    // whole effect — the label is white to begin with and
                    // elements are drawn in order.
                    ...(cmd.name === 'LW' ? { white: true } : {}),
                };
                elements.push(place(el));
                break;
            }

            case 'X': {
                // X p1,p2,p3,p4,p5 — manual p. 3-120: X start, Y start, line
                // thickness, X end, Y end. A BOX between two corners, so the
                // corner order does not matter.
                if (p.length < 5) {
                    issue('warning', 'epl-x-params', `X needs x1,y1,thickness,x2,y2. Found ${p.length}. Skipped.`, 'X');
                    break;
                }
                const x1 = num(p[0], 0);
                const y1 = num(p[1], 0);
                const t = Math.max(1, Math.trunc(num(p[2], 1)));
                const x2 = num(p[3], x1);
                const y2 = num(p[4], y1);
                const el: BoxElement = {
                    kind: 'box', id: nextId++,
                    ox: Math.min(x1, x2) + refX, oy: Math.min(y1, y2) + refY, f: 0,
                    widthDots: Math.max(1, Math.abs(x2 - x1)),
                    heightDots: Math.max(1, Math.abs(y2 - y1)),
                    thicknessDots: t,
                };
                elements.push(place(el));
                break;
            }

            case 'b': {
                // b p1,p2,p3,[,p4][,p5][,p6][,p7],"DATA" — the 2D bar code
                // (manual p. 3-20/3-25/3-29). p3 is a LETTER naming the
                // symbology, and the optional parameters after it carry their
                // own prefix letter (c columns, r rows, h module size, v
                // inverse) rather than being positional.
                //
                // EPL2 has Data Matrix, MaxiCode and PDF417 — and NO QR CODE.
                // A QR design therefore has no EPL representation at all, which
                // the generator reports rather than silently dropping.
                if (p.length < 3) {
                    issue('warning', 'epl-b-params', `b needs x,y,type. Found ${p.length}. Skipped.`, 'b');
                    break;
                }
                const kind = (p[2] ?? '').trim().toUpperCase();
                const data = cmd.data ?? '';
                if (data === '') {
                    issue('warning', 'epl-2d-empty', 'A 2D bar code with no data prints nothing.', 'b');
                    break;
                }
                const map: Record<string, { symbology: string; note?: string }> = {
                    D: { symbology: '17' },   // Data Matrix
                    M: { symbology: '14' },   // MaxiCode
                    P: { symbology: '12' },   // PDF417
                };
                const found = map[kind];
                if (!found) {
                    issue('info', 'epl-2d-unsupported',
                        `EPL 2D type "${kind}" is not one this viewer knows. EPL2 defines D (Data Matrix), M (MaxiCode) and P (PDF417); there is no QR code in the language at all. Nothing is drawn for it.`, 'b');
                    break;
                }
                // The optional parameters after the type letter carry their own
                // prefix — EXCEPT for PDF417, which the manual gives a
                // positional tail: "p3 = P ... p4 (www) = maximum print width in
                // dots, p5 (hhh) = maximum print height in dots", then the
                // prefixed p6 (s = error correction) and p7 (c = compression).
                // Reading p4 as a prefixed option never matched, so a PDF417's
                // stated width and height were dropped, and the symbol came out
                // at the h-prefix default instead.
                const opt = (letter: string): string | undefined => {
                    const hit = p.find(v => v.trim().toUpperCase().startsWith(letter.toUpperCase()));
                    return hit ? hit.trim().slice(1) : undefined;
                };
                // MaxiCode's mode is POSITIONAL too — the manual gives
                // "bp1,p2,p3,[p4,]" with "p4 = Mode Selection: M2 Mode 2,
                // M3 Mode 3, m4 Mode 4, m6 Mode 6", and automatic selection
                // when p4 is omitted. The mixed case is the manual's own.
                //
                // Reading it as a prefixed option found nothing: measured, all
                // four documented forms — M2, M3, m4, m6 — and the prefixed
                // form alike produced an empty mode, so every MaxiCode came out
                // with automatic selection whatever the stream asked for.
                // Data Matrix options, manual p. 3-20: "p4 (c) = number of
                // columns to encode, p5 (r) = number of rows, p6 (h) = the
                // minimum square data module size (1-40, default 5), p7 (v) =
                // selects an INVERSE image of the bar code". "Order is not
                // important for parameters p4-p7", so each is found by its
                // prefix rather than its position.
                const dmCols = kind === 'D' ? opt('c') : undefined;
                const dmRows = kind === 'D' ? opt('r') : undefined;
                const dmInverse = kind === 'D' && opt('v') !== undefined
                    && !/^0+$/.test(opt('v')!.trim());
                const p4Raw = (p[3] ?? '').trim();
                let maxiMode: string | undefined;
                if (kind === 'M' && /^[Mm][2346]$/.test(p4Raw)) {
                    maxiMode = p4Raw.slice(1);
                }
                // A mode written anywhere other than the positional p4 is not
                // the manual's form, but it is what a stream is likely to carry
                // if someone read the PDF417 section by mistake — so it is
                // named rather than silently ignored.
                if (kind === 'M' && maxiMode === undefined) {
                    const stray = p.slice(3).find(v => /^[Mm][2346]$/.test(v.trim()));
                    if (stray !== undefined) {
                        issue('warning', 'epl-maxicode-mode-position',
                            `MaxiCode mode is written as "${stray.trim()}", but the manual puts it in the POSITIONAL p4: b x,y,M,M2,"DATA". The symbol is drawn with automatic selection.`, 'b');
                    }
                }
                const isPdf = kind === 'P';
                // p4 (www) and p5 (hhh) are MAXIMUM print width and height in
                // DOTS. Neither is the IR's pdfColumns, which counts the
                // symbol's data columns — putting a dot count there would tell
                // the encoder to lay out that many columns. Only the height
                // maps onto the IR directly; the width is a ceiling the encoder
                // sizes within, so it is reported rather than stored.
                const maxWidth = isPdf ? Math.max(1, Math.trunc(num(p[3], 0))) : 0;
                const maxHeight = isPdf ? Math.max(1, Math.trunc(num(p[4], 0))) : 0;
                if (isPdf && maxWidth > 1) {
                    issue('info', 'epl-pdf417-max-width',
                        `PDF417 maximum print width is ${maxWidth} dots; this preview sizes the symbol from its data and does not cap it.`, 'b');
                }
                // The module size still comes from the h prefix where a stream
                // uses one (Data Matrix and MaxiCode both do); for PDF417 the
                // box states the extent and a nominal module keeps the anchor
                // sane, which is what this preview measures matrices from.
                const moduleSize = Math.max(1, Math.trunc(num(opt('h'), 5)));
                const el: BarcodeElement = {
                    kind: 'barcode', id: nextId++,
                    ox: num(p[0], 0) + refX, oy: num(p[1], 0) + refY, f: 0,
                    symbology: found.symbology,
                    // 2D symbols are measured from their module size, not a bar
                    // height; a nominal extent keeps the anchor sane.
                    heightDots: isPdf && maxHeight > 1 ? maxHeight : moduleSize * 21,
                    moduleDots: moduleSize,
                    ratio: 1,
                    hri: 0,
                    source: { type: 'fixed', data },
                    ...(maxiMode !== undefined ? { maxiMode } : {}),
                    ...(dmCols !== undefined ? { dmCols } : {}),
                    ...(dmRows !== undefined ? { dmRows } : {}),
                    ...(dmInverse ? { inverse: true } : {}),
                };
                if (dmInverse) {
                    // The manual's own words: "Selects an inverse image of the
                    // bar code (sometimes known as reverse video or a negative
                    // image)." It was dropped SILENTLY, so an inverted Data
                    // Matrix previewed as ordinary black-on-white with nothing
                    // said — the message is the fix, not the rendering.
                    //
                    // The renderer paints dark modules on a white sheet and has
                    // no inversion path; an attempt to add one by rasterising
                    // offscreen and flipping the pixels did not change the drawn
                    // ink when measured (ratio 0.311 -> 0.308), so it was
                    // reverted rather than left in looking implemented.
                    issue('info', 'epl-dm-inverse',
                        'Data Matrix v selects an INVERSE image (white on black); this preview draws it black on white.', 'b');
                }
                if (kind === 'M' && maxiMode === undefined) {
                    // Manual: "If p4 (Mx) is not used, the printer will use the
                    // following rules to automatically format the DATA ... all
                    // numeric -> Mode 2, alpha -> Mode 3", which is what the
                    // encoder does when no mode is given. Nothing to say.
                }
                if (kind === 'M' && maxiMode !== undefined) {
                    // The four documented values are the whole set; anything
                    // else is not a mode, and saying so beats passing it to an
                    // encoder that would reject or misread it.
                    if (!['2', '3', '4', '6'].includes(maxiMode)) {
                        issue('warning', 'epl-maxicode-mode',
                            `MaxiCode mode "${p4Raw}" is not one of the documented selections (M2, M3, m4, m6); the symbol is drawn with automatic selection.`, 'b');
                        delete el.maxiMode;
                    }
                }
                if (isPdf && (opt('s') !== undefined || opt('c') !== undefined)) {
                    // s = error correction level 1-8, c = data compression 0/1.
                    // The encoder takes an EC level; the compression mode has no
                    // slot, so it is named rather than dropped.
                    if (opt('s') !== undefined) el.pdfEcLevel = opt('s');
                    if (opt('c') !== undefined) {
                        issue('info', 'epl-pdf417-compression',
                            `PDF417 data compression c${opt('c')} is not reproduced; the encoder chooses its own compaction.`, 'b');
                    }
                }
                elements.push(place(el));
                break;
            }

            case 'P': {
                // Print (manual p. 3-87): P1 prints one copy, Pn n copies.
                // The EPL GENERATOR already emits this line for the design's
                // quantity, so a stream this app produced carries the copy
                // count — and the parser returned no settings at all, so it
                // read back as a single label and the viewer's batch controls
                // stayed hidden for a job that really prints several.
                settings.quantity = Math.max(1, Math.trunc(num(cmd.params.split(',')[0], 1)));
                break;
            }

            case 'q':
                // Set Label Width (manual p. 3-89): the width of the label in
                // dots, across the printhead.
                qWidthDots = Math.max(1, Math.trunc(num(cmd.params.split(',')[0], 0)));
                break;

            case 'Q':
                // Set Label Length (manual p. 3-91): the length in dots along
                // the feed, with the gap as its second parameter.
                qLengthDots = Math.max(1, Math.trunc(num(cmd.params.split(',')[0], 0)));
                break;

            case 'oW': {
                // oW p1,p2,p3,p4,p5 — Customize Bar Code Parameters (manual
                // p. 3-82). The manual's own words: it "allows the advanced
                // programmer to modify specific bar code parameters to exceed
                // the specified bar code's design tolerances, i.e. reduce the
                // bar code size", and warns that doing so "may cause bar codes
                // to become unreadable by some or all bar code scanners".
                //
                //   p1 initial width, narrow WHITE bar   (default 2)
                //   p2 initial width, narrow BLACK bar   (default 2)
                //   p3 initial width, WIDE white bar     (default 4)
                //   p4 initial width, WIDE black bar     (default 4)
                //   p5 initial bar code GAP              (default 3)
                //
                // It is a global printer command — it "cannot be issued inside
                // a form" — and it applies to every bar code printed after it.
                // The preview builds each symbol from the field's own narrow
                // module and wide:narrow ratio, so it draws the DESIGN's bar
                // widths and not these. That is a real divergence for any
                // stream that sets values other than the defaults, which is
                // the only reason to use the command at all.
                //
                // Reported as a warning rather than the generic info: the bar
                // widths on the label differ from the ones the printer would
                // lay down, and for these parameters that is the difference
                // between a scan and a failed read.
                const DEF = [2, 2, 4, 4, 3];
                const asked = DEF.map((d, k) => Math.trunc(num(p[k], d)));
                if (asked.every((v, k) => v === DEF[k])) break;  // defaults: nothing to say
                const label = ['narrow white', 'narrow black', 'wide white', 'wide black', 'gap'];
                issue('warning', 'epl-ow-bar-widths',
                    `oW sets the bar widths to ${asked.join(',')} (${label.map((n, k) => `${n} ${asked[k]}`).join(', ')}); the manual's defaults are ${DEF.join(',')}. This preview draws each symbol from its own module and ratio, so the printed bars will differ in width.`,
                    'oW');
                break;
            }

            case 'LE': {
                // LE p1,p2,p3,p4 — Line Draw Exclusive OR (manual p. 3-68):
                // "Any area, line, image or field that this line intersects or
                // overlays will have the image reversed or inverted ... all
                // black will be reversed to white and all white will be
                // reversed to black within the line's area". It is a DRAWING
                // command that erases and inverts, and it sat in
                // PRINTER_SETTINGS — the list meant for sensor and job
                // settings — so it produced no element AND no issue: the worst
                // case this parser has, since even an unsupported command names
                // itself. Reported as a warning rather than the generic info,
                // because unlike LS or GW the label is visibly wrong, not
                // merely missing a feature.
                if (p.length < 4) {
                    issue('warning', 'epl-le-params', `LE needs x,y,horizontal,vertical. Found ${p.length}. Skipped.`, 'LE');
                    break;
                }
                const w = Math.max(0, Math.trunc(num(p[2], 0)));
                const h = Math.max(0, Math.trunc(num(p[3], 0)));
                issue('warning', 'epl-le-invert',
                    `LE inverts every dot it crosses — black to white and white to black — over a ${w}x${h} dot area at ${num(p[0], 0)},${num(p[1], 0)}. This preview has no way to invert what is already drawn, so nothing is drawn for it.`, 'LE');
                break;
            }

            default: {
                if (PRINTER_SETTINGS.has(cmd.name)) break;
                // Everything else is a real EPL command this subset does not
                // draw. Naming it is the difference between "not supported" and
                // a field silently missing from the label.
                if (cmd.name === 'LS') {
                    issue('info', 'epl-ls-unsupported', 'Diagonal lines (LS) are not part of this viewer yet.', 'LS');
                } else if (cmd.name === 'GW') {
                    issue('info', 'epl-gw-unsupported', 'Binary graphics (GW) are not part of this viewer yet.', 'GW');
                } else if (cmd.name === 'GG') {
                    // GG is Print Graphics (manual p. 3-57): it prints a PCX
                    // image by NAME from the printer's own memory. It draws, so
                    // it must not be silent — but it cannot be drawn here either,
                    // because the graphic lives in the printer and the stream
                    // carries only the name. Named at 'info' rather than
                    // 'warning': nothing the user typed is wrong, the image is
                    // simply elsewhere, and the message says where it looks.
                    const stored = /"([^"]*)"/.exec(cmd.raw);
                    issue('info', 'epl-gg-stored-graphic',
                        stored
                            ? `GG prints the stored graphic "${stored[1]}", which lives in the printer's memory and is not part of this stream, so nothing is drawn for it.`
                            : `GG prints a graphic stored in the printer, which is not part of this stream, so nothing is drawn for it.`, 'GG');
                } else {
                    issue('info', 'epl-unsupported', `${cmd.name} is not part of the supported EPL subset, so it has no effect here.`, cmd.name);
                }
            }
        }
    }

    // Both or neither: a lone q or Q is half a page, and half a page is worse
    // than none — the viewer's own fallback (size from content) is honest about
    // what it does not know.
    const sized = qWidthDots !== null && qLengthDots !== null;
    return {
        widthDots: sized ? qWidthDots : null,
        heightDots: sized ? qLengthDots : null,
        elements, issues, settings,
    };
};
