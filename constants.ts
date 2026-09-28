

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
 * The strip along each edge of the stock that the print head cannot reach, in
 * mm, drawn as a guide rectangle on the canvas and in the viewer.
 *
 * These are the DRIVER's own figures, not a guess. `Stock.UnprintableWidth` in
 * the Seagull model table (`ss#ipl.ddz` -> `Model.d`) gives, for the 203 dpi
 * models this project ships: PD43 / PC23d / PC43d / PM43 = 0.00 in, and
 * PD41 = 3.00 mm (2.20 mm at 300 dpi). The table is most of the evidence:
 * 29 of its 62 entries are 0.00, and the non-zero ones cluster on the older
 * 3400/4100/4400 generation at 0.05-0.12 in. The key carries WIDTH only — no
 * per-edge variant exists anywhere in the table — so it describes the two
 * edges ACROSS the print head, and the guide insets both of those.
 *
 * An earlier revision carried a flat 1 mm for every model and said so in this
 * comment: "NOT a measured printer specification". It was wrong in both
 * directions — three times too small for the PD41 and inventing a margin the
 * PD43 does not have — which is exactly the failure a guessed table buys.
 *
 * What this does NOT model: the leading/trailing edges along the feed axis.
 * `Stock.Printable.Y` equals the stock length on every model above (68.00 in
 * against a 68.00 in maximum), so the table claims nothing is lost there, and
 * the guide follows it rather than insetting those edges on a hunch.
 *
 * Treat it as a layout-safe band, not a hard limit: a design placed outside it
 * may still print, and one inside it will. 'Generic' has no head to describe,
 * so it gets 0 and draws no guide.
 */
