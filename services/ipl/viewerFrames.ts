// Frame-level parsing primitives for the IPL viewer (split from
// viewerParser.ts): parameter splitting, print-block data extraction, code
// page timelines, and the shared tables/regexes. Pure functions and constants
// only — no parser state. The class in viewerParser.ts imports them back.
import { tokenizeFramesWithLines, maskFieldPayloads } from './tokenizer';
import type {
    ViewerLabel,
    ViewerElement,
    TextElement,
    BarcodeElement,
    FieldSource,
    PagePlacement,
} from './types';
import { isBarcodeEngineReady, measureBarcode, applyI2of5Padding, interpretiveText, IPL_UNPRINTABLE_SYMBOLOGIES } from './barcodes';
import { VirtualPrinter, KIND_PREFIX } from './virtualPrinter';
import { FONT_MAP, PRINTABLE_WIDTH_IN, LABEL_WIDTH_ADJUSTMENT } from '../../constants';
import { extractDirectGraphics, nibblizedToByteString, directGraphicToBitmap, directGraphicInkBounds, type DirectGraphic } from './directGraphics';
import { encodeBitmapColumns } from './graphics';
import { decodePrintData } from './residentCharset';

// Font ids known to the designer — derived from constants.FONT_MAP so the
// table cannot drift (audit T1; it used to be a hand-copied literal here).
export const KNOWN_FONTS = new Set(Object.keys(FONT_MAP));
export const OUTLINE_FONTS = new Set(
    Object.entries(FONT_MAP).filter(([, f]) => f.type === 'outline').map(([id]) => id),
);

// The point size an outline field falls back to when the stream gives it nothing
// to go on. `k` (Point Size, Set) is documented as "n = 12" for every printer
// (PRM 2.70 p.207), so that is the size the printer itself would use.
export const OUTLINE_DEFAULT_POINT_SIZE = 12;

// Frames are normalized by the tokenizer, so ESC always appears literally.
export const LITERAL_ESC = '<ESC>';

/**
 * Control characters that cannot print, stripped from a print block's captured
 * field data. A block's data is <ESC>F-delimited, so it is NOT masked by
 * maskFieldPayloads — the whole stream reaches this sweep — and it used to
 * clean only <ESC>/<US>/<RS>. Everything else (<EM> Abort Print Job, <DEL>
 * Clear Data From Current Field, <CR> Next Data Entry Field, and 20 more) was
 * captured as LITERAL TEXT and painted onto the label with no warning: a
 * field's data reading "AAAA<EM><DEL>".
 *
 * The names come from PRM 2.70's "Print Commands (t = 0)" table (p.250), not
 * from memory — an earlier hand-written list MISSED <CR> and <SI>, both of
 * which are commands in that table, and <CR> is exactly the character this
 * sweep exists to catch.
 *
 * <FS> and <GS> are deliberately EXCLUDED — they are the odometer's region
 * markers, read by resolveLabelAtBatch, and stripping them here would delete
 * the serial counters. Both spellings are covered: the literal placeholder and
 * the raw byte (a raw capture keeps \x1c/\x1d as bytes).
 *
 * LF (0x0A) is excluded from the raw-byte range too, but for a different
 * reason: this data model USES a real newline for a multi-line text field (the
 * generator emits <SUB><CR>, and the sweep above rewrites it to "\n"). A range
 * covering every byte from 0x00 would delete the newline it had just created —
 * which is exactly what the first cut of this fix did, silently collapsing
 * "AA\nBB" to "AABB". The <LF> PLACEHOLDER is still stripped: that is the
 * command, while the raw byte here is the data model's separator.
 */
export const IN_BLOCK_CONTROL_CHARS =
    /<(?:NUL|SOH|STX|ETX|EOT|ENQ|ACK|BEL|BS|HT|LF|VT|FF|CR|SO|SI|DLE|DC1|DC2|DC3|DC4|NAK|SYN|ETB|CAN|EM|SUB|RS|US|DEL)>|[\x00-\x09\x0b-\x1b\x1e\x1f\x7f]/g;

