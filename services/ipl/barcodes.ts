// Maps IPL barcode symbologies onto bwip-js (public toCanvas API) and paints
// them dot-exact into the viewer's transformed context.
//
// Sizing strategy: render once at scale=1 into an offscreen canvas (one pixel
// per module), then drawImage-stretch so that one module equals exactly
// `moduleDots` printer dots. Bar edges therefore stay on integer module
// boundaries at any zoom level.

/** IPL symbology id -> bwip-js BCID. */
export const IPL_SYMBOLOGY_TO_BCID: { [id: string]: string } = {
    '0': 'code39',
    '1': 'code93',
    '2': 'interleaved2of5',
    '3': 'industrial2of5',
    // bwip-js exposes Codabar as rationalizedCodabar; plain `codabar` is not a
    // valid bcid. IPL data may omit the A-D start/stop characters.
    '4': 'rationalizedCodabar',
    '5': 'code11',
    '6': 'code128',
    '8': 'hibccode39',
    '9': 'code16k',
    '10': 'code49',
    '11': 'postnet',
    '12': 'pdf417',
    '16': 'hibccode128',
    '17': 'datamatrix',
    '18': 'qrcode',
    '19': 'micropdf417',
    '22': 'planet',
};

// pixs-shaped rasters: keep modules square, do not stretch vertically by h.
// The stacked databar variants and maxicode rasterize as pixs in bwip (probed).
// The composite encoders are included: each renders a linear row PLUS a 2D
// stack, so treating one as linear (and passing the linear `height` option)
// makes the encoder refuse the symbol outright.
const MATRIX_BCIDS = new Set(['pdf417', 'datamatrix', 'qrcode', 'micropdf417', 'code16k', 'code49',
    'maxicode', 'databarstacked', 'databarstackedomni', 'databarexpandedstacked',
    'gs1-128composite', 'ean13composite', 'ean8composite', 'upcacomposite', 'upcecomposite',
    'databaromnicomposite', 'databartruncatedcomposite', 'databarstackedcomposite',
    'databarstackedomnicomposite', 'databarlimitedcomposite', 'databarexpandedcomposite',
    'databarexpandedstackedcomposite']);

// QR Code model/EC/mask and MicroPDF417 size modifiers (PRM pp.158-159).
const QR_EC_LEVELS = new Set(['L', 'M', 'Q', 'H']);
const MICRO_COLS = new Set([0, 1, 2, 3, 4]);

/** c21,m1 -> bwip composite encoder (PRM p.162). Versions 1-12 differ only in
 *  the LINEAR component; all pair it with CC-A/CC-B chosen from the data. */
const COMPOSITE_BCID: { [m1: string]: string } = {
    '0': 'gs1-128composite',   // UCC/EAN-128 with CC-C
    '1': 'gs1-128composite',   // UCC/EAN-128 with CC-A/CC-B
    '2': 'ean13composite',
    '3': 'ean8composite',
    '4': 'upcacomposite',
    '5': 'upcecomposite',
    '6': 'databaromnicomposite',        // RSS-14
    '7': 'databartruncatedcomposite',
    '8': 'databarstackedcomposite',
    '9': 'databarstackedomnicomposite',
    '10': 'databarlimitedcomposite',
    '11': 'databarexpandedcomposite',
    '12': 'databarexpandedstackedcomposite',
};

// RSS/GS1 DataBar c20,m1 -> bwip bcid (PRM p.166; default m1=2 Stacked).
const RSS_VERSION_TO_BCID: { [m1: string]: string } = {
    '0': 'databaromni',
    '1': 'databartruncated',
    '2': 'databarstacked',
    '3': 'databarstackedomni',
    '4': 'databarlimited',
    '5': 'databarexpanded',
    '6': 'databarexpandedstacked',
};

/**
 * GS1 mod-10 check digit for a GTIN body (weights 3,1,3,1… from the left,
 * matching a 13-digit GTIN-14 body / 8-digit EAN-8 body etc.). bwip's databar
 * expanded encoders require the full 14-digit GTIN and do not compute the
 * check digit, so a bare 13-digit host GTIN gets it appended here — exactly
 * what the printer does (PRM p.165 "the check digit is not included in the
 * data"). Verified against bwip: both wrap results encode.
 */
export const gtinCheckDigit = (body: string): string => {
    let sum = 0;
    for (let i = 0; i < body.length; i++) {
        const w = (body.length - i) % 2 === 1 ? 3 : 1;
        sum += (body.charCodeAt(i) - 48) * w;
    }
    return String((10 - (sum % 10)) % 10);
};

// bwip-js is large; it is loaded lazily so the main bundle stays light.
// Until ensureBarcodesReady() resolves, barcode rendering falls back to
// placeholder boxes.
type ToCanvasFn = (canvas: HTMLCanvasElement, options: Record<string, unknown>) => void;
interface RawSymbol { sbs: number[]; bbs: number[]; bhs: number[] }
type RawFn = (options: Record<string, unknown>) => RawSymbol[];

let toCanvasFn: ToCanvasFn | null = null;
let rawFn: RawFn | null = null;
let loadingPromise: Promise<void> | null = null;

