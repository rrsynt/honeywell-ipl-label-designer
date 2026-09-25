

// --- CONSTANTS ---
export const DPI_MAP = { '203': 8, '300': 11.8, '406': 16 };
export const POINTS_TO_MM = 25.4 / 72;
export const PREVIEW_SCALE = 4;
export const SNAP_THRESHOLD = 8;
export const GRID_SPACING_MM = 5;

export const PRINTER_MODELS: { [model: string]: (203 | 300 | 406)[] } = {
    'Generic': [203, 300, 406],
    'PD41': [203, 300],
    'PD43': [203, 300],
    'PD45S': [203, 300, 406],
};

/**
 * Fase 3: the strip along each edge of the stock that the print head cannot
 * reach, in mm, drawn as a guide rectangle on the canvas. Honeywell does not
 * publish a per-model figure for this, so the values below are the conservative
 * inset the designer warns with, NOT a measured printer specification — a
 * design placed outside it may still print, and one inside it will. 'Generic'
 * has no head to describe, so it gets none and draws no guide.
 */
export const UNPRINTABLE_MARGIN_MM: { [model: string]: number } = {
    'Generic': 0,
    'PD41': 1,
    'PD43': 1,
    'PD45S': 1,
};

// THE single source of font metrics (audit T1: the designer, the viewer
// renderer and the parser each used to carry their own diverging table).
// baseHeight/baseWidth are the GLYPH CELL in dots (PRM270 §7.3: c0 is 7×9,
// c1 7×11, c2 10×14, c7 5×7); gapWidth is the intercharacter gap (PRM270
// p.54: c0 prints "with a 1-dot gap"; 2 dots for the rest). Horizontal
// advance = baseWidth + gapWidth — use fontAdvanceDots(), never baseWidth.
export interface FontDef {
    name: string;
    type: 'bitmap' | 'outline';
    baseHeight?: number;
    baseWidth?: number;
    /** Intercharacter gap in dots (bitmap fonts only). */
    gapWidth?: number;
    family?: 'monospace' | 'sans-serif' | 'serif';
    /**
     * Nominal size in points for the fixed-size families (c20 8pt, c21 12pt,
     * c22 20pt, c30-c41 …). The printer uses this when the field carries no
     * `k` point size; without it every member of that family would render at
     * one indistinguishable size.
     */
    defaultPointSize?: number;
}

// CSS font stacks per family key (audit batch 6: golden font portability).
// The families named "Liberation …" are vendored under public/fonts and
// registered into @napi-rs/canvas by tests/golden/fonts.ts (node) and declared
// as @font-face in index.html (browser) — so a golden render measures the same
// font on Windows, Linux CI and any user machine, instead of silently
// substituting whatever Courier New/Arial/Times the host happens to have.
// Liberation Mono/Sans/Serif are metric-compatible with those originals.
export const FONT_FAMILIES: { monospace: string; 'sans-serif': string; serif: string } = {
    monospace: '"Liberation Mono", "Courier New", monospace',
    'sans-serif': '"Liberation Sans", Arial, Helvetica, sans-serif',
    serif: '"Liberation Serif", "Times New Roman", serif',
};

/**
 * CSS font string for one text element. Everything is painted at regular
 * weight — see the note on FONT_MAP below for why the ids whose names say
 * "bold" are not emboldened.
 */
export const fontStack = (family: string | undefined): string =>
    FONT_FAMILIES[family as keyof typeof FONT_FAMILIES] ?? FONT_FAMILIES.monospace;