// Resource caps for untrusted streams. A hand-authored .ipl is small; a hostile
// one can declare a G raster or box spanning the full 5-digit field (x99999) or
// stream thousands of Direct-Graphics frames, each forcing a huge canvas alloc
// in the renderer. Clamp to physical-printhead-plausible maxima and report the
// clamp as an issue (never silently drop — that's the silent-failure this
// project exists to avoid).
export const MAX_GRAPHIC_DIM = 20000; // dots per axis — far beyond any real label
export const MAX_DG_FRAMES = 5000;    // RLE payload frames per graphic mode

export interface FieldParam {
    key: string;
    value: string;
}

/**
 * A field parameter that follows the fixed data: ONE lowercase letter with a
 * purely numeric value ("k12", "h3", "w2", "c25", "f0").
 *
 * This shape is what separates a parameter from ordinary text. "A;B",
 * "X;B2;Y" and "LOT;ROLLS" all fail it — an upper-case key, or letters inside
 * the value — so they stay data, which is what the greedy behaviour was
 * protecting in the first place.
 *
 * 'd' is excluded: a second `d` segment is malformed here, and re-reading it
 * as a param would be a guess.
 *
 * 'o' (Field Origin) is excluded too, and that is a decision rather than an
 * oversight — the manual puts origin FIRST in every example it gives. Of the 26
 * field commands in PRM 2.70 that carry d3, ALL 26 write `o` before the data
 * and NONE writes it after. `o` opens a field; it is not a trailing modifier
 * like k/h/w/f/r. Admitting it would buy a shape the manual never produces and
 * would cost correctness on real text — "d3,REF;o9" is a part number, and
 * splitting it there truncates the printed value. (This docstring used to list
 * "o10,40" as an example of the shape while the class excluded it; the comment
 * was wrong, not the class.)
 *
 * 'g' (Pitch Size, Set) belongs in the set and was missing. It is a real
 * human-readable parameter — the manual's own task table lists it under
 * "Human-Readable Field Editing Commands" (PRM pp.92-95) with "Syntax: gn",
 * default 12, range 1-50, and parseTextField reads it as `pitchParam`. Because
 * it failed this regex, a pitch written after the data printed as text:
 *
 *   <STX>H1;o10,10;c0;h2;w2;d3,AB;g10<ETX>   drew the literal "AB;g10"
 *
 * That is the same defect class the rule exists for — a real parameter read as
 * data — and unlike 'l'/'x'/'y' (whose field types do not take d3 at all) 'g'
 * is reachable in the documented shape. The set here is still narrow: it
 * admits one lowercase letter with a numeric value, so "A;B", "LOT;ROLLS" and
 * "X;B2;Y" all continue to stay text.
 */
export const FIELD_PARAM_AFTER_DATA = /^[abcefghijkmnpqrstuwz][\d,.\-]+$/;

/**
 * `p` (Code 39 Prefix Character, PRM p.181) is the ONE field parameter whose
 * value is not numeric: `p[n1][n2][n3][n4]` takes up to four characters from
 * "A to Z (uppercase only) and 0 to 9", or a leading '@' meaning "clears all
 * prefixes". It therefore fails FIELD_PARAM_AFTER_DATA, and a trailing
 * `pABC4` after d3 was read as part of the PRINTED TEXT — the field drew
 * "123;pABC4" where the printer draws "123" with an ABC4 prefix on the bars.
 *
 * Pinned to the manual's own alphabet and length so ordinary text ending in
 * ";p…" still stays data: a lowercase letter, a fifth character, or any
 * punctuation other than a leading '@' all fail this and remain text.
 */
export const CODE39_PREFIX_AFTER_DATA = /^p(?:@|[A-Z0-9]{1,4})$/;