/** Loads the bwip-js encoder once. Safe to call repeatedly. */
export const ensureBarcodesReady = (): Promise<void> => {
    if (!loadingPromise) {
        loadingPromise = import('bwip-js/browser')
            .then(m => {
                toCanvasFn = m.toCanvas as unknown as ToCanvasFn;
                // The ESM build's *named* `raw` export requires a drawing
                // argument (a _ToAny variant); the usable API lives on the
                // default export as raw(bcid-or-options) -> symbol[].
                const def = (m as unknown as { default?: { raw?: RawFn } }).default;
                rawFn = def?.raw ?? null;
                if (!rawFn && toCanvasFn) {
                    // Without raw() the wide:narrow run-length path degrades
                    // to the encoder's fixed ratio — never let that be silent.
                    console.warn('bwip-js raw() unavailable: declared bar code ratios (r0/r2) will render at the encoder default.');
                }
            })
            .catch(() => { toCanvasFn = null; rawFn = null; });
    }
    return loadingPromise;
};

const ready = (): ToCanvasFn | null => toCanvasFn;

/** True once the bwip-js encoder has finished loading. */
export const isBarcodeEngineReady = (): boolean => toCanvasFn !== null;

const EAN_UPC_VERSION_TO_BCID: { [version: number]: string } = {
    1: 'ean8',
    2: 'ean13',
    3: 'upca',
    4: 'upce',
    // m2 5-8 are UPC Version D1-D5 (PRM p.154); no bwip encoder exists for the
    // D-series (and most printers reject them). They resolve to null, which the
    // validator reports and the renderer draws as a placeholder.
};

/**
 * EAN/UPC supplemental data is delimited from the main data by "." and is
 * always exactly 2 or 5 digits (PRM p.154). Returns the main data plus the
 * supplemental digits when present (supplemental undefined when the suffix
 * is not a valid 2/5-digit add-on — main data is then still returned as-is
 * so validation can report the length error for the main symbol).
 */
export const splitEanSupplement = (data: string): { main: string; supplemental?: string } => {
    const dot = data.indexOf('.');
    if (dot < 0) return { main: data };
    const main = data.slice(0, dot);
    const sup = data.slice(dot + 1);
    if (data.lastIndexOf('.') !== dot && (sup.length === 2 || sup.length === 5)) {
        // More than one delimiter is itself an error (PRM error 07); pass the
        // whole string through so the encoder rejects the combined length.
        return { main: data };
    }
    if (sup.length === 2 || sup.length === 5) return { main, supplemental: sup };
    // Invalid supplemental count (PRM error 06): bwip rejects "NNN.NNN" as
    // main length anyway — pass the whole string through unchanged.
    return { main: data };
};

const eanUpcBcid = (data: string, version = 0): string | null => {
    if (version !== 0) return EAN_UPC_VERSION_TO_BCID[version] ?? null;
    const digits = data.replace(/\D/g, '');
    switch (digits.length) {
        case 13: return 'ean13';
        case 8: return 'ean8';
        case 12: return 'upca';
        case 7: return 'upce';
        default: return null;
    }
};

/**
 * Code 39 `c0[,m]` mode (PRM p.150): 0-2 = 8646-compatible charset,
 * 3-5 = full ASCII, 6-8 = 43-character; within each group +0 none,
 * +1 printer enters check digit, +2 host enters check digit (verified).
 * bwip-js `code39` covers the 43-char set natively; full ASCII needs the
 * `code39ext` encoder.
 */
export interface Code39Params { mode?: string }
const code39Plan = (mode: string | undefined): { bcid: string; includecheck: boolean; validatecheck: boolean } => {
    const m = parseInt(mode ?? '0', 10);
    const base = { includecheck: false, validatecheck: false };
    switch (m) {
        case 1: return { bcid: 'code39', includecheck: true, validatecheck: false };
        case 2: return { bcid: 'code39', includecheck: false, validatecheck: true };
        case 3: return { bcid: 'code39ext', ...base };
        case 4: return { bcid: 'code39ext', includecheck: true, validatecheck: false };
        case 5: return { bcid: 'code39ext', includecheck: false, validatecheck: true };
        case 6: return { bcid: 'code39', ...base };
        case 7: return { bcid: 'code39', includecheck: true, validatecheck: false };
        case 8: return { bcid: 'code39', includecheck: false, validatecheck: true };
        default: return { bcid: 'code39', ...base }; // 0 and undocumented values
    }
};