// Outline font ids per PRM 2.70 p.206 (the authoritative list). c27 exists in
// 3240-era docs but is absent from the 2.70 table, so it stays out.
//
// On the "bold" in these names: measured against a real BarTender export
// (testdata/bartender-tes1-export.png, whose c26 fields are named "Swiss Mono
// 721 bold"), the median stroke width is 3 px — identical to our REGULAR
// Liberation Mono and one pixel thinner than its Bold. BarTender, the
// reference implementation, prints these ids at regular weight.
//
// So "bold" here is part of the printer font's NAME, not an instruction to
// embolden, and NO id is emboldened — including the proportional ones (62/63/
// 66), which have no reference export but which the designer could not render
// bold anyway: geometry.ts and canvasDrawer.ts paint every outline field
// through a `normal`-weight stack, so emboldening only the viewer would put
// the on-screen designer ~9% away from the print preview of the same label.
// tests/outlineBoldWeight.test.ts re-measures the export and pins this.
export const FONT_MAP: { [key: string]: FontDef } = {
    '0': { name: '7x9 Standard (86XX)', type: 'bitmap', baseHeight: 9, baseWidth: 7, gapWidth: 1 }, '1': { name: '7x11 OCR (86XX)', type: 'bitmap', baseHeight: 11, baseWidth: 7, gapWidth: 2 },
    '2': { name: '10x14 Standard (86XX)', type: 'bitmap', baseHeight: 14, baseWidth: 10, gapWidth: 2 }, '7': { name: '5x7 Standard (86XX)', type: 'bitmap', baseHeight: 7, baseWidth: 5, gapWidth: 2 },
    '20': { name: '8 point monospace', type: 'outline', family: 'monospace', defaultPointSize: 8 },
    '21': { name: '12 point monospace', type: 'outline', family: 'monospace', defaultPointSize: 12 },
    '22': { name: '20 point monospace', type: 'outline', family: 'monospace', defaultPointSize: 20 },
    '23': { name: 'OCR A', type: 'outline', family: 'monospace' },
    '24': { name: 'OCR B size 2', type: 'outline', family: 'monospace' },
    '25': { name: 'Swiss Mono 721', type: 'outline', family: 'monospace' },
    '26': { name: 'Swiss Mono 721 bold', type: 'outline', family: 'monospace' },
    '28': { name: 'Dutch Roman 801', type: 'outline', family: 'serif' },
    '30': { name: '6 point monospace bold', type: 'outline', family: 'monospace', defaultPointSize: 6 },
    '31': { name: '8 point monospace bold', type: 'outline', family: 'monospace', defaultPointSize: 8 },
    '32': { name: '10 point monospace standard', type: 'outline', family: 'monospace', defaultPointSize: 10 },
    '33': { name: '10 point monospace bold', type: 'outline', family: 'monospace', defaultPointSize: 10 },
    '34': { name: '12 point monospace bold', type: 'outline', family: 'monospace', defaultPointSize: 12 },
    '35': { name: '16 point monospace standard', type: 'outline', family: 'monospace', defaultPointSize: 16 },
    '36': { name: '16 point monospace bold', type: 'outline', family: 'monospace', defaultPointSize: 16 },
    '37': { name: '20 point monospace bold', type: 'outline', family: 'monospace', defaultPointSize: 20 },
    '38': { name: '24 point monospace standard', type: 'outline', family: 'monospace', defaultPointSize: 24 },
    '39': { name: '24 point monospace bold', type: 'outline', family: 'monospace', defaultPointSize: 24 },
    '40': { name: '30 point monospace bold', type: 'outline', family: 'monospace', defaultPointSize: 30 },
    '41': { name: '36 point monospace bold', type: 'outline', family: 'monospace', defaultPointSize: 36 },
    '50': { name: 'Kanji Outline (TBMinPro)', type: 'outline', family: 'sans-serif' },
    '51': { name: 'Kanji monospace outline', type: 'outline', family: 'monospace' },
    '61': { name: 'Swiss 721 (Univers)', type: 'outline', family: 'sans-serif' },
    '62': { name: 'Swiss 721 bold', type: 'outline', family: 'sans-serif' },
    '63': { name: 'Swiss 721 bold condensed', type: 'outline', family: 'sans-serif' },
    '64': { name: 'Prestige bold', type: 'outline', family: 'monospace' },
    '65': { name: 'Zurich extra condensed', type: 'outline', family: 'sans-serif' },
    '66': { name: 'Dutch 801 bold', type: 'outline', family: 'serif' },
    '67': { name: 'Century Schoolbook', type: 'outline', family: 'serif' },
    '68': { name: 'Futura light', type: 'outline', family: 'sans-serif' },
    '69': { name: 'Letter Gothic', type: 'outline', family: 'monospace' },
    '70': { name: 'DingDings', type: 'outline', family: 'sans-serif' },
};

/** Horizontal advance of one character in dots: cell width + gap (never the
 *  cell width alone — that made the designer measure text 1-2 dots per char
 *  narrower than the viewer printed it). Unknown fonts fall back to c0-ish. */
export const fontAdvanceDots = (fontId: string): number => {
    const f = FONT_MAP[fontId];
    if (!f || f.type !== 'bitmap') return 8 + 2; // generic monospace-ish fallback
    return (f.baseWidth ?? 7) + (f.gapWidth ?? 2);
};

/** Row width in dots for `charCount` bitmap chars at magnification wMag —
 *  the last gap is dropped, matching the viewer renderer's advance math
 *  exactly (services/ipl/renderer.ts estimateElementSize). */
export const bitmapTextWidthDots = (fontId: string, charCount: number, wMag = 1): number => {
    if (charCount <= 0) return 0;
    const f = FONT_MAP[fontId];
    const gap = f && f.type === 'bitmap' ? (f.gapWidth ?? 2) : 2;
    return Math.max(0, charCount * fontAdvanceDots(fontId) * wMag - gap * wMag);
};

export const BARCODE_MAP: { [key: string]: string } = {
    '0': 'Code 39', '1': 'Code 93', '2': 'Interleaved 2 of 5', '3': 'Code 2 of 5', '4': 'Codabar', '5': 'Code 11', '6': 'Code 128 / GS1-128', '7': 'EAN/UPC',
    '8': 'HIBC Code 39', '9': 'Code 16K', '10': 'Code 49', '11': 'POSTNET',
    '12': 'PDF417', '14': 'MaxiCode', '16': 'HIBC Code 128', '17': 'DataMatrix', '18': 'QR Code', '19': 'MicroPDF417', '20': 'RSS / GS1 DataBar', '22': 'Planet',
};