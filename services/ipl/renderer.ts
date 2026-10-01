import type { ViewerLabel, ViewerElement, TextElement, BarcodeElement } from './types';
import { measureBarcode, paintBarcode, buildBwipSpec, applyI2of5Padding, interpretiveText, type BarcodeParams } from './barcodes';
import { decodeGraphicColumns, paintBitmap } from './graphics';
import { OUTLINE_FONTS } from './viewerParser';
import { FONT_MAP, FONT_FAMILIES, fontAdvanceDots, fontStack } from '../../constants';
import { paintFixedCellText } from '../fixedCellText';
import { outlineTextBlockWidthDots, getUploadedFontMetrics } from './fontMetrics';

export interface RenderOptions {
    /** Printer resolution - needed to convert outline font points to dots. */
    dpi: number;
    /** Final device pixels per printer dot (includes zoom). */
    pxPerDot: number;
    /** Canvas backing-store scale for sharpness (default 2). */
    quality?: number;
    /**
     * Whole-page rotation preview in quarter-turns CCW (0-3), mirroring the
     * `q` command's value space (PRM p.192: 0=horizontal, 1=90° CCW, …).
     * BarTender applies its stock rotation during page setup, outside the IPL
     * stream, so streams like bartender-tes1 render portrait unless the viewer
     * rotates them here. The label-edge border stays axis-aligned.
     */
    rotation?: number;
}

export interface LabelExtent {
    widthDots: number;
    heightDots: number;
}

/** Visual (post-rotation) bounding box of an element in dots. */
export const elementVisualBox = (
    el: ViewerElement,
    dpi: number,
): { x: number; y: number; w: number; h: number } => {
    // A diagonal's end point is ABSOLUTE, so its box comes from the two points
    // rather than from a length-and-rotation reading. `f` is 0 for it and the
    // switch below must not be applied — the end can lie in any direction.
    if (el.kind === 'diagonal') {
        const x = Math.min(el.ox, el.ex) - el.thicknessDots;
        const y = Math.min(el.oy, el.ey) - el.thicknessDots;
        return {
            x, y,
            w: Math.abs(el.ex - el.ox) + el.thicknessDots * 2,
            h: Math.abs(el.ey - el.oy) + el.thicknessDots * 2,
        };
    }
    const { lengthDots: L, crossDots: C } = estimateElementSize(el, dpi);
    switch (el.f) {
        case 1: return { x: el.ox, y: el.oy - L, w: C, h: L };
        case 2: return { x: el.ox - L, y: el.oy - C, w: L, h: C };
        case 3: return { x: el.ox - C, y: el.oy, w: C, h: L };
        default: return { x: el.ox, y: el.oy, w: L, h: C };
    }
};

/** Overall label extent in dots: <SI>W/L when present, else content bounds. */
export const computeLabelExtent = (label: ViewerLabel, dpi: number): LabelExtent => {
    let w = label.widthDots ?? 0;
    let h = label.heightDots ?? 0;
    for (const el of label.elements) {
        const b = elementVisualBox(el, dpi);
        // Rotated elements may legitimately start left/above their origin.
        w = Math.max(w, b.x + b.w);
        h = Math.max(h, b.y + b.h);
    }
    return {
        widthDots: Math.max(64, Math.ceil(w)),
        heightDots: Math.max(64, Math.ceil(h)),
    };
};

/**
 * Translates the context so field content can be drawn axis-aligned in local
 * coordinates (origin top-left, extending right/down over length x cross).
 * Mirrors the inverse-origin table used by the designer's parser/generator pair.
 */
const applyFieldTransform = (
    ctx: CanvasRenderingContext2D,
    el: ViewerElement,
    dpi: number,
    s: number,
): void => {
    const { lengthDots: L, crossDots: C } = estimateElementSize(el, dpi);
    let vx = el.ox;
    let vy = el.oy;
    let vw = L;
    let vh = C;
    switch (el.f) {
        case 1: vy = el.oy - L; vw = C; vh = L; break;
        case 2: vx = el.ox - L; vy = el.oy - C; break;
        case 3: vx = el.ox - C; vw = C; vh = L; break;
    }
    ctx.translate(vx * s, vy * s);
    switch (el.f) {
        case 1: ctx.translate(0, vh * s); ctx.rotate(-Math.PI / 2); break;
        case 2: ctx.translate(vw * s, vh * s); ctx.rotate(Math.PI); break;
        case 3: ctx.translate(vw * s, 0); ctx.rotate(Math.PI / 2); break;
    }
};

