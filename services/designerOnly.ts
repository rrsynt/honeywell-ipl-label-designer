import type { Design, PrinterLanguage } from '../types';

/**
 * Properties the DESIGNER draws but no printer language can carry. The screen
 * honours them, so the design looks like it prints that way — and the exporter
 * runs through the same generator as the Code panel, so an exported image loses
 * them too. Naming the field is the difference between "not supported" and
 * "silently missing".
 *
 * Each entry states only what is true of EVERY target language. Where one
 * language can carry the property and another cannot, the generator that CAN
 * is the one that reports it — EPL and TSPL already warn for themselves when
 * the human-readable line is asked to print above (they can only print it
 * below), so that case is deliberately absent here rather than duplicated.
 */
export const designerOnlyWarnings = (_language: PrinterLanguage, design: Design): string[] => {
    const out: string[] = [];
    const shown = design.fields.filter(f => f.visible !== false);

    // A line's arrow head. No language here has an end-cap parameter — IPL `L`
    // is o/f/l/w (PRM p.182), ZPL draws lines as filled `^GB` rectangles, and
    // EPL `LO` / TSPL `BAR` take a length and a thickness.
    const arrows = shown.filter(f => f.type === 'line' && f.lineEnding === 'arrow');
    if (arrows.length > 0) {
        out.push(`${arrows.map(f => `"${f.name}"`).join(', ')}: no printer language has a line end-cap, so the arrow head is drawn on screen but not printed. The line itself prints.`);
    }

    // HRI horizontal placement. Every language anchors the human-readable line
    // at the start of the bar code: IPL's interpretive field is ALWAYS left
    // justified (PRM p.200 — it has no `o` of its own and cannot be moved), and
    // the ZPL/EPL/TSPL generators each place it at the field's own origin. So a
    // centre or right choice is a preview-only promise on all four targets.
    const misaligned = shown.filter(f =>
        f.type === 'barcode' && f.humanReadable !== 'none'
        && f.hriAlign !== undefined && f.hriAlign !== 'left');
    if (misaligned.length > 0) {
        const one = misaligned.length === 1;
        out.push(`${misaligned.map(f => `"${f.name}"`).join(', ')}: the human-readable line is anchored at the start of the bar code in every supported printer language, so the alignment set on screen ${one ? 'is' : 'are'} not printed.`);
    }

    // Multi-up stock (Grid Columns / Rows). No supported language has a
    // ganging command: IPL's only width control is <SI>W, which "sets the LABEL
    // width" (PRM p.131) — one label per feed, sized by that number of dots. So
    // every generator prints the full declared width as ONE label and the grid
    // never reaches the printer. The canvas draws the same full label for the
    // same reason: dividing it here used to shrink the stock to one cell and
    // then clip away any field outside that cell, so the screen hid ink the
    // printer would print.
    const { columns, rows } = design.labelSettings;
    const cols = Math.max(1, Math.floor(columns || 1));
    const rws = Math.max(1, Math.floor(rows || 1));
    if (cols > 1 || rws > 1) {
        out.push(`the label stock is set to ${cols}x${rws} (multi-up), but no supported printer language has a ganging command — the whole ${design.labelSettings.width}x${design.labelSettings.height}mm is printed as ONE label. Set Grid Columns and Rows to 1 unless the stock really is that size.`);
    }

    return out;
};
