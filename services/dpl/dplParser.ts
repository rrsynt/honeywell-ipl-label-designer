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
        .replace(/<LF>/gi, '\n');
    for (const line of text.split(/\r\n|\r|\n/)) {
        if (line === '') continue;
        const parts = line.split('\x02');

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

            if (markerText !== null && !/^[A-Za-z]/.test(stx)) {
                // An attention-getter that is not followed by a command letter
                // CLOSES the time string, and the rest of the line is data
                // again. The whole segment is kept, leading space included.
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
export const parseDPL = (code: string, labelLengthDots?: number, now: Date = new Date()): ViewerLabel => {
    const issues: ViewerIssue[] = [];
    const elements: ViewerElement[] = [];
    let nextId = 1;

    const issue = (level: ViewerIssue['level'], code_: string, message: string, command?: string) =>
        issues.push({ level, code: code_, message, command });
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

    /** DPL position units -> dots. Hundredths of an inch, or tenths of a mm. */
    const positionToDots = (units: number, dpi: number): number =>
        metric ? (units / 10) * (dpi / 25.4) : (units / 100) * dpi;

    const cmds = tokenizeDpl(code, now);

    /**
     * Which records a `<STX>S` fills, keyed by the record's token index.
     *
     * The manual writes the recall AFTER the record it fills, on the next line:
     * `121100000000000Testing<CR>G<CR>1A2210001000000<STX>SA` (p. 126). So the
     * pairing is a lookahead over the token list, and it is the PRECEDING
     * RECORD that identifies the special command rather than the System-Level
     * `<STX>S` (Set Feed Speed) the manual warns not to confuse it with
     * (p. 125) — a record can only exist inside a label format, so a record
     * immediately before the sigil settles it with no state to thread.
     *
     * Values are deliberately NOT read here: a register is filled by an earlier
     * `G`, so it can only be resolved when the main loop reaches the record.
     */
    const recallFor = new Map<number, string>();
    for (let i = 1; i < cmds.length; i++) {
        const c = cmds[i];
        if (c.name !== 'S' || !/^[A-P]$/.test(c.params)) continue;
        const prev = cmds[i - 1];
        if (prev.name === '' && /^\d/.test(prev.params)) recallFor.set(i - 1, c.params);
    }

    for (let ci = 0; ci < cmds.length; ci++) {
        const cmd = cmds[ci];
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
                case 'P': settings.printSpeed = Math.trunc(num(rest, 0)); break;
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
                    if (!'cefpST'.includes(letter)) {
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
            const shape = payload.trim();
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
            if (payload.trim() === '') {
                issue('warning', 'dpl-empty-barcode',
                    `A ${bc.type.name} record has no data field, so there is nothing to encode. The header alone accounts for the whole line, which is also what a truncated record looks like.`, bChar);
            }
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