/** Extra c-parameter modifiers needed to encode a field like the printer would. */
export interface BarcodeParams {
    eanUpcVersion?: number;
    code39Mode?: string;
    /** Code 128 c6,m3 start-subset selector: 1=A, 2=B, 3=C; 0/undefined = auto. */
    code128StartSubset?: string;
    /** Code 128 c6,m1: '1' = UCC-128 Serial Shipping Container Code (PRM p.144). */
    code128Ucc?: string;
    /** Code 128 c6,m2: '1' keeps parentheses/spaces in the interpretive field. */
    code128KeepInterpretive?: string;
    /** IPL r code: 0=2.5:1, 1=3:1 (default), 2=2:1 (PRM p.170). */
    ratio?: number;
    /** w — narrow element width in dots; needed for the PRM odd-width r0 rule. */
    narrowDots?: number;
    /** c18,m1 — QR model. Only '2' has an encoder; anything else is the
     * parser's job to warn about before it reaches here. */
    qrModel?: string;
    /** c18,m2 — QR error-correction level L/M/Q/H (default M). */
    qrEcl?: string;
    /** c18,m3 — QR mask in the PRINTER domain 0-7 (8/auto = omit; bwip's
     * option is 1-based, translated in buildBwipSpec). */
    qrMask?: string;
    /** c19,m1 — MicroPDF417 data columns 1-4 (0/auto = encoder default). */
    microColumns?: string;
    /** c19,m2 — MicroPDF417 data rows (valid combos are fixed by the spec). */
    microRows?: string;
    /** c12,m1 — PDF417 data columns 0-30; 0 (the printer's default) picks a
     * near-square symbol (PRM p.149). */
    pdfColumns?: string;
    /** c12,m2 — PDF417 error-correction level 0-8; 9 (the default) is auto. */
    pdfEcLevel?: string;
    /** c12,m3 — PDF417 truncate flag: '1' drops the right row indicators. */
    pdfTruncate?: string;
    /** c21,m1 — EAN.UCC Composite version 0-12, selecting the linear
     * component and which CC variant pairs with it (PRM p.162). */
    compositeVersion?: string;
    /** c21,m3 — 2D columns (m1=0, 1-30) or segments per row (m1=12). */
    compositeColumns?: string;
    /** c21,m5 — height of each 2D row; 0 or absent = 3x magnification. */
    compositeRowHeight?: string;
    /** c20,m1 — RSS/GS1 DataBar version 0-6 (default 2 = Stacked). */
    rssVersion?: string;
    /** c20,m2 — separator-row height for the stacked versions. */
    rssSepHeight?: string;
    /** c20,m3 — segments per row for expanded-stacked (even 2-22). */
    rssSegments?: string;
    /** c14,m1 — MaxiCode mode 2-6 (undefined = auto-discriminate). */
    maxiMode?: string;
}

/**
 * Wide:narrow families (PRM p.170 table): symbologies whose geometry scales
 * with `r`. Module-based Code 93/128 and EAN/UPC are deliberately absent.
 */
const WIDE_NARROW_SYMBOLOGIES = new Set(['0', '2', '3', '4', '5']);

/** IPL r code -> wide:narrow numeric ratio. Unknown codes render 3:1 (default). */
export const ratioValue = (ratio: number | undefined): number =>
    ratio === 0 ? 2.5 : ratio === 2 ? 2 : 3;

/**
 * Effective ratio honoring the PRM rule "If the bar code width is odd and you
 * select r0, the printer substitutes r1" (a 2.5:1 bar needs an even narrow
 * width to land on whole dots).
 */
const effectiveRatio = (params: BarcodeParams): number => {
    if (params.ratio === 0 && params.narrowDots !== undefined && params.narrowDots % 2 !== 0) return 3;
    return ratioValue(params.ratio);
};

// A half-module unit grid: narrow = 2 units, wide = round(2*ratio) units, so
// every ratio (2, 2.5, 3) yields integer unit widths and bar edges stay on
// sub-dot boundaries at any zoom, mirroring the scale-1-then-stretch trick.
const HALF_UNITS_PER_MODULE = 2;

/** One symbol to draw: bcid + data + bwip options. EAN add-ons yield a second one. */
export interface BwipSymbol {
    bcid: string;
    text: string;
    opts: Record<string, unknown>;
}

export interface BwipSpec {
    main: BwipSymbol;
    /** 2-/5-digit EAN/UPC add-on, drawn to the right of the main symbol. */
    supplement?: BwipSymbol;
    /** GS1-mandated quiet gap between main symbol and add-on, in modules. */
    supplementGapModules?: number;
}

/** Quiet zone between an EAN/UPC main symbol and its add-on, in narrow modules. */
export const EAN_SUPPLEMENT_GAP_MODULES = 11;

/**
 * Translates one barcode field's IPL parameters into bwip-js encode calls.
 * Returns null when the symbology has no mapping. This is the single source
 * of truth shared by validation, measuring and painting, so all three see
 * the same encoder choices.
 */
