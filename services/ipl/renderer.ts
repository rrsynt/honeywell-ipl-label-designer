import type { ViewerLabel, ViewerElement, TextElement, BarcodeElement } from './types';
import { measureBarcode, paintBarcode, buildBwipSpec, applyI2of5Padding, interpretiveText, type BarcodeParams } from './barcodes';
import { decodeGraphicColumns, paintBitmap } from './graphics';
import { OUTLINE_FONTS } from './viewerParser';
import { FONT_MAP, FONT_FAMILIES, fontAdvanceDots, fontStack } from '../../constants';
import { outlineTextBlockWidthDots } from './fontMetrics';

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
            const lines = data.split('\n');
            const maxChars = Math.max(1, ...lines.map(l => l.length));
            if (el.pointSize && OUTLINE_FONTS.has(el.font)) {
                const hDots = Math.round((el.pointSize / 72) * dpi);
                // Batch U: per-glyph advance table (fontMetrics.ts) replaces
                // the flat 0.6em — exact for monospace, calibrated for the
                // proportional sans/serif families (c61 Swiss, c28 Dutch).
                const family = FONT_MAP[el.font]?.family ?? 'monospace';
                return {
                    lengthDots: Math.round(outlineTextBlockWidthDots(lines, hDots, family)),
                    crossDots: Math.round(lines.length * hDots * 1.15),
                };
            }
            // Bitmap fonts advance by cell width + intercharacter gap
            // (c0: "7 dots wide by 9 dots high, with a 1-dot gap"; 10 chars of
            // c0 = 79 dots wide — PRM270 p.54). Cell heights from §7.3.
            const meta = FONT_MAP[el.font] ?? FONT_FALLBACK;
            const gap = meta.gapWidth ?? 2;
            // Pitch (g) replaces the cell metrics with one derived from the
            // label width: n characters per line (PRM p.197).
            if (el.pitchAdvanceDots !== undefined) {
                const cellH = el.pitchAdvanceDots * ((meta.baseHeight ?? 9) / ((meta.baseWidth ?? 7) + gap));
                return {
                    lengthDots: Math.max(0, Math.round(maxChars * el.pitchAdvanceDots)),
                    crossDots: Math.round(cellH * lines.length),
                };
            }
            const advance = fontAdvanceDots(el.font) * el.wMag;
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
    rssVersion: el.rssVersion,
    rssSepHeight: el.rssSepHeight,
    rssSegments: el.rssSegments,
    maxiMode: el.maxiMode,
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
            const lines = (data || '').split('\n');

            let charW: number;
            let lineH: number;
            // For outline fonts the border box must track the per-glyph
            // table too (Batch U) — fillText advances by the real font, and
            // 0.6em mis-sized b>0 borders for proportional families.
            let outlineW: ((line: string) => number) | null = null;
            if (meta.type === 'outline' && el.pointSize) {
                const hPx = (el.pointSize / 72) * dpi * s;
                charW = hPx * 0.6; // fallback for the bitmap-style math below
                lineH = hPx * 1.15;
                const family = meta.family ?? 'monospace';
                outlineW = (line: string) => outlineTextBlockWidthDots([line], hPx, family);
                ctx.font = `${hPx}px ${fontStack(family)}`;
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
                // Advance = cell width + intercharacter gap (c0: +1, others +2).
                charW = fontAdvanceDots(el.font) * el.wMag * s;
                // Batch V: bitmap fonts are fixed matrix cells — the printer
                // advances exactly cellHeight per line (estimateElementSize
                // already measured lines × cellH × 1.0; drawing at 1.15 made
                // the viewer contradict its own layout math for multi-line
                // bitmap text).
                lineH = cellH;
                ctx.font = `${cellH}px ${FONT_FAMILIES.monospace}`;
            }
            ctx.fillStyle = '#000000';
            ctx.textBaseline = 'top';
            if (el.borderDots && el.borderDots > 0) {
                // Border b (PRM p.167): white letters on a black n-dot surround.
                const textW = outlineW
                    ? Math.max(...lines.map(outlineW))
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
            } else {
                lines.forEach((line, i) => ctx.fillText(line, 0, i * lineH));
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
            const hriCellH = 9 * 2 * s;
            const barYPx = el.hri === 2 && data ? hriCellH + 2 * s : 0;
            ctx.save();
            ctx.translate(0, barYPx);
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
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, Math.max(1, el.lengthDots * s), Math.max(1, el.thicknessDots * s));
            break;
        }
        case 'graphic': {
            if (el.data && el.data.length > 0 && el.widthDots > 0 && el.heightDots > 0) {
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
