import { tokenizeFramesWithLines, maskFieldPayloads } from './tokenizer';
import type {
    ViewerLabel,
    ViewerElement,
    TextElement,
    BarcodeElement,
    FieldSource,
    PagePlacement,
} from './types';
import { isBarcodeEngineReady, measureBarcode, applyI2of5Padding, interpretiveText } from './barcodes';
import { VirtualPrinter, KIND_PREFIX } from './virtualPrinter';
import { FONT_MAP, PRINTABLE_WIDTH_IN, LABEL_WIDTH_ADJUSTMENT } from '../../constants';
import { extractDirectGraphics, nibblizedToByteString, directGraphicToBitmap, directGraphicInkBounds, type DirectGraphic } from './directGraphics';
import { encodeBitmapColumns } from './graphics';
import { decodePrintData } from './residentCharset';

// Font ids known to the designer — derived from constants.FONT_MAP so the
// table cannot drift (audit T1; it used to be a hand-copied literal here).
const KNOWN_FONTS = new Set(Object.keys(FONT_MAP));
export const OUTLINE_FONTS = new Set(
    Object.entries(FONT_MAP).filter(([, f]) => f.type === 'outline').map(([id]) => id),
);

// Frames are normalized by the tokenizer, so ESC always appears literally.
const LITERAL_ESC = '<ESC>';

// Resource caps for untrusted streams. A hand-authored .ipl is small; a hostile
// one can declare a G raster or box spanning the full 5-digit field (x99999) or
// stream thousands of Direct-Graphics frames, each forcing a huge canvas alloc
// in the renderer. Clamp to physical-printhead-plausible maxima and report the
// clamp as an issue (never silently drop — that's the silent-failure this
// project exists to avoid).
const MAX_GRAPHIC_DIM = 20000; // dots per axis — far beyond any real label
const MAX_DG_FRAMES = 5000;    // RLE payload frames per graphic mode

interface FieldParam {
    key: string;
    value: string;
}

const splitParams = (body: string): FieldParam[] => {
    // d3 (fixed text) is greedy: everything after `d3,` is the payload, ';'
    // included. Both this app's generator and BarTender emit d3 last in the
    // field, and the printer treats the origin onward as raw data — splitting
    // it by ';' truncated 'A;B' to 'A' and silently dropped real data.
    const di = body.search(/(?:^|;)d3,/);
    if (di >= 0) {
        const head = body.slice(0, di).replace(/;$/, '');
        // +4 skips 'd3,' itself. A single trailing ';' is the customary frame
        // separator (generator and BarTender both end the last param with it),
        // not part of the text — strip exactly one.
        const data = body.slice(di + 4).replace(/;$/, '');
        const params = head.length > 0 ? splitParamsPlain(head) : [];
        params.push({ key: 'd', value: `3,${data}` }); // resolveSource wants the '3,' prefix
        return params;
    }
    return splitParamsPlain(body);
};

const splitParamsPlain = (body: string): FieldParam[] =>
    body
        .split(';')
        .filter(p => p.length > 0)
        .map(p => ({ key: p.charAt(0), value: p.substring(1) }));

const parseOrigin = (value: string): { x: number; y: number } => {
    const [x, y] = value.split(',').map(n => parseInt(n, 10));
    return { x: isNaN(x) ? 0 : x, y: isNaN(y) ? 0 : y };
};


/**
 * Offsets (and optionally rotates) a format's elements into page coordinates.
 * Rotation q rotates the whole format around its own origin (0,0) — matching
 * the manual's "Format Direction in a Page" semantics — then the O offset is
 * applied in page space.
 */
