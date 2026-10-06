// NOW-1 (2026-10-06): stock presets for the New-Label dialog. Every entry point
// that starts a design (TopBar New, StartScreen, Templates) used to converge on
// one hardcoded 100x65 stock (templates.ts:56), so an operator could never start
// from the right size. These presets carry BarTender-like names plus the full
// LabelSettings/PrinterSettings they imply; buildStockDesign turns a selection
// into a real Design whose width/height/dpi flow to all five generators through
// the existing labelSettings path (no new state shape, no UI-only size).
import type { Design } from '../types';
import { DPI_MAP, PRINTABLE_WIDTH_IN, UNPRINTABLE_MARGIN_MM } from '../constants';
import { getTemplate } from './templates';

export type StockCategory = 'roll' | 'sheet' | 'receipt';

export interface StockPreset {
    id: string;
    name: string;
    description: string;
    category: StockCategory;
    widthMm: number;
    heightMm: number;
    orientation: 'portrait' | 'landscape';
    model: string;
    dpi: 203 | 300 | 406;
    columns: number;
    rows: number;
}

export const STOCK_PRESETS: StockPreset[] = [
    { id: 'shipping-4x6', name: 'Shipping 4×6"', description: 'Ship-to/from blocks, tracking barcode. The warehouse default.', category: 'roll', widthMm: 102, heightMm: 152, orientation: 'portrait', model: 'PD43', dpi: 203, columns: 1, rows: 1 },
    { id: 'shipping-100x150', name: 'Shipping 100×150', description: 'Metric 4×6" class shipping label.', category: 'roll', widthMm: 100, heightMm: 150, orientation: 'portrait', model: 'PD43', dpi: 203, columns: 1, rows: 1 },
    { id: 'box-4x3', name: 'Box 4×3"', description: 'Outer-box label, landscape.', category: 'roll', widthMm: 102, heightMm: 76, orientation: 'landscape', model: 'PD43', dpi: 203, columns: 1, rows: 1 },
    { id: 'small-3x2', name: 'Small 3×2"', description: 'Bin and shelf label.', category: 'roll', widthMm: 76, heightMm: 51, orientation: 'landscape', model: 'PD43', dpi: 203, columns: 1, rows: 1 },
    { id: 'price-50x30', name: 'Price 50×30', description: 'Retail price tag with EAN-13.', category: 'roll', widthMm: 50, heightMm: 30, orientation: 'landscape', model: 'PD43', dpi: 203, columns: 1, rows: 1 },
    { id: 'price-50x25', name: 'Price 50×25', description: 'Compact price tag.', category: 'roll', widthMm: 50, heightMm: 25, orientation: 'landscape', model: 'PD43', dpi: 203, columns: 1, rows: 1 },
    { id: 'retail-38x25', name: 'Retail 38×25', description: 'Small product label.', category: 'roll', widthMm: 38, heightMm: 25, orientation: 'landscape', model: 'PD43', dpi: 203, columns: 1, rows: 1 },
    { id: 'lab-30x20', name: 'Lab 30×20', description: 'Vial and sample sticker.', category: 'roll', widthMm: 30, heightMm: 20, orientation: 'landscape', model: 'PD43', dpi: 203, columns: 1, rows: 1 },
    { id: 'jewellery-25x15', name: 'Jewellery 25×15', description: 'Rat-tail asset tag.', category: 'roll', widthMm: 25, heightMm: 15, orientation: 'landscape', model: 'PD43', dpi: 203, columns: 1, rows: 1 },
    { id: 'square-50x50', name: 'Square 50×50', description: 'QR asset and seal label.', category: 'roll', widthMm: 50, heightMm: 50, orientation: 'portrait', model: 'PD43', dpi: 203, columns: 1, rows: 1 },
    { id: 'square-76x76', name: 'Square 76×76', description: 'Large seal and drum label.', category: 'roll', widthMm: 76, heightMm: 76, orientation: 'portrait', model: 'PD43', dpi: 203, columns: 1, rows: 1 },
    { id: 'receipt-80mm', name: 'Receipt 80mm', description: 'Continuous receipt stock. Trim the length on the printer.', category: 'receipt', widthMm: 80, heightMm: 150, orientation: 'portrait', model: 'PD43', dpi: 203, columns: 1, rows: 1 },
    { id: 'sheet-a4-3x8', name: 'Sheet A4 3×8', description: 'Laser sheet, 3 columns by 8 rows.', category: 'sheet', widthMm: 210, heightMm: 297, orientation: 'portrait', model: 'Generic', dpi: 300, columns: 3, rows: 8 },
];

