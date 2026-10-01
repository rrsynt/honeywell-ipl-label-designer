// ZPL -> the neutral viewer IR (services/ipl/types.ts).
//
// Fase 5. The IR already renders IPL; this fills the SAME elements from ZPL so
// the renderer does not grow a second paint path. Scope is deliberately the six
// families the plan names: ^A text, ^B3/^BC/^BX/^BQ barcodes, ^GB box/line,
// ^FO position, ^PW/^LL size, ^FD data. Anything else is recorded as an issue
// and never dropped silently — the same contract the IPL viewer keeps.
//
// ZPL facts this relies on (Zebra ZPL II Programming Guide):
//  - A label is ^XA ... ^XZ. Commands start with ^ or ~; a parameterless command
//    is exactly two letters, otherwise parameters run to the next ^ or ~.
//  - ^FD reads until ^FS, and ^ / ~ inside it are data, not commands. The only
//    escapes are \^ \\ \& (newline) \~ and the hex form \_xx.
//  - ^FO is the field ORIGIN: the top-left of the field AFTER its rotation, so
//    a rotated field's stored origin differs from IPL's anchor. The IR stores
//    the IPL anchor (see types.ts ElementBase), and elementVisualBox derives the
//    top-left back from it — so this parser converts one into the other.
//  - ^A0 is font 0, the printer's scalable font. Its height/width are in dots.

import type { ViewerLabel, ViewerElement, TextElement, BarcodeElement, LineElement, BoxElement, ViewerIssue, EllipseElement, DiagonalElement } from '../ipl/types';
import { estimateElementSize, elementVisualBox } from '../ipl/renderer';

const ROT: Record<string, number> = { N: 0, R: 1, I: 2, B: 3 };

/** ^FD payload -> plain text. \& is a newline, \_xx a byte, \^ \\ \~ literals. */
export const unescapeFd = (raw: string): string =>
    raw.replace(/\\([\\^&~])|\\_([0-9a-fA-F]{2})/g, (m, esc: string, hex: string) => {
        if (hex) return String.fromCharCode(parseInt(hex, 16));
        return esc === '&' ? '\n' : esc;
    });

interface ZplCommand { name: string; params: string; }

/**
 * Index of the next command caret, or the string length. Parameters run up to
 * but not through it: the caret belongs to the next command, and consuming it
 * makes the scan miss `^FS` entirely.
 */
const nextCommandAt = (src: string, from: number): number => {
    for (let k = from; k < src.length; k++) if (src[k] === '^' || src[k] === '~') return k;
    return src.length;
};

/**
 * Splits one label into commands. ^FD is special: it consumes everything up to
 * its ^FS, escapes included, because ^ inside field data is not a command.
 */
const tokenize = (src: string): ZplCommand[] => {
    const out: ZplCommand[] = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c !== '^' && c !== '~') { i++; continue; }
        // Font (^A0) and barcode (^B3) commands carry a trailing digit that is
        // part of the NAME. Every other command is exactly two letters — letting
        // the digit rule apply to them turned ^PW800 into a command named PW8.
        const head = src.slice(i + 1);
        // ^A takes a digit ONLY when no orientation letter follows (^A0N, ^A@).
        // ^AB and ^AE are bitmap fonts with no digit; treating every ^A as
        // digit-named turned them into a bare ^A and dropped the font.
        // ^A0 is a font and ^B3 a barcode: the digit names the variant. ^AB and
        // ^BE have no digit, so the rule only fires when one is actually there.
        const digitName = /^[AB]\d/.test(head);
        const nm = (digitName ? /^[A-Za-z]\d/ : /^[A-Za-z]{2}/).exec(head);
        if (!nm) { i++; continue; }
        const name = nm[0].toUpperCase();
        const start = i + 1 + nm[0].length;
        if (name === 'FD') {
            // ^FD consumes up to its ^FS, but the ^FS is still a command and must
            // be emitted — it is what commits the field. Skipping past it left
            // every field unclosed and only the last one drawn.
            const end = src.indexOf('^FS', start);
            out.push({ name, params: end < 0 ? src.slice(start) : src.slice(start, end) });
            i = end < 0 ? src.length : end;
            continue;
        }
        const j = nextCommandAt(src, start);
        out.push({ name, params: src.slice(start, j).trim() });
        i = j;
    }
    return out;
};