export const splitParams = (body: string): FieldParam[] => {
    // d3 (fixed text) is greedy up to a POINT parameter: everything after `d3,`
    // is the payload, ';' included, because splitting it by ';' truncated 'A;B'
    // to 'A' and silently dropped real data.
    //
    // But the manual puts parameters AFTER the data too. Its own example
    // (PRM 2.70 p.109) is "<STX>H0;o35,40;c25;d3,Cat.;k12;<ETX>" — the point
    // size comes last. Reading the whole tail as text made the field print
    // "Cat.;k12" and silently dropped k (and h/w/r/f when present), so the
    // preview showed text the printer never produces.
    //
    // Resolution: strip a TRAILING run of well-formed parameters, keep
    // everything before it as data. Only a trailing run, so a param-looking
    // segment in the middle of intended text cannot split it.
    const di = body.search(/(?:^|;)d3,/);
    if (di >= 0) {
        const head = body.slice(0, di).replace(/;$/, '');
        // +4 skips 'd3,' itself. A single trailing ';' is the customary frame
        // separator (generator and BarTender both end the last param with it),
        // not part of the text — strip exactly one.
        const tail = body.slice(di + 4).replace(/;$/, '');
        const segs = tail.split(';');
        let cut = segs.length;
        while (cut > 0 && (FIELD_PARAM_AFTER_DATA.test(segs[cut - 1]) || CODE39_PREFIX_AFTER_DATA.test(segs[cut - 1]))) cut--;
        const data = segs.slice(0, cut).join(';');
        const params = head.length > 0 ? splitParamsPlain(head) : [];
        for (const seg of segs.slice(cut)) {
            params.push({ key: seg.charAt(0), value: seg.slice(1) });
        }
        params.push({ key: 'd', value: `3,${data}` }); // resolveSource wants the '3,' prefix
        return params;
    }
    return splitParamsPlain(body);
};

export const splitParamsPlain = (body: string): FieldParam[] =>
    body
        .split(';')
        .filter(p => p.length > 0)
        .map(p => ({ key: p.charAt(0), value: p.substring(1) }));

export const parseOrigin = (value: string): { x: number; y: number } => {
    const [x, y] = value.split(',').map(n => parseInt(n, 10));
    return { x: isNaN(x) ? 0 : x, y: isNaN(y) ? 0 : y };
};


/**
 * Offsets (and optionally rotates) a format's elements into page coordinates.
 * Rotation q rotates the whole format around its own origin (0,0) — matching
 * the manual's "Format Direction in a Page" semantics — then the O offset is
 * applied in page space.
 */
export const applyPlacement = (el: ViewerElement, p: PagePlacement): ViewerElement => {
    // Always copy: a format placed more than once must not alias one shared
    // element object across placements (later mutation would leak between them).
    if (p.rotation === 0 && p.offsetX === 0 && p.offsetY === 0) return { ...el };
    const rot = (dx: number, dy: number): { x: number; y: number } => {
        switch (p.rotation) {
            case 1: return { x: -dy, y: dx };       // 90° CCW
            case 2: return { x: -dx, y: -dy };      // 180°
            case 3: return { x: dy, y: -dx };       // 270° CCW
            default: return { x: dx, y: dy };
        }
    };
    const r = rot(el.ox, el.oy);
    const nx = r.x + p.offsetX;
    const ny = r.y + p.offsetY;
    const nf = (el.f + p.rotation) % 4;
    return { ...el, ox: nx, oy: ny, f: nf };
};



/**
 * One `<ESC>F<id>` slice of a print block: the data the host sent for that
 * field, plus the odometer step the field was given.
 */
export interface PrintBlockEntry {
    data: string;
    /**
     * Signed step from `<ESC>In` / `<ESC>Dn` found inside THIS field's slice
     * (positive increments, negative decrements), or 0 when `<ESC>N` cleared
     * the field's flags. Undefined when the field set no step of its own.
     *
     * The step is per field, not per job: PRM p.104 "Sets the increment value
     * for the selected field", p.103 the same for decrement, p.97 "Each region
     * independently increments or decrements according to the increment or
     * decrement value specified for the field". A job may therefore advance one
     * field upward by 1 while another runs downward by 10.
     */
    serialStep?: number;
}

/**
 * Reads the odometer step a field's slice assigns it, in command order: a
 * later `<ESC>In`/`<ESC>Dn` supersedes an earlier one, and `<ESC>N` (PRM p.109
 * "Resets any increment or decrement flags for the current field") clears
 * whatever came before it.
 *
 * A bare `<ESC>I` with no value is malformed — the syntax is `<ESC>In where n
 * is the increment value` — so it leaves the step untouched rather than
 * inventing the documented default of 1.
 */