export const buildBwipSpec = (symbology: string, data: string, params: BarcodeParams = {}): BwipSpec | null => {
    if (!data) return null;
    if (symbology === '7') {
        const { main, supplemental } = splitEanSupplement(data);
        const bcid = eanUpcBcid(main, params.eanUpcVersion ?? 0);
        if (!bcid) return null;
        let supplement: BwipSymbol | undefined;
        if (supplemental) {
            const supBcid = supplemental.length === 2 ? 'ean2' : 'ean5';
            if (!/^\d+$/.test(supplemental)) return null;
            supplement = { bcid: supBcid, text: supplemental, opts: {} };
        }
        return { main: { bcid, text: main, opts: {} }, supplement, supplementGapModules: EAN_SUPPLEMENT_GAP_MODULES };
    }
    if (symbology === '0') {
        const plan = code39Plan(params.code39Mode);
        const opts: Record<string, unknown> = {};
        if (plan.includecheck) opts.includecheck = true;
        if (plan.validatecheck) opts.validatecheck = true;
        return { main: { bcid: plan.bcid, text: data, opts } };
    }
    if (symbology === '6') {
        if (params.code128Ucc === '1') {
            // UCC-128 SSCC (PRM p.144): exactly 19 numeric characters (the
            // parentheses/spaces of GS1-formatted data are never encoded),
            // the printer forces the first two digits to 00, and the symbol
            // starts in subset C after an FNC1 — bwip's '^FNC1' entry under
            // parsefnc (its ONLY FNC1 syntax; a backslash is plain data).
            const digits = data.replace(/[() ]/g, '');
            if (!/^\d{19}$/.test(digits)) return null;
            return { main: { bcid: 'code128', text: '^FNC100' + digits.slice(2), opts: { parsefnc: true } } };
        }
        // m2=1: ignore parentheses and spaces in the bar code (they stay in
        // the interpretive field — see interpretiveText).
        const encoded = params.code128KeepInterpretive === '1' ? data.replace(/[() ]/g, '') : data;
        if (!encoded) return null;
        // m3 forces the start subset (PRM p.144). bwip-js has no start-subset
        // option, so build the codewords explicitly via raw:true (bwip still
        // appends the mod-103 check digit and stop). Characters outside the
        // chosen subset fail to encode — matching the printer's error 11.
        const subset = params.code128StartSubset ?? '0';
        if (subset === '1' || subset === '2' || subset === '3') {
            return code128ForcedSubset(encoded, subset);
        }
        return { main: { bcid: 'code128', text: encoded, opts: {} } };
    }
    if (symbology === '8' || symbology === '16') {
        // HIBC: bwip's hibc encoders ALWAYS prepend the '+' flag themselves
        // (probed: '+A1234$B567' encodes one Code-39 character longer than
        // 'A1234$B567' — the host '+' is kept AND another is added), so a
        // host-supplied '+' must be stripped or the symbol double-flags and
        // the mod-43 check covers the wrong sequence.
        const hibcData = data.startsWith('+') ? data.slice(1) : data;
        if (!hibcData) return null;
        const bcid = symbology === '8' ? 'hibccode39' : 'hibccode128';
        return { main: { bcid, text: hibcData, opts: {} } };
    }
    if (symbology === '18') {
        // QR Code c18[,m1][,m2][,m3] (PRM p.164): m1 model 1/2 (only model 2
        // has an encoder — the parser warns and keeps the field renderable),
        // m2 EC level L/M/Q/H (printer default M), m3 mask 0-7 with 8 = auto;
        // bwip's mask option is 1-based with 0 meaning auto.
        const ecl = (params.qrEcl || 'M').toUpperCase();
        if (!QR_EC_LEVELS.has(ecl)) return null;
        const opts: Record<string, unknown> = {};
        if (ecl !== 'M') opts.eclevel = ecl;
        const mask = parseInt(params.qrMask ?? '', 10);
        if (Number.isInteger(mask) && mask >= 0 && mask <= 7) opts.mask = mask + 1;
        return { main: { bcid: 'qrcode', text: data, opts } };
    }
    if (symbology === '21') {
        // EAN.UCC Composite c21[,m1][,m2][,m3][,m4][,m5][,m6] (PRM p.162).
        //
        // The data is TWO components separated by <HT>: the linear part first,
        // then the 2D supplement ("to print a Composite bar code with the
        // linear component encoding 112233445566 and the 2D component encoding
        // aabbccddeeff, the data is sent as 112233445566<HT>aabbccddeeff").
        // bwip's composite encoders take exactly that shape with '|' as the
        // separator, and they exist for every linear family the manual lists —
        // an earlier note in this file claimed they only accept a GS1-AI form,
        // which the probed behaviour disproves (they encode bare linear data
        // such as '9520123456788|(99)1234-abcd').
        //
        // m1 selects the linear component AND, implicitly, the CC variant the
        // printer will pair with it (the printer picks CC-A or CC-B from the
        // data length; only m1=0 fixes CC-C). Versions 1-12 all mean "the same
        // family as this linear symbology, with CC-A or CC-B".
        const version = params.compositeVersion ?? '0';
        const bcid = COMPOSITE_BCID[version];
        if (!bcid) return null;
        // The separator arrives either as a raw 0x09 byte (what a printer
        // capture carries) or as the literal "<HT>" spelling a hand-authored
        // or editor-pasted stream uses. Accept both, exactly as the tokenizer
        // accepts <STX> and 0x02 for the same delimiter.
        const parts = data.replace(/<HT>/gi, '\t').split('\t');
        if (parts.length < 2 || !parts[0] || !parts[1]) return null;
        const opts: Record<string, unknown> = {};
        // m1=0 is the only version the manual pins to CC-C; the rest are
        // CC-A/CC-B, which is bwip's 'b' (it upgrades to CC-C only when the
        // data cannot fit a MicroPDF417).
        opts.ccversion = version === '0' ? 'c' : 'b';
        const cols = parseInt(params.compositeColumns ?? '0', 10);
        if (Number.isInteger(cols) && cols > 0 && cols <= 30) opts.cccolumns = cols;
        const rowH = parseInt(params.compositeRowHeight ?? '0', 10);
        if (Number.isInteger(rowH) && rowH > 0) opts.ccrowheight = rowH;
        return { main: { bcid, text: `${parts[0]}|${parts[1]}`, opts } };
    }
    if (symbology === '12') {
        // PDF417 c12[[,m1][,m2][,m3]] (PRM p.149): m1 columns 0-30 (0 = the
        // printer picks a near-square symbol), m2 error-correction level 0-8
        // (9 = auto), m3 truncation. All three were previously dropped, so a
        // stream asking for a specific column count or EC level silently got
        // the encoder's defaults — the encoder's `rowmult` is already 3, which
        // is the ratio the manual cites for the auto case, so the DEFAULT
        // shape was right while every explicit parameter was ignored.
        const opts: Record<string, unknown> = {};
        const cols = parseInt(params.pdfColumns ?? '0', 10);
        if (Number.isInteger(cols) && cols > 0) {
            if (cols > 30) return null; // out of the documented range
            opts.columns = cols;
        }
        const ec = parseInt(params.pdfEcLevel ?? '9', 10);
        if (Number.isInteger(ec) && ec >= 0 && ec <= 8) opts.eclevel = ec;
        if (params.pdfTruncate === '1') opts.compact = true;
        return { main: { bcid: 'pdf417', text: data, opts } };
    }
    if (symbology === '19') {
        // MicroPDF417 c19[,m1][,m2] (PRM p.164): m1 columns 0-4, m2 rows;
        // only the spec's fixed columns-x-rows combos are legal — an illegal
        // combo makes bwip throw, which the deep-validation pass reports.
        const cols = parseInt(params.microColumns ?? '0', 10);
        const rows = parseInt(params.microRows ?? '0', 10);
        if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 0 || rows < 0) return null;
        const opts: Record<string, unknown> = {};
        if (cols || rows) {
            if (!MICRO_COLS.has(cols)) return null;
            if (cols) opts.columns = cols;
            if (rows) opts.rows = rows;
        }
        return { main: { bcid: 'micropdf417', text: data, opts } };
    }
    if (symbology === '20') {
        // RSS / GS1 DataBar c20[,m1][,m2][,m3] (PRM p.166). bwip's databar
        // encoders speak the GS1 AI form and (for the expanded variants)
        // REQUIRE the full 14-digit GTIN — they do not add the check digit
        // themselves. A bare 13-digit GTIN is therefore wrapped as "(01)" plus
        // the computed mod-10 check (the printer does the same: PRM "the check
        // digit is not included in the data"); a 14-digit or AI-form input
        // passes through for the encoder to verify.
        const m1 = params.rssVersion ?? '2';
        const bcid = RSS_VERSION_TO_BCID[m1];
        if (!bcid) return null;
        let text = data;
        if (/^\d{13}$/.test(data)) text = '(01)' + data + gtinCheckDigit(data);
        else if (/^\d{14}$/.test(data)) text = '(01)' + data;
        const opts: Record<string, unknown> = {};
        const sep = parseInt(params.rssSepHeight ?? '', 10);
        if (Number.isInteger(sep) && sep >= 1 && (m1 === '2' || m1 === '3' || m1 === '6')) opts.sepheight = sep;
        const seg = parseInt(params.rssSegments ?? '', 10);
        // PRM p.166: even segments only (odd would make bwip throw).
        if (m1 === '6' && Number.isInteger(seg) && seg >= 2 && seg <= 22 && seg % 2 === 0) opts.segments = seg;
        return { main: { bcid, text, opts } };
    }
    if (symbology === '14') {
        // MaxiCode c14[,m1] (PRM p.159): fixed-size 2D symbol; mode 2-6 or
        // auto-discriminate (no mode option). Structured Carrier Messages
        // arrive as the raw <RS>/<GS>/<EOT> banner the host sends verbatim.
        const opts: Record<string, unknown> = {};
        const mode = parseInt(params.maxiMode ?? '', 10);
        if (Number.isInteger(mode)) opts.mode = mode;
        return { main: { bcid: 'maxicode', text: data, opts } };
    }
    const bcid = IPL_SYMBOLOGY_TO_BCID[symbology];
    return bcid ? { main: { bcid, text: data, opts: {} } } : null;
};