/** Comma-separated parameters. ZPL treats a missing parameter as "use default". */
const parts = (params: string): string[] => params.split(',');

const num = (s: string | undefined, fallback: number): number => {
    if (s === undefined || s.trim() === '') return fallback;
    const n = Number(s);
    return Number.isFinite(n) ? n : fallback;
};

/** Barcode commands in scope, mapped to the IR symbology ids the renderer paints. */
const BARCODE_SYMBOLOGY: Record<string, string> = {
    BC: 'code128',
    B3: 'code39',
    // ^B2 is Interleaved 2 of 5, and the generator has written it for the IR's
    // '2' since it was written — while this table had no entry, so a stream
    // produced by this app for an I2of5 design fell to the generic
    // "barcode this viewer does not draw yet" and the field was lost. Labelary
    // confirms the command exists and takes o,h,f,g like ^BC.
    B2: 'interleaved2of5',
    BQ: 'qrcode',
    BX: 'datamatrix',
};

export interface ZplParseResult {
    label: ViewerLabel;
}

/**
 * Parses one ZPL label into the viewer IR. A stream with several ^XA…^XZ labels
 * yields the FIRST one plus an info issue naming how many were skipped — batch
 * jobs are a Fase 6 concern, and guessing which label to draw would hide data.
 */