export const UNPRINTABLE_MARGIN_MM: { [model: string]: number } = {
    'Generic': 0,
    'PD41': 3,       // Stock.UnprintableWidth=3.00 mm at 203 dpi, 2.20 mm at 300
    'PD43': 0,       // Stock.UnprintableWidth=0.00 in
    'PD45S': 0,      // absent from the driver table; PD43/PC43/PM43 all read 0.00
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
// c1 7×11, c2 10×14, c7 5×7); gapWidth is the intercharacter gap. Horizontal
// advance = baseWidth + gapWidth — use fontAdvanceDots(), never baseWidth.
//
// THE GAP IS DOCUMENTED FOR c0 ONLY. PRM270 p.54 (and DevGuide p.30) state it
// for c0 alone — "the letters in font c0 are 7 dots wide by 9 dots high, with a
// 1-dot gap between characters", which the manual's own worked example pins:
// 10 c0 characters are 79 dots, i.e. 10 × (7+1) − 1. That example is a test in
// this repo, so c0's 1 is measured against a published number.
//
// Every OTHER cell takes 2, and that value is an ASSUMPTION, not a measurement.
// No manual publishes a gap for c1/c2/c7 or for the c52..c56 CJK cells; there
// is no per-font gap table; and the driver's per-id PFMs contain no byte or u16
// reading 1,2,2,2 for c0/c1/c2/c7 at any aligned offset, so it is not in the
// files either. The nearest published figure is the `z` command's default
// ("Intercharacter Space for UDF, n = 2"), which is stated for USER-DEFINED
// fonts and never claimed to govern resident cells.
//
// Two sources disagree about the default when `c`'s optional m is absent: the
// PRMs say "the printer uses the default value of the selected font" (i.e.
// these per-font values) while the K10 command reference says "Default is 0".
// The font default is used, because the 79-dot example pins that model for c0;
// the disagreement is recorded in docs/HONEYWELL-SIMULATOR.md rather than
// silently resolved — see tests/bitmapTextAdvance.test.ts.
//
// Exposure is bounded: for c1 it is 1 dot per character (10 chars meter 88 at
// gap 2 vs 79 at gap 1). Kept as-is because no source contradicts it, changing
// it would silently move every existing golden, and an announced assumption is
// recoverable while a measured-looking wrong number is not.
export interface FontDef {
    name: string;
    type: 'bitmap' | 'outline';
    baseHeight?: number;
    baseWidth?: number;
    /** Intercharacter gap in dots (bitmap fonts only). */
    gapWidth?: number;
    family?: FontFamily;
    /**
     * Nominal size in points for the families that name one (c20 8pt, c21 12pt,
     * c22 20pt, c30-c41 …). The printer uses this when the field carries no `k`
     * point size; without it every member of that family would render at one
     * indistinguishable size.
     *
     * ABSENT means the font documents no size — it does NOT mean the field is
     * unsized. Fifteen outline ids have none (c25, c26, c28, c50-c70 apart from
     * the numbered monospace ones), and for those the field falls back to the
     * `k` command's own published default of 12pt. See
     * OUTLINE_DEFAULT_POINT_SIZE in services/ipl/viewerParser.ts.
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

// Outline font ids per PRM 2.70 p.206 (the authoritative list).
//
// c27 and c29 are NOT missing fonts — they are RESERVED GAPS. Every manual's
// per-printer range for the `c` (Font Type, Select) command skips both:
// "0 to 26, 28, 30 to 41" and "0 to 28, 30 to 41" appear 7-8 times in each of
// PRM 2.70, the 4400 manual and the older PRM, so an id of 27 or 29 is outside
// the printer's valid range rather than a face we have not found. The two ids
// are also absent from every "Values for n" font table and the driver ships no
// c27.pfm / c29.pfm. They stay out, and the range evidence — not a missing
// source — is the reason.
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
    // c52..c56 are the resident CJK BITMAP faces (face TBMinPro-Light). The
    // manual publishes their cells in the id's own name — "Katakana 12 x 16
    // bitmap", "Kanji 24 x 24 bitmap" — which is a stronger statement than
    // anything derivable, so these are the published numbers and no inference
    // was needed. The driver's c52.pfm..c56.pfm agree: bytes 0x1b/0x16 read
    // 12/16, 16/24, 24/36, 16/16, 24/24 for the five ids, matching the names
    // exactly. (Those two bytes do NOT carry the cell for the 86XX ids — there
    // they read 8/11, 16/22, 12/17, 6/9 against published 7x9, 7x11, 10x14,
    // 5x7 — so the PFM template differs and the manual is the authority here.)
    //
    // The intercharacter gap is NOT published for these ids — same situation as
    // c1/c2/c7, see the note on the FONT_MAP metrics above. They take the same
    // 2-dot assumption, stated rather than hidden. Advance = width + gap.
    '52': { name: 'Katakana 12 x 16 bitmap', type: 'bitmap', baseWidth: 12, baseHeight: 16, gapWidth: 2 },
    '53': { name: 'Katakana 16 x 24 bitmap', type: 'bitmap', baseWidth: 16, baseHeight: 24, gapWidth: 2 },
    '54': { name: 'Katakana 24 x 36 bitmap', type: 'bitmap', baseWidth: 24, baseHeight: 36, gapWidth: 2 },
    '55': { name: 'Kanji 16 x 16 bitmap', type: 'bitmap', baseWidth: 16, baseHeight: 16, gapWidth: 2 },
    '56': { name: 'Kanji 24 x 24 bitmap', type: 'bitmap', baseWidth: 24, baseHeight: 24, gapWidth: 2 },
    // c57..c60 (Kanji / Korean / Traditional Chinese / Simplified Chinese) are
    // DELIBERATELY absent, for the same reason c27 is: they are not in the
    // authoritative table. PRM 2.70 p.206 jumps straight from 56 to 61, and
    // none of the four manuals in docs/manuals/ lists 57-60 at all. The
    // Seagull driver does name them in ~FontDescriptions.d — Type=Scalable,
    // each with its own font GROUP FILE (Kanji.pfg, Korean.pfg, ChineseGB.pfg,
    // ChineseBig5.pfg) and a Honeywell part number — which is the signature of
    // a downloadable language OPTION, not a resident face. The manual's own
    // per-printer table agrees: the 4X30/PD43 range is "0 to 28, 30 to 41",
    // with the 50s available only "with the Kanji option".
    //
    // Writing cells for them would mean inventing metrics for fonts the printer
    // may not have. A stream that uses them gets the unknown-font warning,
    // which is the honest outcome.
    '61': { name: 'Swiss 721 (Univers)', type: 'outline', family: 'sans-serif' },
    '62': { name: 'Swiss 721 bold', type: 'outline', family: 'sans-serif' },
    '63': { name: 'Swiss 721 bold condensed', type: 'outline', family: 'univers-condensed' },
    // c62, c64, c66 carry "bold" in their NAME, and the authoritative K10 table
    // confirms the printer really does substitute a bold face behind them
    // (Univers Bold / Andale Mono Bold / CG Times Bold). They are drawn here
    // with their family's regular cut. Measured 2026-09-28 from the driver's own
    // per-face PFMs, to put a number on that rather than assume it is harmless:
    //
    //   c64 (Andale Mono Bold)   monospace, so the advance is IDENTICAL —
    //                            measured 0 of 95 glyphs differ. No exposure.
    //   c62 (Univers Bold)       bold differs from regular on 42/95 glyphs.
    //   c66 (CG Times Bold)      47/95 glyphs, mean 59 per-mille apart.
    //
    // Against OUR tables the picture is subtler, and it is why the mapping is
    // left alone: scaled to a common mean, Liberation Sans sits 23.5 per-mille
    // from Univers Bold but only 16.7 from Univers regular, and Liberation Serif
    // sits 32.3 from CG Times Bold against 28.1 from CG Times regular. The
    // regular cut is the closer of the two in both cases — so the current
    // mapping is the better of the available choices, not an oversight.
    //
    // Painting these bold would be worse: every outline id is drawn at regular
    // weight (tests/outlineBoldWeight.test.ts), and geometry.ts and
    // canvasDrawer.ts hardcode normal weight, so emboldening only the viewer
    // would desync the designer from the preview.
    '64': { name: 'Prestige bold', type: 'outline', family: 'monospace' },
    '65': { name: 'Zurich extra condensed', type: 'outline', family: 'univers-condensed' },
    '66': { name: 'Dutch 801 bold', type: 'outline', family: 'serif' },
    '67': { name: 'Century Schoolbook', type: 'outline', family: 'schoolbook' },
    '68': { name: 'Futura light', type: 'outline', family: 'sans-serif' },
    '69': { name: 'Letter Gothic', type: 'outline', family: 'letter-gothic' },
    // c70 (DingDings) is the weakest id in this table, and it is kept only
    // because PRM 2.70 p.206 lists it. Three things are worth knowing:
    //   - It is ABSENT from the authoritative K10 table, which stops at 69. So
    //     the face behind it is undocumented by the source this project treats
    //     as decisive.
    //   - The manual gives no face beyond the name, no cell, no size, and no
    //     statement of what character set it holds, so "sans-serif" here is a
    //     placeholder rather than a measurement. A dingbat face is not a text
    //     face; if it is used at all it is for symbol glyphs that none of our
    //     tables describe.
    //   - Only the PM4i/PX4i/PX6i line lists 61-70 in its `c` range at all
    //     ("0 to 26, 28, 30 to 41, 61 to 70"); every PD43-era entry stops at 41.
    //
    // It stays in FONT_MAP because the PRM names it and a stream may legitimately
    // carry it, but nothing here should be read as knowing what it looks like.
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