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
}

export type FieldSource =
    | { type: 'fixed'; data: string }
    | { type: 'variable'; data: string }
    | { type: 'date'; formatIndex: number }
    | { type: 'time'; formatIndex: number }
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
    /** Set when this is an interpretive field (I<n>) bound to barcode <n>;
     * its default anchor was derived from that barcode's rendered box. */
    interpretiveOf?: number;
    source: FieldSource;
    /** Interpretive-field style options are ignored for plain text. */
    reverse?: boolean;
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
    /** c20,m1 — RSS/GS1 DataBar version 0-6 (default 2 = Stacked, PRM p.166). */
    rssVersion?: string;
    /** c20,m2 — separator-row height (stacked versions only). */
    rssSepHeight?: string;
    /** c20,m3 — segments per row, even 2-22 (expanded-stacked only). */
    rssSegments?: string;
    /** c14,m1 — MaxiCode mode 2-6 (default = auto-discriminate, PRM p.159). */
    maxiMode?: string;
}

export interface LineElement extends ElementBase {
    kind: 'line';
    lengthDots: number;
    thicknessDots: number;
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
}

export interface UnknownElement extends ElementBase {
    kind: 'unknown';
    command: string;
    raw: string;
}

export type ViewerElement =
    | TextElement
    | BarcodeElement
    | LineElement
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
    /** Field increment step (<ESC>In). Default 1. */
    increment?: number;
    /** Field decrement step (<ESC>Dn). */
    decrement?: number;
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
