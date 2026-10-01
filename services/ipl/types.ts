// Neutral viewer model for IPL streams.
// The viewer parses IPL directly into these elements instead of going through
// the internal Design model, so third-party streams still render even when a
// full designer mapping is not possible.

export type IssueLevel = 'error' | 'warning' | 'info';

export interface ViewerIssue {
    level: IssueLevel;
    code: string;
    message: string;
    command?: string;
    /** 1-based source line the offending frame started on, when known. */
    line?: number;
}

interface ElementBase {
    /** Field number (H0, B12...) if present. */
    id?: number;
    /** Origin in dots, as written in the o parameter. */
    ox: number;
    oy: number;
    /** Rotation quadrant 0-3 (IPL f parameter). */
    f: number;
    /**
     * Signed per-field odometer step for this field's <FS>/<GS> regions
     * (<ESC>In / <ESC>Dn, PRM pp.103-104). The step belongs to the field it was
     * set on — "Sets the increment value for the selected field" — so two
     * fields in one job may advance in opposite directions by different
     * amounts. Positive increments, negative decrements; 0 means <ESC>N
     * cancelled the field's flags. Absent when the field set no step of its
     * own, which falls back to the printer's documented default of 1.
     */
    serialStep?: number;
}

export type FieldSource =
    | { type: 'fixed'; data: string }
    | { type: 'variable'; data: string }
    /**
     * d2,m1[,m2] — master/slave (PRM p.175 "Field Data, Define Source"): this
     * field copies its data from field m1 of the same format. m2 is an optional
     * FS/GS-delimited element offset 0-9999. Resolved to the master's current
     * data at end of parse (resolveMasterSources).
     */
    | { type: 'master'; masterId: number; offset?: number };

export interface TextElement extends ElementBase {
    kind: 'text';
    font: string;
    hMag: number;
    wMag: number;
    /** Outline font size in points (k parameter). */
    pointSize?: number;
    /** Border thickness in dots (b parameter). >0 renders white letters on a
     * black n-dot surround (PRM p.167). */
    borderDots?: number;
    /**
     * Character rotation (r parameter, PRM p.170): 0 horizontal, 1 = 90° CCW.
     * Distinct from `f` (field direction, which rotates the whole field box):
     * this turns each GLYPH in place while the advance still runs along the
     * field's own axis, so `f3;r1` prints a column of upright characters.
     */
    charRot?: 0 | 1;
    /**
     * Pitch sizing (`gn`, PRM p.197): per-character advance in dots when the
     * field asks for n characters per line. Pitch is a third sizing mode that
     * REPLACES h/w/k ("when you use the pitch size command, you disable the
     * height and width magnification and point"), so a field carrying this has
     * hMag/wMag of 1 and no k of its own.
     */
    pitchAdvanceDots?: number;
    /**
     * Intercharacter gap override (`c n,m` — K10 "Font Type, Select"; PRM
     * p.180): "the space between characters", replacing the font's own gap
     * (1 dot for c0, 2 for the others). Absent = use the font default. The
     * documented range is -199..399 (K10) / -199..199 (PRM), so a negative
     * value overlaps characters and is honoured rather than clamped.
     */
    intercharGapDots?: number;
    /** Set when this is an interpretive field (I<n>) bound to barcode <n>;
     * its default anchor was derived from that barcode's rendered box. */
    interpretiveOf?: number;
    /**
     * A paragraph laid out inside a width/height box, wrapped at the box width
     * — TSPL's BLOCK (manual p. 80) and ZPL's ^FB. Absent for an ordinary
     * single-line TEXT field, whose content is drawn as written: the two must
     * not be confused, because wrapping text that has no box would reflow a
     * label that prints exactly as authored.
     */
    wrapDots?: number;
    /** The box height, and how many wrapped lines are drawn before the rest is
     *  CUT OFF — the behaviour measured from ZPL's ^FB, where a 2-line box
     *  drops the continuation rather than overflowing. */
    boxHeightDots?: number;
    maxLines?: number;
    /** Extra leading between lines in dots, ADDED to the normal line pitch —
     *  "Add or delete the space between lines" (TSPL), which ^FB's third
     *  parameter behaves like too. Measured, not assumed: see the renderer. */
    spaceDots?: number;
    /**
     * Per-line alignment inside the box, as a NAME rather than a number.
     *
     * A number would be a live trap: TSPL's BLOCK numbers it 0/1 left, 2
     * centre, 3 right, while TSPL's own TEXT command numbers 0 left, 1 centre,
     * 2 right, and ZPL's ^FB uses letters L/C/R/J. The same digit therefore
     * means two different things across these three commands.
     */
    align?: 'left' | 'center' | 'right' | 'justify';
    /** BLOCK's fit flag — shrink the text so the paragraph fits the box. */
    fit?: boolean;
    source: FieldSource;
}

