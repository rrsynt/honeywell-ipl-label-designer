// The Design model -> DPL, following the same shape as the EPL and TSPL
// generators: one record per field, wrapped in <STX>L ... E.
//
// The one thing that makes this generator different from its siblings: DPL
// positions are measured UP from the label's BOTTOM edge, while the designer
// measures DOWN from the top. Every row therefore has to be flipped, and the
// label length the flip needs is the stock height — which the design knows and
// a DPL stream cannot say (see dplParser).

import type { Design, Field, TextField, BarcodeField } from '../../types';
import { DPI_MAP } from '../../constants';
import { getObjectBoundingBox } from '../geometry';
import { resolveLinkedPreview, applyTransform } from '../tableSource';
import { getFormattedDateTime } from '../dateTimeFormat';
import { dplMultiplier } from './dplFonts';
import { DPL_BARCODES } from './dplBarcodes';
import { charsetWarning } from '../charsetRisk';

export interface DplGenerateResult {
    dpl: string;
    warnings: string[];
}

/** Rotation: 1 = 0°, 2 = 90°, 3 = 180°, 4 = 270°, all CLOCKWISE (p. 133). */
const dplRotation = (rotation: number): number => {
    const q = ((Math.round(rotation / 90) % 4) + 4) % 4;
    return ((4 - q) % 4) + 1;
};

/**
 * The DPL bar code letter for an IR symbology, choosing the case by whether a
 * human-readable line is wanted: "Values A through T (uppercase) will print bar
 * codes with human-readable interpretations. Values a through z (lowercase)
 * will print bar codes only" (p. 133).
 */
const DPL_LETTER_FOR: Record<string, { letter: string; wId?: string; name: string }> = {
    '0': { letter: 'A', name: 'Code 39' },
    '2': { letter: 'D', name: 'Interleaved 2 of 5' },
    '4': { letter: 'I', name: 'Codabar' },
    '6': { letter: 'E', name: 'Code 128' },
    '7': { letter: 'B', name: 'UPC-A' },
    '11': { letter: 'P', name: 'Postnet' },
    '12': { letter: 'Z', name: 'PDF417', wId: 'W1Z' },
    '14': { letter: 'U', name: 'UPS MaxiCode' },
    '17': { letter: 'C', name: 'DataMatrix', wId: 'W1C' },
    '18': { letter: 'D', name: 'QR Code', wId: 'W1D' },
    '23': { letter: 'F', name: 'Aztec', wId: 'W1F' },
};

/**
 * DPL's `Wxx` two-character IDs are addressed through the SAME b field that
 * normally holds one letter, so the record header shifts by two characters
 * when one is used — a generator that pads them to one letter would produce a
 * stream the printer reads as a completely different record.
 */
const bFieldFor = (sym: string, hri: boolean): { field: string; warning?: string } | null => {
    const entry = DPL_LETTER_FOR[sym];
    if (!entry) return null;
    if (entry.wId) {
        // "The column labeled..." — the W forms carry their own case rule:
        // W1C (upper C) prints human readable, W1c does not.
        const field = hri ? entry.wId : entry.wId.slice(0, 2) + entry.wId[2].toLowerCase();
        return { field };
    }
    // Postnet, MaxiCode and PDF417 have no human-readable form at all, so the
    // lowercase letter is the ONLY valid spelling; asking for text would give
    // the printer a letter the manual says is invalid.
    const noHri = sym === '11' || sym === '14' || sym === '12';
    const letter = hri && !noHri ? entry.letter : entry.letter.toLowerCase();
    return {
        field: letter,
        ...(hri && noHri
            ? { warning: `DPL's ${entry.name} has no human-readable form, so the line is not printed.` }
            : {}),
    };
};

const fieldData = (field: TextField | BarcodeField, design: Design): string => {
    const ds = field.dataSource;
    if (ds.type === 'fixed') return ds.data;
    if (ds.type === 'variable') return ds.defaultData;
    if (ds.type === 'date' || ds.type === 'time') return getFormattedDateTime(ds.type, ds.format);
    if (ds.type === 'linked') {
        const source = design.dataSources.find(s => s.id === ds.sourceId);
        const resolved = resolveLinkedPreview(source, ds, field.name) ?? '';
        return ds.transform ? applyTransform(ds.transform, resolved, design).result : resolved;
    }
    return '';
};