export const resolveBcid = (symbology: string, data: string, eanUpcVersion = 0): string | null =>
    buildBwipSpec(symbology, data, { eanUpcVersion })?.main.bcid ?? null;

/**
 * The human-readable interpretive row for a field, per the same PRM p.144
 * c6 table that drives encoding: parentheses/spaces stay in the interpretive
 * unless UCC-128 without m2=1 — where the printer prints the normalized
 * SSCC it encoded (first two digits forced to 00).
 */
export const interpretiveText = (symbology: string, data: string, params: BarcodeParams): string => {
    if (symbology !== '6') return data;
    if (params.code128Ucc === '1' && params.code128KeepInterpretive !== '1') {
        const digits = data.replace(/[() ]/g, '');
        // Only a valid 19-digit SSCC gets the printer's forced-00 form;
        // anything else (variable data, wrong length) prints verbatim so the
        // interpretive never garbles unrenderable input.
        return /^\d{19}$/.test(digits) ? '00' + digits.slice(2) : data;
    }
    return data;
};

/**
 * Interleaved 2 of 5: "The printer adds a zero to character strings that are
 * odd in length" (PRM p.143). Reproduce that padding before encoding/rendering.
 */
export const applyI2of5Padding = (symbology: string, data: string): string => {
    if (symbology !== '2' || data.length % 2 === 0) return data;
    return `0${data}`;
};