// Font stacks live in constants.ts (single source): Liberation-first so node
// golden renders and the browser resolve the SAME vendored font on every host
// (audit batch 6, golden font portability).

// Font metrics come from the single source of truth in constants.ts (audit T1:
// this module used to carry a hand-copied FONT_META that diverged from the
// designer's table). Unknown fonts fall back to a c0-ish 8x9 cell, 2-dot gap.
const FONT_FALLBACK = { baseHeight: 9, baseWidth: 8, gapWidth: 2 } as const;

/** Estimated unrotated size of an element in dots, used for layout and anchors. */
export const estimateElementSize = (
    el: ViewerElement,
    dpi: number,
): { lengthDots: number; crossDots: number } => {
    switch (el.kind) {
        case 'text': {
            const data = el.source.type === 'fixed' || el.source.type === 'variable' ? el.source.data : '[DATE]';
            let lines = data.split('\n');
            // A BLOCK paragraph lays out inside its box, so its size is the BOX
            // rather than the unwrapped text — measuring the raw characters
            // would report a single long line running off the label.
            if (el.wrapDots !== undefined && el.wrapDots > 0) {
                // The paragraph's size IS its box: the block was laid out to
                // fit width x height, so measuring the unwrapped characters
                // would report one long line running off the label.
                // Line height comes from the same cell metrics the painter
                // uses, so layout and ink agree.
                const wrapMeta = FONT_MAP[el.font] ?? FONT_FALLBACK;
                const wrapGap = el.intercharGapDots ?? wrapMeta.gapWidth ?? 2;
                const advance = ((wrapMeta.baseWidth ?? 7) + wrapGap) * el.wMag;
                const cellH = (wrapMeta.baseHeight ?? 9) * el.hMag;
                const perLine = Math.max(1, Math.floor(el.wrapDots / Math.max(1, advance)));
                const wrapped: string[] = [];
                for (const line of lines) {
                    if (line === '') { wrapped.push(''); continue; }
                    let rest = line;
                    while (rest.length > perLine) {
                        const window = rest.slice(0, perLine + 1);
                        const space = window.lastIndexOf(' ');
                        const cut = space > 0 ? space : perLine;
                        wrapped.push(rest.slice(0, cut));
                        rest = rest.slice(cut).replace(/^ +/, '');
                    }
                    wrapped.push(rest);
                }
                // The line cap CUTS the paragraph, so the box does not grow past
                // it — the same slice the painter applies, or the layout would
                // reserve height for lines that are never drawn.
                const drawn = el.maxLines !== undefined && el.maxLines > 0
                    ? Math.min(wrapped.length, el.maxLines)
                    : wrapped.length;
                const pitch = el.spaceDots !== undefined ? cellH + el.spaceDots : cellH;
                return {
                    lengthDots: Math.max(1, el.wrapDots),
                    crossDots: Math.max(1, el.boxHeightDots ?? drawn * pitch),
                };
            }
            const maxChars = Math.max(1, ...lines.map(l => l.length));
            if (el.pointSize && OUTLINE_FONTS.has(el.font)) {
                const hDots = Math.round((el.pointSize / 72) * dpi);
                // Batch U: per-glyph advance table (fontMetrics.ts) replaces
                // the flat 0.6em — exact for monospace, calibrated for the
                // proportional sans/serif families (c61 Swiss, c28 Dutch).
                // An uploaded face is measured by its OWN table (fontMetrics.ts
                // keeps one per installed font). A resident id resolves through
                // FONT_MAP exactly as before.
                const uploaded = getUploadedFontMetrics(el.font);
                const family = uploaded ? el.font : (FONT_MAP[el.font]?.family ?? 'monospace');
                // `c n,m` adds m dots between characters for outline faces too
                // — "Selects a font type for human-readable and interpretive
                // fields" is not restricted to the bitmap ids, and m is
                // "the space between characters". Added between the n glyphs,
                // never after the last one.
                const gapDots = (el.intercharGapDots ?? 0) * (maxChars - 1);
                return {
                    lengthDots: Math.round(outlineTextBlockWidthDots(lines, hDots, family) + gapDots),
                    crossDots: Math.round(lines.length * hDots * 1.15),
                };
            }
            // Bitmap fonts advance by cell width + intercharacter gap
            // (c0: "7 dots wide by 9 dots high, with a 1-dot gap"; 10 chars of
            // c0 = 79 dots wide — PRM270 p.54). Cell heights from §7.3.
            // `c n,m` replaces the font's own gap for this field.
            const meta = FONT_MAP[el.font] ?? FONT_FALLBACK;
            const gap = el.intercharGapDots ?? meta.gapWidth ?? 2;
            // Pitch (g) replaces the cell metrics with one derived from the
            // label width: n characters per line (PRM p.197).
            if (el.pitchAdvanceDots !== undefined) {
                const cellH = el.pitchAdvanceDots * ((meta.baseHeight ?? 9) / ((meta.baseWidth ?? 7) + gap));
                return {
                    lengthDots: Math.max(0, Math.round(maxChars * el.pitchAdvanceDots)),
                    crossDots: Math.round(cellH * lines.length),
                };
            }
            // Advance = (cell width + gap) × w — spelled out rather than
            // fontAdvanceDots() so an `m` override participates. The last gap
            // is dropped: 10 chars of c0 are 79 dots, not 80.
            const advance = ((meta.baseWidth ?? 7) + gap) * el.wMag;
            return {
                lengthDots: Math.max(0, maxChars * advance - gap * el.wMag),
                crossDots: (meta.baseHeight ?? 9) * el.hMag * lines.length,
            };
        }
        case 'barcode': {
            const data = applyI2of5Padding(
                el.symbology,
                (el.source.type === 'fixed' || el.source.type === 'variable' ? el.source.data : '') ?? '',
            );
            // HRI row height = font 0 at h2: 9-dot cell x2, plus the 2-dot gap.
            const hriExtra = el.hri !== 0 ? 9 * 2 + 2 : 0;
            const measure = data ? measureBarcode(el.symbology, data, barcodeParams(el)) : null;
            if (measure) {
                return {
                    lengthDots: Math.round(measure.widthModules * Math.max(1, el.moduleDots)),
                    crossDots: Math.max(el.heightDots, measure.isMatrix ? measure.heightPx * Math.max(1, el.moduleDots) : 0) + hriExtra,
                };
            }
            const estWidth = Math.max(40, data.length * 11 * el.moduleDots * 0.7);
            return { lengthDots: Math.round(estWidth), crossDots: el.heightDots + hriExtra };
        }
        case 'line': return { lengthDots: el.lengthDots, crossDots: el.thicknessDots };
        case 'reverse': return { lengthDots: el.widthDots, crossDots: el.heightDots };
        case 'ellipse': return { lengthDots: el.widthDots, crossDots: el.heightDots };
        case 'diagonal':
            // The extent of a slanted line is its own bounding box, measured
            // from the start point — the end can lie in any of the four
            // quadrants, so a signed difference is not enough.
            return {
                lengthDots: Math.abs(el.ex - el.ox) + el.thicknessDots,
                crossDots: Math.abs(el.ey - el.oy) + el.thicknessDots,
            };
        case 'box': return { lengthDots: el.widthDots, crossDots: el.heightDots };
        case 'graphic': return { lengthDots: el.widthDots, crossDots: el.heightDots };
        case 'unknown': return { lengthDots: 60, crossDots: 20 };
    }
};