export const readFieldStep = (slice: string): number | undefined => {
    let step: number | undefined;
    const re = /(?:<ESC>|\x1b)([IDN])(\d*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(slice)) !== null) {
        if (m[1] === 'N') { step = 0; continue; }
        if (m[2] === '') continue;
        step = m[1] === 'I' ? parseInt(m[2], 10) : -parseInt(m[2], 10);
    }
    return step;
};

/**
 * Control characters inside a print block's field data that CHANGE what the
 * field prints, for reporting. They are stripped either way (a control
 * character is not printable text), but these make the preview differ from the
 * printer, so silence about them would be the exact failure this project
 * fights.
 *
 * The other control commands (<BEL> error code, <ENQ> status, <BS> warm boot,
 * the DC1-3 handshakes, …) are status/comms: they cannot change the label, so
 * they are stripped without a word. That split is why this returns only the
 * output-changing few rather than every control character it removed.
 *
 * Names and semantics from PRM 2.70's "Print Commands (t = 0)" table (p.250)
 * and the definition bodies:
 *   <EM>  p.91  "Stops batch printing" — a job that is aborted prints fewer
 *               labels than the preview shows.
 *   <DEL> p.98  "Deletes data from the current field" — the field prints
 *               empty here, not with the data the block carries.
 *   <CR>  p.111 "Moves the field pointer to the next data entry field" — the
 *               following data belongs to a DIFFERENT field than the one this
 *               viewer bound it to.
 *   <DLE> p.92  "Executes a printer power-up reset immediately… erases all
 *               data and commands in the input buffer" — the job does not
 *               print at all, so this is more destructive than <EM>.
 *   <SI>  p.250 is 0x0F "Go to Shift Command Table" in the t=0 print table,
 *               and a Shift command "must precede these commands with" it
 *               (p.252) — so "<SI>W812" inside block data is a SETUP command.
 *               This viewer strips it and does NOT apply it, so the geometry
 *               the printer would use differs from the preview's.
 *
 * NOT here, and the manual is explicit about why: <BS> (p.118) is a warm boot
 * that "does not take effect immediately. The printer executes all previous
 * commands before the warm boot takes effect" — the label still prints, so it
 * cannot change the output and stays silent. That is the reason the immediate
 * commands cannot be lumped together: three of them (EM/DEL/DLE) change what
 * prints and one (BS) does not.
 */
export const BLOCK_COMMANDS_THAT_CHANGE_OUTPUT: Array<[RegExp, string]> = [
    [/<EM>|\x19/, '<EM>'],
    [/<DEL>|\x7f/, '<DEL>'],
    // NOT preceded by <SUB>: "<SUB><CR>" is Data Shift escaping a CR into data
    // (this project's own newline convention, emitted by the generator for a
    // text-field \n), so it is a literal character and not the "next field"
    // command. Reporting it would fire on every multi-line label.
    [/(?<!<SUB>)<CR>|(?<!\x1a)\x0d/, '<CR>'],
    // A <DLE> is the Reset command (p.92). A DOUBLED <DLE> still resets, and
    // the manual is unusually explicit: "<STX><DLE><DLE><ETX> ... the first
    // DLE is a transparency character. It instructs the printer to use the
    // <DLE> as a reset command." The escapes that turn a DLE into DATA are
    // removed before this list runs (see withoutDataShiftEscapes).
    [/<DLE>|\x10/, '<DLE>'],
    // Reached only when NOT escaped: <SUB><SI> is Data Shift turning the SI
    // into a literal character (p.99 lists <SI> among the escapable ones), and
    // withoutDataShiftEscapes removes that pair before this list runs.
    [/<SI>|\x0f/, '<SI>'],
];

/**
 * Removes Data Shift escapes from a raw field slice, so what remains is only
 * characters that ARE commands rather than data.
 *
 * <SUB> (p.99) escapes EVERY command character except <DC1>/<DC3>/<STX>/<ETX>,
 * so "<SUB>" + anything is an escape pair and is consumed whole.
 *
 * <DLE> (p.100) is the reverse: it escapes exactly those four. But it is ALSO
 * the Reset command on its own, and the manual's own example
 * ("<STX><DLE><DLE><ETX>", p.92) shows a DOUBLED <DLE> still performing the
 * reset. So only a <DLE> followed by one of the four is an escape; any other
 * <DLE> — bare, doubled, or before an unrelated field byte — is a command and
 * must survive this function to be reported.
 */