export interface BarcodeMeasure {
    /** Natural width at 1px/module, incl. add-on and its gap. */
    widthModules: number;
    /** Natural height in pixels at scale 1. */
    heightPx: number;
    isMatrix: boolean;
}

let measureCache: Map<string, BarcodeMeasure | null> | null = null;
const MAX_MEASURE_ENTRIES = 500;
const cacheGet = (): Map<string, BarcodeMeasure | null> => {
    if (!measureCache) measureCache = new Map();
    return measureCache;
};

/** Insert with an age cap — dynamic batch data must not grow the map forever. */
const cacheSet = (key: string, value: BarcodeMeasure | null): void => {
    const c = cacheGet();
    if (c.size >= MAX_MEASURE_ENTRIES) {
        // Map preserves insertion order; drop the oldest entries first.
        for (const old of c.keys()) {
            c.delete(old);
            if (c.size < MAX_MEASURE_ENTRIES * 0.9) break;
        }
    }
    c.set(key, value);
};

// Natural-raster cache for the paint path (Batch D): the designer canvas
// repaints at pointer rate (hover/drag) and the viewer preview re-renders
// every label of a batch, each pass painting the same fields. Encoding
// depends only on (symbology, data, params) — the scale-1 raster is
// pxPerDot-independent, so it is cached and stretched per draw. Replaces the
// JsBarcode raster cache (services/barcodeRaster.ts, retired). NOTE: this is
// a SEPARATE cache from measureCache — a field that is both measured and
// painted encodes once per cache (2 total), then zero on every later frame.
interface PaintRasters { off: HTMLCanvasElement; sup?: HTMLCanvasElement }
let rasterCache: Map<string, PaintRasters | null> | null = null;
const RASTER_MAX_ENTRIES = 120;
const rasterCacheGet = (): Map<string, PaintRasters | null> => {
    if (!rasterCache) rasterCache = new Map();
    return rasterCache;
};

// Ratio-aware (wide:narrow) paint rasters: encodeRatioCanvas allocates a
// canvas + raw() per call, so the same hover-rate caching applies.
let ratioCache: Map<string, { canvas: HTMLCanvasElement; widthDots: number } | null> | null = null;
const ratioCacheGet = (): Map<string, { canvas: HTMLCanvasElement; widthDots: number } | null> => {
    if (!ratioCache) ratioCache = new Map();
    return ratioCache;
};

/** Actual bwip encode sites; test seam for the cache hot paths. */
let encodeCount = 0;
export const barcodeEncodeCount = (): number => encodeCount;

/** Cache key capturing every input that can change the encoded symbol.
 *  NUL separators so data containing '|' cannot collide with other keys. */
const paramsKey = (p: BarcodeParams): string =>
    [p.eanUpcVersion ?? 0, p.code39Mode ?? '', p.code128StartSubset ?? '',
        p.code128Ucc ?? '', p.code128KeepInterpretive ?? '',
        p.ratio ?? 1, p.narrowDots ?? 0,
        p.qrModel ?? '', p.qrEcl ?? '', p.qrMask ?? '',
        p.microColumns ?? '', p.microRows ?? '',
        p.pdfColumns ?? '', p.pdfEcLevel ?? '', p.pdfTruncate ?? '',
        p.compositeVersion ?? '', p.compositeColumns ?? '', p.compositeRowHeight ?? '',
        p.rssVersion ?? '', p.rssSepHeight ?? '', p.rssSegments ?? '',
        p.maxiMode ?? ''].join('\x00');

/**
 * True when the field is painted from bwip raw() module runs instead of the
 * encoder's own raster: any wide:narrow family whose r + w are known. The
 * run-length path classifies each element as narrow/wide and re-times it to
 * the declared ratio (narrow = w dots, wide = ratio*w); at the 3:1 default it
 * reproduces bwip's rendered raster exactly (bwip stores ITF wide runs as 2
 * modules but renders them 3:1), so default-ratio goldens never shift.
 * Module-based symbologies (Code 93/128) and EAN/UPC stay on the encoder path.
 */
const usesRunLengthRatio = (symbology: string, params: BarcodeParams): boolean =>
    WIDE_NARROW_SYMBOLOGIES.has(symbology) && params.ratio !== undefined
    && params.narrowDots !== undefined && rawFn !== null;

export interface RunPattern {
    /** Half-module widths (narrow=2, wide=round(2*ratio)) for each element. */
    units: number[];
    /** true when element i is a bar, false for a space; index 0 is a bar. */
    isBar: boolean[];
}

/**
 * m3 forces the Code 128 start subset (PRM p.144). bwip-js has no
 * start-subset option, so the codewords are built explicitly and handed to
 * bwip's raw:true mode (which still appends the mod-103 check and stop).
 * Characters outside the chosen subset return null — the printer rejects
 * them with error code 11 ("only characters within the chosen subset are
 * valid"), so an invalid field must not silently render as something else.
 */