export const generateDPL = (design: Design): DplGenerateResult => {
    const dpi = design.printerSettings.dpi;
    const dots = (mm: number) => Math.round(mm * DPI_MAP[dpi]);
    const warnings: string[] = [];
    const lines: string[] = [];

    const { width, height, orientation } = design.labelSettings;
    const landscape = orientation === 'landscape';
    // The label LENGTH as the printer sees it: the feed direction.
    const labelLengthDots = dots(landscape ? width : height);

    /**
     * Millimetres from the TOP of the label -> DPL rows counting UP from the
     * bottom, in hundredths of an inch (imperial is DPL's default mode; the
     * generator stays in it so the stream needs no <STX>m).
     */
    const rowFor = (mmFromTop: number): number => {
        const fromBottom = (landscape ? width : height) - mmFromTop;
        return Math.max(0, Math.min(9999, Math.round((fromBottom / 25.4) * 100)));
    };
    const colFor = (mmFromLeft: number): number =>
        Math.max(0, Math.min(9999, Math.round((mmFromLeft / 25.4) * 100)));

    lines.push(`\x02L`);
    // Density and speed are printer commands with the same letters as the
    // label-level ones; D11 is the dot-size multiplier every example uses.
    lines.push(`D11`);

    for (const field of design.fields) {
        const box = getObjectBoundingBox(field, design);
        const row = rowFor(field.y + box.height);
        const col = colFor(field.x);
        const rot = dplRotation(field.rotation);
        const rowStr = String(row).padStart(4, '0');
        const colStr = String(col).padStart(4, '0');

        if (field.type === 'text') {
            const data = fieldData(field, design);
            // Font 9 (smooth/scalable) needs the two extra size fields; the
            // bitmap fonts 0-8 must NOT carry them or the record shifts.
            const smooth = field.fontSize >= 14;
            const b = smooth ? '9' : '2';
            if (smooth) {
                const pts = String(Math.max(4, Math.min(72, Math.round(field.fontSize))));
                lines.push(`${rot}${b}${dplMultiplier(field.w_mag)}${dplMultiplier(field.h_mag)}A${pts.padStart(2, '0')}${rowStr}${colStr}P${pts.padStart(3, '0')}P${pts.padStart(3, '0')}${data}`);
            } else {
                lines.push(`${rot}${b}${dplMultiplier(field.w_mag)}${dplMultiplier(field.h_mag)}000${rowStr}${colStr}${data}`);
            }
            continue;
        }

        if (field.type === 'barcode') {
            const data = fieldData(field, design);
            const wantHri = field.humanReadable !== 'none';
            const bf = bFieldFor(field.symbology, wantHri);
            if (!bf) {
                warnings.push(`"${field.name}" is barcode type ${field.symbology}, which has no DPL equivalent. It was left off the label.`);
                continue;
            }
            if (bf.warning) warnings.push(`"${field.name}": ${bf.warning}`);
            // eee is the symbol height, also in hundredths of an inch.
            const heightUnits = Math.max(1, Math.min(999, Math.round((field.h_mag / dpi / 25.4) * 100 * 100) || 40));
            // c is the wide bar, d the narrow bar; for module-based codes the
            // manual requires them to match.
            const narrow = dplMultiplier(Math.max(1, field.w_mag));
            lines.push(`${rot}${bf.field}${narrow}${narrow}${String(heightUnits).padStart(3, '0')}${rowStr}${colStr}${data}`);
            continue;
        }

        if (field.type === 'box') {
            const w = Math.round((field.width / 25.4) * 100);
            const h = Math.round((field.height / 25.4) * 100);
            const t = Math.max(1, Math.round((field.thickness / 25.4) * 100));
            // "BOX***: Bhhhvvvbbbsss" — width, height, top/bottom thickness,
            // side thickness, all three digits.
            const obj = `B${String(w).padStart(3, '0')}${String(h).padStart(3, '0')}${String(t).padStart(3, '0')}${String(t).padStart(3, '0')}`;
            lines.push(`1X11000${rowStr}${colStr}${obj}`);
            continue;
        }

        if (field.type === 'line') {
            const vertical = field.rotation === 90 || field.rotation === 270;
            const len = Math.round((field.length / 25.4) * 100);
            const th = Math.max(1, Math.round((field.thickness / 25.4) * 100));
            // "LINE*: Lhhhvvv" — a line is a filled box, so one dimension is
            // the thickness.
            const w = vertical ? th : len;
            const h = vertical ? len : th;
            const obj = `L${String(w).padStart(3, '0')}${String(h).padStart(3, '0')}`;
            lines.push(`1X11000${rowStr}${colStr}${obj}`);
            continue;
        }

        warnings.push(`"${field.name}" is a ${field.type}, which DPL output does not support yet. It was left off the label.`);
    }

    // Q is the label count, E terminates and prints (manual pp. 118, 113).
    lines.push(`Q${String(Math.max(1, design.printerSettings.quantity)).padStart(4, '0')}`);
    lines.push('E');

    const charset = charsetWarning(design, 'dpl');
    if (charset) warnings.push(charset);
    return { dpl: lines.join('\r') + '\r', warnings };
};