export const withoutDataShiftEscapes = (slice: string): string =>
    slice
        .replace(/<SUB>(?:<[A-Z]{2,4}>|[\s\S])|\x1a[\s\S]/g, '')
        .replace(/<DLE>(?=<(?:STX|ETX|DC1|DC3)>)/g, '')
        .replace(/\x10(?=[\x02\x03\x11\x13])/g, '');

/** Which output-changing control commands appear in a block field's raw slice. */
export const findBlockControlChars = (slice: string): string[] => {
    const effective = withoutDataShiftEscapes(slice);
    return BLOCK_COMMANDS_THAT_CHANGE_OUTPUT
        .filter(([re]) => re.test(effective))
        .map(([, name]) => name);
};

/** Why each reported command makes the preview differ from the printer. */
export const BLOCK_COMMAND_EFFECTS: Record<string, string> = {
    '<EM>': 'it aborts the print job, so fewer labels come out than this preview shows',
    '<DEL>': "it clears the field's data, so the printer prints the field empty",
    '<CR>': 'it moves the field pointer, so the printer puts this data in a different field',
    '<DLE>': 'it resets the printer and erases its input buffer, so the job does not print at all',
    '<SI>': 'it selects the shift command table for the command that follows, which this preview does not apply — so the geometry here may differ from the print',
};

/**
 * Extracts variable-field data from EVERY print block, keyed by the format id
 * its <ESC>E<id> invocation names (blocks without one key to 0). Scoping by
 * format matters: a page composing formats 1 and 2 (each with its own field 1)
 * would otherwise feed format 1's data to both.
 *
 * `codePageAt(offset) -> number | undefined` gives the printer language in
 * effect AT each block, not the stream's final value: a job that switches
 * language between labels must decode each block with the page it was sent
 * under. A single page number would render the first label with the second
 * label's characters.
 */