export const getStockPreset = (id: string): StockPreset | undefined =>
    STOCK_PRESETS.find(p => p.id === id);

/** Millimetres to printer dots at a dpi. Uses the same rounded dots-per-mm
 *  table every generator uses (DPI_MAP: 8 / 11.8 / 16), not the exact
 *  dpi/25.4 — a second rounding here would show the dialog preview one dot off
 *  from what the stream actually carries (measured: 102mm @203dpi = 816 on the
 *  wire, 815 exact). Dots are integers on the wire. */
export const dotsFor = (mm: number, dpi: number): number => {
    const table = DPI_MAP[dpi as 203 | 300 | 406];
    const perMm = table ?? dpi / 25.4;
    return Math.max(1, Math.round(mm * perMm));
};

/** Largest sane single dimension: a roll wider than a metre is a typo, and a
 *  sheet bigger than A3 does not fit the sheet path. */
export const MAX_STOCK_MM = 1000;

export interface StockValidation {
    errors: string[];
    warnings: string[];
}

/** Human-readable verdict for a WxH stock on a model/dpi. Errors block Create;
 *  warnings create anyway. Never throws: NaN and unknown models are verdicts. */
export const validateStock = (widthMm: number, heightMm: number, model: string, dpi: number): StockValidation => {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!Number.isFinite(widthMm) || widthMm <= 0) errors.push('Width must be a number above 0.');
    if (!Number.isFinite(heightMm) || heightMm <= 0) errors.push('Height must be a number above 0.');
    if (widthMm > MAX_STOCK_MM) errors.push(`Width ${widthMm} mm is larger than ${MAX_STOCK_MM} mm — check the unit switcher (mm / inch / dots).`);
    if (heightMm > MAX_STOCK_MM) errors.push(`Height ${heightMm} mm is larger than ${MAX_STOCK_MM} mm — check the unit switcher (mm / inch / dots).`);
    if (errors.length > 0) return { errors, warnings };
    const margin = UNPRINTABLE_MARGIN_MM[model] ?? 0;
    if (margin > 0 && widthMm < margin * 2) {
        warnings.push(`${model} cannot reach ${margin} mm on each print-head edge — this stock is narrower than the unprintable band.`);
    }
    const printableIn = PRINTABLE_WIDTH_IN[model]?.[dpi as 203 | 300 | 406];
    if (printableIn !== undefined && widthMm / 25.4 > printableIn) {
        warnings.push(`Wider than the ${model} printable width (${printableIn.toFixed(2)} in at ${dpi} dpi) — the edges may clip.`);
    }
    return { errors, warnings };
};

export interface StockSelection {
    name: string;
    widthMm: number;
    heightMm: number;
    orientation: 'portrait' | 'landscape';
    model: string;
    dpi: 203 | 300 | 406;
    columns: number;
    rows: number;
}

/** A fresh blank canvas on the chosen stock. Built from the shared blank
 *  template so printer/label defaults cannot drift from it. */
export const buildStockDesign = (sel: StockSelection): Design => {
    const d = getTemplate('blank')!.build();
    d.name = sel.name;
    d.labelSettings = {
        width: sel.widthMm,
        height: sel.heightMm,
        columns: Math.max(1, Math.floor(sel.columns || 1)),
        rows: Math.max(1, Math.floor(sel.rows || 1)),
        unit: 'mm',
        orientation: sel.orientation,
    };
    d.printerSettings = { ...d.printerSettings, model: sel.model, dpi: sel.dpi };
    return d;
};
