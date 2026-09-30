import type { Design, Field, TextField, BarcodeField, LineField, BoxField, ImageField, PrinterSettings, HRIPlacement, FieldDataSource, DateFormat, TimeFormat, CounterDataSource } from '../types';
import { DPI_MAP, FONT_MAP, POINTS_TO_MM } from '../constants';
import { decodeGraphicColumns } from './ipl/graphics';
import { normalizeAllControlChars, maskFieldPayloads } from './ipl/tokenizer';
import { readFieldStep } from './ipl/viewerParser';

const dotsToMm = (dots: number, dpi: PrinterSettings['dpi']): number => {
    return dots / DPI_MAP[dpi];
};

const mmToDots = (mm: number, dpi: PrinterSettings['dpi']): number => {
    return Math.round(mm * DPI_MAP[dpi]);
};

/**
 * A field parameter that follows the fixed data: ONE lowercase letter with a
 * purely numeric value ("k12", "h3", "w2", "c25", "o10,40", "f0").
 *
 * Same shape and same purpose as FIELD_PARAM_AFTER_DATA in viewerParser — the
 * two parsers read the same streams, so they must agree on where fixed text
 * ends. Kept in step deliberately rather than shared, because the importer
 * works on the already-split frame body while the viewer works on the whole
 * frame; the RULE is what has to match, not the mechanics.
 */
const FIELD_PARAM_AFTER_DATA = /^[abcefghijkmnpqrstuwz][\d,.\-]+$/;

/**
 * `p` (Code 39 Prefix Character, PRM p.181) is the ONE field parameter whose
 * value is not numeric — `p[n1][n2][n3][n4]`, "A to Z (uppercase only) and 0
 * to 9", or a leading '@' meaning "clears all prefixes". Without this, a
 * trailing `pABC4` stayed glued to the fixed data exactly as it did in the
 * viewer: "d3,123;pABC4" imported as the literal text "123;pABC4".
 *
 * Kept identical to viewerParser.CODE39_PREFIX_AFTER_DATA — the rule has to
 * match across the two parsers even though the mechanics differ.
 */
const CODE39_PREFIX_AFTER_DATA = /^p(?:@|[A-Z0-9]{1,4})$/;

/**
 * The start of a NEW FIELD inside a `;`-chain, e.g. `B2`, `H1`, `L3`, `W4`.
 *
 * `d3` fixed text is greedy — "H0;o10,10;d3,A;B" is ONE field reading "A;B" —
 * but greedy without limit swallowed the REST OF THE LABEL when a chain held
 * more than one field. In the manual's own form,
 *   <STX>E1;F1;H1;o100,100;…;d3,Hello World!;B2;o100,200;…;d3,12345678<ETX>
 * the `H1` field's data read "Hello World!;B2;o100,200;…;d3,12345678;R" and the
 * barcode was never created.
 *
 * Only a segment that is exactly a field letter followed by its id can start a
 * new field, which is the same "trailing run of well-formed segments" tradeoff
 * as the parameter rules above: text that happens to end in `;B2` is still read
 * as a new barcode field, and that is intentional — it is indistinguishable
 * from the real thing, and the manual's layout is the common case.
 */
const FIELD_START = /^[HBLWU]\d+$/;

/**
 * Break a `;`-chain into one segment-group per FIELD.
 *
 * The manual writes a label as a single frame:
 *   <STX>E1;F1;H1;o100,100;…;d3,Hello World!;B2;o100,200;…;d3,12345678;R<ETX>
 * and the viewer has always read that. The importer treated the whole frame as
 * ONE field, so `d3`'s greedy text ran to the end of the label and everything
 * after the first field vanished — samples/chained.ipl imported as ZERO fields.
 *
 * The split is made only at a segment that IS a field start (`H1`, `B2`), so
 * the `d3` greediness that splitFieldCommand protects still holds within each
 * field: "H0;o10,10;d3,A;B" has no field-shaped segment after the data and
 * stays one field reading "A;B".
 */
const splitChainIntoFields = (body: string): string[] => {
    const segs = body.split(';');
    const out: string[] = [];
    let current: string[] = [];
    for (let i = 0; i < segs.length; i++) {
        const seg = segs[i].trim();
        // A new field starts here, and only here.
        if (i > 0 && FIELD_START.test(seg)) {
            out.push(current.join(';'));
            current = [seg];
            continue;
        }
        // `R` exits program mode and ends the label; it is a command, never
        // data. Without this it stayed glued to the last field's text —
        // "...d3,12345678;R" imported the barcode's data as "12345678;R".
        if (i > 0 && seg === 'R' && i === segs.length - 1) break;
        current.push(segs[i]);
    }
    out.push(current.join(';'));
    return out.filter(s => s.trim().length > 0);
};

