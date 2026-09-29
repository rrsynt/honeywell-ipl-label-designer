import type { LabelSettings } from '../types';

/**
 * The label's printed size, in millimetres.
 *
 * This is a PASS-THROUGH of the settings. It exists as a named seam because the
 * app once treated `orientation: 'landscape'` as a request to turn the stock a
 * quarter — transposing `<SI>W`/`<SI>L`, every field origin and every rotation,
 * and turning the designer canvas to match. That was wrong: a landscape stock
 * is simply one whose width exceeds its length, and the driver leaves the
 * coordinates alone. Verified against a `btLandscape` page the driver itself
 * produced (samples/bartender-sweep-one-box-landscape.ipl, fixture in
 * tools/bartender/BuildParityLabels.cs:228): a box authored 0.6 in from the
 * page's LEFT edge prints there, and the stream declares W388 for a 96x48 mm
 * stock — the width as written, with nothing transposed.
 *
 * So orientation is DESCRIPTIVE today, and this function is the single place
 * that decision is recorded. If a "turn the stock" feature is ever wanted, it
 * belongs here, and every caller of this function inherits it.
 */
export const printedLabelMm = (
    labelSettings: Pick<LabelSettings, 'width' | 'height'>,
): { widthMm: number; heightMm: number } => ({
    widthMm: labelSettings.width,
    heightMm: labelSettings.height,
});
