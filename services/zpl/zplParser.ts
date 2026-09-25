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

import type { ViewerLabel, ViewerElement, TextElement, BarcodeElement, LineElement, BoxElement, ViewerIssue } from '../ipl/types';
import { estimateElementSize } from '../ipl/renderer';

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
    let pendingBarcode: { symbology: string; heightDots: number; hri: 0 | 1 } | null = null;
    let byModule = 2;
    let byRatio = 3;           // ^BY wide:narrow, default 3.0
    let byHeight = 10;
    let data: string | null = null;
    let nextId = 1;

    const issue = (level: ViewerIssue['level'], code_: string, message: string, command?: string) =>
        issues.push({ level, code: code_, message, command });

    const resetField = () => {
        origin = null; font = null; pendingBarcode = null; data = null; fieldRotation = null;
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
        const f = fieldRotation ?? rotation;
        if (pendingBarcode) {
            const el: BarcodeElement = {
                kind: 'barcode', id: nextId++, ox: origin.x, oy: origin.y, f,
                symbology: pendingBarcode.symbology,
                heightDots: pendingBarcode.heightDots,
                moduleDots: Math.max(1, byModule),
                // IR ratio codes: 0 = 2.5:1, 1 = 3:1, 2 = 2:1. ^BY's default is 3.
                ratio: byRatio <= 2.2 ? 2 : byRatio < 2.8 ? 0 : 1,
                hri: pendingBarcode.hri,
                source: { type: 'fixed', data },
            };
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
            };
            const sz = estimateElementSize(el, 203);
            Object.assign(el, anchor(origin.x, origin.y, f, sz.lengthDots, sz.crossDots));
            elements.push(el);
        }
        resetField();
    };

    for (const cmd of tokenize(body)) {
        const p = parts(cmd.params);
        switch (cmd.name) {
            case 'PW': widthDots = num(p[0], widthDots ?? 0); break;
            case 'LL': heightDots = num(p[0], heightDots ?? 0); break;
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
            case 'BC': case 'B3': case 'BQ': case 'BX': {
                const r = ROT[(p[0] ?? '').trim().toUpperCase()];
                fieldRotation = r === undefined ? null : r;
                const hri: 0 | 1 = (p[1] ?? 'Y').trim().toUpperCase() === 'N' ? 0 : 1;
                const height = cmd.name === 'BQ' ? num(p[1], byModule) * 25
                    : cmd.name === 'BX' ? num(p[1], byModule) * 10
                    : num(p[2], byHeight);
                pendingBarcode = { symbology: BARCODE_SYMBOLOGY[cmd.name], heightDots: Math.max(1, height), hri: cmd.name === 'BQ' || cmd.name === 'BX' ? 0 : hri };
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
            case 'FH': break; // hex indicator — \_xx is always decoded, so this is a no-op here
            case 'CI': break; // character set. UTF-8 (^CI28) is what we already assume.
            case 'PQ': break; // print quantity — a job concern, not a label concern
            case 'XZ': break;
            default:
                if (cmd.name.startsWith('B')) {
                    issue('warning', 'zpl-barcode-unsupported', `^${cmd.name} is a barcode this viewer does not draw yet. Its data is kept in the issues but nothing is rendered for it.`, `^${cmd.name}`);
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