/**
 * Splits one frame body into field-command segments, keeping `d3` fixed text
 * greedy.
 *
 * Plain `split(';')` truncated the label's own text: "H0;o10,10;d3,A;B" is one
 * field whose fixed data READS "A;B" (PRM 2.70 p.109 puts a field parameter
 * after the data the same way), but the split made it "d3,A" plus a stray "B",
 * so the importer produced "A" where the viewer — which has always handled this
 * — produced "A;B". Three comments in this file already promise "viewer
 * parity"; this is the place that broke it.
 *
 * Only a TRAILING RUN of well-formed parameters is split off, so a
 * param-shaped segment in the middle of intended text cannot cut it. That is
 * the same rule and the same tradeoff as viewerParser.splitParams.
 *
 * This splits ONE field into its parts. Breaking a `;`-chain into several
 * FIELDS is splitChainIntoFields' job, which runs first — doing it here would
 * return the later fields' segments as if they were parameters of this one.
 */
const splitFieldCommand = (body: string): string[] => {
    const di = body.search(/(?:^|;)d3,/);
    if (di < 0) return body.split(';');
    const head = body.slice(0, di).split(';').filter(s => s.length > 0);
    const tail = body.slice(di + 1);              // from "d3," to the end
    const segs = tail.split(';');
    let cut = segs.length;
    while (cut > 1 && (FIELD_PARAM_AFTER_DATA.test(segs[cut - 1]) || CODE39_PREFIX_AFTER_DATA.test(segs[cut - 1]))) cut--;
    // segs[cut - 1] ends with the frame's customary trailing ';' when present;
    // strip exactly one, as the single-frame path does.
    const d3Seg = segs.slice(0, cut).join(';').replace(/;$/, '');
    return [...head, d3Seg, ...segs.slice(cut)];
};

function parseParameters(paramArray: string[]): { params: { [key: string]: string }, dataSource: FieldDataSource | null } {
    const params: { [key: string]: string } = {};
    let dataSource: FieldDataSource | null = null;

    const dateFormatRev: { [key: string]: DateFormat } = {
        '0': 'YY/MM/DD', '1': 'YYYY/MM/DD', '2': 'DD/MM/YY', '3': 'DD/MM/YYYY',
    };
    const timeFormatRev: { [key: string]: TimeFormat } = {
        '0': 'HH:MM:SS 24hr', '1': 'HH:MM 24hr', '2': 'HH:MM:SS 12hr',
        '3': 'HH:MM 12hr', '4': 'HH:MM:SS am/pm', '5': 'HH:MM am/pm',
    };

    for (const p of paramArray) {
        if (!p) continue;
        const key = p.charAt(0);
        const value = p.substring(1);
        if (p.startsWith('d3,')) {
            dataSource = { type: 'fixed', data: p.substring(3) };
        } else if (p.startsWith('d0')) { // Can be d0 or d0,255
             dataSource = { type: 'variable', defaultData: '' };
             params[key] = value;
        } else if (p.startsWith('d4,')) {
            dataSource = { type: 'date', format: dateFormatRev[p.charAt(3)] || 'DD/MM/YYYY' };
        } else if (p.startsWith('d5,')) {
            dataSource = { type: 'time', format: timeFormatRev[p.charAt(3)] || 'HH:MM:SS 24hr' };
        } else {
            params[key] = value;
        }
    }

    return { params, dataSource };
}

interface ImportedGraphicDef { w: number; h: number; strips: string[]; rowForm: boolean }

// Batch W removed the per-type rotation-anchor compensation, and with it the
// only consumer of calculateFieldDimensionsDots — imported positions are now
// identity (the printed origin IS the designer's stored top-left), so the
// parser never needs field sizes to un-rotate a placement. The function was
// dead code and has been deleted; field construction reads its own params
// (and graphicDefs for U sizes) directly.


/** Something the import could not represent, for the caller to surface. */
export interface ImportNotice {
    /** Command or command letter that was dropped, e.g. "I1" or "Z9". */
    command: string;
    message: string;
}

