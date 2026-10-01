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
    BoxElement, LineElement, EllipseElement, PolygonElement, GraphicElement, UnknownElement,
} from '../ipl/types';
import { estimateElementSize } from '../ipl/renderer';
import { DPL_FONTS, DPL_SMOOTH_FONT, dplMultiplierValue, dplDefaultHeightDots, DPL_SPEED_IPS } from './dplFonts';
import { dplBarcodeFor, DPL_CODE_PAGE_IDS, DPL_CHAR_MAP_IDS } from './dplBarcodes';
import { substituteDplDateTime } from './dplDateTime';
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
 * The point size of a scalable-font record (b = 9).
 *
 * THE SIZE IS NOT IN `eee` for the coded forms. Table 8-5 gives that field two
 * jobs at once — "Font height; Font selection" — over the range `000-999,
 * A04-A72, S00-S9z`, and the `S` forms select a FONT rather than a size: `SA0`
 * is CG Times, `S00` a CG Triumvirate size, `UK1` a Kanji Gothic. The size for
 * those lives in the OPTIONAL SCALABLE FONT HEIGHT field `hhhh`, which the same
 * chapter says "must be specified for scalable fonts" and which this parser was
 * discarding without reading.
 *
 * `hhhh` states points or dots by its first character: "To specify the height in
 * points the first character of the field is a `P' followed by the number of
 * points, 004 to 999. To specify the size in dots, all four characters must be
 * numeric."
 *
 * The `A04`-`A72` form states points directly in `eee` and leaves `hhhh` unused,
 * so it is still read from there. Anything else has no size to read and falls
 * back to the default rather than inventing one from a font id.
 */
/**
 * Table H-1's point size for a bit-mapped font-9 code.
 *
 * "Font 9 Bit-Mapped Resident Fonts (E-Class and M-4206, only): CG Triumvirate,
 * Single Byte, `000 - 010` — 5, 6, 8, 10, 12, 14, 18, 24, 30, 36, 48,
 * respectively." The codes are INDICES into that list, not point sizes, so `006`
 * is 18 points and not six — and the table is one of the few things in these
 * appendices that extracts cleanly, because each row is a single line.
 */
const DPL_BITMAP_FONT9_POINTS = [5, 6, 8, 10, 12, 14, 18, 24, 30, 36, 48];

const smoothPointFromSize = (eee: string, heightField: string): number => {
    // The optional scalable height wins: it is the field the manual says must
    // carry the size for a scalable font.
    const h = (heightField ?? '').trim();
    if (h.length >= 4) {
        const points = /^[Pp](\d{3})/.exec(h);
        if (points) return Math.max(1, parseInt(points[1], 10));
        if (/^\d{4}$/.test(h)) {
            // Dots, not points: "There are 72.307 points per 1 inch (2.847 mm)"
            // and the manual notes a dot size "will output differently on
            // printers with different DPI/MMPI resolutions". The preview works
            // at 203 dpi.
            const dots = parseInt(h, 10);
            if (dots > 0) return Math.max(1, Math.round((dots / 203) * 72.307));
        }
    }
    const a = /^[Aa](\d{2})$/.exec(eee.trim());
    if (a) return Math.max(1, parseInt(a[1], 10));
    // The bit-mapped resident codes are table INDICES, not sizes: "000 - 010 —
    // 5, 6, 8, 10, 12, 14, 18, 24, 30, 36, 48, respectively" (Table H-1), so
    // 006 is 18 points. Reading them as numbers gave every one of them the same
    // default.
    const idx = /^(\d{3})$/.exec(eee.trim());
    if (idx) {
        const n = parseInt(idx[1], 10);
        if (n <= 10) return DPL_BITMAP_FONT9_POINTS[n];
    }
    return 12;
};

/**
 * The scalable font options Appendix Q adds, by their `eee` code.
 *
 * "Scalable CG TIMES Font Code (`eee' field): SA0 -CG TIMES, SA1 - CG TIMES
 * ITALIC, SA2 - CG TIMES BOLD, SA3 - CG TIMES BOLD ITALIC"; the double-byte
 * options are the KANJI, CHINESE and KOREAN tables, where the code is `U`/`u`
 * plus the font's own name (`U40`, `UK1`, `UC0`, `UGB`).
 *
 * The CASE IS THE ADDRESSING, which is why this is looked up case-sensitively
 * before the upper-case name is taken: each table lists a code twice, e.g.
 * `UC0` marked binary and `uc0` marked hex ASCII, and both print the same font.
 * Lower-case codes are the hex-ASCII spelling and the payload is hex pairs; a
 * table whose name is not known still has its hex spelling recognised, because
 * the case carries that on its own.
 */
const ILPC_FONT_NAMES: Record<string, { name: string }> = {
    SA0: { name: 'CG Times' },
    SA1: { name: 'CG Times Italic' },
    SA2: { name: 'CG Times Bold' },
    SA3: { name: 'CG Times Bold Italic' },
    U40: { name: 'Kanji Gothic' },
    UK1: { name: 'Kanji Gothic' },
    UC0: { name: 'Simplified Chinese GB' },
    UGB: { name: 'Simplified Chinese GB' },
};