const applyPlacement = (el: ViewerElement, p: PagePlacement): ViewerElement => {
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
): Map<number, Map<number, string>> => {
    const byFormat = new Map<number, Map<number, string>>();
    // Optional <ESC>E<id> prefix (both notations); terminator <ETB>/<RS>/<FF>.
    const blockRe = /(?:<ESC>E(\d*)|\x1bE(\d*))?(?:<CAN>|\x18)([\s\S]*?)(?:<(?:ETB|RS|FF)>|[\x17\x1e\x0c])/gi;
    let bm: RegExpExecArray | null;
    while ((bm = blockRe.exec(code)) !== null) {
        const formatId = parseInt(bm[1] ?? bm[2] ?? '0', 10) || 0;
        const codePage = codePageAt(bm.index);
        const block = bm[3]
            .replace(new RegExp(LITERAL_ESC, 'g'), '\x1b')
            .replace(/<NUL>/g, '\x00');
        const fields = byFormat.get(formatId) ?? new Map<number, string>();
        const fieldRegex = /\x1bF(\d+)\x00([\s\S]*?)(?=\x1bF\d+\x00|$)/g;
        let m: RegExpExecArray | null;
        while ((m = fieldRegex.exec(block)) !== null) {
            // Strip in-block printer commands (<ESC>x, <US>/<RS> counts, raw
            // control bytes) from the captured data; they configure the job, not
            // print as text.
            const cleaned = m[2]
                .replace(/<ESC>[A-Z]\d*/g, '')
                .replace(/\x1b[A-Z]\d*/g, '')
                .replace(/<(US|RS)>\d*/g, '')
                .replace(/[\x1f\x1e]\d*/g, '')
                .replace(/<SUB><CR>/g, '\n');
            fields.set(parseInt(m[1], 10), decodePrintData(cleaned, codePage));
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
const buildCodePageTimeline = (code: string): Array<{ at: number; page: number }> => {
    const marks: Array<{ at: number; page: number }> = [];
    const re = /<SI>l(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) marks.push({ at: m.index, page: parseInt(m[1], 10) });
    return marks;
};

export class IPLViewerParser {
    /**
     * All mutable parse state lives in the VirtualPrinter (two-phase model:
     * commands mutate pending state / commit elements; see virtualPrinter.ts).
     * A fresh printer is constructed per parse() call.
     */
    private printer = new VirtualPrinter();

    /**
     * Target printer model/resolution for this parse. Held on the parser, not
     * the printer, because parse() builds a fresh VirtualPrinter per call and
     * would otherwise drop them.
     */
    private driverModel: string | null = null;
    private driverDpi: 203 | 300 | 406 | null = null;

    /**
     * Page orientation and height. The driver writes Direct Graphics origins in
     * different frames per orientation, and the stream records neither, so both
     * are inputs rather than deductions.
     */
    private pageOrientation: 'portrait' | 'landscape' | null = null;
    private pageHeightDots: number | null = null;

    /** Sets the target printer, which Direct Graphics placement may need. */
    setDriver(model: string | undefined, dpi: 203 | 300 | 406 | undefined): void {
        this.driverModel = model ?? null;
        this.driverDpi = dpi ?? null;
    }

    /** Sets the page description Direct Graphics placement may need. */
    setPage(orientation: 'portrait' | 'landscape' | undefined, pageHeightDots: number | undefined): void {
        this.pageOrientation = orientation ?? null;
        this.pageHeightDots = pageHeightDots ?? null;
    }

    parse(code: string): ViewerLabel {
        this.printer = new VirtualPrinter();
        this.printer.pageOrientation = this.pageOrientation;
        this.printer.pageHeightDots = this.pageHeightDots;
        this.printer.driverModel = this.driverModel;
        this.printer.driverDpi = this.driverDpi;

        const frames = tokenizeFramesWithLines(code);
        if (frames.length === 0) {
            this.printer.issue('error', 'empty-input', 'No IPL frames found. Expected <STX>...<ETX> commands.');
            return this.printer.label;
        }

        for (const frame of frames) {
            this.printer.currentLine = frame.line;
            this.parseFrame(frame.content);
        }
        this.printer.currentLine = undefined;
        // A stream that ends inside Direct Graphics mode (no 0x28
        // end-of-bitmap) still deserves its partial decode — report it.
        if (this.printer.directGraphicsMode !== null && this.printer.directGraphicsFrames.length > 0) {
            this.printer.issue('warning', 'direct-graphics-unterminated', `Direct Graphics mode (<ESC>g${this.printer.directGraphicsMode}) was entered but the stream ended before the end-of-bitmap command (0x28). Decoding what arrived.`);
            this.decodeDirectGraphics();
            this.printer.directGraphicsMode = null;
            this.printer.directGraphicsFrames = [];
        }

        // Job-level commands scanned over the WHOLE stream (quantity, batch
        // count, odometer step). d3 fixed-text payloads are blanked first
        // (maskFieldPayloads): greedy-parsed text may literally contain
        // "<RS>50" or "<ESC>I9" — that is what the label SAYS, not what the
        // job does. Print blocks (<CAN>) keep their real <RS>/<ESC>I.
        const jobCode = maskFieldPayloads(code);

        // Repeat count from the print block
        const rsMatch = /(?:<RS>|\x1e)(\d+)/.exec(jobCode);
        if (rsMatch) this.printer.label.settings.quantity = parseInt(rsMatch[1], 10);

        // Copies per batch (<US>n): total labels = batches x copies (PRM p.93).
        const usMatch = /(?:<US>|\x1f)(\d+)/.exec(jobCode);
        if (usMatch) this.printer.label.settings.batchCount = parseInt(usMatch[1], 10);

        // Increment/decrement steps, applied to <FS>/<GS> regions once per
        // batch after it prints (PRM pp.98-99). <ESC>N resets both.
        const inc = /(?:<ESC>I|\x1bI)(\d*)/.exec(jobCode.replace(new RegExp(LITERAL_ESC, 'g'), '\x1b'));
        if (inc && inc[1] !== '') this.printer.label.settings.increment = Math.min(parseInt(inc[1], 10) || 1, 9999);
        const dec = /(?:<ESC>D|\x1bD)(\d*)/.exec(jobCode.replace(new RegExp(LITERAL_ESC, 'g'), '\x1b'));
        if (dec && dec[1] !== '') this.printer.label.settings.decrement = Math.min(parseInt(dec[1], 10) || 1, 9999);

        if (this.printer.label.elements.length === 0 && this.printer.pendingDirectGraphics.length === 0 && !this.printer.hasIssue('no-format')) {
            this.printer.issue(
                'error',
                'no-fields',
                'No printable fields found. Expected a format block: <STX><ESC>P<ETX> ... <STX>E1;F1<ETX> ... fields ... <STX>R<ETX>',
            );
        }

        // Attach print-block data to variable fields by field number, scoped to
        // the format the data was sent for (a page may compose several formats
        // that reuse the same field ids). A 0-keyed block (no <ESC>E id) or a
        // field whose format has no dedicated block falls back to the 0 map.
        const codePageMarks = buildCodePageTimeline(code);
        const varData = extractPrintBlockData(code, offset => {
            let page: number | undefined;
            for (const mark of codePageMarks) {
                if (mark.at > offset) break;
                page = mark.page;
            }
            return page;
        });
        if (varData.size > 0) {
            const fallback = varData.get(0);
            for (const el of this.printer.label.elements) {
                if ((el.kind === 'text' || el.kind === 'barcode') && el.source.type === 'variable' && el.id !== undefined) {
                    const fmtFields = varData.get(this.printer.formatIdOf(el));
                    const data = (fmtFields ?? fallback)?.get(el.id);
                    if (data !== undefined) el.source = { type: 'variable', data };
                }
            }
        }

        // d2,m1[,m2] slave fields copy their data from their master field —
        // resolved after print-block attachment so a slave of a variable field
        // shows the data the host actually sent (PRM p.175).
        this.resolveMasterSources();

        // I<n> fields with no data source of their own mirror their host
        // barcode's interpretive — including the c6 normalization rules
        // (UCC-128 forced-00, m2 keep-verbatim) — after print-block data has
        // attached, so the two interpretive paths can never disagree.
        this.syncInterpretiveFields();

        this.composePageIfNeeded();
        // Placed last (after page composition): DG payloads belong to the
        // print stream, not to any stored format, so they must not be
        // captured by format buckets that composePageIfNeeded rebuilds from.
        this.placeDirectGraphics();
        return this.printer.label;
    }

    /**
     * When a page (S frame) composed several formats onto one label, rebuild
     * label.elements from the placements: each placed format's captured
     * elements are offset by the placement offset (and rotated by the page
     * rotation q, which applies to whole formats). Without a page this is a
     * no-op and per-format capture stays transparent.
     */
    /**
     * Give every I<n> field without its own data source the text its host
     * barcode would print interpretively — same normalization rules as the
     * built-in HRI row (interpretiveText: UCC-128 forced-00, c6,m2 keep
     * verbatim), so the two paths cannot disagree. Host resolution mirrors
     * parse-time semantics: the closest preceding barcode with the field id,
     * scoped to the defining format's bucket (ids are per-format). Runs
     * before page composition, so label.elements still holds the bucket
     * objects themselves (identity lookup via indexOf is valid here).
     */
    private syncInterpretiveFields(): void {
        for (const el of this.printer.label.elements) {
            if (el.kind !== 'text' || el.interpretiveOf === undefined) continue;
            // Only fields with no data of their own mirror the host; explicit
            // d3/d4/d5 sources stay as the host sent them.
            if (el.source.type !== 'variable' || el.source.data !== '') continue;
            // Scope the host search to the format bucket that DEFINED this
            // field (ids are per-format): find its bucket, then search
            // backwards for the closest preceding barcode with the id.
            const definingBucket = this.printer.bucketOf(el);
            const host = this.printer.findPrecedingIn(
                definingBucket,
                definingBucket ? definingBucket.indexOf(el) : 0,
                cand => cand.kind === 'barcode' && cand.id === el.interpretiveOf,
            ) as BarcodeElement | undefined;
            if (!host) continue;
            if (host.source.type !== 'fixed' && host.source.type !== 'variable') continue; // [DATE]/[TIME] host
            const data = applyI2of5Padding(host.symbology, host.source.data ?? '');
            el.source = {
                type: 'fixed',
                data: interpretiveText(host.symbology, data, {
                    code128Ucc: host.code128Ucc,
                    code128KeepInterpretive: host.code128KeepInterpretive,
                }),
            };
        }
    }

    private composePageIfNeeded(): void {
        const page = this.printer.label.page;
        if (!page) return;
        const out: ViewerElement[] = [];
        for (const p of page.placements) {
            const bucket = this.printer.formats.get(p.formatId);
            if (!bucket) {
                this.printer.issue('warning', 'page-format-missing', `Page assigns format ${p.formatId} to position ${p.position}, but that format was never defined.`, `S${page.id}`);
                continue;
            }
            for (const el of bucket) {
                const moved = applyPlacement(el, p);
                out.push(moved);
            }
        }
        this.printer.label.elements = out;
    }

    /**
     * Decodes accumulated Direct Graphics frames (PRM Appendix E RLE) and
     * keeps them pending. Placement needs the label height (origins count
     * from the bottom edge), which may be declared after the graphics — or
     * not at all — so elements are placed at end of parse().
     */
    /**
     * True when the buffered Direct Graphics payload contains the end-of-bitmap
     * marker (0x28). g0 carries raw bytes, so the marker is a byte inside the
     * newest frame; g1 carries ASCII hex, so it is the hex pair "28" — which an
     * editor's line wrap may split across frames, hence the join.
     */
    private dgBitmapComplete(): boolean {
        if (this.printer.directGraphicsMode === 1) {
            return nibblizedToByteString(this.printer.directGraphicsFrames.join('')).bytes.includes('\x28');
        }
        const last = this.printer.directGraphicsFrames.at(-1) ?? '';
        for (let i = 0; i < last.length; i++) if ((last.charCodeAt(i) & 0xff) === 0x28) return true;
        return false;
    }

    private decodeDirectGraphics(): void {
        const mode = this.printer.directGraphicsMode ?? 0;
        if (mode === 1 && nibblizedToByteString(this.printer.directGraphicsFrames.join('')).oddNibble) {
            this.printer.issue('warning', 'direct-graphics-odd-nibble', 'Nibblized Direct Graphics (<ESC>g1) has one unpaired hex digit (a truncated pair or a non-hex character splitting a pair); that nibble was dropped.', '<ESC>g1');
        }
        const graphics = extractDirectGraphics(this.printer.directGraphicsFrames, mode);
        this.printer.pendingDirectGraphics.push(...graphics);
        if (graphics.length > 0) {
            this.printer.issue('info', 'direct-graphics', `${graphics.length} direct graphic(s) decoded from RLE data.`, `<ESC>g${mode}`);
        }
    }

    /** Places pending Direct Graphics using the final label height. */
    private placeDirectGraphics(): void {
        if (this.printer.pendingDirectGraphics.length === 0) return;
        // TWO conventions write bit origins, decided by whether the stream
        // defines the label's LENGTH:
        //
        //  * `<SI>L` present — PRM Appendix E's bottom-up frame is well-defined
        //    ("measured from the label's BOTTOM edge"), so originY counts from
        //    that edge. This is what this project's own generator writes, and
        //    reading it back is what `directGraphicToBitmap` implements.
        //
        //  * `<SI>L` absent — the driver had no label length to reference and
        //    wrote originY in its own CENTRED frame instead. Every real
        //    BarTender stream is this case (all 8 DG samples in `samples/` have
        //    no <SI>L), and reading it bottom-up put every graphic at the top of
        //    the canvas — 29 to 89 dots off, measured against BarTender's own
        //    previews.
        //
        // Undoing the centred frame needs the printer MODEL, which the stream
        // does not carry. It is therefore never guessed: without an explicitly
        // supplied model the bottom-up reading is used and an info is raised,
        // because a wrong model's constants misplace every graphic silently.
        const W = this.printer.label.widthDots;
        if (this.printer.label.heightDots === null && W !== null) {
            const model = this.printer.driverModel;
            const dpi = this.printer.driverDpi ?? 203;
            const printableX = model ? PRINTABLE_WIDTH_IN[model]?.[dpi] : undefined;
            const adjust = model ? LABEL_WIDTH_ADJUSTMENT[model]?.[dpi] : undefined;
            if (printableX !== undefined && adjust !== undefined) {
                const orientation = this.printer.pageOrientation;
                const pageH = this.printer.pageHeightDots;
                if (orientation === 'portrait') {
                    if (pageH !== null) {
                        this.placePortraitDriverGraphics(W, pageH, adjust, dpi, printableX);
                        this.printer.pendingDirectGraphics = [];
                        return;
                    }
                    this.printer.issue(
                        'info',
                        'dg-portrait-page-height-missing',
                        'Direct Graphics are in the portrait driver frame, which is anchored to the page height — but no page height was given, so they are placed with the landscape reading and will be off. Set the paper height to place them correctly.',
                        '<ESC>g',
                    );
                } else if (orientation === null) {
                    this.printer.issue(
                        'info',
                        'dg-orientation-unknown',
                        'Direct Graphics are in a driver frame that differs between page orientations, and no orientation was given. Assuming landscape, which is what every stream in this repo uses; portrait streams will be misplaced. Set the page orientation to be sure.',
                        '<ESC>g',
                    );
                }
                // Landscape is the default because every BarTender stream in this
                // repository is landscape, and it is the orientation whose frame
                // the shipped formula was verified against first.
                this.placeDriverFramedGraphics(W, printableX, adjust, dpi);
                this.printer.pendingDirectGraphics = [];
                return;
            }
            this.printer.issue(
                'info',
                'dg-driver-frame-unknown-model',
                model
                    ? `Direct Graphics are written in the ${model} driver's centred frame (the stream has no <SI>L), but no placement constants are measured for ${dpi} dpi; they are placed label-relative instead, which is expected to be off.`
                    : 'Direct Graphics are written in a driver\'s centred frame (the stream has no <SI>L) and no printer model was given, so they are placed label-relative instead. Select the printer model to place them correctly.',
                '<ESC>g',
            );
        }
        // Bottom-up path (PRM Appendix E): needs the label height to convert.
        let hBase = this.printer.label.heightDots ?? 0;
        if (!hBase) {
            for (const el of this.printer.label.elements) {
                const b = el.oy + ('heightDots' in el ? (el.heightDots as number) : 0);
                if (b > hBase) hBase = b;
            }
            for (const dg of this.printer.pendingDirectGraphics) hBase = Math.max(hBase, dg.origin[1]);
            hBase = Math.max(hBase, 1);
        }
        for (const dg of this.printer.pendingDirectGraphics) {
            // PRM Appendix E: columns advance rightward from origin X; bit i
            // sits at bottom-up Y = originY - i. directGraphicToBitmap applies
            // the transform and returns the ink box's top-left plus the
            // upright bitmap to draw there.
            const { bitmap, offsetX, offsetY } = directGraphicToBitmap(dg, hBase);
            if (bitmap.length === 0 || bitmap[0].length === 0) continue;
            const stripLen = bitmap[0].length;
            const stripCount = bitmap.length;
            // Pack the visual bitmap back into packed-column form the renderer
            // already knows (encodeBitmapColumns + decodeGraphicColumns path).
            const packed = encodeBitmapColumns(bitmap);
            // DG payloads arrive in the print stream (after R), not inside a
            // format definition — they are placed in label space directly, so
            // they bypass format-bucket capture (a page must not drop or
            // re-transform them).
            this.printer.label.elements.push({
                kind: 'graphic',
                ox: offsetX,
                oy: offsetY,
                f: 0,
                graphicId: -1,
                widthDots: stripLen,
                heightDots: stripCount,
                data: packed,
            });
        }
        this.printer.pendingDirectGraphics = [];
    }

    /**
     * Pushes one decoded graphic as a label element, packing its visual bitmap
     * back into the column form the renderer already knows. Shared by both
     * placement paths so they cannot drift in how they encode or anchor.
     */
    private pushGraphicElement(dg: DirectGraphic, yTop: number): void {
        const { minCol, maxCol, minBit, maxBit } = directGraphicInkBounds(dg);
        if (maxCol < 0) return;
        const w = maxCol - minCol + 1;
        const h = maxBit - minBit + 1;
        const bm: number[][] = [];
        for (let y = 0; y < h; y++) bm.push(new Array(w).fill(0));
        for (let s = 0; s < dg.pixels.length; s++) {
            const strip = dg.pixels[s];
            if (!strip) continue;
            for (let i = 0; i < strip.length; i++) {
                if (!strip[i]) continue;
                bm[maxBit - i][s - minCol] = 1;
            }
        }
        this.printer.label.elements.push({
            kind: 'graphic',
            ox: minCol,
            oy: yTop,
            f: 0,
            graphicId: -1,
            widthDots: w,
            heightDots: h,
            data: encodeBitmapColumns(bm),
        });
    }

    /**
     * Places Direct Graphics written in the DRIVER's centred frame (streams
     * with no <SI>L), where BarTender's own previews are the reference.
     *
     * The transform, verified 8/8 within 1 dot against BarTender's previews on
     * the PD43 (see tests/dgRenderPlacement.test.ts):
     *
     *   yTop = originY + (W + 2*adjust)/2 - maxBit - ceil(printableX*dpi/2)
     *
     * `W` comes from the stream; `adjust` and `printableX` are read from the
     * selected printer model's driver constants (constants.ts). Everything here
     * is per-model: applying the PD43's numbers to another printer misplaces
     * every graphic, which is why an unlisted model falls back to the bottom-up
     * path rather than guessing.
     *
     * This is the LANDSCAPE frame. A portrait page uses a different one — the
     * axes are transposed and the Y anchor is the page height — implemented in
     * placePortraitDriverGraphics below. Which applies is a caller input,
     * because the stream records neither the orientation nor the page height.
     */
    private placeDriverFramedGraphics(W: number, printableX: number, adjust: number, dpi: number): void {
        const driverTop = Math.ceil(printableX * dpi / 2);
        for (const dg of this.printer.pendingDirectGraphics) {
            const { maxBit } = directGraphicInkBounds(dg);
            if (maxBit < 0) continue;
            const yTop = dg.origin[1] + (W + 2 * adjust) / 2 - maxBit - driverTop;
            this.pushGraphicElement(dg, yTop);
        }
    }

    /**
     * Places Direct Graphics written in the PORTRAIT driver frame, where the
     * axes are swapped relative to landscape and the Y anchor is the page's
     * height rather than the graphic's own origin.
     *
     * Measured 2026-09-28 with purpose-built fixtures (a page sweep at 3x2,
     * 2x3 and 3x2.5 in, plus an X-sweep and a Y-sweep on a fixed page), and
     * verified 7/7 within 1 dot — including a fixture whose page, object
     * position AND object size all differed from the derivation set:
     *
     *     inkLeft = originY - maxBit + (W + 18)/2 - 424
     *     inkTop  = pageHeightDots - originX - inkWidth - 8
     *
     * The bitmap is also transposed: the payload's columns run along the page's
     * Y and its bits along the page's X. Sizes confirm it — a 1.2x0.6 in object
     * arrives as 146 cols x 268 bits, and BarTender's own preview draws it
     * 267x146.
     *
     * Both constants here mean the same things they do in the landscape path:
     * 424 is ceil(Stock.Printable.X * dpi / 2) for the PD43's 4.09 in, and 8 is
     * half the preview inset. `pageHeightDots` is a caller input because the
     * stream carries no page height at all (a portrait stream says only
     * `<ESC>C<SI>W591`, with no <SI>L).
     */
    private placePortraitDriverGraphics(W: number, pageHeightDots: number, adjust: number, dpi: number, printableX: number): void {
        const driverTop = Math.ceil(printableX * dpi / 2);
        for (const dg of this.printer.pendingDirectGraphics) {
            const { minBit, maxBit, minCol, maxCol } = directGraphicInkBounds(dg);
            if (maxCol < 0 || maxBit < 0) continue;

            const inkLeft = dg.origin[1] - maxBit + (W + 2 * adjust) / 2 - driverTop;
            const inkWidthData = maxCol - minCol + 1;
            const inkTop = pageHeightDots - dg.origin[0] - inkWidthData - 8;

            // Transposed: data column -> visual row, data bit -> visual column.
            const cols: number[] = [];
            for (let i = 0; i < dg.pixels.length; i++) if (dg.pixels[i]?.some(v => v)) cols.push(i);
            const x0 = cols[0], x1 = cols[cols.length - 1];
            const w = x1 - x0 + 1;
            const h = maxBit - minBit + 1;
            const bm: number[][] = [];
            for (let r = 0; r < w; r++) bm.push(new Array(h).fill(0));
            for (let s = x0; s <= x1; s++) {
                const strip = dg.pixels[s];
                if (!strip) continue;
                for (let b = minBit; b <= maxBit; b++) {
                    if (!strip[b]) continue;
                    // transposed row = column offset, column = bit distance from maxBit
                    bm[s - x0][maxBit - b] = 1;
                }
            }
            this.printer.label.elements.push({
                kind: 'graphic',
                ox: inkLeft,
                oy: inkTop,
                f: 0,
                graphicId: -1,
                widthDots: h,
                heightDots: w,
                data: encodeBitmapColumns(bm),
            });
        }
    }

    /** Opens a format block, validating that program mode was entered first. */
    private openFormat(formatNumber: number, command: string): void {
        if (!this.printer.programModeSeen) {
            this.printer.issue(
                'warning',
                'no-program-mode',
                'Format defined without entering program mode first (<STX><ESC>P<ETX>). Most streams include it before the format header.',
                command,
            );
        }
        this.printer.openFormat(formatNumber);
        if (formatNumber >= 0) this.printer.label.settings.formatNumber = formatNumber;
    }

    /**
     * Page definition frame (PRM p.196): "S1;Ma,1;O0,0;Mb,2;O0,0" — creates
     * page n, assigns format ids to position letters (a–z) with dot offsets
     * (O) and an optional page-wide rotation (q). The page composes the
     * stored formats onto one label; composition happens at the end of parse.
     */
    private parsePageFrame(frame: string): void {
        const id = parseInt(frame.match(/^S(\d+)/)![1], 10);
        this.printer.label.settings.pageNumber = id;
        const placements: PagePlacement[] = [];

        for (const rawSeg of frame.split(';').slice(1)) {
            const seg = rawSeg.trim();
            if (!seg) continue;
            const m = seg.charAt(0);
            const v = seg.slice(1);
            if (m === 'M') {
                // Mp,n — assign format n to position p
                const pm = v.match(/^([a-z]),(\d+)$/);
                if (!pm) {
                    this.printer.issue('warning', 'page-m-invalid', `Page placement "${seg}" is malformed; expected Mp,n with position a-z.`, frame.slice(0, 24));
                    continue;
                }
                placements.push({ position: pm[1], formatId: parseInt(pm[2], 10), offsetX: 0, offsetY: 0, rotation: 0 });
            } else if (m === 'O') {
                // On,m — offset for the most recent placement
                const om = v.match(/^(-?\d+),(-?\d+)$/);
                if (!om || placements.length === 0) {
                    this.printer.issue('warning', 'page-o-invalid', `Page offset "${seg}" is malformed or has no preceding M.`, frame.slice(0, 24));
                    continue;
                }
                placements[placements.length - 1].offsetX = parseInt(om[1], 10);
                placements[placements.length - 1].offsetY = parseInt(om[2], 10);
            } else if (m === 'q') {
                // qn — page-wide format rotation
                const q = parseInt(v, 10);
                const rot = Math.max(0, Math.min(3, isNaN(q) ? 0 : q));
                for (const p of placements) p.rotation = rot;
            }
        }
        this.printer.label.page = { id, placements };
    }

    /**
     * Duplicate field ids overwrite each other on a real printer; the viewer
     * keeps only the last definition and flags the conflict.
     */
    private beginField(kindChar: string, id: number | undefined): void {
        if (id === undefined) return;
        // Field ids are PER FORMAT (each stored format has its own field
        // directory): H0 in format 1 and H0 in format 2 are distinct fields.
        // Duplicates only count within the format currently being defined.
        const key = VirtualPrinter.fieldKey(this.printer.activeFormatId, kindChar, id);
        if (this.printer.seenFieldKeys.has(key)) {
            this.printer.issue(
                'error',
                'duplicate-field-id',
                `Field ${kindChar}${id} is defined more than once; the last definition wins.`,
                `${kindChar}${id}`,
            );
            // "Last wins" is scoped to the active format (ids are per-format);
            // VirtualPrinter.evictField enforces the store-consistency
            // invariant in one place.
            this.printer.evictField(e => e.id === id && KIND_PREFIX[e.kind] === kindChar);
        }
        this.printer.seenFieldKeys.add(key);
    }

    private parseFrame(frame: string): void {
        // Printer setup / control frames
        if (frame === 'R') {
            this.printer.closeFormat();
            return;
        }
        // Direct Graphics payload frames are binary (g0: bytes like
        // 0x21/0x26/0x27) or ASCII hex pairs (g1) — either way they must
        // bypass the ESC dispatch below.
        if (this.printer.directGraphicsMode !== null) {
            if (this.printer.directGraphicsFrames.length >= MAX_DG_FRAMES) {
                // Unterminated DG mode with an endless payload: stop buffering
                // (decode what arrived) and leave the mode so later frames
                // parse as commands again instead of filling memory forever.
                this.printer.issue('warning', 'direct-graphics-limit', `Direct Graphics mode received more than ${MAX_DG_FRAMES} payload frames without an end-of-bitmap (0x28); the remainder was ignored.`, `<ESC>g${this.printer.directGraphicsMode}`);
                this.decodeDirectGraphics();
                this.printer.directGraphicsMode = null;
                this.printer.directGraphicsFrames = [];
                return;
            }
            this.printer.directGraphicsFrames.push(frame);
            if (this.dgBitmapComplete()) {
                this.decodeDirectGraphics();
                this.printer.directGraphicsMode = null;
                this.printer.directGraphicsFrames = [];
            }
            return;
        }
        if (frame.startsWith(LITERAL_ESC)) {
            this.parseEscFrame(frame);
            return;
        }
        if (frame.startsWith('<SI>')) {
            this.parseSetupFrame(frame);
            return;
        }
        // Combined print-command frames (BarTender style), e.g.
        // "<RS>1<US>1<ETB>" — quantity, batch count, print in one frame.
        if (/^<(RS|US|ETB|FF)/.test(frame)) {
            const rq = frame.match(/<(RS)>(\d+)/);
            if (rq) this.printer.label.settings.quantity = parseInt(rq[2], 10);
            const uq = frame.match(/<(US)>(\d+)/);
            if (uq) this.printer.label.settings.batchCount = parseInt(uq[2], 10);
            return;
        }
        // Format header, e.g. "E1;F1" or "E5;F5;"
        if (/^E\d+;F\d*;?$/.test(frame)) {
            this.openFormat(parseInt(frame.match(/^E(\d+)/)![1], 10), frame.slice(0, 24));
            return;
        }
        // Standalone "En" (BarTender cache-clear preamble emits E1..E99 to
        // erase stored formats before redefining). Nothing to render — the
        // following F*/E#;F# redefines what matters.
        if (/^E\d+$/.test(frame)) return;
        // Standalone format create, e.g. "F*" (BarTender emits F* with the
        // asterisk = temp-RAM format, PRM p.182) or "F1"/"A1".
        if (/^[FA]\*$|^[FA]\d+$/.test(frame)) {
            const id = frame.charAt(1) === '*' ? -1 : parseInt(frame.slice(1), 10);
            this.openFormat(id, frame.slice(0, 24));
            return;
        }
        // Page definition frame, e.g. "S1;Ma,1;O0,0;Mb,2;O0,0" (PRM p.196):
        // creates page n and assigns formats to positions with offsets.
        if (/^S\d+/.test(frame)) {
            this.parsePageFrame(frame);
            return;
        }
        // Standalone "qn" — Format Direction in a Page (PRM p.192) sent
        // outside an S frame. Some tools use it to declare the whole job's
        // orientation; the viewer applies it as the default preview rotation.
        if (/^q\d+$/.test(frame)) {
            const q = parseInt(frame.slice(1), 10);
            if (q < 0 || q > 3) {
                this.printer.issue('warning', 'rotation-invalid', `Format direction q${q} is outside 0-3; clamped.`, frame);
            }
            this.printer.label.settings.formatDirection = Math.max(0, Math.min(3, q));
            return;
        }
        // BarTender splits graphic definitions across frames: "G0;x122;y384"
        // opens the graphic (x/y = cell dims), then standalone "u<n>,<data>"
        // frames follow with one packed column each (u indices 1-based per
        // PRM p.186 — but BarTender emits u0-based here, so accept both).
        if (/^G\d+;/.test(frame)) {
            this.parseGraphicDefinition(parseInt(frame.match(/^G(\d+)/)![1], 10), splitParams(frame.slice(frame.indexOf(';') + 1)));
            return;
        }
        if (/^u\d+,/.test(frame)) {
            const m = frame.match(/^u(\d+),([\s\S]*)$/)!;
            this.appendGraphicColumn(parseInt(m[1], 10), m[2]);
            return;
        }
        if (/^[UVBLH]\d*$/.test(frame) || /^[A-Z]/.test(frame)) {
            this.parseFieldFrame(frame);
            return;
        }
        // Several tools chain multiple commands inside one STX/ETX pair using
        // ';' separators (e.g. "<ESC>P;E1;F1;H0;o...;B1;...;R").
        if (frame.includes(';')) {
            this.parseChained(frame);
            return;
        }
        this.printer.issue('warning', 'unknown-frame', `Unrecognized command frame ignored.`, frame.slice(0, 24));
    }

    /**
     * Walks ';'-separated segments and dispatches each logical command.
     * A segment that looks like a command header starts a new command;
     * everything else is a parameter of the current one.
     * d3 inside a chained frame is greedy too (matching the plain-frame rule
     * in splitParams): once the buffer carries `d3,`, following segments are
     * raw text data — a ';' inside fixed text ("A;B") is data, not a boundary.
     * The data run ends at `R` (a chain terminator that never appears as a
     * whole segment in text by convention) or at a header segment that is
     * immediately followed by an `o…` origin param — the shape real field
     * commands take (header;o;x;y;…;d3,data) and text rarely imitates. Plain
     * digits text like "B2" stays data unless an `o` param follows.
     */
    private parseChained(body: string): void {
        const COMMAND_START = /^(?:[HBLWUG]\d*|[FA]\*|[FA]\d+|E\d+|R)$/;
        const segments = body.split(';');
        let buffer = '';

        const flush = () => {
            if (!buffer) return;
            const joined = buffer;
            buffer = '';
            // Route through the plain-frame paths (header / field / R).
            if (/^E\d+;F\d*;?$/.test(joined)) {
                this.openFormat(parseInt(joined.match(/^E(\d+)/)![1], 10), joined.slice(0, 24));
                return;
            }
            if (/^[FA]\*$|^[FA]\d+$/.test(joined)) {
                const id = joined.charAt(1) === '*' ? -1 : parseInt(joined.slice(1), 10);
                this.openFormat(id, joined.slice(0, 24));
                return;
            }
            if (joined === 'R') {
                this.printer.closeFormat();
                return;
            }
            this.parseFieldFrame(joined);
        };

        for (let i = 0; i < segments.length; i++) {
            const s = segments[i].trim();
            if (!s) continue;
            // "E1;F1" is ONE format header (PRM p.181), not two commands. The
            // paired form must be consumed whole: flushing "E1" alone routes it
            // to parseFieldFrame, which does not recognize a bare format id and
            // warns "unrecognized command frame" — even though the following
            // "F1" opens the format and every field parses correctly. The
            // warning was false: the stream rendered, it just looked broken.
            if (/^E\d+$/.test(s)) {
                let partner = '';
                let partnerAt = -1;
                for (let j = i + 1; j < segments.length; j++) {
                    const t = segments[j].trim();
                    if (t) { partner = t; partnerAt = j; break; }
                }
                if (/^F\d*$/.test(partner)) {
                    flush();
                    this.openFormat(parseInt(s.slice(1), 10), `${s};${partner}`.slice(0, 24));
                    i = partnerAt;
                    continue;
                }
            }
            if (COMMAND_START.test(s)) {
                // Inside d3 data, a header only counts as a boundary when an
                // origin param follows it — otherwise the text wins.
                const inD3 = /(?:^|;)d3,/.test(buffer);
                if (inD3 && s !== 'R') {
                    let next = '';
                    for (let j = i + 1; j < segments.length; j++) {
                        const t = segments[j].trim();
                        if (t) { next = t; break; }
                    }
                    if (!/^o-?[\d,]+/.test(next)) {
                        if (buffer) buffer += `;${s}`;
                        continue;
                    }
                }
                flush();
                if (s === 'R') {
                    this.printer.closeFormat();
                    continue;
                }
                buffer = s;
            } else if (buffer) {
                buffer += `;${s}`;
            }
            // Params before any command header are dropped silently.
        }
        flush();
    }

    private parseEscFrame(frame: string): void {
        const cmd = frame.charAt(LITERAL_ESC.length);
        const rest = frame.slice(LITERAL_ESC.length + 1);
        switch (cmd) {
            case 'P': // Enter program mode
                this.printer.closeFormat();
                this.printer.programModeSeen = true;
                if (rest.includes(';')) this.parseChained(rest);
                break;
            case 'C': {
                // <ESC>C — Advanced Mode, Select (PRM p.91). NOT "clear stored
                // format" (audit T3's premise, disproved against the manual:
                // that wording is <CAN> "Clear All Data", p.93). n selects dot
                // size (0/1), so a bare <ESC>C1 is the same mode select. Often
                // carries inline <SI> setup (e.g. <ESC>C<SI>W812).
                this.printer.closeFormat();
                const rest2 = rest.replace(/^[01](?![\dA-Za-z])/, '');
                if (rest2.includes('<SI>')) this.parseSetupFrame(rest2);
                else if (rest2.includes(';')) this.parseChained(rest2);
                break;
            }
            case 'E': // Print invocation (<ESC>E1<CAN>...) - ends format definition
                this.printer.closeFormat();
                break;
            case 'F': // Fill field data (inside print invocation)
            case 'N':
            case 'I': // handled at field level when standalone
                break;
            case 'g': // Direct Graphics Mode, Select (PRM p.96 / Appendix E)
                // m=0: raw 8-bit payloads. m=1: nibblized ASCII hex — every byte
                // is two hex digits, so the stream survives clipboard paste.
                if (rest.startsWith('0') || rest.startsWith('1')) {
                    this.printer.directGraphicsMode = rest.startsWith('1') ? 1 : 0;
                    this.printer.directGraphicsFrames = [];
                } else if (rest.length > 0) {
                    this.printer.issue('warning', 'direct-graphics-unknown-mode', `Direct Graphics mode <ESC>g${rest.charAt(0)} is not supported; only g0 (binary) and g1 (nibblized hex) are decoded.`, frame.slice(0, 24));
                }
                break;
            default:
                this.printer.issue('info', 'esc-command', `<ESC>${cmd} printer command acknowledged.`, frame.slice(0, 24));
        }
    }

    private parseSetupFrame(frame: string): void {
        const width = frame.match(/<SI>W(\d+)/);
        if (width) this.printer.label.widthDots = this.clampDim(parseInt(width[1], 10), 'W');
        const length = frame.match(/<SI>L(\d+)/);
        if (length) this.printer.label.heightDots = this.clampDim(parseInt(length[1], 10), 'L');

        const sense = frame.match(/<SI>T([012])/);
        if (sense) {
            this.printer.label.settings.mediaSenseMode =
                sense[1] === '0' ? 'continuous' : sense[1] === '1' ? 'gap' : 'reflective';
        }
        const mediaType = frame.match(/<SI>g([01])/);
        if (mediaType) {
            this.printer.label.settings.mediaType =
                mediaType[1] === '0' ? 'direct-thermal' : 'thermal-transfer';
        }
        const speed = frame.match(/<SI>S(\d+)/);
        if (speed) this.printer.label.settings.printSpeed = parseInt(speed[1], 10) / 10;
        const dark = frame.match(/<SI>d(-?\d+)/);
        if (dark) this.printer.label.settings.darknessAdjust = parseInt(dark[1], 10);

        // Printer Language, Select (PRM p.133). Selects the character set the
        // printer applies to print data; decode is applied when the data is
        // bound to fields (see parse / resolveSource).
        const lang = frame.match(/<SI>l(\d+)/);
        if (lang) this.printer.setCodePage(parseInt(lang[1], 10));

        this.reportUnmodelledSetup(frame);
    }

    /**
     * Setup commands that move or transform the whole printed image, which this
     * renderer does not reproduce. Every other unhandled <SI> setting is comms,
     * network or media handling — it cannot change the picture — but these
     * three can, and silence about them is the failure mode this project exists
     * to prevent (see tests/unmodelledSetup.test.ts for the sources).
     *
     * Warned rather than modelled: their effect is hardware behaviour whose
     * magnitudes are not derivable from the stream alone, and this project has
     * twice proved what a table guessed instead of measured costs.
     */
    private reportUnmodelledSetup(frame: string): void {
        const warn = (what: string, detail: string): void => {
            this.printer.issue('warning', 'setup-not-modelled',
                `${what} changes the printed image, which this preview does not reproduce: ${detail}`,
                frame.slice(0, 24));
        };

        // Label Origin, X-Y Adjust: moves the imaged position on the media.
        // K10/P10 firmware only — PRM rev 008 does not document it. Both
        // parameters are bracketed in the syntax (<SI>X[m1][,m2]), so "<SI>X,3"
        // (m1 omitted, m2 given) is legal and must be caught too — the leading
        // digit group is optional here, unlike <SI>F and <SI>h where n is
        // mandatory. The command letter is uppercase X; "<SI>xc" is a different
        // command and does not match.
        const origin = frame.match(/<SI>X(?:(-?\d+)(?:,(-?\d+))?|,(-?\d+))/);
        if (origin) {
            const m1 = origin[1] === undefined ? 0 : parseInt(origin[1], 10);
            const m2 = (origin[2] ?? origin[3]) === undefined ? 0 : parseInt((origin[2] ?? origin[3])!, 10);
            if (m1 !== 0 || m2 !== 0)
                warn('Label origin X-Y adjust (<SI>X)', `the image is shifted by ${m1} dot(s) in x and ${m2} in y.`);
        }

        // Top of Form, Set: the start print point. Default 20 (PRM p.139).
        const topOfForm = frame.match(/<SI>F(-?\d+)/);
        if (topOfForm && parseInt(topOfForm[1], 10) !== 20)
            warn('Top of form (<SI>F)', `the start print point is ${topOfForm[1]} (5-mil increments), moved from its default of 20.`);

        // Printhead Loading Mode, Select (PRM p.135): n=1 mirrors, ,m=1
        // inverts. Both are mandatory in the syntax, so a bare "<SI>h" — which
        // samples/product.ipl and two siblings carry — supplies no value at
        // all. Nothing is selected, so it stays silent. (The real Intermec
        // sample of this command is "<SI>h0,0;", args and all; ours is likely a
        // hand-authoring slip, but silence is the correct response either way,
        // and warning would fire on our own fixtures.)
        const loading = frame.match(/<SI>h(\d+)(?:,(\d+))?/);
        if (loading) {
            const modes: string[] = [];
            if (loading[1] === '1') modes.push('mirror');
            if (loading[2] === '1') modes.push('inverse');
            if (modes.length) warn('Printhead loading mode (<SI>h)', `${modes.join(' + ')} printing is selected.`);
        }
    }

    private parseFieldFrame(frame: string): void {
        // Interpretive field I<n>: binds to barcode <n>. Its default anchor is
        // derived from that barcode's rendered box; explicit o overrides.
        const interpMatch = frame.match(/^I(\d+)/);
        if (interpMatch) {
            this.parseInterpretiveField(parseInt(interpMatch[1], 10), splitParams(frame.slice(interpMatch[0].length)));
            return;
        }

        const headerMatch = frame.match(/^([HBLWUG])(\d*)/);
        if (!headerMatch) {
            // D<n> deletes field n from the open format (PRM p.174). The
            // viewer honors it by dropping the element; D0 after BarTender's
            // F* blocks clears the temp format's fields.
            const del = frame.match(/^D(\d+)$/);
            if (del && this.printer.inFormat) {
                // Scoped to the active format (ids are per-format) and clears
                // the duplicate-detection key too — VirtualPrinter.deleteField.
                this.printer.deleteField(parseInt(del[1], 10));
                return;
            }
            this.printer.issue('warning', 'unknown-frame', `Unrecognized command frame ignored.`, frame.slice(0, 24));
            return;
        }

        // G definitions are printer resources and may appear before the format
        // header; placement fields (H/B/L/W/U) require an open format block.
        if (!this.printer.inFormat && headerMatch[1] !== 'G') {
            if (/^[^A-Z0-9<]/.test(frame)) return;
            this.printer.issue('warning', 'field-outside-format', `Field command outside a format block was ignored.`, frame.slice(0, 24));
            return;
        }

        const kindChar = headerMatch[1];
        const id = headerMatch[2] ? parseInt(headerMatch[2], 10) : undefined;
        const params = splitParams(frame.slice(headerMatch[0].length));

        switch (kindChar) {
            case 'H': this.parseTextField(id, params); break;
            case 'B': this.parseBarcodeField(id, params); break;
            case 'L': this.parseLongField(id, params); break;
            case 'W': this.parseWideField(id, params); break;
            case 'U': this.parseGraphicField(id, params); break;
            case 'G': this.parseGraphicDefinition(id ?? 0, params); break;
        }
    }

    private resolveSource(params: FieldParam[]): FieldSource {
        for (const p of params) {
            if (p.key !== 'd') continue;
            if (p.value.startsWith('3,')) {
                return {
                    type: 'fixed',
                    data: decodePrintData(
                        p.value.slice(2).replace(/<SUB><CR>/g, '\n'),
                        this.printer.label.settings.codePage,
                    ),
                };
            }
            // d4/d5 are NOT IPL commands: "Field Data, Define Source" documents
            // only n=0..3 (PRM p.184), and no manual in docs/manuals/ mentions a
            // date or clock source. This app's generator used to emit them.
            // Report the field honestly instead of painting a plausible-looking
            // [YY/MM/DD] box for data the printer cannot produce. (A d40-like
            // value must not masquerade either, hence the anchoring.)
            if (/^[45](,|$)/.test(p.value)) {
                const isDate = p.value.startsWith('4');
                this.printer.issue('warning', 'unknown-data-source',
                    `Data source d${p.value.charAt(0)} is not an IPL command (PRM p.184 defines only d0-d3); the field prints nothing. ${isDate ? 'Date' : 'Time'} values must be baked into the format as fixed data (d3) at generate time.`,
                    `d${p.value}`);
                return { type: 'fixed', data: '' };
            }
            // d2,m1[,m2] — master/slave copy (PRM p.175): this field receives
            // its data from field m1; m2 selects the FS/GS-delimited element
            // (0-9999, default 0). Anchored so d20+ cannot masquerade.
            // Resolved to the master's data in resolveMasterSources.
            if (/^2(,|$)/.test(p.value)) {
                const parts = p.value.split(',');
                const masterId = parseInt(parts[1] ?? '', 10);
                if (Number.isInteger(masterId) && masterId >= 0) {
                    let offset: number | undefined;
                    if (parts[2] !== undefined && parts[2] !== '') {
                        const o = parseInt(parts[2], 10);
                        if (isNaN(o) || o < 0 || o > 9999) {
                            this.printer.issue('warning', 'master-offset-invalid', `d2 master element offset "${parts[2]}" is outside 0-9999 (PRM p.175); using element 0.`);
                        } else {
                            offset = o;
                        }
                    }
                    return { type: 'master', masterId, offset };
                }
                // d2 with no/unparseable master id: nothing to copy — render blank.
                return { type: 'variable', data: '' };
            }
            return { type: 'variable', data: '' }; // d0/d1[,m] (d1 = same semantics, PRM p.175)
        }
        return { type: 'variable', data: '' };
    }

    /**
     * Resolve d2 master/slave fields: replace each `{ type: 'master' }` source
     * with the master field's current data. Runs AFTER print-block attachment
     * so slaves of host-fed masters show what was sent, not ''. The master is
     * looked up by field id within the SAME format (ids are per-format),
     * nearest preceding definition winning — matching IPL's "define before
     * you reference" (a later slave cannot pull from a redefined master... in
     * practice masters precede slaves; last-wins here keeps redefinitions
     * consistent with beginField's duplicate rule). A missing master, or a
     * master that is itself [DATE]/[TIME], renders as the literal the printer
     * would carry (empty) with a warning — never silently.
     */
    private resolveMasterSources(): void {
        const slaves = this.printer.label.elements.filter(
            (el): el is TextElement | BarcodeElement =>
                (el.kind === 'text' || el.kind === 'barcode') && el.source.type === 'master',
        );
        if (slaves.length === 0) return;
        for (const slave of slaves) {
            const src = slave.source as { type: 'master'; masterId: number; offset?: number };
            const bucket = this.printer.bucketOf(slave);
            const master = this.printer.findPrecedingIn(
                bucket,
                bucket ? bucket.indexOf(slave) : 0,
                cand => cand.id === src.masterId && (cand.kind === 'text' || cand.kind === 'barcode'),
            ) as TextElement | BarcodeElement | undefined; // predicate guarantees the kind
            const cmd = `${KIND_PREFIX[slave.kind]}${slave.id ?? ''} d2,${src.masterId}`;
            if (!master) {
                this.printer.issue('warning', 'master-field-missing', `Slave field references undefined master field ${src.masterId}; renders empty.`, cmd);
                slave.source = { type: 'variable', data: '' };
                continue;
            }
            if (slave.kind === 'barcode' && master.kind === 'text') {
                // PRM p.175: "A bar code field cannot copy data from a
                // human-readable field" (the reverse is allowed).
                this.printer.issue('warning', 'master-field-direction', `Bar code slave field cannot copy from human-readable master ${src.masterId} (PRM p.175); renders empty.`, cmd);
                slave.source = { type: 'variable', data: '' };
                continue;
            }
            let data =
                master.source.type === 'fixed' || master.source.type === 'variable'
                    ? master.source.data
                    : ''; // unresolvable mid-chain (shouldn't happen: backward-only lookup is cycle-free)
            if (src.offset !== undefined) {
                // FS/GS element selection (PRM p.175): the copy takes the
                // offset-th element of a separator-delimited master value.
                const parts = data.split(/[\x1c\x1d]|<FS>|<GS>/);
                if (src.offset >= parts.length) {
                    this.printer.issue('warning', 'master-offset-out-of-range', `d2 element offset ${src.offset} exceeds the master's ${parts.length} FS/GS element(s); copy is empty.`, cmd);
                    data = '';
                } else {
                    data = parts[src.offset];
                }
            }
            slave.source = { type: 'variable', data };
        }
    }

    private int(params: FieldParam[], key: string, fallback: number): number {
        const p = params.find(x => x.key === key);
        if (!p) return fallback;
        const n = parseInt(p.value.split(',')[0], 10);
        return isNaN(n) ? fallback : n;
    }

    /** Caps a declared dot dimension at MAX_GRAPHIC_DIM, issuing a warning. */
    private clampDim(n: number, what: string): number {
        if (n > MAX_GRAPHIC_DIM) {
            this.printer.issue('warning', 'dimension-clamped', `<SI>${what} declares ${n} dots (> ${MAX_GRAPHIC_DIM}); clamped.`, `<SI>${what}`);
            return MAX_GRAPHIC_DIM;
        }
        return n;
    }

    private originOf(params: FieldParam[], command: string): { ox: number; oy: number } | null {
        const o = params.find(p => p.key === 'o');
        if (!o) {
            this.printer.issue('warning', 'missing-origin', `${command} field has no origin (o) parameter; placed at 0,0.`, command);
            return { ox: 0, oy: 0 };
        }
        const { x, y } = parseOrigin(o.value);
        if (x < 0 || y < 0) {
            // Passed through rather than clamped to 0: a BarTender sweep placing
            // boxes at X=-0.4in keeps them at their negative origin and lets the
            // label edge cut them (measured: its preview's ink runs to pixel 0 on
            // three sides, with the overhanging boxes' remaining halves visible).
            // Moving the field inward instead would print ink where the host
            // never asked for any.
            this.printer.issue('warning', 'origin-negative', `${command} field origin (${x},${y}) is negative and outside the documented 0-19999 range; it is not clamped, so the part beyond the label edge will not print.`, command);
        }
        return { ox: x, oy: y };
    }

    private rotationOf(params: FieldParam[], command?: string): number {
        const raw = params.find(p => p.key === 'f');
        if (raw) {
            const f = parseInt(raw.value, 10);
            if (!isNaN(f) && (f < 0 || f > 3)) {
                this.printer.issue('warning', 'rotation-invalid', `Rotation f${f} is outside 0-3; clamped to ${Math.max(0, Math.min(3, f))}.`, command);
            }
        }
        const f = this.int(params, 'f', 0);
        return Math.max(0, Math.min(3, f));
    }

    /**
     * Character rotation `rn` for human-readable fields (PRM p.170): 0
     * horizontal, 1 = 90° CCW. Values above 1 are undocumented — the manual
     * prints only "rotates the characters ... by 90 degrees counterclockwise"
     * and nothing for 2/3 — so they clamp to horizontal and say so, rather
     * than inventing a 180/270 reading the printer may not share.
     */
    private charRotationOf(params: FieldParam[], command: string): 0 | 1 {
        const raw = params.find(p => p.key === 'r');
        if (!raw) return 0;
        const n = parseInt(raw.value, 10);
        if (n === 1) return 1;
        if (!isNaN(n) && n !== 0) {
            this.printer.issue('warning', 'char-rotation-invalid', `Character rotation r${n} is outside the documented range for text fields (0 horizontal, 1 = 90° CCW); rendered horizontal.`, command);
        }
        return 0;
    }

    /**
     * `c n[,m][,p]` on a text field — "Font Type, Select" (PRM p.180, K10
     * "Font Type, Select"). Returns the font id and, when the caller asked for
     * it, the intercharacter gap `m`: "the space between characters", which
     * REPLACES the font's own gap for this field (1 dot for c0, 2 for the
     * rest). Range -199..399 per K10, -199..199 per PRM; values outside are
     * reported and the font default is kept, because a silently different gap
     * is exactly the class of quiet misprint this project exists to prevent.
     *
     * Editions disagree about the no-`m` case: PRM says the printer uses "the
     * default value of the selected font", K10 says "Default is 0". The font
     * default is what the 79-dot worked example pins, so it wins here; the
     * discrepancy is recorded rather than hidden.
     *
     * The third parameter, `p` ("Name of the font (if the font does not have
     * an ID number)"), is NOT handled: a downloadable named face has no bytes
     * in this renderer, so there is nothing to draw it with. It is ignored
     * rather than reported on purpose — no stream we hold uses it, and the
     * two-parameter form `c18,2,L,8` on BAR CODE frames is a different
     * command ("Bar Code, Select Type") whose third slot is a label, so a
     * warning here would fire on correct barcode frames in real samples.
     */
    private fontSpecOf(params: FieldParam[], command: string): { font: string; gap?: number } {
        const fontParams = params.filter(p => p.key === 'c');
        const raw = fontParams.length > 0 ? fontParams[fontParams.length - 1].value : undefined;
        if (raw === undefined) return { font: '0' }; // PRM p.189 default
        const parts = raw.split(',');
        const font = parts[0].trim();
        if (parts.length < 2 || parts[1].trim() === '') return { font };
        const gap = parseInt(parts[1], 10);
        if (!Number.isInteger(gap)) {
            this.printer.issue('warning', 'interchar-gap-invalid', `Intercharacter gap c${raw} is not a number; the font's own gap is used.`, command);
            return { font };
        }
        if (gap < -199 || gap > 399) {
            this.printer.issue('warning', 'interchar-gap-out-of-range', `Intercharacter gap c${raw} is outside the documented range -199 to 399; the font's own gap is used.`, command);
            return { font };
        }
        return { font, gap };
    }

    private parseTextField(id: number | undefined, params: FieldParam[]): void {
        this.beginField('H', id);
        const origin = this.originOf(params, 'H');
        // FONT_SELECT: c n[,m][,p]. `m` (intercharacter gap) overrides the
        // font's own gap; see fontSpecOf for the range/default rules.
        const spec = this.fontSpecOf(params, `H${id ?? ''}`);
        const font = spec.font;
        if (!KNOWN_FONTS.has(font)) {
            this.printer.issue('warning', 'unknown-font', `Text field uses unknown font "${font}"; rendered with a fallback face.`, `H${id ?? ''}`);
        }
        // "Code pages 11 through 33 do not work with resident fonts" (PRM
        // p.134). Resident bitmap fonts ignore the printer language, so bytes
        // above 0x7F print as whatever the font's own table holds.
        const codePage = this.printer.label.settings.codePage;
        if (codePage !== undefined && codePage >= 11 && codePage <= 33 && FONT_MAP[font]?.type === 'bitmap') {
            this.printer.issue('warning', 'code-page-resident-font',
                `Font "${font}" is a resident bitmap font, which does not use code page ${codePage}; non-ASCII characters in this field may not print.`,
                `H${id ?? ''}`);
        }
        const kParam = params.find(p => p.key === 'k');
        let pointSize = kParam ? parseInt(kParam.value.split(',')[0], 10) || undefined : undefined;
        // Border: n>0 = white letters on an n-dot black surround (PRM p.167).
        const borderRaw = this.int(params, 'b', 0);
        const borderDots = borderRaw > 0 ? Math.min(borderRaw, 999) : undefined;
        let hMag = this.int(params, 'h', 2);
        let wMag = this.int(params, 'w', 2);
        // Pitch `gn` (PRM p.197, 2.70 p.206, 4400 7-120): "Pitch is characters
        // per line. The higher the pitch, the smaller the characters." It is a
        // THIRD sizing mode, and "when you use the pitch size command, you
        // disable the height and width magnification and point" — so a field
        // carrying g ignores h, w and k entirely (default 12, range 1-50).
        //
        // The manuals never tabulate a glyph height per pitch, so the only
        // quantity they define directly is the count: n characters fit the
        // label's width. Size the glyph from that — advance = widthDots / n —
        // and derive the cell height from the font's own aspect, which is what
        // "scales smoothly" describes for outline faces.
        const pitchParam = params.find(p => p.key === 'g');
        let pitchChars: number | undefined;
        if (pitchParam) {
            const n = parseInt(pitchParam.value.split(',')[0], 10);
            if (!Number.isInteger(n) || n < 1 || n > 50) {
                this.printer.issue('warning', 'pitch-out-of-range', `Pitch g${pitchParam.value} is outside the documented range 1-50 characters per line; ignored.`, `H${id ?? ''}`);
            } else if (this.printer.label.widthDots === null) {
                this.printer.issue('warning', 'pitch-without-width', `Pitch g${n} needs the label width (<SI>W) to size characters, which the stream has not set; ignored.`, `H${id ?? ''}`);
            } else {
                pitchChars = n;
            }
        }
        if (pitchChars !== undefined) {
            // Pitch wins over the other three, as the manual states, so point
            // size and magnification are dropped rather than combined. The
            // manual defines the count and nothing else, so the advance is
            // derived from it: n characters span the label's width.
            const widthDots = this.printer.label.widthDots!;
            const advance = widthDots / pitchChars;
            const bitmap = FONT_MAP[font]?.type === 'bitmap';
            this.printer.issue('info', 'pitch-applied', `Pitch g${pitchChars} fits ${pitchChars} characters across the ${widthDots}-dot label (${Math.round(advance * 10) / 10} dots each); h, w and k are ignored as the manual specifies.`, `H${id ?? ''}`);
            const pitched: TextElement = {
                kind: 'text',
                id,
                ...origin,
                f: this.rotationOf(params, `H${id ?? ''}`),
                font,
                hMag: 1,
                wMag: 1,
                pitchAdvanceDots: advance,
                // An outline face still needs a canvas size; express the pitch
                // advance as the equivalent point size, which is the same 0.6 em
                // relation the fontMetrics tables use for monospace.
                pointSize: bitmap ? undefined : Math.max(1, Math.round((advance / 0.6) * 72 / 203)),
                intercharGapDots: spec.gap,
                borderDots,
                charRot: this.charRotationOf(params, `H${id ?? ''}`),
                source: this.resolveSource(params),
            };
            this.printer.commitElement(pitched);
            return;
        }
        if (OUTLINE_FONTS.has(font)) {
            if (pointSize !== undefined && (pointSize <= 0 || pointSize > 720)) {
                this.printer.issue('warning', 'size-out-of-range', `Outline font size k${pointSize} is outside the printable range (1-720 points).`, `H${id ?? ''}`);
            }
            // Outline fonts sized via h/w: the manual's h/w for outline fonts
            // are the BASE CHARACTER dimensions in dots (PRM p.187/p.201),
            // not magnification. BarTender emits h17;w17 meaning ~17pt text.
            // Convert: pointSize = h (dots) → pt = dots × 72 / dpi. Keep hMag/
            // wMag at 1 so the renderer scales the outline glyph to the box.
            if (pointSize === undefined && hMag > 4) {
                pointSize = Math.round(hMag * 72 / 203);
                hMag = 1;
                wMag = 1;
            }
            // No k and no h/w either: the fixed-size families name their size
            // in the font itself (c20 is "8 point monospace", c41 "36 point
            // monospace bold" — PRM 2.70 p.206). Without this every member of
            // that family would paint at one identical size, so the id would
            // carry no meaning at all.
            if (pointSize === undefined) pointSize = FONT_MAP[font]?.defaultPointSize;
        } else {
            if (hMag < 1 || wMag < 1 || hMag > 99 || wMag > 99) {
                this.printer.issue('warning', 'magnification-invalid', `Bitmap font magnification h${hMag}/w${wMag} is outside 1-99.`, `H${id ?? ''}`);
            }
        }
        const element: TextElement = {
            kind: 'text',
            id,
            ...origin,
            f: this.rotationOf(params, `H${id ?? ''}`),
            font,
            // Manual defaults for H fields: h2/w2 (PRM p.189). For outline
            // fonts sized via h/w, hMag/wMag were reset to 1 above.
            hMag,
            wMag,
            pointSize,
            intercharGapDots: spec.gap,
            borderDots,
            charRot: this.charRotationOf(params, `H${id ?? ''}`),
            source: this.resolveSource(params),
        };
        this.printer.commitElement(element);
    }

    /**
     * Interpretive field I<n> (PRM p.191): a text field bound to barcode <n>.
     * Defaults: font 0 at h2/w2, anchored 2 dots below the barcode's left edge;
     * explicit o/f/c/h/w parameters override.
     */
    private parseInterpretiveField(barcodeId: number, params: FieldParam[]): void {
        const cmd = `I${barcodeId}`;
        if (!this.printer.inFormat) {
            this.printer.issue('warning', 'field-outside-format', 'Interpretive field outside a format block was ignored.', cmd);
            return;
        }
        // Host lookup is scoped to the CURRENT format's bucket and searched
        // backwards: field ids are per-format, so I1 in format 2 must never
        // anchor to (or later mirror) a B1 defined in format 1.
        const activeBucket = this.printer.formats.get(this.printer.activeFormatId);
        const host = this.printer.findPrecedingIn(
            activeBucket,
            activeBucket ? activeBucket.length : 0,
            cand => cand.kind === 'barcode' && cand.id === barcodeId,
        ) as BarcodeElement | undefined;
        if (!host) {
            this.printer.issue('warning', 'interpretive-no-host', `${cmd} references bar code field ${barcodeId}, which has not been defined.`, cmd);
        }
        const hasOrigin = params.some(p => p.key === 'o');
        let ox = 0;
        let oy = 0;
        if (hasOrigin) {
            ({ ox, oy } = this.originOf(params, cmd));
        } else if (host) {
            // Manual default anchor: 2 dots below the bar code field, left justified.
            ox = host.ox;
            oy = host.oy + host.heightDots + 2;
        }

        // Interpretive fields take the same `c n[,m][,p]` font spec as H fields
        // ("Selects a font type for human-readable and interpretive fields").
        const spec = this.fontSpecOf(params, cmd);
        const element: TextElement = {
            kind: 'text',
            id: undefined,
            ox,
            oy,
            f: this.rotationOf(params, cmd),
            font: spec.font,
            hMag: this.int(params, 'h', 2),
            wMag: this.int(params, 'w', 2),
            pointSize: (() => {
                const k = params.find(p => p.key === 'k');
                return k ? parseInt(k.value.split(',')[0], 10) || undefined : undefined;
            })(),
            intercharGapDots: spec.gap,
            borderDots: undefined,
            charRot: this.charRotationOf(params, cmd),
            interpretiveOf: host ? barcodeId : undefined,
            source: this.resolveSource(params),
        };
        // An interpretive without its own data source is a live view of its
        // host barcode's data — synced (with the host's c6 interpretive rules
        // applied) at end of parse, after print-block data attachment.
        this.printer.commitElement(element);
    }

    private parseBarcodeField(id: number | undefined, params: FieldParam[]): void {
        this.beginField('B', id);
        const cmd = `B${id ?? ''}`;
        const origin = this.originOf(params, 'B');
        const cParam = params.find(p => p.key === 'c');
        // Manual default: c = Code 39 (symbology 0), PRM270 p.171.
        const cValue = cParam ? cParam.value : '0';
        const parts = cValue.split(',');
        // c7,m2 selects the version 0-8 (PRM p.154). Out-of-domain values must
        // not be misdiagnosed later as a data error — warn and default to
        // variable-length (0). D-series (5-8) is manual-valid but has no
        // encoder here, so it renders a placeholder with an info.
        let eanUpcVersion: number | undefined;
        if (parts[0] === '7') {
            const v = Number(parts[2] ?? 0);
            if (!Number.isInteger(v) || v < 0 || v > 8) {
                this.printer.issue('warning', 'ean-upc-version-invalid', `EAN/UPC version modifier c7,${parts[1] ?? '0'},${parts[2] ?? ''} is outside 0-8 (PRM p.154); defaulted to variable-length (0).`, cmd);
                eanUpcVersion = 0;
            } else {
                eanUpcVersion = v;
            }
        }
        const eanDSeries = eanUpcVersion !== undefined && eanUpcVersion >= 5;
        if (eanDSeries) {
            this.printer.issue('info', 'ean-upc-d-unsupported', 'UPC Version D-series (c7,m2 5-8) has no encoder available in the viewer; the field renders as a placeholder.', cmd);
        }

        const hriParam = params.find(p => p.key === 'i');
        // Manual default: interpretive disabled (i0), PRM p.192.
        const hriRaw = hriParam ? parseInt(hriParam.value, 10) : 0;
        if (hriParam && isNaN(hriRaw)) {
            this.printer.issue('warning', 'hri-invalid', `Interpretive field selection i"${hriParam.value}" is not 0, 1 or 2; defaulted to disabled.`, cmd);
        }

        const heightDots0 = this.int(params, 'h', 50);
        // Manual default: w1 narrow-element width (PRM270 p.171). Older parser
        // default of 2 was wrong: the printer keeps w1 in drag mode and only
        // raises it to 2 in picket mode (handled below).
        const moduleDots0 = this.int(params, 'w', 1);
        // POSTNET (c11): h/w magnify a base cell 13 dots tall × 22 wide, the
        // default 2×2 yielding USPS-spec size (PRM p.156). bwip's scale-1
        // POSTNET/Planet raster is ALREADY the spec symbol (≈1 px per dot
        // horizontally, 10 px tall = the 26-dot default cell), so magnification
        // n folds to height 13·n dots and width stretch max(1, n/2) on the
        // natural module. Planet (c22) prints at a fixed size — "any height and
        // width commands are ignored" (PRM p.171) — pinned to that natural size.
        let heightDots = heightDots0;
        let moduleDots = moduleDots0;
        // Picket vs drag (PRM p.53, same note in the 2.70 and 4400 manuals and
        // the Developer's Guide): "You can only print a bar width of 1 if you
        // are printing in drag mode (bars perpendicular to the print head). If
        // you select a width of 1 in picket mode (bars parallel to the print
        // head), the printer defaults to 2."
        //
        // Which mode applies is decidable from the stream after all: the print
        // head is a single line across the web, so bars lying ACROSS the web
        // (the field's own axis perpendicular to the feed) are picket, and the
        // media step quantises their width — 1 dot is not reachable. Bars ALONG
        // the feed are drag and keep w1. Field direction f sets that axis:
        // measured on our renderer, f0/f2 draw bars vertically (along the feed
        // = drag) and f1/f3 horizontally (across the web = picket).
        //
        // The spec called this undecidable (§15 item 3, "expose a toggle");
        // it is decidable, and a toggle would make the same stream render two
        // ways depending on a switch no printer has.
        const picket = this.rotationOf(params, cmd) % 2 === 1;
        let picketWidened = false;
        if (picket && moduleDots === 1) {
            moduleDots = 2;
            picketWidened = true;
        }
        if (parts[0] === '11') {
            // Clamp the magnification to the printable 1-10 band. The designer
            // always emits h/w in DOTS (e.g. h50), which read literally as a
            // POSTNET magnification would be a 650-dot-tall symbol; clamp with
            // a warning instead of rendering an absurd glyph.
            let magH = this.int(params, 'h', 2);
            let magW = this.int(params, 'w', 2);
            if (magH < 1 || magH > 10 || magW < 1 || magW > 10) {
                this.printer.issue('warning', 'postnet-magnification-out-of-range', `POSTNET cell magnification h${magH}/w${magW} is outside the printable 1-10 range; clamped (PRM p.156).`, cmd);
                magH = Math.max(1, Math.min(10, magH));
                magW = Math.max(1, Math.min(10, magW));
            }
            heightDots = 13 * magH;
            moduleDots = Math.max(1, Math.round(magW / 2));
        } else if (parts[0] === '22') {
            if (params.some(p => p.key === 'h' || p.key === 'w')) {
                this.printer.issue('info', 'planet-fixed-size', 'Planet (c22) prints at a fixed size; h and w are ignored (PRM p.171).', cmd);
            }
            heightDots = 26;
            moduleDots = 1;
        }
        // Ratio r: 0=2.5:1, 1=3:1 (default), 2=2:1; clamped to the documented set.
        // Wide:narrow families (0,2,3,4,5) apply it through the run-length path
        // in barcodes.ts (module-based symbologies carry no ratio, PRM p.170).
        const ratioRaw = parseInt(params.find(p => p.key === 'r')?.value ?? '1', 10);
        const ratio = [0, 1, 2].includes(ratioRaw) ? ratioRaw : 1;
        if (heightDots0 < 1 || heightDots0 > 9999) {
            this.printer.issue('warning', 'height-out-of-range', `Barcode height h${heightDots0} is outside the printable range (1-9999 dots).`, cmd);
        }
        if (moduleDots0 < 1 || moduleDots0 > 30) {
            this.printer.issue('warning', 'module-width-out-of-range', `Barcode module width w${moduleDots0} is outside the printable range (1-30 dots).`, cmd);
        }
        if (picketWidened) {
            this.printer.issue('info', 'picket-width-widened', `Bar width w1 in picket mode (bars across the web, f${this.rotationOf(params, cmd)}) prints as 2 dots — the printer cannot place a 1-dot bar across the head (PRM p.53).`, cmd);
        }
        const code39Mode = parts[0] === '0' ? parts[1] : undefined;
        // c6[,m1][,m2][,m3] (PRM p.144): m1=1 selects UCC-128 SSCC, m2=1
        // keeps parentheses/spaces in the interpretive field, m3 forces the
        // start subset. m3 is only valid with m1=0 (PF4i/PM4i fw 2.10+).
        const code128Ucc = parts[0] === '6' ? parts[1] : undefined;
        const code128Keep = parts[0] === '6' ? parts[2] : undefined;
        const code128StartSubset = parts[0] === '6' && parts.length >= 4 ? parts[3] : undefined;
        if (code128StartSubset && code128StartSubset !== '0' && code128Ucc === '1') {
            this.printer.issue('warning', 'code128-mode-conflict', `c6 m3 (start subset ${code128StartSubset}) is ignored when m1=1 selects UCC-128 (PRM p.144).`, cmd);
        }
        // ---- Batch A symbology parameter capture (PRM pp.154-171) ----
        let qrModel: string | undefined;
        let qrEcl: string | undefined;
        let qrMask: string | undefined;
        let microColumns: string | undefined;
        let microRows: string | undefined;
        let pdfColumns: string | undefined;
        let pdfEcLevel: string | undefined;
        let pdfTruncate: string | undefined;
        let compositeVersion: string | undefined;
        let compositeColumns: string | undefined;
        let compositeRowHeight: string | undefined;
        let hibcMode: string | undefined;
        let rssVersion: string | undefined;
        let rssSepHeight: string | undefined;
        let rssSegments: string | undefined;
        let maxiMode: string | undefined;
        if (parts[0] === '21') {
            // EAN.UCC Composite c21[,m1][,m2][,m3][,m4][,m5][,m6] (PRM p.162):
            // m1 selects the linear component and the CC variant paired with it
            // (0-12), m3 the 2D columns or segments per row, m5 the row height.
            // m2 (separator row), m4 (display spacing) and m6 (linear HRI) are
            // presentation details this viewer does not model.
            compositeVersion = parts[1];
            compositeColumns = parts[3];
            compositeRowHeight = parts[5];
            if (compositeVersion) {
                const v = Number(compositeVersion);
                if (!Number.isInteger(v) || v < 0 || v > 12) {
                    this.printer.issue('warning', 'composite-version-invalid', `EAN.UCC Composite version c21,m1="${compositeVersion}" is outside 0-12 (PRM p.162); defaulted to 0 (UCC/EAN-128 with CC-C).`, cmd);
                    compositeVersion = undefined;
                }
            }
            const compositeData = params.find(p2 => p2.key === 'd')?.value ?? '';
            if (!/\t/.test(compositeData) && !/<HT>/i.test(compositeData)) {
                this.printer.issue('warning', 'composite-needs-two-parts', `EAN.UCC Composite (c21) needs a linear component and a 2D component separated by <HT> in the data (PRM p.160); this field has only one part.`, cmd);
            }
        }
        if (parts[0] === '12') {
            // PDF417 c12[[,m1][,m2][,m3]] (PRM p.149): m1 columns 0-30 with 0
            // meaning "as close to square as possible", m2 error-correction
            // level 0-8 with 9 meaning auto, m3 truncation. These were captured
            // nowhere before, so every explicit parameter was silently ignored.
            pdfColumns = parts[1];
            pdfEcLevel = parts[2];
            pdfTruncate = parts[3];
            const c = Number(pdfColumns ?? 0);
            if (pdfColumns && (!Number.isInteger(c) || c < 0 || c > 30)) {
                this.printer.issue('warning', 'pdf417-columns-invalid', `PDF417 columns c12,m1="${pdfColumns}" is outside 0-30 (PRM p.149); defaulted to automatic.`, cmd);
                pdfColumns = undefined;
            }
            const e = Number(pdfEcLevel ?? 9);
            if (pdfEcLevel && (!Number.isInteger(e) || e < 0 || e > 9)) {
                this.printer.issue('warning', 'pdf417-ec-invalid', `PDF417 error-correction level c12,m2="${pdfEcLevel}" is outside 0-9 (PRM p.149); defaulted to automatic.`, cmd);
                pdfEcLevel = undefined;
            }
            if (pdfTruncate !== undefined && pdfTruncate !== '' && pdfTruncate !== '0' && pdfTruncate !== '1') {
                this.printer.issue('warning', 'pdf417-truncate-invalid', `PDF417 truncate flag c12,m3="${pdfTruncate}" is not 0 or 1 (PRM p.149); ignored.`, cmd);
                pdfTruncate = undefined;
            }
        }
        if (parts[0] === '18') {
            qrModel = parts[1];
            qrEcl = parts[2] ? parts[2].toUpperCase() : undefined;
            qrMask = parts[3];
            // PRM p.164: m1 is 1 or 2 (default 2). Model 1 has no bwip
            // encoder — warn and render model 2. Anything else (0, 5, 'foo')
            // is invalid syntax, not an unsupported model: say so distinctly.
            if (qrModel === '1') {
                this.printer.issue('warning', 'qr-model-unsupported', 'QR model 1 (c18,m1) has no encoder in the viewer; the symbol renders as model 2 (PRM p.164).', cmd);
            } else if (qrModel && qrModel !== '2') {
                this.printer.issue('warning', 'qr-model-invalid', `QR model "${qrModel}" (c18,m1) is not 1 or 2 (PRM p.164); defaulted to model 2.`, cmd);
                qrModel = undefined;
            }
            if (qrEcl && !['L', 'M', 'Q', 'H'].includes(qrEcl)) {
                this.printer.issue('warning', 'qr-ecl-invalid', `QR error-correction level c18,${parts[1] ?? ''},${parts[2] ?? ''} is not L/M/Q/H; defaulted to M.`, cmd);
                qrEcl = undefined;
            }
            if (qrMask) {
                const mk = Number(qrMask);
                if (!Number.isInteger(mk) || mk < 0 || mk > 8) {
                    this.printer.issue('warning', 'qr-mask-invalid', `QR mask c18,m3="${qrMask}" is outside 0-8; defaulted to automatic selection.`, cmd);
                    qrMask = undefined;
                }
            }
        } else if (parts[0] === '19') {
            microColumns = parts[1];
            microRows = parts[2];
            const c = Number(microColumns ?? 0);
            if (microColumns && (!Number.isInteger(c) || c < 0 || c > 4)) {
                this.printer.issue('warning', 'micro-columns-invalid', `MicroPDF417 columns c19,m1="${microColumns}" is outside 0-4 (PRM p.165); defaulted to automatic.`, cmd);
                microColumns = undefined;
            }
            const r = Number(microRows ?? 0);
            if (microRows && (!Number.isInteger(r) || r < 0 || r > 44)) {
                this.printer.issue('warning', 'micro-rows-invalid', `MicroPDF417 rows c19,m2="${microRows}" is outside 0-44 (PRM p.165); defaulted to automatic.`, cmd);
                microRows = undefined;
            }
        } else if (parts[0] === '20') {
            // RSS / GS1 DataBar c20[,m1][,m2][,m3] (PRM p.166). m1 selects the
            // version (default 2 = Stacked); m2 separator height and m3
            // segments-per-row apply only to the stacked variants.
            const m1 = parts[1];
            if (m1 !== undefined && m1 !== '') {
                const v = Number(m1);
                if (!Number.isInteger(v) || v < 0 || v > 6) {
                    this.printer.issue('warning', 'rss-version-invalid', `RSS version c20,m1="${m1}" is outside 0-6 (PRM p.166); defaulted to 2 (Stacked).`, cmd);
                } else {
                    rssVersion = m1;
                }
            }
            rssSepHeight = parts[2];
            rssSegments = parts[3];
            if (rssSegments) {
                const s = Number(rssSegments);
                if (!Number.isInteger(s) || s < 2 || s > 22 || s % 2 !== 0) {
                    this.printer.issue('warning', 'rss-segments-invalid', `RSS segments-per-row c20,m3="${rssSegments}" must be an even number 2-22 (PRM p.166); defaulted to automatic.`, cmd);
                    rssSegments = undefined;
                }
            }
            // No h sent: the printer derives height from w per version
            // (PRM p.166: 33*w for m1=0/3/5, 13*w for m1=1, 7*w for m1=2,
            // 10*w for m1=4, 34*w for m1=6). Override the generic h50 default.
            if (!params.some(p => p.key === 'h')) {
                const v = rssVersion ?? '2'; // invalid m1 defaulted to Stacked
                const mult = v === '1' ? 13 : v === '2' ? 7 : v === '4' ? 10 : v === '6' ? 34 : 33;
                // moduleDots can be 0 from an invalid w0 (already warned above);
                // guard so the derived height never collapses to 0 dots.
                heightDots = mult * Math.max(1, moduleDots);
            }
        } else if (parts[0] === '14') {
            // MaxiCode c14[,m1] (PRM p.159): fixed-size — the printer ignores
            // h/w, so pin natural dimensions (bwip rasterizes 121x101 px).
            maxiMode = parts[1];
            if (maxiMode) {
                const mo = Number(maxiMode);
                if (!Number.isInteger(mo) || mo < 2 || mo > 6) {
                    this.printer.issue('warning', 'maxi-mode-invalid', `MaxiCode mode c14,m1="${maxiMode}" is outside 2-6 (PRM p.159); defaulted to auto-discrimination.`, cmd);
                    maxiMode = undefined;
                }
            }
            if (params.some(p => p.key === 'h' || p.key === 'w')) {
                this.printer.issue('info', 'maxicode-fixed-size', 'MaxiCode (c14) is a fixed-size symbol; height and width magnification are ignored (PRM p.159).', cmd);
            }
            heightDots = 101;
            moduleDots = 1;
        } else if (parts[0] === '15') {
            // JIS-ITF is a boxed variant bwip lacks (PRM p.157). c21 no longer
            // belongs here: bwip ships composite encoders for every linear
            // family the manual lists, which the earlier note in this file
            // wrongly claimed it did not.
            this.printer.issue('info', 'symbology-no-encoder', `Symbology c${parts[0]} has no faithful encoder in the viewer; the field renders as a placeholder.`, cmd);
        } else if (parts[0] === '8' || parts[0] === '16') {
            hibcMode = parts[1];
            // Supplier second-data formats (m1=2) and provider second/multiple
            // formats (m1=5,6) need a linkage character across two paired
            // fields the viewer cannot reconstruct — flag; still render primary.
            if (hibcMode === '2' || hibcMode === '5' || hibcMode === '6') {
                this.printer.issue('info', 'hibc-secondary-unsupported', `HIBC secondary/multiple format (m1=${hibcMode}) encodes a linkage across paired fields; the viewer renders the single concatenated data.`, cmd);
            }
        }

        // Deep-validate fixed data against the symbology when the encoder is up.
        // Symbologies with no bwip mapping (JIS-ITF c15) skip
        // deep validation — the regex pass already ran. Batch A (2026-09-21)
        // wired 8/9/10/11/16/18/19/22 and Batch B added 14/20 into bwip.
        // c6 data is pre-strip-validated: '{' entries would otherwise consume
        // literal braces, so validation uses the same forced prefix as painting.
        const DEEP_VALIDATE_SKIP = new Set(['15']);
        const source = this.resolveSource(params);
        const encodable = applyI2of5Padding(parts[0], source.type === 'fixed' ? source.data : '');
        if (source.type === 'fixed' && encodable && !DEEP_VALIDATE_SKIP.has(parts[0]) && !eanDSeries) {
            if (isBarcodeEngineReady() && !measureBarcode(parts[0], encodable, {
                eanUpcVersion, code39Mode, code128StartSubset: code128StartSubset,
                code128Ucc, code128KeepInterpretive: code128Keep,
                qrModel, qrEcl, qrMask, microColumns, microRows,
                pdfColumns, pdfEcLevel, pdfTruncate,
                compositeVersion, compositeColumns, compositeRowHeight,
                rssVersion, rssSepHeight, rssSegments, maxiMode,
            })) {
                this.printer.issue('error', 'barcode-data-invalid', parts[0] === '6' && code128Ucc === '1'
                    ? `UCC-128 (c6,1) requires exactly 19 numeric characters (parentheses and spaces may be kept for the interpretive). Data: "${encodable.slice(0, 24)}"`
                    : `Data fails ${parts[0] === '7' ? 'EAN/UPC' : `symbology ${parts[0]}`} encoding rules. Data: "${encodable.slice(0, 24)}"`, cmd);
            }
        }

        const element: BarcodeElement = {
            kind: 'barcode',
            id,
            ...origin,
            f: this.rotationOf(params, cmd),
            symbology: parts[0],
            heightDots,
            moduleDots,
            ratio,
            hri: hriRaw === 2 ? 2 : hriRaw === 1 ? 1 : 0,
            source: this.resolveSource(params),
        };
        if (eanUpcVersion !== undefined) element.eanUpcVersion = eanUpcVersion;
        if (code39Mode) element.code39Mode = code39Mode;
        if (code128StartSubset) element.code128StartSubset = code128StartSubset;
        if (code128Ucc && code128Ucc !== '0') element.code128Ucc = code128Ucc;
        if (code128Keep && code128Keep !== '0') element.code128KeepInterpretive = code128Keep;
        if (hibcMode) element.hibcMode = hibcMode;
        if (qrModel) element.qrModel = qrModel;
        if (qrEcl) element.qrEcl = qrEcl;
        if (qrMask) element.qrMask = qrMask;
        if (microColumns) element.microColumns = microColumns;
        if (microRows) element.microRows = microRows;
        if (pdfColumns) element.pdfColumns = pdfColumns;
        if (pdfEcLevel) element.pdfEcLevel = pdfEcLevel;
        if (pdfTruncate) element.pdfTruncate = pdfTruncate;
        if (compositeVersion) element.compositeVersion = compositeVersion;
        if (compositeColumns) element.compositeColumns = compositeColumns;
        if (compositeRowHeight) element.compositeRowHeight = compositeRowHeight;
        if (rssVersion) element.rssVersion = rssVersion;
        if (rssSepHeight) element.rssSepHeight = rssSepHeight;
        if (rssSegments) element.rssSegments = rssSegments;
        if (maxiMode) element.maxiMode = maxiMode;

        this.printer.commitElement(element);
    }

    private parseLongField(id: number | undefined, params: FieldParam[]): void {
        this.beginField('L', id);
        const origin = this.originOf(params, 'L');
        const lengthDots = this.clampDim(this.int(params, 'l', 100), 'L.l');
        // w = line WIDTH (thickness) in dots, default 1 (PRM p.193 "Line
        // Field, Create or Edit"). Note `l` is the length; `w` is never a
        // second "width of the shape" — the shape is 1-D.
        const thicknessDots = this.clampDim(this.int(params, 'w', 1), 'L.w');
        if (lengthDots <= 0 || thicknessDots <= 0) {
            this.printer.issue('warning', 'nonpositive-size', `Line field has non-positive size (l${lengthDots}, w${thicknessDots}).`, `L${id ?? ''}`);
        }
        this.printer.commitElement({
            kind: 'line',
            id,
            ...origin,
            f: this.rotationOf(params, `L${id ?? ''}`),
            lengthDots,
            thicknessDots,
        });
    }

    private parseWideField(id: number | undefined, params: FieldParam[]): void {
        this.beginField('W', id);
        const cmd = `W${id ?? ''}`;
        const origin = this.originOf(params, 'W');
        const widthDots = this.clampDim(this.int(params, 'l', 100), 'W.l');
        const heightDots = this.clampDim(this.int(params, 'h', 100), 'W.h');
        const rParam = params.find(p => p.key === 'r');
        const radiusDots = rParam ? parseInt(rParam.value, 10) || undefined : undefined;
        if (widthDots <= 0 || heightDots <= 0) {
            this.printer.issue('warning', 'nonpositive-size', `Box field has non-positive size (l${widthDots}, h${heightDots}).`, cmd);
        }
        if (radiusDots !== undefined && radiusDots * 2 >= Math.min(widthDots, heightDots)) {
            this.printer.issue('warning', 'radius-out-of-range', `Corner radius r${radiusDots} is too large for a ${widthDots}x${heightDots} box; printers clamp it.`, cmd);
        }
        this.printer.commitElement({
            kind: 'box',
            id,
            ...origin,
            f: this.rotationOf(params, cmd),
            widthDots,
            heightDots,
            // PRM p.169 names this "Box width w, default 1": despite the name,
            // w is the border LINE thickness — the box's geometric extent is
            // l (length) × h (height). Same clamp as L.w; never silent.
            thicknessDots: this.clampDim(this.int(params, 'w', 1), 'W.w'),
            radiusDots,
        });
    }

    /** U field: places a previously defined graphic. */
    private parseGraphicField(id: number | undefined, params: FieldParam[]): void {
        this.beginField('U', id);
        const origin = this.originOf(params, 'U');
        const graphicRef = this.int(params, 'c', 0);
        const def = this.printer.downloadedGraphics.get(graphicRef);
        if (!def) {
            this.printer.issue('warning', 'graphic-undefined', `Graphic field references undefined graphic G${graphicRef}.`, 'U');
        }
        this.finalizeGraphicOrientation(def, graphicRef);
        this.printer.commitElement({
            kind: 'graphic',
            id,
            ...origin,
            f: this.rotationOf(params, `U${id ?? ''}`),
            graphicId: graphicRef,
            name: def?.name,
            widthDots: def?.widthDots ?? this.clampDim(this.int(params, 'l', 100), 'U.l'),
            heightDots: def?.heightDots ?? this.clampDim(this.int(params, 'h', 100), 'U.h'),
            data: def?.data,
        });
    }

    /**
     * BarTender's split graphic form stores the bitmap in print-head
     * orientation: each u strip is a ROW of the visual image, and the G
     * header's x/y are swapped vs the visual (x = strip count, y = 6 × strip
     * length). Detect that shape once all strips have arrived and swap the
     * stored dimensions so the renderer draws the graphic upright.
     */
    private finalizeGraphicOrientation(def: { widthDots: number; heightDots: number; data: string[] } | undefined, graphicId: number): void {
        if (!def || (def as { orientationFinalized?: boolean }).orientationFinalized) return;
        (def as { orientationFinalized?: boolean }).orientationFinalized = true;
        // Only the BarTender SPLIT form (0-based u strips fed frame-by-frame,
        // tracked via graphicColumnBase === 0) stores rows in print-head
        // orientation. The single-frame form (1-based u, column-major) must
        // not be transposed even when its shape signature matches.
        if (this.printer.graphicColumnBase !== 0) return;
        const stripLen = def.data.find(d => d !== undefined)?.length ?? 0;
        if (stripLen > 0 && stripLen * 6 === def.heightDots && def.data.length === def.widthDots) {
            const visualW = stripLen * 6;
            def.widthDots = visualW;
            def.heightDots = def.data.length;
        }
    }

    /**
     * G definition: "G1,NAME;x<w>;y<h>;u0,<packed ascii>;u1,..." (single
     * frame) — or the BarTender split form: "G1;x<w>;y<h>" followed by
     * standalone "u<n>,<data>" frames. appendGraphicColumn() feeds the latter.
     *
     * Orientation note: BarTender stores graphics in print-head orientation —
     * each u strip is a ROW of the visual image (bits run across the label
     * width), and the G header's x/y are swapped relative to the visual.
     * When the strip count (u indices) exceeds the header's x, we transpose:
     * visual width = 6 × strip length, visual height = strip count.
     */
    private parseGraphicDefinition(id: number, params: FieldParam[]): void {
        // First parameter is the resource name (only when it's not a param key).
        const first = params[0];
        const name = first && !/^[a-zA-Z]<|^u\d+,/.test(first.value) && !/^\d+$/.test(first.value) && !/^[a-z]/.test(first.value) ? first.value : undefined;
        const w = this.int(params, 'x', 0);
        const h = this.int(params, 'y', 0);
        const data: string[] = [];
        this.storeGraphic(id, name, w, h, data, params.filter(p => p.key === 'u'));
    }

    /** Stores a graphic, folding in any inline u rows (single-frame form). */
    private storeGraphic(id: number, name: string | undefined, w: number, h: number, data: string[], uRows: FieldParam[]): void {
        for (const row of uRows) {
            const commaIdx = row.value.indexOf(',');
            if (commaIdx < 0) continue;
            const idx = parseInt(row.value.slice(0, commaIdx), 10);
            if (!isNaN(idx)) this.placeColumn(data, idx, row.value.slice(commaIdx + 1));
        }
        const clamp = (n: number) => {
            if (n > MAX_GRAPHIC_DIM) {
                this.printer.issue('warning', 'graphic-dim-clamped', `Raster graphic ${id} declares ${n} dots on one axis (> ${MAX_GRAPHIC_DIM}); clamped.`, 'G');
                return MAX_GRAPHIC_DIM;
            }
            return n;
        };
        this.printer.downloadedGraphics.set(id, { name, widthDots: clamp(w), heightDots: clamp(h), data });
        this.printer.lastGraphicId = id;
        this.printer.issue('info', 'graphic-defined', `Raster graphic "${name ?? id}" (${w}x${h} dots) decoded from ${data.length} strips.`, 'G');
    }

    /** Id of the most recently defined graphic (for split u-frame form). */
    /** u-index base detected from the first column of the current graphic. */

    /**
     * Standalone "u<n>,<data>" frame from a BarTender split graphic def:
     * appends one column into the most recently opened graphic.
     */
    private appendGraphicColumn(idx: number, data: string): void {
        const last = this.printer.lastGraphicId;
        const def = last !== null ? this.printer.downloadedGraphics.get(last) : undefined;
        if (!def) {
            this.printer.issue('warning', 'graphic-column-orphan', `Graphic column u${idx} appeared before any G definition.`, `u${idx}`);
            return;
        }
        this.placeColumn(def.data, idx, data);
    }

    /**
     * Places a packed strip at 0-based position. Two bases exist in the wild:
     * the manual's single-frame form is 1-based (PRM p.186), while BarTender's
     * split form emits 0-based u0,u1,…. Detect the base from the first strip
     * of each graphic: idx===0 → 0-based sequence; otherwise 1-based.
     */
    private placeColumn(data: string[], idx: number, value: string): void {
        if (idx === 0) {
            this.printer.graphicColumnBase = 0;
        } else if (data.length === 0) {
            this.printer.graphicColumnBase = 1;
        }
        const target = this.printer.graphicColumnBase === 1 ? idx - 1 : idx;
        data[target] = value;
    }
}

export interface ParseOptions {
    /**
     * Target printer model. Direct Graphics written in a driver's centred frame
     * (streams with no <SI>L) need per-model placement constants; without a
     * model they fall back to the label-relative reading and are misplaced.
     */
    model?: string;
    dpi?: 203 | 300 | 406;
    /**
     * Page orientation of the source document. The driver writes Direct
     * Graphics origins in DIFFERENT frames for the two orientations — measured
     * with purpose-built fixtures (see directGraphics placement notes) — and
     * the stream does not record which was used. btPortrait additionally needs
     * `pageHeightDots`, because its formula is anchored to the page's height.
     */
    orientation?: 'portrait' | 'landscape';
    /** Page height in dots (the feed axis). Required for `orientation:
     *  'portrait'`; the stream never carries it. */
    pageHeightDots?: number;
}

export const parseViewerIPL = (code: string, opts: ParseOptions = {}): ViewerLabel => {
    const parser = new IPLViewerParser();
    parser.setDriver(opts.model, opts.dpi);
    parser.setPage(opts.orientation, opts.pageHeightDots);
    return parser.parse(code);
};