export interface BarcodeElement extends ElementBase {
    kind: 'barcode';
    symbology: string;
    /** Height in dots (h parameter). */
    heightDots: number;
    /** Narrow module width in dots (w parameter). */
    moduleDots: number;
    /** Wide:narrow ratio code (r parameter). 0=2.5:1, 1=3:1 (default), 2=2:1. */
    ratio: number;
    /** 0 none, 1 below, 2 above. */
    hri: 0 | 1 | 2;
    hriFont?: string;
    hriPointSize?: number;
    source: FieldSource;
    /** c0,m — Code 39 charset/check-digit mode 0-8 (PRM p.150). */
    code39Mode?: string;
    /** p — Code 39 prefix characters, 1-4 of A-Z0-9 (PRM p.181). They are
     * encoded into the symbol but "do not appear in the interpretive field". */
    code39Prefix?: string;
    /** c6,m3 — Code 128 forced start subset: 1=A, 2=B, 3=C. */
    code128StartSubset?: string;
    /** c6,m1 — '1' selects UCC-128 Serial Shipping Container Code. */
    code128Ucc?: string;
    /** c6,m2 — '1' keeps parentheses/spaces in the interpretive while the
     * bar code ignores them; with m1=1 controls the SSCC interpretive too. */
    code128KeepInterpretive?: string;
    /** c7,m2 — EAN/UPC version selector. m1 (check digit) is implicit in the
     * data length: 12/7-digit data means the printer enters the check digit,
     * 13/8-digit data means the host entered it and the encoder verifies. */
    eanUpcVersion?: number;
    /** c8,c16,m1 — HIBC format selector (PRM pp.154-155): supplier 0-2,
     * provider 3-6. bwip's HIBC encoders auto-detect from the data's leading
     * '+', so this only gates the info issued for unsupported secondary modes. */
    hibcMode?: string;
    /** c18,m1 — QR model 1|2. Only model 2 has an encoder here; model 1
     * degrades to 2 with a warning at parse. */
    qrModel?: string;
    /** c18,m2 — QR error-correction level L/M/Q/H (printer default M). */
    qrEcl?: string;
    /** c18,m3 — QR mask number; stored printer-domain 0-7, translated to
     * bwip's 1-based 1-8 (0/8 = automatic mask) at encode time. */
    qrMask?: string;
    /** c19,m1 — MicroPDF417 data columns (0/auto = printer chooses). */
    microColumns?: string;
    /** c19,m2 — MicroPDF417 data rows (0/auto = printer chooses). */
    microRows?: string;
    /** c12,m1 — PDF417 data columns 0-30 (0/auto = as close to square as
     * possible, PRM p.149). */
    pdfColumns?: string;
    /** c12,m2 — PDF417 error-correction level 0-8 (9/auto = printer chooses). */
    pdfEcLevel?: string;
    /** c12,m3 — PDF417 truncate flag ('1' drops the right row indicators). */
    pdfTruncate?: string;
    /** c21,m1 — EAN.UCC Composite version 0-12: which linear component, and
     * the CC variant paired with it (PRM p.162). */
    compositeVersion?: string;
    /** c21,m3 — 2D columns (m1=0) or segments per row (m1=12). */
    compositeColumns?: string;
    /** c21,m5 — height of each 2D row (0/absent = 3x magnification). */
    compositeRowHeight?: string;
    /** c20,m1 — RSS/GS1 DataBar version 0-6 (default 2 = Stacked, PRM p.166). */
    rssVersion?: string;
    /** c20,m2 — separator-row height (stacked versions only). */
    rssSepHeight?: string;
    /** c20,m3 — segments per row, even 2-22 (expanded-stacked only). */
    rssSegments?: string;
    /** c14,m1 — MaxiCode mode 2-6 (default = auto-discriminate, PRM p.159). */
    maxiMode?: string;
    /** c17,m1 — Data Matrix ECC version, '100' or '200' (PRM p.162). They are
     *  different encodings with different parity, so this is not a preference. */
    dmVersion?: string;
    /** c17,m2 — Data Matrix shape: 'rectangle' for m2=1 (PRM p.162); square is
     *  the default and stays unset. */
    dmShape?: string;
    /** EPL b…D,v1 — an INVERSE Data Matrix, white on black (EPL manual p. 3-20). */
    inverse?: boolean;
    /** EPL b…D,c/r — the symbol's column and row count. */
    dmCols?: string;
    dmRows?: string;
    /**
     * TSPL AZTEC `ecp` — the error-control parameter. It selects BOTH the
     * correction level and the symbol FORMAT, and those are different symbols
     * rather than a preference:
     *
     *   0            encoder default
     *   1..99        minimum error-correction percentage
     *   101..104     1..4-layer COMPACT symbol
     *   201..232     1..32-layer FULL-RANGE symbol
     *   300          a simple Aztec "Rune"
     */
    aztecEcp?: string;
    /** TSPL CODABLOCK row height and module width (manual p. 50). The printed
     *  row height is `rowHeight × moduleWidth`. */
    codablockRowHeight?: string;
    codablockModuleWidth?: string;
}

export interface LineElement extends ElementBase {
    kind: 'line';
    lengthDots: number;
    thicknessDots: number;
    /** EPL's LW draws a WHITE line: it erases the ink under it rather than
     *  adding any. Painting white is correct because the label is filled white
     *  first and elements are drawn in order — the same order a printer lays
     *  them down. Only LW sets it. */
    white?: boolean;
}