const code128ForcedSubset = (data: string, subset: '1' | '2' | '3'): BwipSpec | null => {
    const cws: number[] = [];
    if (subset === '1') {
        // Subset A: SP.._ -> 0..63, NUL..US -> 64..95.
        cws.push(103);
        for (let i = 0; i < data.length; i++) {
            const c = data.charCodeAt(i);
            if (c >= 32 && c <= 95) cws.push(c - 32);
            else if (c < 32) cws.push(c + 64);
            else return null;
        }
    } else if (subset === '2') {
        // Subset B: SP..DEL -> 0..95.
        cws.push(104);
        for (const ch of data) {
            const c = ch.charCodeAt(0);
            if (c < 32 || c > 127) return null;
            cws.push(c - 32);
        }
    } else {
        // Subset C: digit pairs only; a lone trailing digit is out of subset.
        if (!/^\d+$/.test(data) || data.length % 2 !== 0) return null;
        cws.push(105);
        for (let i = 0; i < data.length; i += 2) cws.push(parseInt(data.slice(i, i + 2), 10));
    }
    return {
        main: {
            bcid: 'code128',
            text: cws.map(n => `^${String(n).padStart(3, '0')}`).join(''),
            opts: { raw: true },
        },
    };
};

/**
 * Converts one bwip raw() symbol into an IPL-width element run list. bwip's
 * linear output stores every element width in `sbs` (bars and spaces
 * alternating, bar-first) with `bbs` all zero; any other shape (composite
 * layers, non-unit heights) returns null so the caller falls back to toCanvas.
 */
export const rawToRunPattern = (sym: RawSymbol, ratio: number): RunPattern | null => {
    const { sbs, bbs, bhs } = sym;
    if (sbs.length === 0 || bbs.some(v => v !== 0) || !bhs.every(v => v === 1)) return null;
    // Run count is odd for bar-terminated symbologies (Industrial 2of5 starts
    // AND stops with a bar); the bar-first alternating mapping handles it.
    // The encoder's own internal grid varies (Code 39 stores wide=3 at 3:1,
    // ITF stores wide=2 at an internal 2.5:1); only narrow-vs-wide class
    // membership is stable, so classify by the smallest run in the symbol.
    const min = Math.min(...sbs);
    if (min < 1 || sbs.some(w => w !== min && w < 2 * min)) return null; // non-binary widths
    const units: number[] = [];
    const isBar: boolean[] = [];
    for (const w of sbs) {
        units.push(w === min ? HALF_UNITS_PER_MODULE : Math.round(HALF_UNITS_PER_MODULE * ratio));
        isBar.push(isBar.length % 2 === 0);
    }
    return { units, isBar };
};

/**
 * Encodes a wide:narrow field at its IPL ratio by rasterizing the module runs
 * directly: one offscreen pixel per printer dot — narrow = w dots, wide =
 * ratio*w dots, computed on a cumulative half-module grid (round at every
 * boundary) so bar edges never drift and the total is widthDots exactly.
 * Returns null when the raw shape is unexpected or the data is invalid
 * (encoder throws); callers then fall back to the default-raster path.
 */
const encodeRatioCanvas = (
    spec: BwipSpec, params: BarcodeParams,
): { canvas: HTMLCanvasElement; widthDots: number } | null => {
    if (!rawFn || typeof document === 'undefined') return null;
    const narrowDots = params.narrowDots ?? 0;
    if (narrowDots < 1) return null;
    let pattern: RunPattern | null = null;
    try {
        encodeCount++; // raw() is an encode too (see barcodeEncodeCount)
        const rawSym = rawFn({ bcid: spec.main.bcid, text: spec.main.text, ...spec.main.opts })[0];
        pattern = rawSym ? rawToRunPattern(rawSym, effectiveRatio(params)) : null;
    } catch {
        return null; // invalid data for this symbology
    }
    if (!pattern) return null;
    // 1 unit = half a narrow module; 1 narrow module = narrowDots dots,
    // so dots = units * narrowDots / 2 (exact for whole-module runs).
    const bounds: number[] = new Array(pattern.units.length + 1);
    let acc = 0;
    bounds[0] = 0;
    for (let i = 0; i < pattern.units.length; i++) {
        acc += pattern.units[i];
        bounds[i + 1] = Math.round((acc * narrowDots) / HALF_UNITS_PER_MODULE);
    }
    const widthDots = bounds[pattern.units.length];
    const off = document.createElement('canvas');
    off.width = widthDots;
    off.height = 1; // linear symbologies only; uniform columns, stretched by the painter
    const ctx = off.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#000';
    for (let i = 0; i < pattern.units.length; i++) {
        if (!pattern.isBar[i]) continue;
        if (bounds[i + 1] > bounds[i]) ctx.fillRect(bounds[i], 0, bounds[i + 1] - bounds[i], 1);
    }
    return { canvas: off, widthDots };
};

const encodeTo = (toCanvas: ToCanvasFn, sym: BwipSymbol, height: number | undefined): HTMLCanvasElement => {
    encodeCount++;
    const off = document.createElement('canvas');
    toCanvas(off, {
        bcid: sym.bcid, text: sym.text, scale: 1, padding: 0, includetext: false,
        // The nominal height is a linear-raster stub only; matrix/pixs shapes
        // must measure at natural size — bwip's QR encoder in particular
        // doubles the module grid to approach a requested height (42x21 for a
        // 21x21 symbol at height 10), which would corrupt the measurement.
        ...(height !== undefined && !MATRIX_BCIDS.has(sym.bcid) ? { height } : {}),
        ...sym.opts,
    });
    return off;
};

