// How the designer canvas and the pointer space relate.
//
// The canvas draws a landscape label TURNED a quarter — the same 90° CCW the
// viewer's renderLabel uses for rot 1, because that is what the generator does
// to the stream (<SI>W/<SI>L swap, services/iplGenerator.ts). Every pointer
// interaction therefore needs one of two conversions, and they are NOT each
// other's inverse:
//
//   screenToLabel  — a POINT. A label point (u,v) lands on the canvas at
//                    (v, H-u), so the inverse is u = H - local.y, v = local.x.
//   screenToLabelDelta — a DIRECTION. A label direction (du,dv) lands at
//                    (-dv, du), so the inverse is du = -dy, dv = dx.
//
// Getting these the wrong way round is invisible in portrait (both are the
// identity there) and wrong only on a turned canvas, which is exactly the kind
// of bug that survives a test suite that never sets landscape.

import type { LabelSettings } from '../types';

export const isTurned = (labelSettings: Pick<LabelSettings, 'orientation'>): boolean =>
    labelSettings.orientation === 'landscape';

/** The printed label's size in millimetres: the swap the generator performs. */
export const printedLabelMm = (
    labelSettings: Pick<LabelSettings, 'width' | 'height' | 'orientation'>,
): { widthMm: number; heightMm: number } => isTurned(labelSettings)
    ? { widthMm: labelSettings.height, heightMm: labelSettings.width }
    : { widthMm: labelSettings.width, heightMm: labelSettings.height };

/**
 * A point in the panned canvas, expressed in the label's own unrotated frame
 * with the label's top-left as the origin. `heightPx` is the turned label's
 * height on the canvas — the `H` of the transform, not the stock's height.
 */
export const screenToLabel = (
    point: { x: number; y: number },
    pan: { x: number; y: number },
    turned: boolean,
    heightPx: number,
): { x: number; y: number } => {
    const local = { x: point.x - pan.x, y: point.y - pan.y };
    return turned ? { x: heightPx - local.y, y: local.x } : local;
};

/**
 * A drag direction in canvas pixels, expressed along the label's own axes. The
 * label-to-canvas map for a direction drops the translation, so this is a plain
 * quarter turn the other way.
 */
export const screenToLabelDelta = (
    delta: { x: number; y: number },
    turned: boolean,
): { x: number; y: number } => turned ? { x: -delta.y, y: delta.x } : delta;

/**
 * The FORWARD direction: a label-frame point (plus the pan) as canvas pixels.
 * A rotation pivot lives in the label's own frame and has to be put through
 * this before it is compared with pointer positions — using the un-turned
 * value leaves the pivot off by up to the label's height, and a rotation drag
 * then measures its angle about the wrong point.
 */
export const labelToScreen = (
    point: { x: number; y: number },
    pan: { x: number; y: number },
    turned: boolean,
    heightPx: number,
): { x: number; y: number } => {
    // The pan is the OUTERMOST transform — the canvas translates the scene
    // first and only then rotates the label's content — so it is added after
    // the turn, not folded into the point before it.
    if (!turned) return { x: point.x + pan.x, y: point.y + pan.y };
    return { x: pan.x + point.y, y: pan.y + heightPx - point.x };
};