export const parseZPL = (code: string): ViewerLabel => {
    const issues: ViewerIssue[] = [];
    const elements: ViewerElement[] = [];

    const xa = code.search(/\^XA/i);
    if (xa < 0) {
        issues.push({ level: 'error', code: 'zpl-no-label', message: 'No ZPL label found. Expected ^XA … ^XZ.' });
        return { widthDots: null, heightDots: null, elements, issues, settings: {} };
    }
    const xz = code.search(/\^XZ/i);
    const body = code.slice(xa + 3, xz < 0 ? code.length : xz);
    if (xz < 0) issues.push({ level: 'warning', code: 'zpl-unterminated', message: 'Label has no ^XZ. Parsing up to the end of the input.' });
    const labels = code.match(/\^XA/gi)?.length ?? 0;
    if (labels > 1) issues.push({ level: 'info', code: 'zpl-extra-labels', message: `Stream holds ${labels} labels. Only the first is shown.` });

    let widthDots: number | null = null;
    let heightDots: number | null = null;
    // Field state. ^FO/^FW/^A/^BY all configure the NEXT field; ^FS ends it.
    let origin: { x: number; y: number } | null = null;
    let rotation = 0;          // ^FW, in IPL quadrants
    let fieldRotation: number | null = null; // a per-command orientation overrides ^FW
    let font: { h: number; w: number } | null = null;
    let pendingBarcode: { symbology: string; heightDots: number; moduleDots: number; hri: 0 | 1; code39Mode?: string } | null = null;
    let byModule = 2;
    let byRatio = 3;           // ^BY wide:narrow, default 3.0
    let byHeight = 10;
    let data: string | null = null;
    /** ^FR — the field is printed white on a black box ("Field Reverse Print"). */
    let reverseField = false;
    /** ^FB — the field is a paragraph laid out inside a box. */
    let fbWidth: number | null = null;
    let fbMaxLines: number | null = null;
    let fbSpacing: number | null = null;
    let fbAlign: 'left' | 'center' | 'right' | 'justify' | null = null;
    let nextId = 1;

    const issue = (level: ViewerIssue['level'], code_: string, message: string, command?: string) =>
        issues.push({ level, code: code_, message, command });

    const resetField = () => {
        origin = null; font = null; pendingBarcode = null; data = null; fieldRotation = null;
        reverseField = false;
        fbWidth = null; fbMaxLines = null; fbSpacing = null; fbAlign = null;
    };

    /** IR anchor for a field whose visual top-left is (x, y). See elementVisualBox. */
    const anchor = (x: number, y: number, f: number, length: number, cross: number): { ox: number; oy: number } => {
        switch (f) {
            case 1: return { ox: x, oy: y + length };
            case 2: return { ox: x + length, oy: y + cross };
            case 3: return { ox: x + cross, oy: y };
            default: return { ox: x, oy: y };
        }
    };

    const commitField = () => {
        if (data === null || origin === null) { resetField(); return; }
        // Which element this field produces, so ^FR inverts THAT one — a field
        // that draws nothing must not invert whatever came before it.
        const before = elements.length;
        const f = fieldRotation ?? rotation;
        if (pendingBarcode) {
            const el: BarcodeElement = {
                kind: 'barcode', id: nextId++, ox: origin.x, oy: origin.y, f,
                symbology: pendingBarcode.symbology,
                heightDots: pendingBarcode.heightDots,
                moduleDots: Math.max(1, pendingBarcode.moduleDots),
                // IR ratio codes: 0 = 2.5:1, 1 = 3:1, 2 = 2:1. ^BY's default is 3.
                ratio: byRatio <= 2.2 ? 2 : byRatio < 2.8 ? 0 : 1,
                hri: pendingBarcode.hri,
                source: { type: 'fixed', data },
            };
            if (pendingBarcode.code39Mode) el.code39Mode = pendingBarcode.code39Mode;
            // The anchor is derived from the size the RENDERER measures, not an
            // estimate of our own. The two diverging is exactly what put a
            // rotated field's top-left somewhere other than its ^FO point.
            const sz = estimateElementSize(el, 203);
            Object.assign(el, anchor(origin.x, origin.y, f, sz.lengthDots, sz.crossDots));
            elements.push(el);
        } else if (font) {
            const pointSize = Math.max(1, Math.round(font.h * 72 / 203));
            const el: TextElement = {
                kind: 'text', id: nextId++, ox: origin.x, oy: origin.y, f,
                // c25 is an outline font the renderer sizes by pointSize, which is
                // how a ZPL scalable font works. '0' is not in the IR's font map,
                // so it would fall back to a bitmap cell and ignore the size.
                font: '25', hMag: 1, wMag: 1, pointSize,
                source: { type: 'fixed', data },
                // ^FB made this field a PARAGRAPH: it wraps at the box width and
                // is cut off after the line cap, and this is what keeps it from
                // being drawn as one long line running off the label.
                ...(fbWidth !== null && fbWidth > 0 ? { wrapDots: fbWidth } : {}),
                ...(fbMaxLines !== null && fbMaxLines > 0 ? { maxLines: fbMaxLines } : {}),
                ...(fbSpacing !== null ? { spaceDots: fbSpacing } : {}),
                ...(fbAlign !== null && fbAlign !== 'left' ? { align: fbAlign } : {}),
            };
            const sz = estimateElementSize(el, 203);
            Object.assign(el, anchor(origin.x, origin.y, f, sz.lengthDots, sz.crossDots));
            elements.push(el);
        }
        // ^FR ("Field Reverse Print") inverts this field's own box, so it goes
        // in AFTER the field, the same order the printer lays them down: black
        // box, then the glyphs knocked out of it. The box is the field's VISUAL
        // extent, taken from the element just pushed rather than recomputed, so
        // a rotated field is inverted where it actually landed.
        if (reverseField && elements.length > before) {
            const box = elementVisualBox(elements[elements.length - 1], 203);
            elements.push({
                kind: 'reverse', id: nextId++, ox: box.x, oy: box.y, f: 0,
                widthDots: Math.max(1, Math.round(box.w)),
                heightDots: Math.max(1, Math.round(box.h)),
            } as ViewerElement);
        }
        resetField();
    };

    for (const cmd of tokenize(body)) {
        const p = parts(cmd.params);
        switch (cmd.name) {
            case 'PW': widthDots = num(p[0], widthDots ?? 0); break;
            case 'LL': heightDots = num(p[0], heightDots ?? 0); break;
            // ^FR reverses the field — the printer lays a black box behind it
            // and knocks the glyphs out white. That is ink this preview does not
            // draw, so it gets its own message rather than sharing the generic
            // "no effect here" line with settings that genuinely change nothing
            // visible.
            case 'GF': {
                // ^GFa,totalBytes,bytesTotal,bytesPerRow,<data> — the tokenizer
                // takes two letters, so the format letter is p[0].
                //
                // No ZPL manual is in the repo, so the parameters were settled
                // by PROBING the oracle and measuring:
                //   ^GFA,16,16,2, FFx16 -> 16x8   ^GFA,16,2,2, FFx16 -> 16x1
                //     so p2 CAPS the data drawn — only p2 bytes are used — and
                //     p3 (bytesPerRow) fixes the SHAPE: 16 bytes over 2 per row
                //     is 8 rows of 16 dots;
                //   ^GFA,999,16,2, FFx16 -> 16x8, i.e. p1 is ignored;
                //   ^GFA,8,8,0, FFx8 -> 8x16, so a zero p3 flows bytes DOWN.
                //   ^GFA,8,8,1,80… put the dot at the LEFT edge and 01… at the
                //     right, so dots run from the HIGH bit.
                if (origin === null) {
                    issue('warning', 'zpl-gf-no-origin', '^GF has no ^FO before it, so it has nowhere to go. Skipped.', '^GF');
                    break;
                }
                const fmt = (p[0] ?? '').trim().toUpperCase();
                const dataStart = (cmd.params.match(/,/) ? cmd.params.indexOf(',') : -1);
                let raw = dataStart >= 0 ? cmd.params.slice(dataStart + 1) : '';
                // Everything up to the FOURTH comma is parameters; the rest is
                // the payload, which may not contain a comma of its own.
                for (let k = 0; k < 3; k++) {
                    const c = raw.indexOf(',');
                    if (c < 0) break;
                    raw = raw.slice(c + 1);
                }
                const declared = num(p[1], 0);      // total bytes (ignored by the printer)
                void declared;
                const totalBytes = num(p[2], 0);    // bytes actually drawn
                const perRow = num(p[3], 0);

                if (fmt !== 'A' && fmt !== 'B') {
                    issue('info', 'zpl-gf-compressed',
                        `^GF${fmt} is a compressed bitmap form (Z64 or similar); this preview decodes the uncompressed A (hexadecimal) and B (binary) forms.`, '^GF');
                    resetField();
                    break;
                }
                let bytes: number[] = [];
                if (fmt === 'A') {
                    for (let k = 0; k + 1 < raw.length; k += 2) {
                        const v = parseInt(raw.slice(k, k + 2), 16);
                        if (Number.isNaN(v)) break;
                        bytes.push(v);
                    }
                } else {
                    for (const ch of raw) bytes.push(ch.charCodeAt(0) & 0xff);
                }
                if (totalBytes > 0) bytes = bytes.slice(0, totalBytes);
                if (bytes.length === 0) {
                    issue('info', 'zpl-gf-empty', '^GF carries no bitmap data, so nothing is drawn.', '^GF');
                    resetField();
                    break;
                }
                let w: number;
                let h: number;
                if (perRow > 0) {
                    w = perRow * 8;
                    h = Math.ceil(bytes.length / perRow);
                } else {
                    // A zero bytes-per-row is not "no shape": the oracle drew
                    // ^GFA,8,8,0, FFx8 as 8x16, so each byte is one row of 8.
                    w = 8;
                    h = bytes.length;
                }
                const rows = Array.from({ length: h }, (_, r) =>
                    bytes.slice(r * (perRow > 0 ? perRow : 1), (r + 1) * (perRow > 0 ? perRow : 1))
                        .map((b) => String.fromCharCode(b))
                        .join(''),
                );
                elements.push({
                    kind: 'graphic', id: nextId, ox: origin.x, oy: origin.y, f: fieldRotation ?? rotation,
                    graphicId: nextId++, widthDots: w, heightDots: h, rows,
                } as ViewerElement);
                resetField();
                break;
            }

            case 'FB': {
                // ^FB width,maxLines,lineSpacing,align[,hangingIndent].
                // No ZPL manual is in this repo, so every parameter was settled
                // by PROBING the oracle and measuring the ink:
                //   ^FB300,3,4,L  on one long string -> 2 lines, extent 284
                //   ^FB150,3,4,L                     -> 3 lines, extent 131
                // so p1 is the BOX WIDTH in dots (narrower wraps sooner);
                //   ^FB300,2,4,L  -> only 2 lines, ^FB300,6 -> 2 lines as well
                // so p2 is NOT a wrap limit to fill but a CAP: the continuation
                // is CUT OFF;
                //   spacing 0/2/10/30 -> ink height 39/41/49/69
                // so p3 is dots ADDED to the line pitch, not a replacement;
                //   L/C/R left the lines at x104/109/113 and J widened to the
                // box edge, so p4 is per-line alignment.
                fbWidth = num(p[0], 0);
                fbMaxLines = num(p[1], 0);
                fbSpacing = num(p[2], 0);
                const a = (p[3] ?? '').trim().toUpperCase();
                fbAlign = a === 'C' ? 'center' : a === 'R' ? 'right' : a === 'J' ? 'justify' : 'left';
                if (p[4] !== undefined && p[4] !== '' && num(p[4], 0) !== 0) {
                    issue('info', 'zpl-fb-indent',
                        '^FB\'s hanging indent applies to every line after the first; this preview wraps at the box width without it.', '^FB');
                }
                break;
            }
            case 'FR':
                // "Field Reverse Print" — the printer lays a black box behind the
                // field and knocks the glyphs out white. That is exactly a
                // reversal of the field's own area, so it is DRAWN by pushing a
                // ReverseElement over the field's box after it commits, rather
                // than reported as something the preview cannot do.
                reverseField = true;
                break;
            // ^LH ^LT ^LS move the WHOLE image on the media, so they belong
            // with the picture-changing commands, not with the printer
            // settings. The generic "not part of the supported ZPL subset, so
            // it has no effect here" said the same thing about these as about
            // ^MD (darkness) and ^PR (speed) — which genuinely cannot change
            // what is drawn — and that understates a real divergence: the
            // preview draws every field at its ^FO coordinate while the printer
            // offsets the lot.
            //
            // Reported as a warning with the offsets named, matching the
            // precedent IPL already set for its own equivalent (<SI>X "the
            // image is shifted by N dot(s) in x and M in y", <SI>F, <SI>h).
            case 'LH': case 'LT': case 'LS': {
                // ^LH takes x,y; ^LT and ^LS take a single value (^LT moves the
                // image down, ^LS sideways).
                const x = num(p[0], 0);
                const y = cmd.name === 'LH' ? num(p[1], 0) : 0;
                if (x !== 0 || y !== 0) {
                    const what = cmd.name === 'LH' ? '^LH moves the label home'
                        : cmd.name === 'LT' ? '^LT shifts every field down'
                        : '^LS shifts every field sideways';
                    const by = cmd.name === 'LH' ? `${x} dot(s) in x and ${y} in y` : `${x} dot(s)`;
                    issue('warning', 'zpl-image-shifted',
                        `${what} by ${by}; this preview draws every field at its ^FO position and does not apply that offset.`,
                        `^${cmd.name}`);
                }
                break;
            }
            case 'FO':
            case 'FT':
                origin = { x: num(p[0], 0), y: num(p[1], 0) };
                if (cmd.name === 'FT') issue('info', 'zpl-ft-as-fo', '^FT anchors on the text baseline; it is placed like ^FO here, so text sits one line lower than a printer would put it.', '^FT');
                break;
            case 'FW': {
                const r = ROT[(p[0] ?? 'N').trim().toUpperCase()];
                if (r === undefined) issue('warning', 'zpl-bad-orientation', `^FW orientation "${p[0]}" is not N, R, I or B. Keeping the previous one.`, '^FW');
                else rotation = r;
                break;
            }
            case 'FWN': case 'FWR': case 'FWI': case 'FWB':
                rotation = ROT[cmd.name[2]]; break;
            case 'A0': case 'AA': case 'AB': case 'AD': case 'AE': case 'AF': case 'AG': case 'AH': {
                const r = ROT[(p[0] ?? '').trim().toUpperCase()];
                fieldRotation = r === undefined ? null : r;
                font = { h: num(p[1], 9), w: num(p[2], num(p[1], 5)) };
                if (cmd.name !== 'A0') issue('info', 'zpl-bitmap-font', `^${cmd.name} is a bitmap font. It is drawn with the scalable font at the same height.`, `^${cmd.name}`);
                break;
            }
            case 'A@':
                font = { h: num(p[1], 15), w: num(p[2], 15) };
                issue('info', 'zpl-font-name', '^A@ names a downloaded font, which is not available here. Drawn with the scalable font at the requested size.', '^A@');
                break;
            case 'BC': case 'B3': case 'B2': case 'BQ': case 'BX': {
                const r = ROT[(p[0] ?? '').trim().toUpperCase()];
                fieldRotation = r === undefined ? null : r;
                // A 1D barcode's p[1] is its human-readable flag and p[2] is its
                // height. The MATRIX commands put their MAGNIFICATION there
                // instead — and ^BY does not apply to them at all. Measured
                // against Labelary: ^BQN,2,2 renders 42px, ^BQN,2,6 renders
                // 126px and ^BQN,2,10 renders 210px — exactly 21 modules wide
                // each time, i.e. the magnification moves the MODULE, not the
                // symbol. ^BXN,2 is 24px and ^BXN,6 is 72px, 12 modules.
                //
                // Reading those commands like the 1D ones took p[1] as a height
                // flag, so every matrix symbol came out at ^BY's module size:
                // our own generator's ^BQN,2,2 read back with module 2 while
                // ^BQN,2,10 also read back as 2. The preview drew both at the
                // same size, and the ^BX case is the worse one — that field is
                // the only place a DataMatrix's size is stated, so it was
                // ignored outright.
                const matrixMag = Math.max(1, Math.trunc(num(p[1], 2)));
                // The 1D commands do NOT share a parameter order. ^BC and ^B2
                // are ^B<cmd>o,h,f,g — height SECOND. ^B3 is ^B3o,e,h,f,g —
                // check digit second, height THIRD, HRI fourth.
                //
                // Measured against Labelary, the only ZPL oracle here (no ZPL
                // manual in this repo). Putting a large value in one slot and
                // reading the rendered symbol:
                //
                //   ^B3 slot 2 -> nothing      (index 1, the check digit)
                //   ^B3 slot 3 -> height grows (index 2)
                //   ^B3 slot 4 -> HRI row only (index 3)
                //   ^BC slot 2 -> height grows (index 1)
                //   ^BC slot 3 -> HRI row only (index 2)
                //   ^B2 slot 2 -> height grows (index 1)
                //   ^B2 slot 3 -> HRI row only (index 2)
                //
                // The previous code read height from index 2 and the HRI flag
                // from index 1 for all three. That happened to be right about
                // ^B3's height and wrong about everything else: it took ^BC's
                // and ^B2's HEIGHT for a human-readable flag, and it took ^B3's
                // check digit for one.
                const isB3 = cmd.name === 'B3';
                const heightIdx = isB3 ? 2 : 1;
                const hriIdx = isB3 ? 3 : 2;
                const hri: 0 | 1 = (p[hriIdx] ?? 'Y').trim().toUpperCase() === 'N' ? 0 : 1;
                // ^B3 slot 2 (index 1) is the mod-43 CHECK DIGIT flag. It changes
                // the symbol — Labelary draws ^B3N,N,... and ^B3N,Y,... at
                // different ink (3-byte-different PNG, and the bar run gains the
                // check character) — so it is carried. The earlier note that "slot
                // 2 changes nothing" was measured by putting a NUMBER there, which
                // is not a value a Y/N flag can take and so proved nothing.
                const code39Mode = isB3 && (p[1] ?? '').trim().toUpperCase() === 'Y' ? '1' : undefined;
                const height = cmd.name === 'BQ' ? matrixMag * 25
                    : cmd.name === 'BX' ? matrixMag * 10
                    : num(p[heightIdx], byHeight);
                const module = cmd.name === 'BQ' || cmd.name === 'BX' ? matrixMag : byModule;
                pendingBarcode = {
                    symbology: BARCODE_SYMBOLOGY[cmd.name],
                    heightDots: Math.max(1, height),
                    moduleDots: Math.max(1, module),
                    hri: cmd.name === 'BQ' || cmd.name === 'BX' ? 0 : hri,
                    code39Mode,
                };
                break;
            }
            case 'BY':
                byModule = Math.max(1, num(p[0], 2));
                byRatio = num(p[1], 3);
                byHeight = Math.max(1, num(p[2], 10));
                break;
            case 'FD': data = unescapeFd(cmd.params); break;
            case 'FS': commitField(); break;
            case 'GB': {
                if (origin === null) { issue('warning', 'zpl-gb-no-origin', '^GB has no ^FO before it, so it has nowhere to go. Skipped.', '^GB'); break; }
                const w = num(p[0], byModule);
                const h = num(p[1], byModule);
                const t = Math.max(1, num(p[2], 1));
                const rounding = num(p[4], 0);
                const f = rotation;
                if (w <= t || h <= t) {
                    // A bar no thicker than its own stroke is a line. ^GB draws it
                    // along the longer side.
                    const along = Math.max(w, h);
                    const { ox, oy } = anchor(origin.x, origin.y, f, along, t);
                    const el: LineElement = { kind: 'line', id: nextId++, ox, oy, f: w >= h ? f : (f + 1) % 4, lengthDots: along, thicknessDots: t };
                    elements.push(el);
                } else {
                    const { ox, oy } = anchor(origin.x, origin.y, f, w, h);
                    const el: BoxElement = {
                        kind: 'box', id: nextId++, ox, oy, f, widthDots: w, heightDots: h, thicknessDots: t,
                        ...(rounding > 0 ? { radiusDots: Math.round(Math.min(w, h) / 2 * (rounding / 8)) } : {}),
                    };
                    elements.push(el);
                }
                resetField();
                break;
            }
            case 'GC':
            case 'GE': {
                // ^GC d,t and ^GE w,h,t. The parameter meanings were settled by
                // PROBING THE ORACLE rather than from memory — no ZPL manual is
                // in this repo. Labelary renders ^GC 100,4 as a 100x100 ink box
                // and ^GC 200,4 as 200x200, so the first value is the diameter
                // and the second does NOT change the extent (a border drawn
                // inside it). For ^GE, 200,100 gives 200x100 and swapping the
                // axes swaps the box, so those two are the axes.
                if (origin === null) {
                    issue('warning', 'zpl-shape-no-origin', `^${cmd.name} has no ^FO before it, so it has nowhere to go. Skipped.`, `^${cmd.name}`);
                    break;
                }
                const a = num(p[0], 0);
                const b = cmd.name === 'GC' ? a : num(p[1], 0);
                const thickness = Math.max(1, num(p[cmd.name === 'GC' ? 1 : 2], 1));
                if (a <= 0 || b <= 0) {
                    issue('info', 'zpl-shape-empty', `^${cmd.name} with no size draws nothing.`, `^${cmd.name}`);
                    resetField();
                    break;
                }
                const { ox, oy } = anchor(origin.x, origin.y, rotation, a, b);
                // ^GC is exactly the case where both axes are equal — which is
                // how the IR already expresses a circle.
                elements.push({
                    kind: 'ellipse', id: nextId++, ox, oy, f: rotation,
                    widthDots: a, heightDots: b, thicknessDots: thickness,
                } as EllipseElement);
                resetField();
                break;
            }
            case 'GD': {
                // ^GD w,h,t[,color[,orientation]] — a diagonal line. The oracle
                // shows its thickness EXPANDS the ink box (202x100 at t=4,
                // 218x100 at t=20) where ^GB's border does not, which is what a
                // diagonal stroke does; that is also the evidence it really is a
                // slanted line rather than a box.
                if (origin === null) {
                    issue('warning', 'zpl-shape-no-origin', '^GD has no ^FO before it, so it has nowhere to go. Skipped.', '^GD');
                    break;
                }
                const w = num(p[0], 0);
                const h = num(p[1], 0);
                const thickness = Math.max(1, num(p[2], 1));
                if (w <= 0 && h <= 0) {
                    issue('info', 'zpl-shape-empty', '^GD with no size draws nothing.', '^GD');
                    resetField();
                    break;
                }
                // The line runs corner to corner of the w x h box. Which pair of
                // corners is the documented selector: "R" is the rising (bottom
                // left to top right) diagonal, and the default is the other.
                const rising = /^R$/i.test((p[3] ?? '').trim());
                const { ox, oy } = anchor(origin.x, origin.y, rotation, w, h);
                elements.push({
                    kind: 'diagonal', id: nextId++, f: 0,
                    ox,
                    oy: rising ? oy + h : oy,
                    ex: ox + w,
                    ey: rising ? oy : oy + h,
                    thicknessDots: thickness,
                } as DiagonalElement);
                resetField();
                break;
            }
            case 'FH': break; // hex indicator — \_xx is always decoded, so this is a no-op here
            case 'CI': {
                // ^CI n selects the encoding. The viewer assumes UTF-8 (^CI28),
                // which is what this app's own generator emits — but a source
                // using another set (0 is the printer's default, 14 is cp850,
                // ...) makes the same byte a different glyph, so those are
                // named rather than silently decoded as UTF-8.
                const n = (p[0] ?? '').trim();
                if (n !== '' && n !== '28') {
                    issue('info', 'zpl-charset',
                        `^CI${n} selects a character encoding this viewer does not apply; it decodes text as UTF-8 (^CI28), so characters outside that set may differ from the print.`, '^CI');
                }
                break;
            }
            case 'PQ': break; // print quantity — a job concern, not a label concern
            case 'XZ': break;
            default:
                // Each of these says WHAT the command is and WHY it cannot be
                // drawn. A generic "not part of the supported subset" reads as
                // a choice this app made, and that reading was wrong for ^GC,
                // ^GE, ^GD and ^FR in turn — every one of them turned out to be
                // drawable. The ones left are outside what this subset expresses.
                if (cmd.name.startsWith('B')) {
                    issue('warning', 'zpl-barcode-unsupported', `^${cmd.name} is a barcode this viewer does not draw yet. Its data is kept in the issues but nothing is rendered for it.`, `^${cmd.name}`);
                } else if (cmd.name === 'GS') {
                    issue('info', 'zpl-gs-unsupported',
                        '^GS draws a named SYMBOL (check box, copyright mark, ...) from the printer\'s own font, and the glyph is not in the stream. Labelary refuses these too, so the shapes cannot be checked against a reference here.', '^GS');
                } else if (cmd.name === 'SN') {
                    issue('info', 'zpl-sn-unsupported',
                        '^SN makes the PRINTER serialise this field, advancing it once per label. This preview draws the data as sent; the counter advance happens on the printer, not here.', '^SN');
                } else {
                    issue('info', 'zpl-unsupported', `^${cmd.name} is not part of the supported ZPL subset, so it has no effect here.`, `^${cmd.name}`);
                }
        }
    }
    // A label that ends without ^FS still has a field worth showing.
    if (data !== null && origin !== null) {
        issue('warning', 'zpl-field-unclosed', 'A field has ^FD but no ^FS. It is drawn anyway.');
        commitField();
    }

    return { widthDots, heightDots, elements, issues, settings: {} };
};