/**
 * Renders the symbology offscreen at scale 1 and reports its natural size.
 * Returns null when unsupported or when the data fails validation.
 */
export const measureBarcode = (
    symbology: string,
    data: string,
    params: BarcodeParams = {},
): BarcodeMeasure | null => {
    const spec = buildBwipSpec(symbology, data, params);
    const toCanvas = ready();
    if (!spec || !toCanvas || typeof document === 'undefined') return null;

    const key = [symbology, data, paramsKey(params)].join('\x00');
    const cached = cacheGet().get(key);
    if (cached !== undefined) return cached;

    if (usesRunLengthRatio(symbology, params)) {
        // Ratio-aware width: dots = units*w/2 on the half-module grid, so the
        // module figure is a float the layout multiplies back by w exactly.
        const ratioOff = encodeRatioCanvas(spec, params);
        if (ratioOff) {
            const measure: BarcodeMeasure = {
                widthModules: ratioOff.widthDots / (params.narrowDots ?? 1),
                heightPx: 1,
                isMatrix: false,
            };
            cacheSet(key, measure);
            return measure;
        }
        // Unexpected raw shape: fall through to the default encoder path.
    }

    try {
        // Nominal 10 mm bar height; final vertical sizing is done by the painter.
        const off = encodeTo(toCanvas, spec.main, 10);
        let widthModules = off.width;
        if (spec.supplement) {
            widthModules += (spec.supplementGapModules ?? 0) + encodeTo(toCanvas, spec.supplement, 10).width;
        }
        const measure: BarcodeMeasure = {
            widthModules,
            heightPx: off.height,
            isMatrix: MATRIX_BCIDS.has(spec.main.bcid),
        };
        cacheSet(key, measure);
        return measure;
    } catch {
        cacheSet(key, null);
        return null; // invalid data for this symbology
    }
};

/**
 * Paints a barcode at device-pixel origin (xPx, yPx), including an EAN/UPC
 * add-on when the field data carries one. Returns false when nothing was
 * drawn (caller should draw a placeholder).
 */
export const paintBarcode = (
    ctx: CanvasRenderingContext2D,
    symbology: string,
    data: string,
    xPx: number,
    yPx: number,
    pxPerDot: number,
    moduleDots: number,
    heightDots: number,
    params: BarcodeParams = {},
): boolean => {
    const spec = buildBwipSpec(symbology, data, params);
    const toCanvas = ready();
    if (!spec || !toCanvas) return false;

    // Ratio-aware path: the offscreen raster already carries the exact dot
    // width, so it stretches 1:1 in pixels-per-dot rather than per-module.
    if (usesRunLengthRatio(symbology, params)) {
        // Cached like the natural raster — the wide:narrow families (0/2/3/4/5)
        // are exactly what the designer hovers/drags most.
        const ratioKey = [symbology, data, paramsKey(params)].join('\x00');
        const rcache = ratioCacheGet();
        let ratioOff = rcache.get(ratioKey);
        if (ratioOff === undefined) {
            ratioOff = encodeRatioCanvas(spec, params);
            if (rcache.size >= RASTER_MAX_ENTRIES) {
                const oldest = rcache.keys().next().value as string;
                rcache.delete(oldest);
            }
            rcache.set(ratioKey, ratioOff);
        }
        if (ratioOff) {
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(
                ratioOff.canvas, xPx, yPx,
                ratioOff.widthDots * pxPerDot, heightDots * pxPerDot,
            );
            return true;
        }
    }

    // Cached natural raster (see rasterCacheGet): the same field repaints on
    // every hover/drag frame; encoding it once is the whole win.
    const key = [symbology, data, paramsKey(params)].join('\x00');
    const rcache = rasterCacheGet();
    let rasters = rcache.get(key);
    if (rasters === undefined) {
        try {
            const off = encodeTo(toCanvas, spec.main, undefined);
            const sup = spec.supplement ? encodeTo(toCanvas, spec.supplement, undefined) : undefined;
            rasters = { off, sup };
        } catch {
            rasters = null; // invalid data — cached so it does not re-throw per frame
        }
        if (rcache.size >= RASTER_MAX_ENTRIES) {
            const oldest = rcache.keys().next().value as string;
            rcache.delete(oldest);
        }
        rcache.set(key, rasters);
    }
    if (!rasters) return false;
    const { off, sup: supOff } = rasters;

    const modulePx = Math.max(1, moduleDots) * pxPerDot;
    const drawW = off.width * modulePx;

    if (MATRIX_BCIDS.has(spec.main.bcid)) {
        // Keep modules square; center inside the declared field height.
        const drawH = off.height * modulePx;
        const yOff = Math.max(0, (heightDots * pxPerDot - drawH) / 2);
        ctx.drawImage(off, xPx, yPx + yOff, drawW, drawH);
    } else {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(off, xPx, yPx, drawW, heightDots * pxPerDot);
        if (supOff) {
            const gapPx = (spec.supplementGapModules ?? 0) * modulePx;
            ctx.drawImage(supOff, xPx + drawW + gapPx, yPx, supOff.width * modulePx, heightDots * pxPerDot);
        }
    }
    return true;
};