export const extractPrintBlockData = (
    code: string,
    codePageAt: (offset: number) => number | undefined = () => undefined,
    onBlockCommand?: (cmd: string) => void,
): Map<number, Map<number, PrintBlockEntry>> => {
    const byFormat = new Map<number, Map<number, PrintBlockEntry>>();
    // Optional <ESC>E<id> prefix (both notations); terminator <ETB>/<RS>/<FF>.
    //
    // Each terminator is guarded against being the TARGET of a Data Shift
    // escape: PRM p.99-100's own example prints control codes as data
    // ("<SUB><ETB> <SUB><CAN> ... <SUB><FS> <SUB><GS> <SUB><RS> <SUB><US>"), so
    // an escaped terminator is a literal character the field prints, not the
    // end of the block. Without the lookbehind the block ended early and threw
    // the rest of the field's data away — "AB<SUB><FF>CD" captured as "AB".
    const blockTerminator =
        /(?:(?<!<SUB>)(?<!\x1a)(?:<(?:ETB|RS|FF)>|[\x17\x1e\x0c]))/;
    const blockRe = new RegExp(
        '(?:<ESC>E(\\d*)|\\x1bE(\\d*))?(?:<CAN>|\\x18)([\\s\\S]*?)' + blockTerminator.source,
        'gi',
    );
    let bm: RegExpExecArray | null;
    while ((bm = blockRe.exec(code)) !== null) {
        const formatId = parseInt(bm[1] ?? bm[2] ?? '0', 10) || 0;
        const codePage = codePageAt(bm.index);
        const block = bm[3]
            .replace(new RegExp(LITERAL_ESC, 'g'), '\x1b')
            .replace(/<NUL>/g, '\x00');
        const fields = byFormat.get(formatId) ?? new Map<number, PrintBlockEntry>();
        const fieldRegex = /\x1bF(\d+)\x00([\s\S]*?)(?=\x1bF\d+\x00|$)/g;
        let m: RegExpExecArray | null;
        while ((m = fieldRegex.exec(block)) !== null) {
            // Read the step before stripping: it lives in the same slice, and
            // the strip below removes it from the printable data.
            const serialStep = readFieldStep(m[2]);
            // Strip in-block printer commands and control characters from the
            // captured data; they configure the job, they are not printable
            // text. A print block bypasses maskFieldPayloads (its data is
            // <ESC>F-delimited, so the d3 masking rule does not apply), and it
            // used to clean only <ESC>/<US>/<RS> — so <EM> (abort), <DEL>
            // (clear field), <CR> (next field) and 20 others were captured as
            // LITERAL TEXT and painted onto the label, with no warning at all.
            const cleaned = m[2]
                .replace(/<ESC>[A-Z]\d*/g, '')
                .replace(/\x1b[A-Z]\d*/g, '')
                // Data Shift escapes are consumed FIRST, before any other strip.
                // They must be: "<SUB><RS>" is a literal RS escaped into data,
                // and if the <RS> strip below ran first it would delete the RS
                // and leave a bare <SUB> that then ate the NEXT real character —
                // "AB<SUB><RS>CD" lost its C that way.
                //
                // <SUB> is Data Shift (PRM p.99): it escapes the NEXT character
                // into data, so "<SUB><GS>" is a LITERAL GS that prints as a
                // character — NOT an alphanumeric field separator. The pair is
                // consumed together; dropping only the <SUB> would leave a <GS>
                // standing, turning data into a live odometer region the printer
                // never intended.
                //
                // <SUB><CR> is this project's own newline convention (the
                // generator emits it for a text-field \n), so it becomes a real
                // newline rather than being dropped with the rest.
                //
                // The escaped character is one LOGICAL character: a whole <XXX>
                // placeholder or one raw byte.
                .replace(/<SUB><CR>|\x1a\r/g, '\n')
                .replace(/<SUB>(?:<[A-Z]{2,4}>|[\s\S])|\x1a[\s\S]/g, '')
                // <DLE> escaping <STX>/<ETX>/<DC1>/<DC3> into data (p.100).
                .replace(/<DLE>(?=<(?:STX|ETX|DC1|DC3)>)/g, '')
                .replace(/\x10(?=[\x02\x03\x11\x13])/g, '')
                .replace(/<(US|RS)>\d*/g, '')
                .replace(/[\x1f\x1e]\d*/g, '')
                // An <SI> setup command goes WITH its command letter and
                // argument. <SI> is 0x0F "Go to Shift Command Table" (PRM
                // p.250, the t=0 print table), and a Shift command "must precede
                // these commands with" it (p.252) — so "<SI>W812" is ONE
                // command, not an <SI> to drop plus a literal "W812" to print.
                // Stripping only the <SI> left the argument behind as TEXT:
                // "AB<SI>W812" painted "ABW812".
                //
                // AFTER the Data Shift block above, never before: "<SUB><SI>" is
                // an escaped SI that PRINTS as a character, and stripping the SI
                // first would leave a bare <SUB> to eat the next real character.
                //
                // The letter is consumed only when an ARGUMENT follows it, so
                // "<SI>CD" (an SI with no argument, then text) keeps its C.
                .replace(/<SI>[A-Z][-\d,.]+|<SI>/g, '')
                .replace(/\x0f[A-Z][-\d,.]+|\x0f/g, '')
                .replace(IN_BLOCK_CONTROL_CHARS, '');
            // Removing a command is right (it is not printable text), but doing
            // it SILENTLY is the failure mode this project exists to prevent:
            // three of these change what prints — <EM> aborts the job, <DEL>
            // clears the field's data, <CR> moves the field pointer — so the
            // preview differs from the printer and must say why. Collected here
            // and reported by the caller, which owns the issue sink.
            for (const hit of findBlockControlChars(m[2])) onBlockCommand?.(hit);
            fields.set(parseInt(m[1], 10), { data: decodePrintData(cleaned, codePage), serialStep });
        }
        if (fields.size > 0) byFormat.set(formatId, fields);
    }
    return byFormat;
};

/**
 * Maps each byte offset to the printer language in effect there, by replaying
 * every `<SI>l` in stream order. A multi-language job switches page between
 * labels, so a single final value would decode earlier blocks wrongly.
 */
export const buildCodePageTimeline = (code: string): Array<{ at: number; page: number }> => {
    const marks: Array<{ at: number; page: number }> = [];
    const re = /<SI>l(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) marks.push({ at: m.index, page: parseInt(m[1], 10) });
    return marks;
};