export const parseIPL = (
    rawInput: string,
    dpi: PrinterSettings['dpi'],
    /**
     * Optional sink for fields the design model cannot represent.
     *
     * The designer has no concept of an IPL interpretive field (In) — it
     * attaches an HRI row to its barcode instead — so an In that is not an HRI
     * font declaration has nowhere to go, and an unrecognized letter has
     * nowhere at all. Both used to disappear silently: the viewer produced two
     * elements where the importer produced one, and nothing said why. Reported
     * rather than modelled, so the caller can tell the user what was lost.
     *
     * Optional so existing callers and tests keep their current signature.
     */
    onNotice?: (notice: ImportNotice) => void,
): Design => {
    // Every regex below speaks literal notation (<STX>…), but the doc
    // contract is "raw control bytes and literals both accepted" — the viewer
    // hands this parser bytesToByteString output straight from a file. Full
    // control-byte normalization (line endings excepted) makes the whole
    // parser notation-agnostic. Direct Graphics binary payloads would be
    // rewritten by this pass, but parseIPL never decoded DG frames anyway
    // (the viewer owns those); ASCII-packed u/G graphics are unaffected.
    const iplCode = normalizeAllControlChars(rawInput);
    const design: Design = {
        name: 'Imported Label',
        labelSettings: { width: 101.6, height: 50.8, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
        printerSettings: {
            model: 'Generic', dpi, quantity: 1, mediaType: 'thermal-transfer', mediaSenseMode: 'gap',
            printSpeed: 6, darkness: 10,
        },
        fields: [],
        dataSources: [],
        nextId: 1,
        guides: { horizontal: [], vertical: [] },
    };

    const labelWidthMatch = iplCode.match(/<ESC>C<SI>W(\d+)/);
    if (labelWidthMatch) {
        // <SI>W is the label width (across the printhead). Orientation is not
        // decided here — <SI>L below is what settles it, and only when both are
        // present.
        design.labelSettings.width = dotsToMm(parseInt(labelWidthMatch[1], 10), dpi);
    }

    const labelLengthMatch = iplCode.match(/<STX><SI>L(\d+)<ETX>/);
    if (labelLengthMatch) {
        design.labelSettings.height = dotsToMm(parseInt(labelLengthMatch[1], 10), dpi);
        // Orientation is DERIVED, and only when the stream says enough to tell:
        // <SI>W is the width across the printhead and <SI>L the length along
        // the feed, so a length longer than the width means the stock is wider
        // than it is tall. Nothing else depends on the value — the generator
        // sizes the label from `width` and `height` whatever orientation says —
        // but the property panel reads it back, and answering "Portrait" for a
        // landscape stream is a control that contradicts the label beside it.
        //
        // A stream that declares only <SI>W is genuinely undecidable and stays
        // portrait: some drivers write the printhead width there for a landscape
        // page (samples/bartender-sweep-one-box-landscape.ipl declares W388 for
        // a 4x2 in page and no <SI>L at all), so guessing would be wrong about
        // as often as right.
        if (labelWidthMatch && design.labelSettings.height > design.labelSettings.width) {
            design.labelSettings.orientation = 'landscape';
        }
    }

    // Rudimentary settings parsing (tolerates combined <SI> frames from third-party streams)
    const settingsBlock = iplCode.split('<STX><ESC>P<ETX>')[0];
    if (settingsBlock) {
        const speedMatch = settingsBlock.match(/<SI>S(\d+)/);
        if (speedMatch) design.printerSettings.printSpeed = parseInt(speedMatch[1], 10) / 10;
        const darknessMatch = settingsBlock.match(/<SI>d(-?\d+)/);
        if (darknessMatch) design.printerSettings.darkness = parseInt(darknessMatch[1], 10) + 10;
        const mediaTypeMatch = settingsBlock.match(/<SI>g(\d)/);
        if (mediaTypeMatch) design.printerSettings.mediaType = mediaTypeMatch[1] === '0' ? 'direct-thermal' : 'thermal-transfer';
        const mediaSenseMatch = settingsBlock.match(/<SI>T([012])/);
        if (mediaSenseMatch) {
            const senseMap: {[key: string]: 'gap' | 'reflective' | 'continuous'} = {'0': 'continuous', '1': 'gap', '2': 'reflective'};
            design.printerSettings.mediaSenseMode = senseMap[mediaSenseMatch[1]] || 'gap';
        }
    }


    // Extract the format body: everything after the "E#;F#" frame until the
    // program-mode exit (<STX>R<ETX>), a stray field-data frame (<STX>D#<ETX>),
    // the print invocation (<STX><ESC>E...), or end of input. Some generators
    // (including this app) never emit <STX>D0<ETX>, so it must not be required.
    // The format head is `E#;F#`, and it may be a frame of its own —
    // `<STX>E1;F1<ETX>` — or the HEAD OF A CHAINED FRAME, which is how the
    // manual writes a label and how samples/chained.ipl is written:
    //   <STX><ESC>P;E1;F1;H1;o100,100;…;B2;o100,200;…;R<ETX>
    // Matching only the standalone form found no start in a chained stream, so
    // `formatContent` stayed empty and the import produced ZERO fields: the
    // whole label dropped, with nothing said. The viewer has always read both.
    //
    // The match therefore may begin mid-frame, and when it does the frame's
    // REMAINDER after `E#;F#` is label content that must be kept.
    const startMatch = /E\d+;F\d*;?/.exec(iplCode);
    let formatContent = '';
    if (startMatch) {
        const headEnd = iplCode.indexOf('<ETX>', startMatch.index);
        const frameEnd = headEnd < 0 ? iplCode.length : headEnd;
        // Everything from `E#;F#` to the end of its frame is content, whether
        // the frame carried anything else.
        const inFrame = iplCode.slice(startMatch.index, frameEnd);
        const rest = iplCode.slice(frameEnd);
        const endMatch = /<STX>(?:R|D\d+)<ETX>|<STX><ESC>/.exec(rest);
        const afterFrame = endMatch ? rest.slice(0, endMatch.index) : rest;
        // The head segment itself is a command; the rest of its frame follows
        // it as sibling segments, so both are joined by the separator the
        // splitter below expects.
        formatContent = inFrame + afterFrame;
    }

    // A frame holds either ONE command or a `;`-CHAIN of them. A chained frame
    // begins with the format head, `<STX>E1;F1;H1;o…;d3,…<ETX>`. Two things
    // have to happen to it, and leaving out either one silently imported an
    // empty label:
    //
    //   1. the head `E#;F#` is dropped — it is not a field, and while it was
    //      `commandParts[0]` read `E1`, which matches no field letter;
    //   2. the remainder is broken at the NEXT FIELD, so the first field's
    //      greedy `d3` text does not run to the end of the label.
    const commands = formatContent
        .split('<STX>')
        .filter(cmd => cmd.trim().length > 0)
        .flatMap(cmd => {
            const body = cmd.replace(/<ETX>\s*$/, '').replace(/^E\d+;F\d*;?/, '');
            return body.trim().length > 0 ? splitChainIntoFields(body) : [];
        });

    const variableFields: (TextField | BarcodeField)[] = [];

    // Downloaded raster definitions: "G<id>[,NAME];x<w>;y<h>;u1,<strips>..."
    // plus the BarTender split form (bare "u<n>,<data>" frames following the
    // G header). Scan the WHOLE stream: the format-body slice below starts at
    // E#;F#, and generators place G frames before it.
    const graphicDefs = new Map<number, ImportedGraphicDef>();
    {
        let lastGid: number | null = null;
        const frameRe = /<STX>([^<]*)<ETX>/g;
        let m: RegExpExecArray | null;
        const numParam = (body: string, key: string): number => {
            const p = new RegExp(`;${key}(\\d+)`).exec(body);
            return p ? parseInt(p[1], 10) : 0;
        };
        while ((m = frameRe.exec(iplCode)) !== null) {
            const body = m[1];
            const g = /^G(\d+)(?:,[^;<]*)?/.exec(body);
            if (g) {
                const gid = parseInt(g[1], 10);
                graphicDefs.set(gid, { w: numParam(body, 'x'), h: numParam(body, 'y'), strips: [], rowForm: false });
                lastGid = gid;
                const uRe = /;u(\d+),([^;]*)/g;
                let u: RegExpExecArray | null;
                while ((u = uRe.exec(body)) !== null) {
                    const def = graphicDefs.get(gid)!;
                    const idx = parseInt(u[1], 10);
                    if (idx === 0) def.rowForm = true;
                    def.strips[idx] = u[2];
                }
            } else if (lastGid !== null && /^u\d+,/.test(body)) {
                const u = /^u(\d+),([^;]*)/.exec(body)!;
                const def = graphicDefs.get(lastGid);
                if (def) {
                    const idx = parseInt(u[1], 10);
                    if (idx === 0) def.rowForm = true;
                    def.strips[idx] = u[2];
                }
            }
        }
        for (const def of graphicDefs.values()) {
            // BarTender split form (0-based strips): x/y are swapped vs the
            // visual — x = strip (row) count, y = 6 × strip length. Transpose
            // to visual space so decodeGraphicColumns' row-major path fits.
            if (def.rowForm) { const t = def.w; def.w = def.h; def.h = t; }
            // Compact holes (sparse frames) would shift every later strip.
            def.strips = def.strips.filter(s => s !== undefined);
        }
    }


    // Interpretive-field commands carry the HRI font for barcodes.
    const hriFontMap = new Map<number, { font: string; fontSize?: number }>();
    const hriCmdRegex = /<STX>I(\d+);c([^;<]+)(?:;k(\d+))?[^<]*<ETX>/g;
    let hriMatch;
    while ((hriMatch = hriCmdRegex.exec(iplCode)) !== null) {
        hriFontMap.set(parseInt(hriMatch[1], 10), {
            font: hriMatch[2],
            fontSize: hriMatch[3] !== undefined ? parseInt(hriMatch[3], 10) : undefined,
        });
    }

    commands.forEach(commandStr => {
        const commandParts = splitFieldCommand(commandStr);
        const commandIdMatch = commandParts[0].match(/^([HBLWU])(\d+)/);
        if (!commandIdMatch) {
            // A FIELD this model cannot hold. Only an In qualifies, and only an
            // orphan one:
            //
            //   In  an interpretive field. The designer has no such concept (it
            //       attaches the human-readable row to its bar code), and the
            //       HRI font pass above has already consumed the ones that were
            //       font declarations — so only an In with no bar code to
            //       attach to has nowhere to go.
            //
            // Deliberately NOT every unrecognized segment. G/u graphic
            // definitions, D field deletes and N session-save are all handled
            // elsewhere (or are no-ops), and reporting them said "not a field
            // type this designer can represent" about things that were never
            // fields — a false-positive storm on correct input, which trains
            // users to ignore the message. Only a segment that is shaped like a
            // FIELD the designer lacks is worth a word.
            const head = commandParts[0].trim();
            const interpId = /^I(\d+)$/.exec(head);
            if (onNotice && interpId && !hriFontMap.has(parseInt(interpId[1], 10))) {
                onNotice({
                    command: head.slice(0, 24),
                    message: `Interpretive field "${head.slice(0, 24)}" was not imported: this designer attaches the human-readable row to its bar code instead of holding it as its own field.`,
                });
            }
            // Qn — RFID Tag Write Field, Create or Edit (PRM 2.70 p.213). A
            // FIELD this model cannot hold, like the In above: the designer has
            // no RFID concept, and the field writes to a TAG so it draws no
            // label content here. Reported for the same reason — the import
            // silently dropped it, and nothing about the resulting design said
            // a field had been left behind.
            const rfidId = /^Q(\d+)$/.exec(head);
            if (onNotice && rfidId) {
                onNotice({
                    command: head.slice(0, 24),
                    message: `RFID tag write field "${head.slice(0, 24)}" was not imported: this designer has no RFID concept. The field writes to the tag rather than printing, so no label content is lost — but any tag-writing this format relies on is gone.`,
                });
            }
            return;
        }

        const typeChar = commandIdMatch[1];
        const fieldId = parseInt(commandIdMatch[2]);
        
        const { params, dataSource: parsedSource } = parseParameters(commandParts.slice(1));
        
        const [ox_raw, oy_raw] = (params['o'] || '0,0').split(',').map(Number);
        const rotationDeg = (parseInt(params['f'] || '0') * 90);
        
        // Batch W: identity — under the manual's CCW rotation rule the
        // printed origin IS the unrotated top-left corner of the field
        // ("the field origin remains on the corner where it was before you
        // rotated the field", DevGuide p.27), which is exactly what the
        // designer stores in x/y. The old per-type compensation tables
        // paired with the generator's former CW-bridge table; both sides are
        // identity now, so imported rotated fields land where the viewer
        // paints them and where the designer draws them.
        const px_dots = ox_raw;
        const py_dots = oy_raw;
        
        const x = dotsToMm(px_dots, dpi);
        const y = dotsToMm(py_dots, dpi);

        let field: Field | null = null;
        const baseProps = { id: fieldId, rotation: rotationDeg as Field['rotation'] };
        design.nextId = Math.max(design.nextId, fieldId + 1);
        const fieldName = `${typeChar === 'H' ? 'Text' : typeChar === 'B' ? 'Barcode' : typeChar === 'L' ? 'Line' : typeChar === 'U' ? 'Image' : 'Box'} ${baseProps.id}`;
        
        let dataSource: FieldDataSource = parsedSource ?? { type: 'variable', defaultData: '' };
        if (dataSource.type === 'fixed') {
            dataSource = { type: 'fixed', data: dataSource.data.replace(/<SUB>(?:<CR>|\r)/g, '\n') };
        }

        switch (typeChar) {
            case 'H': {
                // c n[,m][,p] — the font id alone must reach FONT_MAP; feeding
                // the raw value in would leave `font: "25,3"`, which resolves
                // to no face at all AND silently drops the gap on regenerate.
                const cParts = (params['c'] ?? '').split(',');
                const fontId = (cParts[0] || '25').trim();
                const gapRaw = cParts.length > 1 ? parseInt(cParts[1], 10) : NaN;
                const intercharGapDots = Number.isInteger(gapRaw) && gapRaw >= -199 && gapRaw <= 399 ? gapRaw : undefined;
                const fontInfo = FONT_MAP[fontId];
                const isOutline = fontInfo?.type === 'outline';
                let fontSize = 12, h_mag = 1, w_mag = 1;

                if (isOutline) {
                    if (params['k']) { // Font size in points
                        fontSize = parseInt(params['k']);
                    } else if(params['h']) { // Font size in dots
                        const h_dots = parseInt(params['h']);
                        fontSize = Math.round(dotsToMm(h_dots, dpi) / POINTS_TO_MM);
                    }
                } else {
                    h_mag = parseInt(params['h'] || '1');
                    w_mag = parseInt(params['w'] || '1');
                }

                const textField: TextField = {
                    ...baseProps, type: 'text', name: fieldName, x, y, dataSource, font: fontId,
                    fontSize, h_mag, w_mag,
                    ...(intercharGapDots === undefined ? {} : { intercharGapDots }),
                };
                if (dataSource.type === 'variable') variableFields.push(textField);
                field = textField;
                break;
            }
            case 'B': {
                 let hri: HRIPlacement = 'below';
                 if (params['i'] === '0') hri = 'none'; else if (params['i'] === '2') hri = 'above';
                 const cParts = (params['c'] || '6').split(',');
                 const symbology = cParts[0];
                 const barcodeField: BarcodeField = {
                     ...baseProps, type: 'barcode', name: fieldName, x, y, dataSource,
                     symbology, humanReadable: hri,
                     h_mag: parseInt(params['h'] || '50'), w_mag: parseInt(params['w'] || '1'),
                 };
                 // POSTNET (c11): h/w are cell MAGNIFICATIONS, not dot sizes
                 // (PRM p.156) — convert the height to dots (13 per unit) so
                 // the designer's "Bar Height (dots)" shows a real size.
                 // Planet (c22) is fixed-size (PRM p.171): keep the defaults.
                 if (symbology === '11' && params['h'] !== undefined) {
                     const mag = Math.max(1, Math.min(10, parseInt(params['h'], 10) || 2));
                     barcodeField.h_mag = 13 * mag;
                 }
                 if (symbology === '0' && cParts.length >= 2) {
                     // PRM p.150: c0 groups m by CHARSET, and the check-digit
                     // meaning repeats within each group — 0/1/2 = 8646,
                     // 3/4/5 = full ASCII, 6/7/8 = 43-character; +0 none,
                     // +1 printer enters, +2 host enters. Reading only 1 and 2
                     // sent 4/5/7/8 (a printer/host check digit in the full-ASCII
                     // and 43-char groups) to 'none', so those imported with the
                     // check digit silently dropped.
                     const checkDigitRev: { [key: string]: 'none' | 'printer-generated' | 'host-verifies' } = {
                         '1': 'printer-generated', '4': 'printer-generated', '7': 'printer-generated',
                         '2': 'host-verifies', '5': 'host-verifies', '8': 'host-verifies',
                     };
                     barcodeField.code39_checkDigit = checkDigitRev[cParts[1]] || 'none';
                     // The CHARSET itself is not modeled — this designer's Code 39
                     // is the 8646 set the generator emits. Full ASCII (3-5) and
                     // 43-character (6-8) therefore regenerate as 8646, which
                     // encodes identically for A-Z0-9 but REJECTS the lowercase
                     // and symbols those sets exist for, so the loss is named.
                     const charset = parseInt(cParts[1], 10);
                     if (onNotice && (charset >= 3 && charset <= 8)) {
                         onNotice({
                             command: `c0,${cParts[1]}`.slice(0, 24),
                             message: `Code 39 charset c0,${cParts[1]} (${charset <= 5 ? 'full ASCII' : '43-character'}) was not imported: this designer emits the 8646 set (PRM p.150), so the bar code regenerates as 8646. It encodes A-Z and 0-9 identically, but not the lowercase and symbols the other sets carry.`,
                         });
                     }
                 }
                 // Code 39 Prefix Character, Define (PRM p.181). The prefix is
                 // part of the printed SYMBOL, so dropping it silently would
                 // change the bar pattern — a real loss, not a cosmetic one.
                 // The design model has no prefix concept, so it is reported
                 // the same way the interpretive field is: the caller tells the
                 // user what the import could not carry. Only Code 39 is worth
                 // a word — "only valid for Code 39 fields", so on any other
                 // symbology the printer ignores it and nothing is lost.
                 const prefixParam = params['p'];
                 if (symbology === '0' && prefixParam && onNotice) {
                     const shown = prefixParam.startsWith('@') ? 'p@' : `p${prefixParam}`;
                     onNotice({
                         command: shown.slice(0, 24),
                         message: `Code 39 prefix "${shown.slice(0, 24)}" was not imported: this designer has no prefix setting, so the bar code regenerates without it. The characters are part of the printed symbol (PRM p.181).`,
                     });
                 }
                 if (symbology === '6' && cParts.length >= 4) {
                     const subsetRev: { [key: string]: 'auto' | 'a' | 'b' | 'c' } = {
                         '0': 'auto', '1': 'a', '2': 'b', '3': 'c',
                     };
                     barcodeField.code128_subset = subsetRev[cParts[3]] || 'auto';
                 }
                 // Symbology modifiers (PRM c-syntax) carried into the Design
                 // model so generateIPL can reproduce them. Only in-domain
                 // values are stored; out-of-domain parts are dropped (the
                 // viewer parser owns the user-facing warnings on import
                 // round-trips of hand-written streams).
                 const numIn = (raw: string | undefined, lo: number, hi: number): number | undefined => {
                     if (raw === undefined || raw === '') return undefined;
                     const n = Number(raw);
                     return Number.isInteger(n) && n >= lo && n <= hi ? n : undefined;
                 };
                 if (symbology === '8' || symbology === '16') {
                     barcodeField.hibcMode = numIn(cParts[1], 0, 6);
                 } else if (symbology === '14') {
                     barcodeField.maxiMode = numIn(cParts[1], 2, 6);
                 } else if (symbology === '18') {
                     barcodeField.qrModel = numIn(cParts[1], 1, 2);
                     const ecl = (cParts[2] ?? '').toUpperCase();
                     if (ecl === 'L' || ecl === 'M' || ecl === 'Q' || ecl === 'H') barcodeField.qrEcl = ecl;
                     barcodeField.qrMask = numIn(cParts[3], 0, 8);
                 } else if (symbology === '19') {
                     barcodeField.microColumns = numIn(cParts[1], 0, 4);
                     barcodeField.microRows = numIn(cParts[2], 0, 44);
                 } else if (symbology === '20') {
                     barcodeField.rssVersion = numIn(cParts[1], 0, 6);
                     barcodeField.rssSepHeight = numIn(cParts[2], 1, 99);
                     // PRM p.166: segments per row must be EVEN 2-22.
                     const seg = numIn(cParts[3], 2, 22);
                     barcodeField.rssSegments = seg !== undefined && seg % 2 === 0 ? seg : undefined;
                 }
                 const hriFontInfo = hriFontMap.get(fieldId);
                 if (hriFontInfo && hri !== 'none') {
                     barcodeField.hriFont = hriFontInfo.font;
                     if (hriFontInfo.fontSize !== undefined) barcodeField.hriFontSize = hriFontInfo.fontSize;
                 }
                 if (dataSource.type === 'variable') variableFields.push(barcodeField);
                 field = barcodeField;
                 break;
            }
            case 'L': {
                 field = { ...baseProps, type: 'line', name: fieldName, x, y,
                    length: dotsToMm(parseInt(params['l'] || '100'), dpi),
                    thickness: dotsToMm(parseInt(params['w'] || '1'), dpi),
                };
                break;
            }
            case 'W': {
                 field = { ...baseProps, type: 'box', name: fieldName, x, y,
                    width: dotsToMm(parseInt(params['l'] || '100'), dpi),
                    height: dotsToMm(parseInt(params['h'] || '100'), dpi),
                    thickness: dotsToMm(parseInt(params['w'] || '1'), dpi),
                };
                break;
            }
            case 'U': {
                // Placement of a downloaded raster: rebuild the row-bitmap
                // from its G definition. An unresolvable c<id> (def stripped
                // by the clamps or missing entirely) yields an empty bitmap —
                // the properties panel invites a re-pick, better than losing
                // the layer.
                const def = graphicDefs.get(parseInt(params['c'] || '0', 10));
                const matrix = def ? decodeGraphicColumns(def.w, def.h, def.strips) : [];
                const imageField: ImageField = {
                    ...baseProps, type: 'image', name: fieldName, x, y,
                    bitmap: matrix.map(row => row.map(bit => bit ? '1' : '0').join('')),
                    width: dotsToMm(def?.w ?? 0, dpi),
                    height: dotsToMm(def?.h ?? 0, dpi),
                    threshold: 128,
                };
                field = imageField;
                break;
            }
        }

        if (field) design.fields.push(field);
    });

    // Simple data extraction from print block. Both notations for the
    // delimiters (viewer extractPrintBlockData parity — raw captures import
    // just like literal listings).
    // The terminator is guarded against being the TARGET of a Data Shift
    // escape: PRM p.99-100's own example prints control codes as data
    // ("<SUB><ETB> ... <SUB><RS> <SUB><US>"), so an escaped terminator is a
    // literal character the field prints, not the end of the block. Without the
    // lookbehind the block ended early and discarded the rest of the field's
    // data (viewer extractPrintBlockData carries the same guard, so the two
    // parsers agree on where a block ends).
    const printDataMatch = iplCode.match(
        /(?:<CAN>|\x18)([\s\S]*?)(?:(?<!<SUB>)(?<!\x1a)(?:<(?:ETB|RS)>|[\x17\x1e]))/);
    if (printDataMatch && variableFields.length > 0) {
        // The generator (and human-readable IPL listings) spell control characters
        // as literal placeholders; real printer streams use raw bytes. Accept both.
        const dataBlock = printDataMatch[1].replace(/<ESC>/g, '\x1b').replace(/<NUL>/g, '\x00');
        // Batch Q: the odometer step — <ESC>In increments the <FS>…<FS> numeric
        // region after every printed label, <ESC>Dn decrements, <ESC>N cancels.
        // The step is read from EACH field's own slice, because it belongs to
        // the field it follows (PRM p.104 "Sets the increment value for the
        // selected field"): a job may advance one counter up and another down.
        const serialCounters = new Map<string, string>(); // region|step -> counter id

        const fieldDataRegex = /\x1bF(\d+)\x00([\s\S]*?)(?=\x1bF\d+\x00|$)/g;
        const fieldDataMap = new Map<string, string>();
        const fieldStepMap = new Map<string, number | undefined>();
        let match;
        while((match = fieldDataRegex.exec(dataBlock)) !== null) {
            // Read this field's step before stripping; the strip removes the
            // command from the capture — it configures the print, not printable
            // data (the viewer's extractPrintBlockData does the same).
            fieldStepMap.set(match[1], readFieldStep(match[2]));
            fieldDataMap.set(match[1], match[2].replace(/\x1b[DIN]\d*/g, ''));
        }

        variableFields.sort((a,b) => a.id - b.id).forEach(field => {
            const fieldToUpdate = design.fields.find(f => f.id === field.id) as TextField | BarcodeField;
            if (fieldToUpdate) {
                const data = fieldDataMap.get(field.id.toString()) ?? '';
                const parsedData = data.replace(/<SUB>(?:<CR>|\r)/g, '\n');
                if (fieldToUpdate.dataSource.type === 'variable') {
                    // Batch Q round-trip: the generator wraps a serial counter's
                    // print data in <FS>digits<FS>. Recognize the WHOLE-data
                    // numeric region (both literal and raw \x1c spellings) and
                    // rebuild the linked counter source instead of dumping the
                    // markers into the field's default text. Fields sharing an
                    // identical region + step (text + barcode of one serial,
                    // the lot-template pattern) share ONE counter.
                    const region = /^(?:<FS>|\x1c)([0-9]+)(?:<FS>|\x1c)$/.exec(parsedData.trim());
                    if (region) {
                        // This field's OWN step; 0 is <ESC>N's cancel, which
                        // survives the fallback because ?? only replaces
                        // undefined. A stream that sets no step gets the default.
                        const step = fieldStepMap.get(field.id.toString()) ?? 1;
                        const key = `${region[1]}|${step}`;
                        let counterId = serialCounters.get(key);
                        if (!counterId) {
                            counterId = `cnt-imp-${field.id}`;
                            serialCounters.set(key, counterId);
                            const counter: CounterDataSource = {
                                id: counterId,
                                type: 'counter',
                                name: `Counter ${design.dataSources.filter(s => s.type === 'counter').length + 1}`,
                                start: parseInt(region[1], 10),
                                step, // printer default when the stream sets no step
                                padding: region[1].length,
                                serial: true,
                            };
                            design.dataSources.push(counter);
                        }
                        (fieldToUpdate as { dataSource: FieldDataSource }).dataSource = { type: 'linked', sourceId: counterId };
                    } else {
                        // No (full-region) odometer data: keep it as plain text
                        // with any stray separators stripped — they are control
                        // markers, never printable content (viewer parity).
                        fieldToUpdate.dataSource.defaultData = parsedData.replace(/(?:<FS>|<GS>|\x1c|\x1d)/g, '');
                    }
                }
            }
        });
    }

    // Print quantity from the repeat-count command in the print block.
    // d3 payloads are blanked first (maskFieldPayloads, viewer parity): fixed
    // text that literally says "<RS>50" is what the label SAYS, not a command.
    const quantityMatch = maskFieldPayloads(iplCode).match(/(?:<RS>|\x1e)(\d+)/);
    if (quantityMatch) {
        design.printerSettings.quantity = parseInt(quantityMatch[1], 10);
    }

    return design;
};