/** True when a double-byte code is written in its lower-case hex-ASCII form. */
const isHexAddressedCode = (code: string): boolean =>
    /^u[A-Za-z0-9]{2}$/.test(code);

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
 *
 * A LINE IS NOT THE SAME THING AS A COMMAND, and that is the whole reason this
 * function is not a split-and-indexOf. A record and the commands that fill its
 * data field share one line, exactly as the manual writes them:
 *
 *   `121100001000100<STX>TBCD GHI PQ, TU`   (sample 1 of the <STX>T entry, p. 126)
 *   `1A2210001000000<STX>SA`                (the <STX>S entry's own sample)
 *
 * Taking the first `<STX>` on a line and discarding what came before it — what
 * a plain indexOf does — throws the record away and reports NOTHING. Measured:
 * manual sample 1 parsed to 0 elements and 0 issues. So the line is split at
 * every attention-getter, and what precedes the first one is emitted as the
 * record it is.
 *
 * The two Special Label Formatting Commands are not returned as commands at
 * all. The manual defines them as living "in the format record data field"
 * (p. 125), so their effect belongs to the data, and the record's `params`
 * carries the text with the marker substituted (see dplDateTime). That also
 * sidesteps the collision the manual warns about — "Do not confuse them with
 * System-Level Commands because the same control character is used" — since a
 * `<STX>S` here can no longer be mistaken for the feed-speed setting.
 */
export const tokenizeDpl = (source: string, now: Date = new Date()): DplCommand[] => {
    const out: DplCommand[] = [];
    // <STX> and <SOH> may arrive as raw bytes or as the literal notation, the
    // same hazard every other language here has. Normalise both to raw.
    const text = source
        .replace(/<STX>/gi, '\x02')
        .replace(/<SOH>/gi, '\x01')
        .replace(/<CR>/gi, '\r')
        .replace(/<ESC>/gi, '\x1b')
        .replace(/<LF>/gi, '\n')
        // The manual's CARET notation, which it defines in as many words: "the
        // attention-getters (e.g., 'SOH') are standard ASCII control labels
        // that represent a one character control code (i.e., ^A or Ctrl A)"
        // (p. 7). Appendix B's ASCII sample program is written entirely that
        // way — `^BL`, `H07`, `D11` — and without this the caret was read as a
        // label command and reported as unsupported.
        //
        // Expanded across `^@` to `^_` so nothing is left behind: an unexpanded
        // caret would print as a stray glyph, and the one in `^L` was exactly
        // the "label command '^' is not part of the supported subset" message
        // this removes. A `^` before anything else is left as itself.
        .replace(/\^(.)/g, (whole, ch: string) => {
            const n = ch.charCodeAt(0);
            return n >= 0x40 && n <= 0x5f ? String.fromCharCode(n - 0x40) : whole;
        });
    // The alternate control codes, where `~` (0x7E) is the attention-getter in
    // place of STX and `^` (0x5E) replaces SOH. Appendix B's VB sample sends a
    // whole label built this way — `CharSet = Chr$(126)  'Alternate <stx>
    // character ~` — and Appendix M "(CC) Control Codes" defines the switch:
    // value 1 is "Hex 5E = SOH command; Hex 7E = STX command", value S the
    // standard pair.
    //
    // The `~` form is honoured whether or not the stream announces it. A printer
    // is put into alternate mode by its own menu as often as by the command, and
    // the sample above never sends one — so requiring it would fail the manual's
    // own example. SOH needs no equivalent: nothing in this parser acts on an
    // immediate command, so the `^` spelling can be treated as notation.
    //
    // A switch is detected by SHAPE rather than by the command, because the
    // command cannot be relied on to be present: a printer is put into
    // alternate mode by its own menu as often as by `<STX>CC1`, and Appendix
    // B's sample never sends one. What distinguishes the two is that an
    // attention-getter OPENS a line and is followed by a command letter — so
    // `~L` enters formatting while a `~` inside a data field is just a
    // character, and a stream that never uses the prefix has no such line at
    // all. Requiring the absence of `<STX>` would have missed the manual's own
    // shape, where the `<STX>CC1` announcing the switch is itself a plain
    // attention-getter on its own line.
    const alternate = /(^|[\r\n])~[A-Za-z]/.test(text);
    const stxChar = alternate ? '~' : '\x02';
    for (const line of text.split(/\r\n|\r|\n/)) {
        if (line === '') continue;
        const parts = line.split(stxChar);

        // Everything before the first attention-getter is the record. An empty
        // head means the attention-getter opened the line, which makes it a
        // system-level command with no record in front of it.
        //
        // `record` is deliberately scoped to THIS line rather than taken from
        // the end of `out`. A special command with no record of its own would
        // otherwise append its value to whatever was emitted last — a `<STX>T`
        // on a line of its own was seen to hand its date to the preceding
        // `<STX>L`, turning that command's params into "MON". Reading the value
        // back off the last entry is only safe if that entry is a record.
        const head = parts[0];
        let record: DplCommand | null = null;
        if (head !== '') {
            record = { name: '', params: head.trimStart(), raw: line };
            out.push(record);
        }

        // Which parts are the time STRING and which are DATA is decided by the
        // two attention-getters around it. The manual gives the rule in the
        // <STX>T entry: the command "may be preceded by data to be printed/
        // encoded, and/or the string may now be terminated by an <STX> command
        // and then followed by more data terminated by a <CR>" (p. 126). So
        // only the text between <STX>T and the next <STX> is a marker string;
        // everything outside it is printed as written. Sample 3 is the proof —
        // `191100100100010ABC <STX>TEF/PQ<STX> DEF` prints "ABC 12/21 DEF",
        // with "ABC" and " DEF" carried through untouched.
        let markerText: string | null = null;
        let trailing = '';
        /** Set once a bare <STX> has ended the time string; the rest of the
         *  line is data from there on. */
        let closed = false;
        for (let i = 1; i < parts.length; i++) {
            const seg = parts[i];
            const last = i === parts.length - 1;
            const rest = last ? seg.slice(1).trim() : seg.slice(1);
            const stx = seg.slice(0, 1);

            // A command letter is alphabetic. An attention-getter followed by a
            // digit therefore opened no command at all — the most likely stream
            // is a stray <STX> in front of a record, and reading it as a command
            // named "1" would drop the record in the system-level branch, which
            // reports nothing for an unrecognized letter.
            if (record === null && !/[A-Za-z]/.test(stx)) {
                record = { name: '', params: last ? seg.trim() : seg, raw: line };
                out.push(record);
                continue;
            }

            // The NEXT attention-getter after <STX>T is what terminates the
            // string, whatever follows it — the manual's rule is that the
            // string "may now be terminated by an <STX> command and then
            // followed by more data terminated by a <CR>" (p. 126). So the
            // decision is `markerText !== null`, NOT what this segment starts
            // with: testing the first character sent every segment beginning
            // with a letter down the command path instead.
            //
            // That is the difference between data and a command name, and it
            // matters most exactly where spaces are not allowed. A barcode's
            // data has no separator, so `<STX>TBCD<STX>SUFFIX` is how a date
            // followed by a literal is written — and reading `S` as a command
            // produced `S:"UFFIX"` with no issue at all, while `UFFIX`
            // disappeared from the label. `<STX>TCD<STX>MORE` was worse: `M`
            // is Mirror Mode, so the label would have been silently flipped.
            //
            // Everything from the closing sigil on is DATA, the sigil's own
            // character included — it was consumed by the split, not by a
            // command, so the whole segment is kept.
            if (closed || markerText !== null) {
                if (markerText !== null && record) {
                    record.params += substituteDplDateTime(markerText, now);
                    markerText = null;
                }
                closed = true;
                trailing += seg;
                continue;
            }

            if (stx === 'T' && record) {
                markerText = (markerText ?? '') + rest;
                continue;
            }

            // Any other sigil ends the string, so what it was holding goes back
            // into the record's data before the command itself is emitted.
            if (markerText !== null && record) {
                record.params += substituteDplDateTime(markerText, now);
                markerText = null;
            }
            if (stx === '') trailing += rest;
            else out.push({ name: stx, params: rest, raw: line });
        }

        if (markerText !== null && record) record.params += substituteDplDateTime(markerText, now);
        if (record && trailing) record.params += trailing;
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

/**
 * A graphic record's object, read out of its data field.
 *
 * `fillPattern` is carried but not drawn: the IR has no fill model, and the
 * patterns are a mix of tones (6%, 25%, 50%), hachures and shadings that a
 * single alpha or hatch could not stand in for. The record is reported when it
 * asks for one, so the difference is named rather than silently flattened.
 */
interface PendingShape {
    kind: 'line' | 'box' | 'circle' | 'polygon';
    widthDots: number;
    heightDots: number;
    thicknessDots: number;
    fillPattern?: number;
    /**
     * For a polygon: the vertices in PRINTER units, row counting up from the
     * label's bottom edge, exactly as the record lists them. They are kept in
     * that space and converted once, because the row flip at the end of the
     * parse moves an element by its own height — converting here as well would
     * apply the origin change twice.
     */
    points?: Array<{ row: number; col: number }>;
    /** For a circle: its centre in printer units, for the same reason. */
    centre?: { row: number; col: number };
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
export const parseDPL = (
    code: string,
    labelLengthDots?: number,
    now: Date = new Date(),
    dpiHint = 203,
): ViewerLabel => {
    const issues: ViewerIssue[] = [];
    const elements: ViewerElement[] = [];
    let nextId = 1;
    /**
     * Circles, by element id: a circle's record names its CENTRE, while the IR's
     * ellipse is placed by its bounding box's upper-left corner. The corner can
     * only be worked out after the page height is known — the centre's row is in
     * the printer's counting-up space — so the centre is held here and the
     * corner resolved in the flip pass with everything else.
     */
    const pendingCircles = new Map<number, { row: number; col: number }>();

    const issue = (level: ViewerIssue['level'], code_: string, message: string, command?: string) =>
        issues.push({ level, code: code_, message, command });
    /**
     * Advanced format attributes, from Table 8-16. All three manuals in
     * docs/manuals/ agree on the same six: FB, FI and FU toggle bold, italic
     * and underline with +/-; FPn and FSn set the vertical and horizontal point
     * size; FR[+/-]ndegrees rotates the baseline.
     *
     * They are written on the SAME line as the command they follow — the
     * manual's Figure 2 stream is `D11FA+FB+` (p. 144) — and they are only
     * valid for scalable fonts. Nothing here draws them, because the IR's text
     * element has no bold/italic/underline and inventing one would be a
     * rendering change that cannot be checked against a printer.
     */
    // The F-less forms are not a guess: the manual's own Figure 2 stream uses
    // them, writing `FU+I+`, `FB+I+U+` and `FB-U-I-` — one F establishing the
    // prefix and the following pairs sharing it. Table 8-16 lists only the
    // F-prefixed spellings, so the examples are the wider usage of the two.
    const ATTR_SPEC = /^(?:F(?:[BIU][+-]|[PS]\d+|R[+-]?\d+)|[BIU][+-])/;
    /** Anything shaped like an attribute but not in Table 8-16. */
    const ATTR_SHAPED = /^(?:F[A-Za-z]{1,2}[+-]?\d*|[A-Za-z]{1,2}[+-])/;
    /** The same set, anchored at the end, for attributes written AFTER a
     *  record on one line: `…P018P018New DPL WorldFU-B+` (p. 144). */
    const ATTR_TAIL = /(?:F[BIU][+-]|F[PS]\d+|FR[+-]?\d+|[BIU][+-])$/;
    /**
     * Consumes `F…` attributes from the END of a label command's parameter
     * string and returns the undrawn prefix, which is either empty or the start
     * of a record the line is sharing.
     *
     * `head` is the text BEFORE the attributes and `tail` the text after them,
     * because the manual writes them in both positions: appended to a command
     * (`D11FA+FB+`) and in front of a record
     * (`FA+1911S0105000020P018P018DPL allows …`).
     */
    const consumeAttributes = (head: string, tail: string): string => {
        let t = tail;
        let seen = 0;
        const unknown: string[] = [];
        for (;;) {
            const known = ATTR_SPEC.exec(t);
            if (known) { t = t.slice(known[0].length); seen++; continue; }
            const other = ATTR_SHAPED.exec(t);
            if (other) {
                // Terse forms share an F that the command's own sigil may
                // already have supplied — `FB+I+U+` is FB+, FI+ and FU+ — so
                // the reported name is completed only when it lacks one, rather
                // than being taken as written.
                unknown.push(other[0][0] === 'F' ? other[0] : `F${other[0]}`);
                t = t.slice(other[0].length);
                continue;
            }
            break;
        }
        if (seen > 0) {
            once('attrs', 'info', 'dpl-advanced-attributes',
                'F selects advanced format attributes (bold, italic, underline, point size, baseline rotation) for scalable fonts. They cannot be drawn in this preview, so this text may differ from the print.', 'F');
        }
        if (unknown.length > 0) {
            // `FA+` is written in the manual's OWN Figure 2 stream and appears
            // in no manual's Table 8-16, so it is named rather than accepted:
            // an attribute this parser guessed at would look like it did
            // something.
            once(`attrs-unknown-${unknown.join(',')}`, 'info', 'dpl-attribute-unknown',
                `"${unknown.join('", "')}" is written as a format attribute but is not in Table 8-16 (FB, FI, FU, FPn, FSn, FR[+/-]n); nothing is drawn for it.`, 'F');
        }
        return head + t;
    };

    /**
     * One dot row of a Datamax 7-bit ASCII image as the IR carries it.
     *
     * `rows` is one character per BYTE, leftmost dot in the HIGH bit (bit 7) —
     * the same convention the renderer already reads for ZPL's `^GF`, and the
     * one Appendix O's own example confirms: a full-width 384-dot row is 48
     * bytes and both `80nndd…` and the byte-count agree on "F" pairs for the
     * rows it shows.
     */
    const imageRowToBytes = (data: string): string => {
        let out = '';
        for (let k = 0; k + 1 < data.length; k += 2) {
            const v = parseInt(data.slice(k, k + 2), 16);
            if (Number.isNaN(v)) break;
            out += String.fromCharCode(v);
        }
        return out;
    };

    const seenOnce = new Set<string>();
    /** Reports a condition once per parse — a stream that sets the same global
     *  state on every record would otherwise bury the panel in duplicates. */
    const once = (key: string, level: ViewerIssue['level'], code_: string, message: string, command?: string) => {
        if (seenOnce.has(key)) return;
        seenOnce.add(key);
        issue(level, code_, message, command);
    };

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
    /**
     * J command: where the record's COLUMN anchors its text. "Ja" with L
     * (default), R or C shifts the string left/centre about the point — and
     * the manual is explicit that only the anchor moves: "the second text will
     * be printed at one inch up one inch over, going left. (Note the
     * characters will not be reversed.)"
     */
    let justification: 'left' | 'center' | 'right' = 'left';
    /** M command: "instructs the printer to mirror all subsequent print field
     *  records ... transposed visually, as if the object is viewed in a
     *  mirror". It TOGGLES, so it is page-level state, not a field flag. */
    let mirror = false;
    /** The data field of the record just read, for `G` to store. */
    let lastRecordData = '';
    /**
     * Images downloaded by `<STX>I`, by name.
     *
     * "Syntax: <STX>Iabfnn...n<CR>data" (p. 20) — the data that follows the
     * command is the image, so it belongs to the command rather than to any
     * record. Only the Datamax 7-bit ASCII form is decoded: Appendix O defines
     * it as "a set of records with identical formats, each representing a dot
     * row of the image; a terminator follows the last of these records", each
     * row being `80nndd…d` with nn the number of character pairs in ASCII hex
     * and a `FFFF` terminator. The BMP/IMG/PCX forms are binary raster files
     * carried inside the token stream, which no parser here can decode — those
     * names are remembered so a record using one can say so instead of drawing
     * nothing.
     */
    const images = new Map<string, { rows: string[]; widthDots: number; heightDots: number } | null>();

    // A graphics record (b = X) describes its object in the DATA field rather
    // than in the header, so it is built when the record is read.
    let pendingShape: PendingShape | null = null;

    /**
     * `G` global registers, A-P, "named in the order received, beginning with
     * register A ... and incrementing with each instance of the G command use"
     * (p. 114). The manual calls this "temporary storage" for a record's print
     * data, so it is per-job state that carries no position of its own — until
     * a `<STX>S` copies it into a record.
     */
    const globalRegisters: string[] = [];

    /**
     * The printer's own clock, as `<STX>A` sets it.
     *
     * `now` is the caller's idea of the time — what the preview would use for a
     * stream that never sets a clock — and this starts there. `<STX>A` then
     * moves it, so that a stream setting a date and printing it shows the date
     * IT named rather than the day the file happened to be opened.
     */
    let printerClock = now;
    // <STX>A is read by a PRE-PASS, because the date is substituted while the
    // stream is tokenized and the tokenizer runs before the command loop would
    // ever see the clock-setting command. Without this a stream that sets 1996
    // and prints its own date still printed the system's day.
    // Against the manual's own sample `<STX>A1020319960855034`, which it says
    // prints "Mon. Feb 3, 1996, 8:55AM": w=1 (Monday), mm=02, dd=03,
    // yyyy=1996, hh=08, MM=55, jjj=034 — SIXTEEN digits, so
    //   [0] w  [1..2] mm  [3..4] dd  [5..8] yyyy  [9..10] hh  [11..12] MM  [13..15] jjj
    // A first attempt counted fifteen and offset every field by one, reading
    // the sample as the 5th of February 1999.
    //
    // Both spellings are handled, because the notation `<STX>` is normalised
    // inside the tokenizer and this pass runs before it. Getting that wrong made
    // a notated stream silently keep the system clock.
    const clockSource = code.replace(/<STX>/gi, '\x02');
    for (const m of clockSource.matchAll(/\x02A(\d{16})/g)) {
        const d = m[1];
        printerClock = new Date(
            Number(d.slice(5, 9)), Number(d.slice(1, 3)) - 1, Number(d.slice(3, 5)),
            Number(d.slice(9, 11)), Number(d.slice(11, 13)),
        );
    }

    /**
     * DPL position units -> dots. Hundredths of an inch, or tenths of a mm.
     *
     * The resolution is the CALLER'S, not a constant. Every measurement in DPL
     * is a physical distance in hundredths of an inch, so the dots it becomes
     * depend on the printer: "0.40" is 81 dots at 203 dpi and 120 at 300. This
     * function used to be passed a literal 203 at all thirteen call sites,
     * which was invisible while the page height came through it too — both
     * scaled together and the LAYOUT stayed right — but left every bar code,
     * box, polygon and circle sized for a 203 dpi machine. Measured: a `eee=040`
     * bar code drew 81 dots at 300 dpi where the inch it names is 120, so every
     * symbol was a third too short.
     */
    const positionToDots = (units: number, dpi: number = dpiHint): number =>
        metric ? (units / 10) * (dpi / 25.4) : (units / 100) * dpi;

    const cmds = tokenizeDpl(code, printerClock);

    /**
     * Which records a `<STX>S` fills, keyed by the record's token index.
     *
     * The manual writes the recall AFTER the record it fills, on the next line:
     * `121100000000000Testing<CR>G<CR>1A2210001000000<STX>SA` (p. 126). So the
     * pairing is a lookahead over the token list, and it is the PRECEDING
     * RECORD that identifies the special command rather than the System-Level
     * `<STX>S` (Set Feed Speed) the manual warns not to confuse it with
     * (p. 125) — a record can only exist inside a label format, so a preceding
     * record settles it with no state to thread.
     *
     * The record is the nearest one BEFORE the sigil, not necessarily the token
     * immediately before it: a label command may sit between the two, and the
     * manual's `J`/`R`/`C` commands are toggles commonly written on a line of
     * their own. Requiring strict adjacency silently fell through to the
     * system-level Set Feed Speed reading whenever anything intervened, so the
     * record printed its placeholder with no recall issue and no warning.
     *
     * Values are deliberately NOT read here: a register is filled by an earlier
     * `G`, so it can only be resolved when the main loop reaches the record.
     */
    const recallFor = new Map<number, string>();
    for (let i = 1; i < cmds.length; i++) {
        const c = cmds[i];
        if (c.name !== 'S' || !/^[A-P]$/.test(c.params)) continue;
        for (let k = i - 1; k >= 0; k--) {
            const p = cmds[k];
            if (p.name === '' && /^\d/.test(p.params)) { recallFor.set(k, c.params); break; }
            // A special command always fills the RECORD it follows, so stop at
            // another one rather than reaching past it to an older record.
            if ((p.name === 'S' || p.name === 'T') && k > 0) break;
        }
    }

    for (let ci = 0; ci < cmds.length; ci++) {
        const cmd = cmds[ci];
        // ---- System-level commands ----
        if (cmd.name !== '') {
            const letter = cmd.name;
            // <STX>I swallows the image that follows it, so it is handled before
            // the format state is even consulted: "the data that immediately
            // follows the command string will be image data" (p. 20), and that
            // data is written as dot-row lines starting with `80nn` — which the
            // record reader would otherwise take for label records and print as
            // text, putting the hex digits of a logo on the label.
            if (letter === 'I') {
                const spec = cmd.params;
                // a = module bank, b = data type (optional 'A'), f = format,
                // then up to 16 characters of name.
                let body = spec;
                if (body[0] === 'A') body = body.slice(1);
                const fmt = body.slice(1, 2);
                const rawName = body.slice(2).trim();
                // "j: ASCII string, up to 16 characters followed by a termination
                // character" (Table 8-11) — the name is space padded in the
                // manual's own sample (`<STX>IDpTest `).
                const name = rawName.split(/\s+/)[0] ?? '';
                const rows: string[] = [];
                let cursor = ci + 1;
                for (; cursor < cmds.length; cursor++) {
                    const next = cmds[cursor];
                    if (next.name !== '') break;
                    // A stray attention-getter off the end of a dot row is not
                    // data — the manual can only mean it as a terminator, since
                    // it is not a hex digit.
                    const line = next.params.trim().replace(/^[~^]/, '').toUpperCase();
                    if (line === 'FFFF') break;
                    // `80nndd…d` — the leading 80 is fixed, nn is the pair count.
                    if (!/^80[0-9A-F]{2}/.test(line)) break;
                    const hex = line.slice(4);
                    if (hex.length % 2 !== 0 || /[^0-9A-F]/.test(hex)) break;
                    // A repeat record (0000FFnn) is not part of the manual's
                    // own example, so it is not guessed at here; anything that
                    // does not decode ends the data rather than being silently
                    // swallowed.
                    rows.push(imageRowToBytes(hex));
                }
                if (rows.length > 0) {
                    // The manual's rows are all the same width, so the first
                    // decides it; a shorter one is padded rather than shifting
                    // every dot after it.
                    const bytesPerRow = Math.max(...rows.map(r => r.length));
                    const padded = rows.map(r => r.padEnd(bytesPerRow, '\0'));
                    images.set(name, { rows: padded, widthDots: bytesPerRow * 8, heightDots: padded.length });
                    issue('info', 'dpl-image-loaded',
                        `<STX>I loads the image "${name}" (${bytesPerRow * 8} x ${padded.length} dots); a record that prints it draws that bitmap.`, 'I');
                } else {
                    // BMP, IMG and PCX arrive as binary raster files, which
                    // this parser cannot decode — so the name is remembered to
                    // say exactly that when a record asks for it.
                    images.set(name, null);
                    issue('info', 'dpl-image-undecodable',
                        fmt.toLowerCase() === 'f'
                            ? `<STX>I names the image "${name}" but no dot-row data followed it, so there is nothing to draw.`
                            : `<STX>I loads "${name}" as a ${fmt.toUpperCase()} file — a binary raster format this preview cannot decode, so a label printing it will show a placeholder instead.`,
                        'I');
                }
                ci = cursor - 1;
                continue;
            }
            // "(CC) Control Codes - This command, depending upon printer type,
            // allows a change to the prefix of the software commands
            // interpreted by the printer" (Appendix M). It is acted on by the
            // tokenizer, which has to know the prefix before it can split
            // anything, so by the time it reaches here the switch has already
            // been applied — and leaving it to the unknown-command report would
            // name a command the parser does understand.
            if (letter === 'C' && /^C[12S]$/i.test(cmd.params)) continue;
            // <STX>A — "Set Time and Date": "This command sets the time and
            // date. The initial setting of the date will be stored in the
            // printer's internal inch counter" (p. 17).
            //
            // It matters because <STX>T PRINTS from that clock: "The sample
            // listings below assume a current printer date of December 21,
            // 1998." A stream that sets the clock and then prints the date was
            // getting the SYSTEM's date instead — measured: a stream setting
            // 3 Feb 1996 printed "THU OCT 01" for its own date field.
            //
            // "Syntax: <STX>AwmmddyyyyhhMMjjj", and the manual's own sample
            // "<STX>A1020319960855034" prints "Mon. Feb 3, 1996, 8:55AM, 034".
            // Read against that sample the layout is w=1, mm=02, dd=03,
            // yyyy=1996, hh=08, MM=55, jjj=034 — the field list's alignment in
            // the extracted text is scrambled, and the sample is what settles it.
            if (letter === 'A') {
                const m = /^(\d)(\d{2})(\d{2})(\d{4})(\d{2})(\d{2})(\d{3})$/.exec(cmd.params.trim());
                if (m) {
                    // `w` states the weekday separately and can contradict the
                    // date — the manual's OWN sample does, `w` = 1 (Monday)
                    // against the 3rd of February 1996, which was a Saturday.
                    // The DATE wins: Table 6-3's `BCD` group is the day NAME,
                    // which a printer holding a date derives rather than is
                    // told, and the manual's "Mon." there is its own error, the
                    // same class as its "SUN" for the 21st of December 1998.
                    // The disagreement is named rather than quietly resolved.
                    const statedDow = Number(m[1]);
                    const derivedDow = printerClock.getDay() === 0 ? 7 : printerClock.getDay();
                    once('settime', 'info', 'dpl-clock-set',
                        `<STX>A sets the printer's clock to ${printerClock.toDateString()} `
                        + `${String(printerClock.getHours()).padStart(2, '0')}:${String(printerClock.getMinutes()).padStart(2, '0')}`
                        + (statedDow === derivedDow
                            ? ', and a later <STX>T prints from it.'
                            : `, which is a different weekday from the ${statedDow} the command also states; the preview follows the DATE, so a <STX>T day name will differ from the command's own count.`),
                        'A');
                } else {
                    issue('info', 'dpl-clock-set',
                        'A sets the printer\'s time and date, but not in the form the manual gives (`<STX>AwmmddyyyyhhMMjjj`), so the preview keeps the clock it had.', 'A');
                }
                continue;
            }
            // <STX>Kc — "Configuration Set", the menu's settings over the wire:
            // "<STX>Kcaa1val1[;aaIvalI][;aanvaln]", with two-letter parameter
            // names (p. 42). Most of it is printer setup the preview has no
            // opinion about, but two parameters MOVE the printed image and
            // would otherwise reach the generic "has no effect on the preview",
            // which for them is untrue:
            //
            //   CF, Column Adjust Fine Tune — "shifting both the horizontal
            //       start of print position and the Label Width termination
            //       point to the right in dots"
            //   RF, Row Adjust Fine Tune — "shifts the vertical start of print
            //       position in dots upward or downward"
            //
            // Both exist "to compensate for slight mechanical differences
            // sometimes evident if multiple printers share label formats", so a
            // stream may well carry one, and a preview that ignores it draws the
            // label at an origin the printer will not use.
            if (letter === 'K' && /^c/i.test(cmd.params)) {
                const shifts: string[] = [];
                for (const m of cmd.params.slice(1).matchAll(/([A-Za-z]{2})(-?\d+)/g)) {
                    const name = m[1].toUpperCase();
                    const what = name === 'CF' ? 'shifts the printed image HORIZONTALLY'
                        : name === 'RF' ? 'shifts the printed image VERTICALLY'
                            : name === 'CO' ? 'shifts the column offset'
                                : name === 'PJ' ? 'shifts the present position'
                                    : null;
                    if (what) shifts.push(`Kc${name} ${what} by ${m[2]} dots`);
                }
                if (shifts.length > 0) {
                    issue('info', 'dpl-config-shift',
                        `${shifts.join('; ')}. The preview draws the label at its own origin, so the printed label will sit at a different position on the media.`, 'Kc');
                } else {
                    issue('info', 'dpl-system-command',
                        'DPL system-level command "Kc" sets printer configuration; it has no effect on the preview.', letter);
                }
                continue;
            }
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
            // Named, never dropped in silence — the same contract the label
            // commands keep. Without this the whole `<STX>x` surface disappears
            // without a word: a mistyped attention-getter command reported
            // NOTHING at all, and DPL's system-level set is large. The four
            // handled above are the ones the preview acts on; the rest —
            // immediate commands, extended system-level setup, print-quality and
            // memory tests — cannot change the image, so they are named and
            // passed over rather than interpreted.
            issue('info', 'dpl-system-command',
                `DPL system-level command "${letter}" is not part of the supported subset; it has no effect on the preview.`, letter);
            continue;
        }

        // The switch that turns on the ALTERNATE prefix. A stream announces it
        // with the standard `<STX>CC1` and then goes on using `~` — which is
        // what the manual describes and what its own VB sample does. Splitting
        // on `~` leaves that opening sigil inside the text, so the line arrives
        // as `\x02CC1` and was reported as an unknown label command, naming a
        // defect in a stream that is doing exactly what it should.
        if (/^\x02?CC[12S]$/i.test(cmd.params.trim())) continue;

        let line = cmd.params;
        // Advanced format attributes can also trail a record on its own line —
        // the manual's Figure 2 has `1911S0101400040P018P018New DPL WorldFU-B+`
        // (p. 144) — and left on, they are read as part of the printed text
        // ("New DPL WorldFU-B" instead of "New DPL World"). Stripped only for
        // a line that IS a record; a label command may legitimately end in the
        // same letters, and `D11FA+FB+` is stripped by its own case.
        if (/^\d/.test(line) && ATTR_TAIL.test(line)) {
            const stripped = line.replace(/(?:F[BIU][+-]|F[PS]\d+|FR[+-]?\d+|[BIU][+-])+$/, '');
            const dropped = line.slice(stripped.length);
            if (dropped !== '') {
                once('attrs', 'info', 'dpl-advanced-attributes',
                    'Advanced format attributes (bold, italic, underline, point size, baseline rotation) cannot be drawn in this preview, so this text may differ from the print.', 'F');
                line = stripped;
            }
        }
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
                    // The manual appends attributes to this very command —
                    // Figure 2's first line is `D11FA+FB+` (p. 144) — and
                    // reading only the two digits silently dropped everything
                    // after them.
                    consumeAttributes('', rest.slice(2));
                    break;
                }
                case 'J': {
                    // "L = left justified (default), R = right justified,
                    // C = center justified" (manual p. 115).
                    const a = rest.trim().toUpperCase();
                    justification = a === 'R' ? 'right' : a === 'C' ? 'center' : 'left';
                    break;
                }
                case 'U': {
                    // "Mark Previous Field as a String Replacement Field" (p.
                    // 121): the field's content is replaced at print time by a
                    // host <STX>U payload of the same length. The format's own
                    // text is a template placeholder, so the value shown here is
                    // what the label carries before substitution — named, the
                    // same way EPL's V token is, rather than silently passed off
                    // as the printed value.
                    issue('info', 'dpl-replacement-field',
                        'U marks the previous field as a string replacement, so its text is filled in from the host at print time; the preview shows the format\'s own placeholder.', 'U');
                    break;
                }
                case 'M': {
                    // "instructs the printer to mirror all subsequent print
                    // field records ... Mirrored fields are transposed
                    // visually, as if the object is viewed in a mirror" (p.
                    // 116), and it TOGGLES rather than taking a value.
                    //
                    // This is a whole-label transform, the same class as TSPL's
                    // DIRECTION, and it is reported rather than applied for the
                    // same reason: the preview draws each field at its own
                    // coordinates, and mirroring the page would move every one
                    // of them. Saying so beats drawing a label that is silently
                    // flipped from the printed one.
                    mirror = !mirror;
                    issue('info', 'dpl-mirror',
                        `M turns Mirror Mode ${mirror ? 'ON' : 'OFF'}: records after it print transposed as if seen in a mirror. This preview draws the label as laid out, so the mirroring is not applied.`, 'M');
                    break;
                }
                case 'p': {
                    // "Syntax: pa — a: Is a single alpha character representing
                    // a speed; see Appendix L for valid ranges" (p. 117). Same
                    // table as `P`, and the manual's sample `pF` "sets the
                    // printer to a backup speed of 3.5 IPS" — which Table L-1
                    // gives for `F`, confirming the letter is read as itself.
                    const ips = DPL_SPEED_IPS[rest.trim()];
                    if (ips !== undefined) {
                        once(`feed-${rest.trim()}`, 'info', 'dpl-print-speed',
                            `p sets the backfeed speed to ${ips} inches per second (Table L-1 "${rest.trim()}"). The preview does not model media motion, so this is not applied.`, 'p');
                    }
                    break;
                }
                case 'F': {
                    // "F Advanced Format Attributes ... These commands extend
                    // the text presentation capabilities for Scalable Fonts"
                    // (p. 113). The manual's OWN example puts a record
                    // immediately after the attributes, on the same line, with
                    // no glyph-less record in between:
                    //
                    //   FA+1911S0105000020P018P018DPL allows \<FP36FS36>FONT
                    //
                    // so a line beginning with F was previously read as the
                    // command alone and the record that followed it vanished
                    // with no element and no issue. Whatever is not an attribute
                    // belongs to a record, which is re-read from that point.
                    // The leading `F` is the command's own sigil — the same
                    // letter the attribute names start with — so the attribute
                    // text is the whole parameter, `rest`.
                    const leftover = consumeAttributes('', rest);
                    if (leftover === '') break;
                    cmd.name = '';
                    cmd.params = leftover;
                    ci--;
                    continue;
                }
                // The label-level metric/inch pair. The same letters do the same
                // job at the system level (`<STX>m` / `<STX>n`), and every
                // position in the format is read in whichever unit is current —
                // so a format that switches mid-stream moves the fields after
                // it, and positionToDots is what honours that.
                case 'm': metric = true; break;
                case 'n': metric = false; break;
                case 'Q': quantity = Math.max(1, Math.trunc(num(rest, 1))); break;
                case 'G': {
                    // "The 'G' command saves the print data of a print format
                    // record in a global register (temporary storage) ... Global
                    // registers are named in the order received, beginning with
                    // register A, ending at register P" (p. 114). It is the
                    // partner of <STX>S, which copies the value into a later
                    // record.
                    if (globalRegisters.length < 16) {
                        globalRegisters.push(lastRecordData);
                        issue('info', 'dpl-global-register',
                            `G stores the preceding record's data ("${lastRecordData}") in global register ${String.fromCharCode(65 + globalRegisters.length - 1)}.`, 'G');
                    } else {
                        issue('warning', 'dpl-global-overflow',
                            'G is used more than 16 times here, but DPL keeps only the registers A to P; the printer ignores this one.', 'G');
                    }
                    break;
                }
                case 'H': settings.darknessAdjust = Math.trunc(num(rest, 0)); break;
                case 'P': {
                    // "Syntax: Pa — a: Is a single character representing a
                    // speed; see Appendix L for valid ranges" (p. 117). The
                    // manual's own sample is `PC`, which it says prints "at a
                    // speed of 2 inches per second".
                    //
                    // Read as a NUMBER, that sample — and every other letter
                    // speed — became 0 in silence. The IR's printSpeed is a
                    // NUMBER in the printer's tenths, so a letter cannot go
                    // there without inventing a unit the type does not declare;
                    // the speed is reported instead, with its own table's value.
                    // The lookup is CASE-SENSITIVE, and has to be: Table L-1
                    // gives `A` as 1.0 ips and `a` as 16.0 — the same letter two
                    // different speeds. Upper-casing first, as this did, read
                    // `Pa` as 1.0 where the table says 16.0.
                    const c = rest.trim();
                    const ips = DPL_SPEED_IPS[c];
                    if (ips !== undefined) {
                        once(`speed-${c}`, 'info', 'dpl-print-speed',
                            `P sets the print speed to ${ips} inches per second (Table L-1 "${c}"). The preview draws at any speed, so this is not applied.`, 'P');
                    } else {
                        issue('info', 'dpl-print-speed',
                            rest === ''
                                ? 'P sets the print speed, but no speed character follows it, so the printer keeps the speed it has.'
                                : `P sets the print speed to "${rest}", which is not one of the characters Table L-1 defines (A-Z, a-e).`,
                            'P');
                    }
                    break;
                }
                case 'X': inFormat = false; break;   // terminate without printing
                case 'E':
                    inFormat = false;
                    // Terminate-and-print; nothing more to read for this label.
                    break;
                default:
                    // A format command this subset does not model. Named, never
                    // dropped in silence — the contract every parser here keeps.
                    //
                    // The list below is re-derived from the manual's own Label
                    // Formatting chapter headings, and the test of a sound entry
                    // is that it can actually BE reached: a name the switch above
                    // already handles can never arrive here, so listing it
                    // silences nothing. 'J', 'R' and 'U' were on the list and all
                    // three are handled above; 'g' was too, but the manual's
                    // command is 'G' (Place Data in Global Register) — there is
                    // no lowercase 'g' in the chapter at all. That is the same
                    // defect 'd' and 'V' had before them: a phantom entry that
                    // quietens a name the tokenizer can never produce while every
                    // real occurrence of the command reports as unknown.
                    //
                    // What remains is six commands, each of which is real and
                    // each of which this subset does not model:
                    //   `c` and its upper-case twin Cut By Amount, `e` Recall
                    //       Printer Configuration (whose parameter is bare text,
                    //       `ePlant1` — it needs a line terminator to end it, so
                    //       a record written right after it without one is read
                    //       as part of the name and never appears), and
                    //   `f` Present Speed and `p` Backfeed Speed (printer
                    //       motion rather than image). Both take bare-text
                    //       parameters too, `fA19110...` in the manual's sample,
                    //       and so carry the same hazard.
                    //   bare `S` Set Feed Speed / `T` Set Field Data Line
                    //       Terminator, which share their letters with the
                    //       special <STX>S / <STX>T commands the manual warns
                    //       not to confuse them with (p. 125).
                    // The digit-sigilled `+`, `-` and `^` are NOT here: they
                    // take no leading letter, so they read as records and are
                    // caught by the not-a-record check further down.
                    //
                    // `F` (Advanced Format Attributes), `r` (Recall Stored
                    // Label Format), `s` (Store Label Format in Module), `y`
                    // (Font Symbol Set) and `z` (Zero Conversion) are NOT here
                    // either, and deliberately: each one changes what the label
                    // looks like or brings in fields this parse never saw, so
                    // they must report rather than be listed as harmless.
                    // `y` is called out because the generic message is actively
                    // WRONG for it. Appendix I's Symbol Set Selection picks the
                    // code page the scalable fonts are mapped through — "in the
                    // code page (CP), character code 0xE4 causes Φ to be
                    // printed. In CP E7, the character code 0xE4 causes δ" — so
                    // it changes what EVERY byte in every following record
                    // means. The preview renders each byte by its Latin-1 value
                    // regardless, which is a real difference from the print and
                    // not "no effect".
                    if (letter === 'y') {
                        // Two commands share this letter and the manual keeps
                        // them apart: "<STX>ySxx" selects a SINGLE-byte code
                        // page and "<STX>yUxx" a DOUBLE-byte character map, and
                        // "each affects an independent database selection and
                        // has no impact on the other" (Table I-2).
                        const sel = /^([SU])([0-9A-Za-z]{2})$/.exec(rest.trim().toUpperCase());
                        // sel[0] is the WHOLE match — the captures start at 1,
                        // so sel[1] is the S/U that says which of the two
                        // commands this is and sel[2] the two-character id.
                        const kind = sel?.[1] === 'U' ? 'character map' : 'symbol set';
                        const name = sel
                            ? (sel[1] === 'U' ? DPL_CHAR_MAP_IDS[sel[2]] : DPL_CODE_PAGE_IDS[sel[2]])
                            : undefined;
                        const table = sel?.[1] === 'U' ? 2 : 1;
                        const label = name ? `"${name}"` : `"${sel?.[2] ?? ''}" (not in Table I-${table})`;
                        issue('info', 'dpl-symbol-set',
                            sel
                                ? `y${sel[1]}${sel[2]} selects the ${kind} ${label}, which decides what every byte prints. The preview draws each byte by its Latin-1 value regardless, so non-ASCII characters may differ from the print.`
                                : `y selects a ${kind} that decides what every byte prints. The preview draws each byte by its Latin-1 value regardless, so non-ASCII characters may differ from the print.`,
                            letter);
                    } else if (!'cefpST'.includes(letter)) {
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
        // A Dotamax 7-bit ASCII image row — `80nndd…d` (Appendix O) — carries
        // NO rotation digit, so it is not a record at all. Read as one it came
        // out as a text field printing the hex digits of the bitmap, which is
        // the worst possible failure: the label shows the image's DATA instead
        // of the image. The rows normally follow an `<STX>I` that consumes
        // them; this catches the ones that do not, and the first digit being
        // outside the manual's 1-4 rotation range is what identifies them.
        if (/^8[0-9A-Fa-f]/.test(line) && line.length > 4) {
            // ... but only when the rest of the line really is a dot row: the
            // count field must agree with the data that follows it, or this is
            // an ordinary record beginning with an 8.
            const declared = parseInt(line.slice(2, 4), 16);
            const data = line.slice(4);
            if (Number.isFinite(declared) && declared * 2 === data.length && /^[0-9A-Fa-f]+$/.test(data)) {
                issue('info', 'dpl-image-row-orphan',
                    'This line is a row of dot data from an image download — the 80nn prefix is Appendix O\'s 7-bit ASCII image format, not a label record. No <STX>I in this stream introduces it, so the image it belongs to was never loaded and nothing is drawn.', 'I');
                continue;
            }
        }
        // The image terminator, "FFFF<CR>" (Appendix O). Left to the record
        // reader it was matched by the attribute shape and reported as an
        // unknown format attribute, which names a defect that is not there.
        if (line.toUpperCase() === 'FFFF') {
            issue('info', 'dpl-image-row-orphan',
                'FFFF terminates a Datamax image download. No <STX>I in this stream introduces one, so nothing is drawn for it.', 'I');
            continue;
        }

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
        //
        // WHICH FONT-9 FORM THIS IS DECIDES WHETHER THERE ARE EXTRA FIELDS AT
        // ALL, and the manual gives the two as SEPARATE record structures:
        //
        //   Table 8-7, Smooth Font:   eee `000-999, A04 to A72, x04 - x72`,
        //                             and no hhhh/iiii — the size IS `eee`.
        //   Table 8-8, Scalable Font: eee `S00 to Szz, U00-Uzz, u00-uzz`, with
        //                             hhhh/iiii "Character height/width;
        //                             points, dots" carrying the size.
        //
        // So `hhhh` is consumed only for the `S`/`U`/`u` forms. Consuming it on
        // every font-9 record ate the first eight characters of an `A36`
        // record's DATA, because that form has no such field — the manual's own
        // `x04-x72` note says where its size lives, and it is in `eee`.
        const scalableForm = /^[SUu]/.test(eee);
        let fontHeightField = '';
        if (bChar === DPL_SMOOTH_FONT && scalableForm) {
            const pair = /^([Pp]\d{3}|\d{4})([Pp]\d{3}|\d{4})/.exec(payload);
            if (pair) {
                fontHeightField = pair[1];
                payload = payload.slice(8);
            }
        }

        const row = positionToDots(num(ffff, 0) + rowOffset);
        const col = positionToDots(num(gggg, 0) + columnOffset);
        const rot = quadrantFromDpl(rotationDigit);

        // A <STX>S following this record replaces its data with a global
        // register's. If that register was never filled the record prints
        // NOTHING on the printer, so it must not be drawn with its placeholder
        // either — and unlike every other record, the data is taken from
        // somewhere else rather than read out of the line afterwards.
        // Searched BACKWARD for the nearest record, since the recall may sit
        // after intervening blank records.
        let recallRegister: string | null = null;
        for (let k = ci; k >= 0; k--) {
            if (recallFor.has(k)) { recallRegister = recallFor.get(k) as string; break; }
            if (cmds[k].name === '' && /^\d/.test(cmds[k].params)) break;
        }
        let recalled: string | null = null;
        if (recallRegister) {
            const idx = recallRegister.charCodeAt(0) - 65;
            recalled = globalRegisters[idx] ?? '';
            once(`recall-${recallRegister}`, 'info', 'dpl-global-recall',
                recalled === ''
                    ? `<STX>S${recallRegister} copies global register ${recallRegister} into this record, but the format never stores anything in that register, so the printer prints nothing here.`
                    : `<STX>S${recallRegister} copies global register ${recallRegister}'s data ("${recalled}") into this record at print time.`,
                'S');
        }
        if (recalled === '') continue;
        if (recalled !== null) payload = recalled;
        lastRecordData = payload.trim();

        // --- Graphic object (b = X): the DATA field describes the shape ---
        if (bChar === 'X') {
            // Every manual example writes the data field with spaces between
            // its sub-fields — "1 X 11 009 0100 0100 C 001 0001 0025" — and
            // every one of them is annotated "spaces have been added for
            // readability", so the real record has none. Both are read the
            // same way by dropping whitespace first: this field is all digits
            // and single letters, so a space can carry no meaning, and leaving
            // them in silently shifted every fixed offset after the first.
            const shape = payload.trim().replace(/\s+/g, '');
            const head = shape[0];
            if (head === undefined || shape === '') {
                issue('warning', 'dpl-shape-empty',
                    'A graphics record (b = X) carries the whole shape in its data field, and that field is empty here, so there is nothing to draw.', 'X');
                continue;
            }
            // "LINE*: Lhhhvvv", "BOX***: Bhhhvvvbbbsss" (manual p. 139). The
            // lowercase forms take four-digit fields instead of three.
            const isUpperForm = head === 'L' || head === 'B';
            const wLen = isUpperForm ? 3 : 4;
            const hLen = isUpperForm ? 3 : 4;
            const w = num(shape.slice(1, 1 + wLen), 0);
            const h = num(shape.slice(1 + wLen, 1 + wLen + hLen), 0);
            if (head === 'L' || head === 'l') {
                pendingShape = { kind: 'line', widthDots: positionToDots(w), heightDots: positionToDots(h), thicknessDots: Math.max(1, dotHeight) };
            } else if (head === 'B' || head === 'b') {
                const tIdx = 1 + wLen + hLen;
                const top = num(shape.slice(tIdx, tIdx + wLen), 1);
                pendingShape = { kind: 'box', widthDots: positionToDots(w), heightDots: positionToDots(h), thicknessDots: Math.max(1, positionToDots(top)) };
            } else if (head === 'C' || head === 'c') {
                // "1 X 11 fff rrrr cccc C ppp bbbb rrrr" (Table 8-14, p. 141).
                //
                // The header is NOT the usual row/column. Read against that
                // structure, the positional fields are fff = FILL PATTERN
                // (e, the slot eee sits in), rrrr = ROW OF THE CENTRE (f) and
                // cccc = COLUMN OF THE CENTRE (g); the data field is then
                // `C` + fill + a fixed 0001 + the radius:
                //
                //   1 X 11 009 0100 0100 C 001 0001 0025
                //
                // "a circle centered at row 0100, column 0100 with a radius of
                // 0025 and filled with pattern 9". The radius is one
                // measurement, so the shape is a circle — an ellipse with equal
                // axes.
                const body = shape.slice(1).replace(/^[A-Za-z]/, '');
                const cRow = num(ffff, 0);
                const cCol = num(gggg, 0);
                // body is `ppp` + `bbbb` + `rrrr` once the leading C is gone.
                const radius = num(body.slice(7, 11), 0);
                const fill = Math.trunc(num(eee, 0));
                if (radius <= 0) {
                    issue('warning', 'dpl-circle-radius', 'A circle record has a radius of zero, so there is nothing to draw.', 'X');
                } else {
                    const d = positionToDots(radius);
                    pendingShape = {
                        kind: 'circle',
                        widthDots: d * 2,
                        heightDots: d * 2,
                        thicknessDots: 1,
                        fillPattern: fill,
                        // The centre, not a corner: the record names the point
                        // the circle is drawn around.
                        centre: { row: positionToDots(cRow), col: positionToDots(cCol) },
                    };
                }
            } else if (head === 'P') {
                // "1 X 11 ppp rrrr cccc P ppp bbbb rrrr cccc rrrr cccc …"
                // (Table 8-13, p. 140). The first row/column pair is the
                // record's own and is point 1; everything after the `P` is a
                // fill pattern, a fixed `0001`, and then the remaining points as
                // row/column pairs — so the manual's triangle sample
                //
                //   1 X 11 000 0010 0010 P 001 0001 0040 0025 0010 0040
                //
                // is point 1 at (0010,0010), then `0040 0025` and `0010 0040`
                // after the fill and the fixed value: exactly the three corners
                // its figure shows. The fill and the fixed 0001 sit in the MIDDLE
                // of the point list and have to be skipped, not read as a
                // coordinate.
                const body = shape.slice(1);
                const fill = Math.trunc(num(body.slice(0, 3), 0));
                // The fill is three characters and the fixed value four, so the
                // points begin at 7. Reading from 6 worked only while the
                // manual's readability spaces were still in the string, which
                // silently re-grouped every coordinate once they were removed.
                const afterFixed = body.slice(7);
                const coords = (afterFixed.match(/\d{4}/g) ?? []).map(v => num(v, 0));
                const points = [{ row: num(ffff, 0), col: num(gggg, 0) }];
                // Pairs of row, column — a trailing odd value is not a point.
                for (let i = 0; i + 1 < coords.length; i += 2) {
                    points.push({ row: coords[i], col: coords[i + 1] });
                }
                if (points.length < 2) {
                    issue('warning', 'dpl-polygon-points',
                        `A polygon record lists ${points.length} point${points.length === 1 ? '' : 's'}; the manual draws a line from two, so nothing is drawn here.`, 'X');
                } else {
                    pendingShape = {
                        kind: 'polygon',
                        widthDots: 0,
                        heightDots: 0,
                        thicknessDots: 1,
                        fillPattern: fill,
                        points: points.map(p => ({
                            row: positionToDots(p.row + rowOffset),
                            col: positionToDots(p.col + columnOffset),
                        })),
                    };
                }
            } else {
                issue('info', 'dpl-graphic', `DPL graphics object "${head}" is not part of the supported subset; nothing is drawn for it.`, 'X');
            }
            const sh = pendingShape;
            pendingShape = null;
            if (sh) {
                if (sh.fillPattern) {
                    // The pattern is real and printed, but the IR has no fill
                    // model and the patterns are a mix of tones, hachures and
                    // shadings that no single stand-in covers — so the outline
                    // is drawn and the difference is named.
                    once(`fill-${sh.fillPattern}`, 'info', 'dpl-fill-pattern',
                        `A graphic record asks for fill pattern ${sh.fillPattern} (Table 8-15: tones, hachures and shadings). The preview draws the outline only, so the printed shape will be filled and this one is not.`, 'X');
                }
                if (sh.kind === 'line') {
                    elements.push({
                        kind: 'line', id: nextId++, ox: col, oy: row, f: rot,
                        lengthDots: Math.round(sh.widthDots),
                        thicknessDots: Math.round(sh.heightDots) || Math.round(sh.thicknessDots),
                    } as LineElement);
                } else if (sh.kind === 'circle' && sh.centre) {
                    // The corner is resolved in the flip pass, once the page
                    // height is known; the centre recorded here is in printer
                    // units exactly as the record gave it.
                    const id = nextId++;
                    pendingCircles.set(id, sh.centre);
                    elements.push({
                        kind: 'ellipse', id, ox: sh.centre.col, oy: sh.centre.row, f: rot,
                        widthDots: Math.round(sh.widthDots),
                        heightDots: Math.round(sh.heightDots),
                        thicknessDots: Math.round(sh.thicknessDots),
                    } as EllipseElement);
                } else if (sh.kind === 'polygon' && sh.points) {
                    // Points are absolute in the printer's space; the element's
                    // origin is the first of them, which is what the row flip
                    // then moves.
                    const first = sh.points[0];
                    elements.push({
                        kind: 'polygon', id: nextId++, ox: first.col, oy: first.row, f: rot,
                        points: sh.points.map(p => ({ x: p.col, y: p.row })),
                        thicknessDots: Math.round(sh.thicknessDots),
                    } as PolygonElement);
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
            if (payload.trim() === '') {
                issue('warning', 'dpl-empty-barcode',
                    `A ${bc.type.name} record has no data field, so there is nothing to encode. The header alone accounts for the whole line, which is also what a truncated record looks like.`, bChar);
            }
            // Table 8-3, "Bar Code Fields": "For module-based bar codes, field
            // d is the narrow bar width in dots (bar code module size) ... For
            // ratio-based bar codes field c is the wide bar width in dots (the
            // numerator); field d is the narrow bar width in dots (the
            // denominator)." So c and d are BOTH WIDTHS, in dots — the ratio is
            // the quotient, not c compared against a dot count.
            //
            // eee is the symbol height. ZERO IS NOT ZERO DOTS: "Unless
            // otherwise noted all bar codes depicted here were produced using
            // the ratio/module values of 00 and height fields of 000 to cause
            // the printer to produce symbols using DEFAULT bar widths and
            // height fields" (p. 181) — and that is how every example in the
            // appendix is written, so reading it as zero drew each of them as a
            // one-dot line.
            const heightDots = (num(eee, 0) > 0
                ? Math.max(1, Math.round(positionToDots(num(eee, 0))))
                : dplDefaultHeightDots(bField)) * barMagnification;
            const wideDots = dplMultiplierValue(cChar);
            const narrowDots = dplMultiplierValue(dChar);
            const moduleDots = Math.max(1, narrowDots) * dotWidth;
            // The IR's ratio codes: 2 = 2:1, 1 = 3:1, 0 = 2.5:1. The quotient
            // is rounded to the nearest of the documented ratios — Code 39
            // states "the expected ratio of wide to narrow bars can range from
            // 2:1 to 3:1", so the two are the whole range that matters here.
            const quotient = wideDots / Math.max(1, narrowDots);
            const ratio: 0 | 1 | 2 = quotient >= 3 ? 1 : quotient >= 2 ? 2 : 0;
            // Code 128 carries its own subset: "The default code subset is B;
            // otherwise, the first character (A, B, C) of the data field
            // determines the subset ... the printer will compute the optimal
            // packing" (Appendix G, p. 181). The letter is a MODE, not data —
            // bwip-js is given the subset directly, and leaving the letter in
            // the payload printed a stray character before the symbol.
            let barcodeData = payload.trim();
            if ((bc.type.symbology === '6' || bc.type.symbology === '15') && /^[ABC]/.test(barcodeData)) {
                barcodeData = barcodeData.slice(1);
            }
            // Appendix P: "For the printer to generate this checksum, a `V' must
            // be placed in the data stream in the position the checksum is
            // requested ... a checksum will be generated using the next five
            // digits" (p. 255). The V is a REQUEST, not data — it is replaced by
            // a digit the printer computes, so a payload carrying one cannot be
            // encoded as it stands.
            //
            // The checksum is computed "per the EAN/UPC bar code standard", and
            // with no DPL stream to check a reading against, guessing its
            // weighting would put a wrong digit into a price. So the V is named
            // and left where it is: the field reports, and nothing pretends to
            // have the value the printer would print.
            if (/V/i.test(barcodeData)) {
                issue('warning', 'dpl-price-checksum',
                    `This record places a "V" in its data, which asks the printer to compute and insert the EAN/UPC price-or-weight checksum at that position (Appendix P). The preview cannot reproduce that digit, so it is left as written and the symbol will not encode until it is provided.`, bChar);
            }
            elements.push({
                kind: 'barcode', id: nextId++, ox: col, oy: row, f: rot,
                symbology: bc.type.symbology,
                heightDots,
                moduleDots,
                ratio,
                // The letter names which EAN/UPC member this is, and the addenda
                // are their own symbols. Without it the variant is guessed from
                // the digit count, which fails on the manual's own records.
                ...(bc.type.eanVariant !== undefined ? { eanUpcVersion: bc.type.eanVariant } : {}),
                hri: bc.hri,
                source: { type: 'fixed', data: barcodeData },
            } as BarcodeElement);
            continue;
        }

        // --- Text: b = 0-8 internal bitmap, or 9 smooth/scalable ---
        if (/^[0-8]$/.test(bChar) || bChar === DPL_SMOOTH_FONT) {
            const text = payload;
            if (text === '') {
                // The header consumed the whole line, so the field is
                // deliberately empty. That is legitimate in DPL — a bar code
                // often draws its text from a neighbouring field and leaves its
                // own data blank — but it is also what a stream looks like when
                // its data was lost, so it is said at warning level rather than
                // passed over in silence.
                issue('warning', 'dpl-empty-text',
                    'A text record with an empty data field prints nothing. This is normal for a field that only reserves a slot, but it is also what a truncated record looks like.', bChar);
                continue;
            }
            const isSmooth = bChar === DPL_SMOOTH_FONT;
            const wMult = dplMultiplierValue(cChar) * dotWidth;
            const hMult = dplMultiplierValue(dChar) * dotHeight;
            if (isSmooth) {
                const code = eee.slice(0, 3);
                const ilpc = ILPC_FONT_NAMES[code.toUpperCase()];
                // The case is the addressing, so it is read from the code
                // itself rather than from the table — an option this build does
                // not know by name still has its hex spelling recognised.
                const hexAddressing = isHexAddressedCode(code);
                elements.push({
                    kind: 'text', id: nextId++, ox: col, oy: row, f: rot,
                    // Font 9 is the AGILE smooth/scalable face, drawn through the
                    // IR's outline path (c25) so the point size can be honoured.
                    font: '25', hMag: hMult, wMag: wMult,
                    pointSize: smoothPointFromSize(eee, fontHeightField),
                    source: { type: 'fixed', data: text },
                } as TextElement);
                if (hexAddressing) {
                    // Appendix Q's tables give each scalable option both a
                    // BINARY and a HEX-ASCII addressing, and the letter case is
                    // the switch: "U40" sends the bytes themselves while "u40"
                    // sends them as hex pairs. Both carry the same font code, so
                    // a case-sensitive lookup is what tells them apart.
                    issue('info', 'dpl-ilpc-hex-addressing',
                        `This ${ilpc.name} record addresses its characters in HEX ASCII (Appendix Q), so the preview shows the hex as written rather than the glyphs — the printer converts each pair into one double-byte character.`, bChar);
                } else if (/<[0-9A-Fa-f]{2}>/.test(payload)) {
                    // The manual writes its double-byte samples in a notation it
                    // explains in its own note: "The notation '<xx>' in this DPL
                    // file should be interpreted by the READER as representing
                    // the hexadecimal value of the byte sent to the printer." It
                    // is addressed to a person converting the sample, not to the
                    // printer, so it is NOT decoded here — the printer would
                    // print the notation as literally as this preview does. What
                    // it gets is the explanation, because a pasted sample whose
                    // glyphs come out as "<4D><3F>" is otherwise baffling.
                    issue('info', 'dpl-hex-notation',
                        'This data uses the "<xx>" notation from Appendix Q, which the manual asks the READER to convert into the byte it names — the printer would print these characters literally. Replace each <xx> with that byte to see the glyphs.', bChar);
                } else if (ilpc) {
                    issue('info', 'dpl-ilpc-font',
                        `This is the ${ilpc.name} option (Appendix Q), not the resident CG Triumvirate; the preview draws it with the outline face, so the glyphs will differ from the printer's.`, bChar);
                } else {
                    issue('info', 'dpl-smooth-font',
                        'DPL font 9 is the scalable CG Triumvirate; the preview draws it with the outline face, so glyph shapes differ from the printer\'s.', bChar);
                }
                continue;
            }
            const metric = DPL_FONTS[bChar] ?? FALLBACK_DPI_FONT;
            // J moves WHERE the string hangs off its point: right justification
            // puts the point at the string's right end (so the text runs left
            // from it) and centre puts it in the middle. The manual is explicit
            // that only the anchor moves and "the characters will not be
            // reversed", so this shifts the origin rather than mirroring.
            const textW = text.length * metric.width * wMult;
            const textCol = justification === 'left' ? col
                : justification === 'right' ? col - textW
                    : col - textW / 2;
            // The IR's bitmap fonts are IPL's cells, which are not DPL's. Pick
            // the closest by HEIGHT and let the multipliers carry the exact
            // ratio, the way the EPL parser does — leaving every DPL font on c0
            // would draw font 6 at a fifth of its size.
            const pick = closestIrFont(metric.height);
            const cell = IR_CELLS[pick];
            elements.push({
                kind: 'text', id: nextId++, ox: textCol, oy: row, f: rot,
                font: pick,
                // Round rather than truncate: a ratio of 1.87 is 2x magnification
                // on a cell that is nearly the right one, not 1x of a wrong one.
                hMag: Math.max(1, Math.round(hMult * (metric.height / cell.h))),
                wMag: Math.max(1, Math.round(wMult * (metric.width / cell.w))),
                source: { type: 'fixed', data: text },
            } as TextElement);
            continue;
        }

        // --- Image (b = Y), Table 8-11, p. 139 -------------------------------
        // "a = 1 Fixed Value; b = Y Image; c = 1 to 9, A to Z, and a to z Width
        // Multiplier; d = ... Height Multiplier; eee = 000 Fixed Value;
        // ffff = Row; gggg = Column; jj...j = ASCII string, up to 16 characters
        // followed by a termination character" — the image's name. "Images can
        // be printed only in Rotation 1."
        if (bChar === 'Y') {
            const name = payload.trim().split(/\s+/)[0] ?? '';
            const wMult = dplMultiplierValue(cChar);
            const hMult = dplMultiplierValue(dChar);
            const img = images.get(name);
            if (img) {
                // "Width Multiplier" and "Height Multiplier" scale the stored
                // bitmap, so each SOURCE dot becomes a wMult x hMult block —
                // the rows are therefore expanded rather than the destination
                // scaled, which keeps the dots square.
                const expanded: string[] = [];
                for (const row of img.rows) {
                    const line2 = Array.from({ length: img.widthDots }, (_, x) => {
                        const bit = (row.charCodeAt(x >> 3) >> (7 - (x & 7))) & 1;
                        return '0'.repeat(wMult - 1) + (bit ? '1' : '0');
                    }).join('');
                    // pack the expanded 1/0 string back into bytes
                    let packed = '';
                    for (let k = 0; k < line2.length; k += 8) {
                        packed += String.fromCharCode(parseInt(line2.slice(k, k + 8).padEnd(8, '0'), 2));
                    }
                    for (let rep = 0; rep < hMult; rep++) expanded.push(packed);
                }
                elements.push({
                    kind: 'graphic', id: nextId++, ox: col, oy: row, f: rot,
                    graphicId: nextId++,
                    widthDots: img.widthDots * wMult,
                    heightDots: expanded.length,
                    rows: expanded,
                    name,
                } as GraphicElement);
                continue;
            }
            issue('info', images.has(name) ? 'dpl-image-undecodable' : 'dpl-image-missing',
                images.has(name)
                    ? `The record prints the image "${name}", which was loaded as a binary raster file this preview cannot decode; a placeholder is drawn in its place.`
                    : `The record prints the image "${name}", but no <STX>I command in this stream loads it — the image lives in a printer memory module, which this preview does not have.`,
                bChar);
            // A named placeholder, so the label shows WHERE the image goes
            // rather than silently leaving the space empty.
            elements.push({
                kind: 'unknown', id: nextId++, ox: col, oy: row, f: rot,
                command: bChar, raw: payload.trim(), prefix: bChar,
            } as UnknownElement);
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
        const sz = estimateElementSize(el, dpiHint);
        contentMaxRow = Math.max(contentMaxRow, el.oy + sz.crossDots);
    }
    // DPL states no label WIDTH in the stream at all, and its one length
    // command is a fault-search distance rather than the media size — the
    // manual tells the programmer to set <STX>M to "2.5 to 3 times the actual
    // label length", so treating it as the page height would draw every label
    // two to three times too tall.
    const statedDots = continuousLengthUnits && continuousLengthUnits > 0
        ? Math.ceil(positionToDots(continuousLengthUnits))
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
        const sz = estimateElementSize(el, dpiHint);
        const moved = { ...el, oy: Math.max(0, pageDots - el.oy - sz.crossDots) };
        // A polygon's vertices and a circle's centre are ABSOLUTE, in the
        // printer's own counting-up rows, so they need the same flip the origin
        // gets. They were left in printer space once, which put them a whole
        // page-height away from the element they belong to. No crossDots here,
        // because a vertex is a point rather than an object with a height.
        if (moved.kind === 'polygon') {
            moved.points = moved.points.map(p => ({ x: p.x, y: Math.max(0, pageDots - p.y) }));
        }
        if (moved.kind === 'ellipse' && pendingCircles.has(el.id as number)) {
            const c = pendingCircles.get(el.id as number) as { row: number; col: number };
            const d = Math.max(0, pageDots - c.row);
            moved.ox = c.col - moved.widthDots / 2;
            moved.oy = d - moved.heightDots / 2;
        }
        return moved;
    });

    // ---- Inverse mode (A5) --------------------------------------------
    // "This mode allows inverse (white on black) printing" (manual p. 110,
    // Table 6-1). It is a page attribute rather than a per-field one, so the
    // whole label is drawn reversed — expressed as a reverse region over the
    // page, which is the same element TSPL's REVERSE and ZPL's ^FR use.
    if (currentAttribute === 5 && flipped.length > 0) {
        const maxX = flipped.reduce((m, el) => {
            const sz = estimateElementSize(el, dpiHint);
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