export interface BoxElement extends ElementBase {
    kind: 'box';
    widthDots: number;
    heightDots: number;
    thicknessDots: number;
    /** Corner radius in dots (r parameter), optional. */
    radiusDots?: number;
}

/** Placeholder for raster graphic fields (G definitions referenced by U). */
export interface GraphicElement extends ElementBase {
    kind: 'graphic';
    graphicId: number;
    name?: string;
    widthDots: number;
    heightDots: number;
    /** Packed ASCII column data from the G definition's u rows, when captured. */
    data?: string[];
    /**
     * Row-major pixels, one string per row, leftmost dot in the HIGH bit of
     * each character — ZPL's ^GF, which is a different storage form from the
     * column-major `data` above rather than another encoding of it.
     *
     * Measured against the oracle: ^GFA,8,8,1,80… puts its dot at the LEFT
     * edge and 01… at the right, so the first dot is bit 7, not bit 0; and the
     * first byte run is the TOP row.
     */
    rows?: string[];
}

/**
 * A rectangle the printer INVERTS: every dot inside flips, so white areas turn
 * black and black areas turn white ("This command reverses a region in image
 * buffer", TSC manual p. 75). It is not a fill of either colour — a white fill
 * would leave existing black ink untouched, and this must erase it.
 */
export interface ReverseElement extends ElementBase {
    kind: 'reverse';
    widthDots: number;
    heightDots: number;
}

/**
 * An outlined ellipse: `ox,oy` is the UPPER-LEFT corner of its bounding box
 * (TSPL CIRCLE/ELLIPSE both document it that way), and a circle is the special
 * case where the two axes are equal.
 */
export interface EllipseElement extends ElementBase {
    kind: 'ellipse';
    widthDots: number;
    heightDots: number;
    thicknessDots: number;
}

/**
 * A line between two FREE POINTS, which is what TSPL's DIAGONAL is. It is not
 * a LineElement with a rotation: a line of a given length rotated by a quarter
 * turn can only ever be horizontal or vertical, so an arbitrary angle has to
 * carry both endpoints.
 *
 * The endpoints are absolute and are already resolved out of any field frame,
 * so `ox,oy` repeats the start point and `f` is always 0 — rotating an element
 * whose coordinates are absolute would move it twice.
 */
export interface DiagonalElement extends ElementBase {
    kind: 'diagonal';
    /** End point in dots, absolute like `ox`/`oy`. */
    ex: number;
    ey: number;
    thicknessDots: number;
}

export interface UnknownElement extends ElementBase {
    kind: 'unknown';
    command: string;
    raw: string;
    /** The field letter that created this element, when it has one (Q for an
     *  RFID tag write field). Field ids are keyed by letter, so duplicate
     *  detection and deletion need the real one, not the '?' placeholder. */
    prefix?: string;
}

export type ViewerElement =
    | TextElement
    | BarcodeElement
    | LineElement
    | ReverseElement
    | EllipseElement
    | DiagonalElement
    | BoxElement
    | GraphicElement
    | UnknownElement;

export interface LabelSettingsInfo {
    mediaSenseMode?: 'gap' | 'reflective' | 'continuous';
    mediaType?: 'direct-thermal' | 'thermal-transfer';
    printSpeed?: number;
    darknessAdjust?: number;
    /** Number of batches (<RS>n); inc/dec advances once per batch. */
    quantity?: number;
    /** Copies per batch (<US>n). Total labels = batches x copies. */
    batchCount?: number;
    formatNumber?: number;
    /** Page id when a page (Sn) is defined. */
    pageNumber?: number;
    /**
     * Format direction (q command, PRM p.192): quarter-turns CCW applied to
     * the whole format/page. From a standalone q frame; inside an S frame it
     * is carried per placement instead.
     */
    formatDirection?: number;
    /**
     * Printer Language, Select `<SI>ln` (PRM p.133): the code page the printer
     * applies to print data. Absent when the stream never selects one.
     */
    codePage?: number;
}

/**
 * One format placement within a page (commands M/O/q, PRM pp.183–185).
 * The page composes several stored formats onto one label.
 */
export interface PagePlacement {
    /** Page position letter a–z. */
    position: string;
    /** Format id assigned to this position (M command). */
    formatId: number;
    /** Format offset within the page (O command), in dots. */
    offsetX: number;
    offsetY: number;
    /** Format direction within the page (q command): 0-3 CCW quadrants. */
    rotation: number;
}

export interface ViewerLabel {
    /** Label width across the printhead in dots (<SI>W), when present. */
    widthDots: number | null;
    /** Maximum label length in dots (<SI>L), when present. */
    heightDots: number | null;
    elements: ViewerElement[];
    issues: ViewerIssue[];
    settings: LabelSettingsInfo;
    /**
     * Page composition (S/M/O/q commands). When present, `elements` holds the
     * union of all placed formats already offset into page coordinates; the
     * placements record which format contributed which region.
     */
    page?: {
        id: number;
        placements: PagePlacement[];
    };
}