const resolveDisplayData = (source: TextElement['source']): string => {
    if (source.type === 'fixed' || source.type === 'variable') return source.data ?? '';
    // 'master' is resolved to the master's data by the parser before painting
    // (viewerParser.resolveMasterSources); reaching here means an unresolved
    // slave — draw it empty rather than invent a value.
    return '';
};

const drawPlaceholderBox = (
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    label: string,
    sublabel?: string,
): void => {
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#d97706';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(1, 1, Math.max(8, w - 2), Math.max(8, h - 2));
    ctx.setLineDash([]);
    ctx.fillStyle = '#d97706';
    ctx.font = `${Math.min(12, Math.max(8, h / 3))}px sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 4, h / 2 - (sublabel ? 5 : 0));
    if (sublabel) {
        ctx.font = '9px monospace';
        const clipped = sublabel.length > 18 ? `${sublabel.slice(0, 17)}…` : sublabel;
        ctx.fillText(clipped, 4, h / 2 + 7);
    }
    ctx.restore();
};

/** Barcode c-parameter modifiers carried on the element, as the encoder needs them. */
const barcodeParams = (el: BarcodeElement): BarcodeParams => ({
    eanUpcVersion: el.eanUpcVersion,
    code39Mode: el.code39Mode,
    code39Prefix: el.code39Prefix,
    code128StartSubset: el.code128StartSubset,
    code128Ucc: el.code128Ucc,
    code128KeepInterpretive: el.code128KeepInterpretive,
    ratio: el.ratio,
    narrowDots: el.moduleDots,
    qrModel: el.qrModel,
    qrEcl: el.qrEcl,
    qrMask: el.qrMask,
    microColumns: el.microColumns,
    microRows: el.microRows,
    pdfColumns: el.pdfColumns,
    pdfEcLevel: el.pdfEcLevel,
    pdfTruncate: el.pdfTruncate,
    compositeVersion: el.compositeVersion,
    compositeColumns: el.compositeColumns,
    compositeRowHeight: el.compositeRowHeight,
    rssVersion: el.rssVersion,
    rssSepHeight: el.rssSepHeight,
    rssSegments: el.rssSegments,
    maxiMode: el.maxiMode,
    dmVersion: el.dmVersion,
    dmShape: el.dmShape,
    inverse: el.inverse,
    dmCols: el.dmCols,
    dmRows: el.dmRows,
    aztecEcp: el.aztecEcp,
    codablockRowHeight: el.codablockRowHeight,
    codablockModuleWidth: el.codablockModuleWidth,
});

/**
 * Renders a barcode with bwip-js (dot-exact module stretch). Returns false
 * when the data is invalid or the symbology is unsupported, letting the
 * caller draw a placeholder instead.
 */
const drawBarcodeContent = (
    ctx: CanvasRenderingContext2D,
    el: BarcodeElement,
    data: string,
    s: number,
): boolean => {
    if (!data || !buildBwipSpec(el.symbology, data, barcodeParams(el))) return false;
    return paintBarcode(ctx, el.symbology, data, 0, 0, s, el.moduleDots, el.heightDots, barcodeParams(el));
};

const drawElement = (ctx: CanvasRenderingContext2D, el: ViewerElement, opts: RenderOptions): void => {
    const { dpi, pxPerDot: s } = opts;
    ctx.save();
    applyFieldTransform(ctx, el, dpi, s);

    switch (el.kind) {
        case 'text': {
            const meta: { type: 'bitmap' | 'outline'; family?: string; baseHeight?: number; baseWidth?: number; gapWidth?: number }
                = FONT_MAP[el.font] ?? { type: 'outline', family: 'monospace' };
            const data = resolveDisplayData(el.source);
            let lines = (data || '').split('\n');

            let charW: number;
            let lineH: number;
            // A real bitmap face (as opposed to an outline font, or a bitmap id
            // that fell back to the outline path because it carries no cell
            // metrics). Decides whether the printer's fixed cell pitch drives
            // the advance or fillText's own font metrics do.
            const isBitmapFace = meta.type === 'bitmap' && el.pointSize === undefined;
            // For outline fonts the border box must track the per-glyph
            // table too (Batch U) — fillText advances by the real font, and
            // 0.6em mis-sized b>0 borders for proportional families.
            let outlineW: ((line: string) => number) | null = null;
            if (meta.type === 'outline' && el.pointSize) {
                const hPx = (el.pointSize / 72) * dpi * s;
                charW = hPx * 0.6; // fallback for the bitmap-style math below
                lineH = hPx * 1.15;
                // Uploaded face: measure against its own advance table and paint
                // with the family name it was registered under, so the drawn
                // width and the measured width describe the same font.
                const uploaded = getUploadedFontMetrics(el.font);
                const family = uploaded ? el.font : (meta.family ?? 'monospace');
                outlineW = (line: string) => outlineTextBlockWidthDots([line], hPx, family);
                ctx.font = `${hPx}px ${uploaded ? uploaded.cssFamily : fontStack(family)}`;
            } else if (el.pitchAdvanceDots !== undefined) {
                // Pitched field: the advance comes from the label width, and
                // the cell keeps the font's own aspect so a pitched c0 still
                // looks like c0 (PRM p.197 — pitch scales, it does not restyle).
                const gap = meta.gapWidth ?? 2;
                charW = el.pitchAdvanceDots * s;
                const cellH = el.pitchAdvanceDots * ((meta.baseHeight ?? 9) / ((meta.baseWidth ?? 7) + gap)) * s;
                lineH = cellH;
                ctx.font = `${cellH}px ${FONT_FAMILIES.monospace}`;
            } else {
                const cellH = (meta.baseHeight ?? 9) * el.hMag * s;
                // Advance = cell width + intercharacter gap (c0: +1, others +2),
                // both multiplied by w. `c n,m` replaces the font's own gap.
                const gap = el.intercharGapDots ?? meta.gapWidth ?? 2;
                charW = ((meta.baseWidth ?? 7) + gap) * el.wMag * s;
                // Batch V: bitmap fonts are fixed matrix cells — the printer
                // advances exactly cellHeight per line (estimateElementSize
                // already measured lines × cellH × 1.0; drawing at 1.15 made
                // the viewer contradict its own layout math for multi-line
                // bitmap text).
                lineH = cellH;
                ctx.font = `${cellH}px ${FONT_FAMILIES.monospace}`;
            }
            // TSPL BLOCK wraps its paragraph at the box width (manual p. 80).
            // An ordinary TEXT field never does — its content prints exactly as
            // written — so this runs ONLY when the field carries a wrap width.
            // The advance is per character, so the break is a character count.
            if (el.wrapDots !== undefined && el.wrapDots > 0) {
                const perLine = Math.max(1, Math.floor(el.wrapDots / Math.max(1, charW)));
                const wrapped: string[] = [];
                for (const line of lines) {
                    // An explicit line break in the data is honoured; each piece
                    // is then wrapped on its own, so a hard break is not undone.
                    if (line === '') { wrapped.push(''); continue; }
                    let rest = line;
                    while (rest.length > perLine) {
                        // Break at the last space that fits, falling back to a
                        // hard cut when a single word is longer than the box.
                        const window = rest.slice(0, perLine + 1);
                        const space = window.lastIndexOf(' ');
                        const cut = space > 0 ? space : perLine;
                        wrapped.push(rest.slice(0, cut));
                        rest = rest.slice(cut).replace(/^ +/, '');
                    }
                    wrapped.push(rest);
                }
                lines = wrapped.length > 0 ? wrapped : [''];
                // A line limit CUTS the paragraph: the printers drop the
                // continuation rather than overflowing the box, which is what
                // the ^FB probe showed (a 2-line box drew 2 of 6 possible
                // lines). Dropping this would draw text the label will not have.
                if (el.maxLines !== undefined && el.maxLines > 0) {
                    lines = lines.slice(0, el.maxLines);
                }
                // "Add or delete the space between lines (in dots)" — the value
                // is ADDED to the normal line pitch, not a replacement for it.
                // It reads as a replacement, and that is how this was first
                // written; the ZPL oracle settled it by measuring, since ^FB's
                // third parameter is the same idea: raising it by 10 raised the
                // paragraph's ink height by exactly 10 (39 -> 49), and by 30 by
                // exactly 30 (39 -> 69). A replacement would have moved the
                // height by a multiple of no such thing.
                if (el.spaceDots !== undefined) lineH = Math.max(1, lineH + el.spaceDots * s);
            }
            ctx.fillStyle = '#000000';
            ctx.textBaseline = 'top';
            // BLOCK's align (2 centre, 3 right) positions each line inside the
            // box; an ordinary field keeps its own origin, which is why this is
            // applied only when an alignment was asked for.
            const lineX = (line: string): number => {
                if (el.align === undefined || el.wrapDots === undefined) return 0;
                if (el.align === 'center') return Math.max(0, (el.wrapDots - line.length * charW) / 2);
                if (el.align === 'right') return Math.max(0, el.wrapDots - line.length * charW);
                return 0;
            };
            if (el.borderDots && el.borderDots > 0) {
                // Border b (PRM p.167): white letters on a black n-dot surround.
                // The surround must cover the `m` gaps too — measuring the run
                // without them would clip the black box short of the ink.
                const gapPad = (el.intercharGapDots ?? 0) * s;
                const textW = outlineW
                    ? Math.max(...lines.map(outlineW)) + gapPad * (Math.max(1, ...lines.map(l => l.length)) - 1)
                    : Math.max(1, ...lines.map(l => l.length)) * charW;
                const textH = lines.length * lineH;
                ctx.fillRect(-el.borderDots * s, -el.borderDots * s, textW + 2 * el.borderDots * s, textH + 2 * el.borderDots * s);
                ctx.fillStyle = '#ffffff';
            }
            if (el.pitchAdvanceDots !== undefined && el.charRot !== 1) {
                // Pitched field: the advance is the label width divided by the
                // pitch count, NOT the font's own advance — that is the whole
                // point of `gn` ("n characters per line", PRM p.197). Drawn
                // per glyph so the sp one the printer was asked for is the
                // spacing that appears.
                const adv = el.pitchAdvanceDots * s;
                lines.forEach((line, li) => {
                    let cx = 0;
                    for (const ch of line) {
                        ctx.fillText(ch, cx, li * lineH);
                        cx += adv;
                    }
                });
            } else if (el.charRot === 1) {
                // r1 (PRM p.170): each character turns 90° CCW in place while
                // the advance still runs along the field's own axis. That is
                // why the manual pairs it with f3 (its own example, p.40):
                // f3 turns the field, r1 un-turns the glyphs, and the result
                // is a column of upright letters. Advance and line pitch are
                // untouched, so the field box — and every anchor derived from
                // it — is unchanged.
                //
                // The advance is measured from the canvas, exactly as the flat
                // path lets fillText advance, so spacing is identical between
                // r0 and r1. Using the printer's cell pitch here instead would
                // space the turned text differently from the upright text of
                // the same font.
                lines.forEach((line, li) => {
                    let cx = 0;
                    for (const ch of line) {
                        // A pitched field advances by the pitch; otherwise the
                        // advance is measured from the canvas, exactly as the
                        // flat path lets fillText advance, so spacing stays
                        // identical between r0 and r1.
                        const adv = el.pitchAdvanceDots !== undefined
                            ? el.pitchAdvanceDots * s
                            : ctx.measureText(ch).width;
                        ctx.save();
                        ctx.translate(cx + adv / 2, li * lineH + lineH / 2);
                        ctx.rotate(-Math.PI / 2);
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(ch, 0, 0);
                        ctx.restore();
                        cx += adv;
                    }
                });
            } else if (isBitmapFace) {
                // Fixed printer cells, not a host face — see
                // services/fixedCellText.ts for why fillText's own advance is
                // wrong here and what the manual's 79-dot example pins.
                paintFixedCellText(ctx, lines, (meta.baseWidth ?? 7) * el.wMag * s, charW, lineH);
            } else if (outlineW && el.intercharGapDots) {
                // `c n,m` on an outline face: m dots between characters. Drawn
                // per glyph from the same advance table the element's box was
                // measured with, so box and ink stay in step (skipping the
                // override entirely here would be the silent-drop this
                // parameter was reported for).
                const gapPx = el.intercharGapDots * s;
                lines.forEach((line, li) => {
                    let cx = lineX(line);
                    for (const ch of line) {
                        ctx.fillText(ch, cx, li * lineH);
                        cx += outlineW!(ch) + gapPx;
                    }
                });
            } else {
                lines.forEach((line, i) => ctx.fillText(line, lineX(line), i * lineH));
            }
            break;
        }
        case 'barcode': {
            const data = applyI2of5Padding(
                el.symbology,
                (el.source.type === 'fixed' || el.source.type === 'variable' ? el.source.data : '') ?? '',
            );
            // Manual: interpretive prints in the default font (font 0, 7x9
            // standard) at h2/w2, 2 dots below the bar code field, left
            // justified (PRM p.191). i2 places it above instead.
            //
            // "Default" is the operative word. A stream that enables i and then
            // names a font in its interpretive field (In;c5;k30) is asking for
            // something else, and the parser carries that here — the designer
            // importer has always read it. Sizing is the font's own cell height
            // at h2 (the documented default magnification), or k when the field
            // gives a point size, which is how PRM p.189 expresses an outline
            // face.
            const hriMeta = el.hriFont ? FONT_MAP[el.hriFont] : undefined;
            const hriCellH = el.hriPointSize
                ? Math.round((el.hriPointSize / 72) * dpi) * s
                : (hriMeta?.baseHeight ?? 9) * 2 * s;
            const barYPx = el.hri === 2 && data ? hriCellH + 2 * s : 0;
            ctx.save();
            ctx.translate(0, barYPx);
            // An INVERSE symbol (EPL Data Matrix v1) is white-on-black: the
            // printer lays a solid dark block and knocks the light modules out
            // of it. This renderer paints dark modules onto a white sheet and
            // cannot express that here, so the parser reports the difference
            // (epl-dm-inverse) rather than drawing a symbol that is not the one
            // the stream asked for.
            const drawn = drawBarcodeContent(ctx, el, data, s);
            if (!drawn) {
                drawPlaceholderBox(ctx, Math.max(40, data.length * 7 * el.moduleDots * s), el.heightDots * s, 'BARCODE', data || undefined);
            }
            ctx.restore();
            if (el.hri !== 0 && data) {
                // c6 interpretive rules (PRM p.144): UCC-128 without m2=1
                // prints the normalized forced-00 SSCC; otherwise the host
                // data is printed verbatim (parentheses included).
                const interpretive = interpretiveText(el.symbology, data, barcodeParams(el));
                ctx.fillStyle = '#000000';
                ctx.font = `${hriCellH}px ${FONT_FAMILIES.monospace}`;
                ctx.textBaseline = 'top';
                ctx.fillText(interpretive, 0, el.hri === 2 ? 0 : el.heightDots * s + 2 * s);
            }
            break;
        }
        case 'box': {
            const t = Math.max(1, el.thicknessDots * s);
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = t;
            const x = t / 2;
            const y = t / 2;
            const w = Math.max(t, el.widthDots * s - t);
            const h = Math.max(t, el.heightDots * s - t);
            ctx.beginPath();
            const r = el.radiusDots ? Math.min((el.radiusDots * s), w / 2, h / 2) : 0;
            if (r > 0 && typeof (ctx as CanvasRenderingContext2D & { roundRect?: unknown }).roundRect === 'function') {
                (ctx as CanvasRenderingContext2D & { roundRect: (x: number, y: number, w: number, h: number, r: number) => void }).roundRect(x, y, w, h, r);
            } else {
                ctx.rect(x, y, w, h);
            }
            ctx.stroke();
            break;
        }
        case 'line': {
            // EPL's LW is a white line — it ERASES. Painting it white is the
            // whole of the effect: the label is filled white (see the label
            // fill below) and this draws over whatever came before it, in
            // element order, which is the order the printer lays them down.
            ctx.fillStyle = el.white ? '#ffffff' : '#000000';
            ctx.fillRect(0, 0, Math.max(1, el.lengthDots * s), Math.max(1, el.thicknessDots * s));
            break;
        }
        case 'ellipse': {
            // An OUTLINED ellipse: "thickness" strokes the outline rather than
            // filling, so it is a stroke of the given width centred on the
            // path — the same reading as TSPL's BOX, which strokes its border.
            const w = Math.max(1, el.widthDots * s);
            const h = Math.max(1, el.heightDots * s);
            const t = Math.max(1, el.thicknessDots * s);
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = t;
            ctx.beginPath();
            // The bounding box is inset by half the stroke so the outline's
            // OUTER edge lands on the declared width/height, which is what the
            // manual's corner coordinates describe.
            ctx.ellipse(w / 2, h / 2, Math.max(0.5, w / 2 - t / 2), Math.max(0.5, h / 2 - t / 2), 0, 0, Math.PI * 2);
            ctx.stroke();
            break;
        }
        case 'diagonal': {
            // Both ends are absolute, and applyFieldTransform has already
            // translated (and, for an ordinary field, rotated) the context by
            // (ox,oy) — so the end point is drawn RELATIVE to the start.
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = Math.max(1, el.thicknessDots * s);
            ctx.lineCap = 'butt';
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo((el.ex - el.ox) * s, (el.ey - el.oy) * s);
            ctx.stroke();
            // A single point carries no direction, and a zero-length path is
            // invisible in most rasterizers — a dot is what the printer lays.
            if (el.ex === el.ox && el.ey === el.oy) {
                const t = Math.max(1, el.thicknessDots * s);
                ctx.fillStyle = '#000000';
                ctx.fillRect(-t / 2, -t / 2, t, t);
            }
            break;
        }
        case 'reverse': {
            // "This command reverses a region in image buffer" (TSC manual
            // p. 75). Every dot inside flips — white to black and black to
            // white — so this is NOT a white fill: a white fill would leave
            // existing black ink where it is and still claim to have erased it.
            // Painting WHITE would be right only if nothing were under it.
            //
            // The readback runs on the label's own backing pixels. It is the
            // one place in this renderer that reads rather than writes, which
            // is what an invert fundamentally needs.
            // The region is in the field's own frame, but the context carries
            // the field transform (rotation) AND renderLabel's quality scale,
            // so the device rectangle is the bounding box of the four
            // transformed corners — not the local size. Multiplying by `s`
            // alone would miss the quality factor, and using only the
            // translation would miss a rotated field.
            const localW = Math.max(1, el.widthDots * s);
            const localH = Math.max(1, el.heightDots * s);
            const t = ctx.getTransform();
            const corners = [[0, 0], [localW, 0], [localW, localH], [0, localH]]
                .map(([cx, cy]) => [cx * t.a + cy * t.c + t.e, cx * t.b + cy * t.d + t.f]);
            const cw = ctx.canvas.width;
            const ch = ctx.canvas.height;
            // getImageData must stay inside the canvas; a region partly off it
            // is clipped rather than throwing.
            const x0 = Math.min(Math.max(0, Math.floor(Math.min(...corners.map(c => c[0])))), cw);
            const y0 = Math.min(Math.max(0, Math.floor(Math.min(...corners.map(c => c[1])))), ch);
            const x1 = Math.min(Math.max(0, Math.ceil(Math.max(...corners.map(c => c[0])))), cw);
            const y1 = Math.min(Math.max(0, Math.ceil(Math.max(...corners.map(c => c[1])))), ch);
            const w = x1 - x0;
            const h = y1 - y0;
            if (w > 0 && h > 0) {
                const img = ctx.getImageData(x0, y0, w, h);
                const d = img.data;
                for (let i = 0; i < d.length; i += 4) {
                    d[i] = 255 - d[i];
                    d[i + 1] = 255 - d[i + 1];
                    d[i + 2] = 255 - d[i + 2];
                    // Alpha is left alone: the label is an opaque sheet, and
                    // inverting it would make erased areas transparent instead
                    // of white.
                }
                ctx.putImageData(img, x0, y0);
            }
            break;
        }
        case 'graphic': {
            if (el.rows && el.rows.length > 0 && el.widthDots > 0 && el.heightDots > 0) {
                // Row-major 8-bit pixels (ZPL's ^GF). Leftmost dot in the high
                // bit — the oracle put ^GFA,8,8,1,80… at the LEFT edge and 01…
                // at the right, so bit 7 is the first dot.
                const bitmap = el.rows.map((row) =>
                    Array.from({ length: el.widthDots }, (_, x) => {
                        const ch = row.charCodeAt(x >> 3);
                        if (!Number.isFinite(ch)) return 0;
                        return (ch >> (7 - (x & 7))) & 1;
                    }),
                );
                while (bitmap.length < el.heightDots) bitmap.push(new Array(el.widthDots).fill(0));
                paintBitmap(ctx, bitmap, 0, 0, s);
            } else if (el.data && el.data.length > 0 && el.widthDots > 0 && el.heightDots > 0) {
                const bitmap = decodeGraphicColumns(el.widthDots, el.heightDots, el.data);
                paintBitmap(ctx, bitmap, 0, 0, s);
            } else {
                drawPlaceholderBox(
                    ctx,
                    Math.max(20, el.widthDots * s),
                    Math.max(20, el.heightDots * s),
                    `GRAPHIC G${el.graphicId}`,
                    el.name,
                );
            }
            break;
        }
        case 'unknown':
            break;
    }
    ctx.restore();
};

/** Draws a full label onto a canvas sized widthDots x heightDots (in CSS px * quality). */
export const renderLabel = (
    canvas: HTMLCanvasElement,
    label: ViewerLabel,
    extent: LabelExtent,
    opts: RenderOptions,
): void => {
    const quality = opts.quality ?? 2;
    // Quarter-turn preview rotation (viewer control / standalone q). The
    // canvas frame swaps sides for odd quarters; content is drawn through a
    // rotated context so every element keeps its exact dot geometry.
    const rot = ((Math.trunc(opts.rotation ?? 0) % 4) + 4) % 4;
    const swap = rot === 1 || rot === 3;
    const cssW = Math.max(1, (swap ? extent.heightDots : extent.widthDots) * opts.pxPerDot);
    const cssH = Math.max(1, (swap ? extent.widthDots : extent.heightDots) * opts.pxPerDot);

    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * quality);
    canvas.height = Math.round(cssH * quality);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(quality, quality);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.imageSmoothingEnabled = false;

    ctx.save();
    switch (rot) {
        case 1: // 90° CCW: top edge lands on the left
            ctx.translate(0, cssH);
            ctx.rotate(-Math.PI / 2);
            break;
        case 2:
            ctx.translate(cssW, cssH);
            ctx.rotate(Math.PI);
            break;
        case 3: // 270° CCW (= 90° CW): top edge lands on the right
            ctx.translate(cssW, 0);
            ctx.rotate(Math.PI / 2);
            break;
    }
    for (const el of label.elements) {
        drawElement(ctx, el, opts);
    }
    ctx.restore();

    // Hairline border marking the physical label edge
    ctx.strokeStyle = 'rgba(99,102,241,0.55)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, cssW - 1, cssH - 1);
};
