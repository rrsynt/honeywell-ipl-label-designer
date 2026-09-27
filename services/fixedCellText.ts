// Painting for the printer's BITMAP faces (c0/c1/c2/c7 and the other resident
// cell fonts). Shared by the viewer/print renderer and the designer's screen
// drawer so the two engines cannot drift apart again.
//
// Why a helper and not ctx.fillText(line, ...): the printer's bitmap faces are
// fixed cells, not a proportional typeface. The manual states the metrics and
// the arithmetic that follows from them (PRM270 p.54, DevGuide p.30):
//
//   "the letters in font c0 are 7 dots wide by 9 dots high, with a 1-dot gap
//    between characters. If you design a field that prints 10 letters in font
//    c0, the field will be 79 dots wide by 9 dots high."
//
// and for width magnification (PRM p.55): "Increasing the width of a text
// field to 2 makes each letter in the field twice as wide... the final field
// would print 158 dots wide."
//
// fillText, by contrast, advances by whatever face the host resolved —
// Liberation Mono's 0.6 em, i.e. 5.4 dots where a c0 cell is 8 — so the ink
// came out roughly a third narrower than the box every layout calculation
// (extent, selection box, anchors, borders) is built from, and `w`
// magnification moved the pixels not at all for the viewer (the designer
// applied it as a canvas scale, which widened the run by the wrong amount).
//
// The glyph is scaled so one host advance equals the printer's CELL width, and
// the run advances by cell + gap. Uniform scaling keeps the relative ink of
// narrow and wide glyphs ('I' vs 'H') intact while making the cell pitch — the
// quantity the printer actually honours — exact.
export const paintFixedCellText = (
    ctx: CanvasRenderingContext2D,
    lines: string[],
    cellWidthPx: number,
    advancePx: number,
    lineHeightPx: number,
): void => {
    const natural = ctx.measureText('M').width || cellWidthPx;
    const sx = cellWidthPx / natural;
    lines.forEach((line, li) => {
        let cx = 0;
        for (const ch of line) {
            ctx.save();
            ctx.translate(cx, li * lineHeightPx);
            ctx.scale(sx, 1);
            ctx.fillText(ch, 0, 0);
            ctx.restore();
            cx += advancePx;
        }
    });
};
