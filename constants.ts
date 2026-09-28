

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
 * Per-model constants behind BarTender's Direct Graphics vertical placement.
 *
 * A BarTender stream writes each graphic's origin Y in a CENTRED frame, so
 * recovering the printed position needs two driver values that the stream does
 * not carry. Both are read from the Seagull driver's own model table
 * (`ss#ipl.ddz` -> `Model.d`, extracted 2026-09-28):
 *
 *   printableXIn  Stock.Printable.X  -- the printable width, in inches
 *   widthAdjust   LabelWidthAdjustment -- folded into the <SI>W the driver sends
 *
 * Placement (verified 8/8 within 1 dot against BarTender's own previews):
 *
 *   yTop = originY + (W + 2*widthAdjust)/2 - maxBit - ceil(printableXIn*dpi/2)
 *
 * `W` comes from the stream, so only these two numbers are model knowledge.
 *
 * DO NOT guess these for a model that is not listed: the constants differ a
 * lot per model and a wrong one silently misplaces every graphic. `undefined`
 * means "unknown", and the renderer falls back to the label's own height --
 * the pre-2026-09-28 behaviour.
 */
export const PRINTABLE_WIDTH_IN: { [model: string]: Partial<Record<203 | 300 | 406, number>> } = {
    'PD41': { 203: 4.09, 300: 4.16 },
    'PD43': { 203: 4.09, 300: 4.17 },
    // PD45S is absent from the driver's own table; the PD43 figures are used as
    // a proxy and should be replaced if a PD45S stream is ever measured.
    'PD45S': { 203: 4.09, 300: 4.17, 406: 4.09 },
};

/**
 * `LabelWidthAdjustment` per model -- the driver adds this into the <SI>W it
 * writes. Kept beside PRINTABLE_WIDTH_IN because the placement formula needs
 * both, and a model is either measured for both or for neither.
 */
export const LABEL_WIDTH_ADJUSTMENT: { [model: string]: Partial<Record<203 | 300 | 406, number>> } = {
    'PD41': { 203: -40, 300: -40 },
    'PD43': { 203: 2, 300: 2 },
    'PD45S': { 203: 2, 300: 2, 406: 2 },
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

/** The resident outline families the printer actually has faces for.
 *
 *  Five are metric families resolved by an advance table: 'monospace'
 *  (Andale Mono), 'sans-serif' (Helvetica metrics — see FONT_FAMILIES),
 *  'serif' (Times/CG Times), 'schoolbook' (Century Schoolbook, c67), and
 *  'letter-gothic' (c69, a 12-pitch face at 500/1000 em).
 *
 *  'univers-condensed' is the SIXTH and is a different kind of thing: it is a
 *  WIDTH OVERRIDE, not a face. The printer's cuts are Univers Condensed Bold
 *  and Univers Extra Condensed, and their advances come from Adobe's own AFM
 *  for the family — but no free Univers-shaped face exists (Nimbus Sans Narrow
 *  is 40.3 per-mille off; Arial Narrow is Windows-only), so the glyphs still
 *  come from Liberation Sans at the condensed advances. That is safe here in a
 *  way it was NOT for c69: measured against the real AFM, 0 of 67 glyphs
 *  overlap, the tightest leaving 25 units of slack. */
export type FontFamily = 'monospace' | 'sans-serif' | 'serif' | 'schoolbook' | 'univers-condensed' | 'letter-gothic';

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
    family?: FontFamily;
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
//
// "schoolbook" is TeX Gyre Schola (GUST Font License, also vendored), the
// metric-exact match for Century Schoolbook — which is what c67 prints in. The
// real face is Monotype's and cannot be shipped. The bare "Century Schoolbook"
// is kept behind it so a host that has the genuine article uses it; note that
// would be a LICENSED Windows install, not a redistribution.
//
// "letter-gothic" is Inconsolata (SIL OFL, also vendored) for c69. Unlike
// schoolbook this is NOT a metric clone — Letter Gothic has no free clone — but
// it is the one free face whose own advance happens to be exactly the printer's
// 500/1000 em, which is what c69 needed: the advance is now right and the glyphs
// fit the cell. See fontMetrics.ts.
//
// CJK: every stack ends in CJK_FALLBACK. fontMetrics.ts charges a full em for a
// wide codepoint (WIDE_PER_MILLE = 1000), which is what the printer does — but
// the vendored faces carry no ideographs, so what actually gets drawn is
// whatever the platform substitutes.
//
// Measured in NODE (the golden harness, where nothing is substituted): naming
// only a Latin face left the ideographs at 0.75 em through the sans stack and
// 0.60 em through the mono one, i.e. the box was metered wide while the glyphs
// painted narrow — so every c50/c51 (Kanji) golden was systematically wrong.
// Appending these names takes it to 1.000 while leaving the Latin advances
// untouched, because the Latin face still wins for Latin text.
//
// The BROWSER is a different story and this does NOT fix it there: Chromium on
// Windows already reaches a full em for kanji with a Latin-only stack, because
// the OS supplies its own fallback. Left as measured rather than asserted — the
// Node behaviour is the one that is verified, and the browser was not.
const CJK_FALLBACK = '"Yu Gothic", "MS Gothic", "Malgun Gothic", "SimSun", '
    + '"Noto Sans CJK SC", "Noto Sans CJK JP", "Meiryo"';

export const FONT_FAMILIES: Record<FontFamily, string> = {
    monospace: `"Liberation Mono", "Courier New", ${CJK_FALLBACK}, monospace`,
    'sans-serif': `"Liberation Sans", Arial, Helvetica, ${CJK_FALLBACK}, sans-serif`,
    serif: `"Liberation Serif", "Times New Roman", ${CJK_FALLBACK}, serif`,
    schoolbook: `"TeX Gyre Schola", "Century Schoolbook", "Liberation Serif", ${CJK_FALLBACK}, serif`,
    // Arial Narrow leads, so a host that has it uses a REAL condensed design;
    // Liberation Sans is the vendored fallback and is squeezed to the
    // condensed advances by the table (see fontMetrics.ts). Both are needed:
    // the advance comes from the table either way, but only Arial Narrow has
    // the right glyph shapes.
    'univers-condensed': `"Arial Narrow", "Liberation Sans", Arial, Helvetica, ${CJK_FALLBACK}, sans-serif`,
    // Letter Gothic is a 12-pitch face: every glyph advances exactly 500/1000 em
    // (URW's own AFM, ulgb8a.afm, gives WX 500 for every character). Inconsolata
    // is vendored because it is the one free face whose real advance IS 500/1000
    // and whose glyphs fit a 500 cell — 0 of 94 overhang, where Liberation Mono
    // (600) had 25 of 94 wider than the cell and collided, which is why this was
    // an announced defect until now. SIL Open Font License.
    'letter-gothic': `"Inconsolata", "Liberation Mono", ${CJK_FALLBACK}, monospace`,
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
    // c23/c24 are BITMAP faces, not outline: the Seagull driver's own table
    // (FontGroup.d, group `bitmap_ocr_203`) and PRM270's "Bitmap fonts
    // recognized by optical character recognition" both say so. Typing them
    // as outline routed them through the outline branch, where `h>4` is read
    // as a point size — so `h8` painted a 3pt field instead of magnifying 8x
    // (~8x too small, and silent). As bitmap, h/w magnify like every other
    // bitmap id.
    //
    // The CELL WIDTH IS STILL UNKNOWN, and the search was taken further than
    // before without finding it. What IS now known, from the driver's own
    // c23_203.pfm / c24_203.pfm (in ss#ipl.ddz), is their point size and the
    // matching em height in dots: byte 0x02 is the point size and 0x08 the em
    // in dots, an encoding validated exactly against all fifteen c20..c41 ids
    // whose sizes the manual states (c20 8pt -> 0x02=8, c41 36pt -> 0x02=36).
    // It reads c23 = 10 pt / 31 dots and c24 = 9 pt / 26 dots.
    //
    // That is NOT the cell. A bitmap id needs width x height in dots, and no
    // shipped table gives the width: the obvious derivation (scale the face's
    // own advance by the em) reproduces none of the four DOCUMENTED cells when
    // checked against c1 — the one anchor named "7 x 11 OCR", whose published
    // width is 7 while the face-derived reading gives 12.6 and the flat 0.6-em
    // reading gives 13.2. So the width is not derivable from these files, and
    // guessing it from an anchor that fails would be exactly the silent-wrong
    // -number this project exists to avoid.
    //
    // The values below are therefore the c0-shaped ones that were already being
    // applied implicitly through FONT_FALLBACK, kept so the assumption is
    // visible and the advance (7+2 = 9 dots at w1) does not move. Do NOT read
    // them as measured. tests/outlineFontCoverage.test.ts pins that they stay
    // an explicit assumption rather than drifting into looking authoritative.
    '23': { name: 'OCR A', type: 'bitmap', baseWidth: 7, baseHeight: 9, gapWidth: 2 },
    '24': { name: 'OCR B size 2', type: 'bitmap', baseWidth: 7, baseHeight: 9, gapWidth: 2 },
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
    // c50/c51 are the Kanji outline ids (face TBMinPro-Light per the driver's
    // Font_Type_Select table). They carry no defaultPointSize on purpose: the
    // manual's fixed-size families name their size IN the font, and these do
    // not, so an id with no `k` is genuinely unsized. What mattered for them was
    // the CJK WIDTH, which was wrong in Node until 2026-09-28 — see CJK_FALLBACK
    // in FONT_FAMILIES: the vendored faces have no ideographs, so the stack
    // decided what got drawn, and it came out at 0.75 em (sans) / 0.60 em (mono)
    // against the full em fontMetrics charges. tests/cjkWidth.test.ts pins it.
    '50': { name: 'Kanji Outline (TBMinPro)', type: 'outline', family: 'sans-serif' },
    '51': { name: 'Kanji monospace outline', type: 'outline', family: 'monospace' },
    '61': { name: 'Swiss 721 (Univers)', type: 'outline', family: 'sans-serif' },
    '62': { name: 'Swiss 721 bold', type: 'outline', family: 'sans-serif' },
    '63': { name: 'Swiss 721 bold condensed', type: 'outline', family: 'univers-condensed' },
    '64': { name: 'Prestige bold', type: 'outline', family: 'monospace' },
    '65': { name: 'Zurich extra condensed', type: 'outline', family: 'univers-condensed' },
    '66': { name: 'Dutch 801 bold', type: 'outline', family: 'serif' },
    '67': { name: 'Century Schoolbook', type: 'outline', family: 'schoolbook' },
    '68': { name: 'Futura light', type: 'outline', family: 'sans-serif' },
    '69': { name: 'Letter Gothic', type: 'outline', family: 'letter-gothic' },
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