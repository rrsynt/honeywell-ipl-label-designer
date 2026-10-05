import type { BarcodeField, Design, PrinterLanguage, TextField } from '../types';
import { BARCODE_MAP } from '../constants';
import { IPL_UNPRINTABLE_SYMBOLOGIES } from './ipl/barcodes';

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
export const designerOnlyWarnings = (language: PrinterLanguage, design: Design): string[] => {
    const out: string[] = [];
    const shown = design.fields.filter(f => f.visible !== false);

    // A line's arrow head. No language here has an end-cap parameter — IPL `L`
    // is o/f/l/w (PRM p.182), ZPL draws lines as filled `^GB` rectangles, and
    // EPL `LO` / TSPL `BAR` take a length and a thickness.
    const arrows = shown.filter(f => f.type === 'line' && f.lineEnding === 'arrow');
    if (arrows.length > 0) {
        out.push(`${arrows.map(f => `"${f.name}"`).join(', ')}: no printer language has a line end-cap, so the arrow head is drawn on screen but not printed. The line itself prints.`);
    }

    // HRI horizontal placement. TSPL's BARCODE carries it (p4: 1 left, 2
    // centre, 3 right — manual p. 38), so a centre/right align IS printed
    // there. The other three anchor the human-readable line at the start of
    // the bar code: IPL's interpretive field is ALWAYS left justified (PRM
    // p.200 — it has no `o` of its own and cannot be moved), and the ZPL/EPL
    // generators place it at the field's own origin. So on those three a
    // centre or right choice is a preview-only promise.
    if (language !== 'tspl') {
        const misaligned = shown.filter(f =>
            f.type === 'barcode' && f.humanReadable !== 'none'
            && f.hriAlign !== undefined && f.hriAlign !== 'left');
        if (misaligned.length > 0) {
            const one = misaligned.length === 1;
            const where = language === 'ipl' ? 'IPL, ZPL and EPL' : 'this language';
            out.push(`${misaligned.map(f => `"${f.name}"`).join(', ')}: the human-readable line is anchored at the start of the bar code in ${where}, so the alignment set on screen ${one ? 'is' : 'are'} not printed. (TSPL carries it.)`);
        }
    }

    // The point size of the human-readable line. IPL carries it on its
    // interpretive field — the `I` command takes `k n`, which iplGenerator
    // emits (`I1;c21;k10`) — and the canvas draws the size it is given. The
    // other four generators never write it (measured: changing hriFontSize
    // leaves their streams byte-identical, the only difference being the box
    // height it contributes to a 2D symbol), so a size set on screen is not
    // printed there and the line comes out at the printer's own default.
    if (language !== 'ipl') {
        const sized = shown.filter(f =>
            f.type === 'barcode' && (f as BarcodeField).hriFontSize !== undefined && f.humanReadable !== 'none');
        if (sized.length > 0) {
            out.push(`${sized.map(f => `"${f.name}"`).join(', ')}: the human-readable line is sized from the printer's own default in this language, so the size set on screen (${sized[0].type === 'barcode' ? (sized[0] as BarcodeField).hriFontSize : ''}pt) is not printed. (IPL carries it.)`);
        }
    }

    // An intercharacter gap (c n,m). IPL carries it on its text field — the
    // `c` command takes `c n,m`, which iplGenerator emits (`c0,5`) — and the
    // canvas draws the gap between characters. The other four generators
    // (ZPL, EPL, TSPL, DPL) never write it (their text commands have no
    // intercharacter gap parameter), so the spacing set on screen is not
    // printed there and the text comes out at the font's own default spacing.
    if (language !== 'ipl') {
        const gapped = shown.filter(f =>
            f.type === 'text' && (f as TextField).intercharGapDots !== undefined);
        if (gapped.length > 0) {
            const one = gapped.length === 1;
            out.push(`${gapped.map(f => `"${f.name}"`).join(', ')}: intercharacter gap is only supported in IPL (c n,m), so the character spacing set on screen ${one ? 'is' : 'are'} not printed in this language. (IPL carries it.)`);
        }
    }

    // A barcode symbology no IPL printer accepts. The IR's own ids 23-35 name
    // forms other languages carry (TSPL 2D commands, DPL addenda, MSI, Plessey
    // UK, Identcode, Leitcode, Telepen, ITF-14, Telepen Numeric, Japanese
    // Postnet, EAN-14), but IPL's `c` list stops at c22 (PRM p.149, "Values for
    // n"; the widest per-printer range is 0-12, 14-22). The designer dropdown
    // offers every id for every target and generateIPL emits them raw (`c27`),
    // so without this the stream carries a value the printer rejects while the
    // preview draws it. Other languages genuinely carry these ids, so this is
    // IPL-only by design.
    if (language === 'ipl') {
        const unprintable = shown.filter(f =>
            f.type === 'barcode' && IPL_UNPRINTABLE_SYMBOLOGIES.has((f as BarcodeField).symbology));
        if (unprintable.length > 0) {
            const named = unprintable.map(f => {
                const sym = (f as BarcodeField).symbology;
                const label = BARCODE_MAP[sym] ?? `Symbology ${sym}`;
                return `"${f.name}" (${label})`;
            });
            out.push(`${named.join(', ')}: no IPL printer accepts this symbology — the c list stops at c22 (PRM p.149), so the bar code is drawn on screen but not printed. Pick a symbology at or below c22, or export to the language that carries it.`);
        }
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
