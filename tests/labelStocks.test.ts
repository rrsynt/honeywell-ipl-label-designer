// NOW-1 (2026-10-06): the New-Label dialog's stock presets must be real
// designs, not UI-only sizes — every preset (and a custom stock) has to flow
// through labelSettings/printerSettings into all five generators with the
// right extent and zero errors, or D1 is paint over the old 100x65 default.
import './golden/setup';
import { describe, it, expect, beforeAll } from 'vitest';
import { STOCK_PRESETS, buildStockDesign, validateStock, dotsFor, getStockPreset } from '../services/labelStocks';
import { generateIPL } from '../services/iplGenerator';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { generateZPL } from '../services/zpl/zplGenerator';
import { generateEPL } from '../services/epl/eplGenerator';
import { generateTSPL } from '../services/tspl/tsplGenerator';
import { generateDPL } from '../services/dpl/dplGenerator';
import { ensureBarcodesReady } from '../services/ipl/barcodes';

beforeAll(async () => { await ensureBarcodesReady(); });

// An empty canvas generates a field-less stream the viewer honestly reports as
// `no-fields` — that is correct behaviour, not a stock bug, so every
// generate/parse assertion below works on a one-text design instead.
import type { Design } from '../types';
const stocked = (sel: Parameters<typeof buildStockDesign>[0]): Design => {
    const d = buildStockDesign(sel);
    d.fields = [{
        id: 1, type: 'text', name: 'T', x: 2, y: 2, rotation: 0,
        dataSource: { type: 'fixed', data: 'Hi' }, font: '0', fontSize: 12, h_mag: 1, w_mag: 1,
    } as never];
    d.nextId = 2;
    return d;
};

describe('stock preset registry', () => {
    it('carries at least the D1 range: roll + sheet + receipt, metric + imperial', () => {
        expect(STOCK_PRESETS.length).toBeGreaterThanOrEqual(10);
        const cats = new Set(STOCK_PRESETS.map(p => p.category));
        expect(cats.has('roll')).toBe(true);
        expect(cats.has('sheet')).toBe(true);
        expect(getStockPreset('shipping-4x6')?.widthMm).toBe(102);
        expect(getStockPreset('shipping-4x6')?.heightMm).toBe(152);
        const ids = STOCK_PRESETS.map(p => p.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('dotsFor matches the generators dots-per-mm table', () => {
        // DPI_MAP rounds 203dpi to 8 dots/mm, so 102mm = 816 on the wire —
        // the exact dpi/25.4 conversion (815.4) would show the dialog preview
        // one dot off from the stream. Same table, same dots.
        expect(dotsFor(102, 203)).toBe(816);
        expect(dotsFor(152, 203)).toBe(1216);
        expect(dotsFor(102, 300)).toBe(Math.round(102 * 11.8));
    });

    it('validateStock blocks nonsense and warns on unprintable widths', () => {
        expect(validateStock(0, 50, 'PD43', 203).errors.length).toBeGreaterThan(0);
        expect(validateStock(NaN, 50, 'PD43', 203).errors.length).toBeGreaterThan(0);
        expect(validateStock(2000, 50, 'PD43', 203).errors.join(' ')).toMatch(/unit/);
        expect(validateStock(102, 152, 'PD43', 203).errors).toEqual([]);
        // 25mm stock on a PD41 (3mm unprintable per edge) still creates, but warns.
        const narrow = validateStock(5, 20, 'PD41', 203);
        expect(narrow.errors).toEqual([]);
        expect(narrow.warnings.join(' ').toLowerCase()).toMatch(/unprintable|edge/);
    });
});

describe('every preset builds a design the generators accept', () => {
    for (const p of STOCK_PRESETS) {
        it(`${p.id}: labelSettings + printerSettings land on the design`, () => {
            const d = buildStockDesign({
                name: p.name, widthMm: p.widthMm, heightMm: p.heightMm,
                orientation: p.orientation, model: p.model, dpi: p.dpi,
                columns: p.columns, rows: p.rows,
            });
            expect(d.labelSettings.width).toBe(p.widthMm);
            expect(d.labelSettings.height).toBe(p.heightMm);
            expect(d.labelSettings.orientation).toBe(p.orientation);
            expect(d.printerSettings.model).toBe(p.model);
            expect(d.printerSettings.dpi).toBe(p.dpi);
            expect(d.fields).toEqual([]);
        });

        it(`${p.id}: IPL generates and parses with zero errors`, async () => {
            const d = stocked({
                name: p.name, widthMm: p.widthMm, heightMm: p.heightMm,
                orientation: p.orientation, model: p.model, dpi: p.dpi,
                columns: p.columns, rows: p.rows,
            });
            const ipl = await generateIPL(d);
            const label = parseViewerIPL(ipl);
            expect(label.issues.filter(i => i.level === 'error')).toEqual([]);
        });

        it(`${p.id}: ZPL carries the stock as ^PW/^LL in dots`, () => {
            const d = buildStockDesign({
                name: p.name, widthMm: p.widthMm, heightMm: p.heightMm,
                orientation: p.orientation, model: 'PD43', dpi: 203,
                columns: p.columns, rows: p.rows,
            });
            const { zpl } = generateZPL(d);
            expect(zpl).toContain(`^PW${dotsFor(p.widthMm, 203)}`);
            expect(zpl).toContain(`^LL${dotsFor(p.heightMm, 203)}`);
        });

        it(`${p.id}: EPL/TSPL/DPL generate without throwing`, () => {
            const d = buildStockDesign({
                name: p.name, widthMm: p.widthMm, heightMm: p.heightMm,
                orientation: p.orientation, model: p.model, dpi: p.dpi,
                columns: p.columns, rows: p.rows,
            });
            expect(() => generateEPL(d)).not.toThrow();
            expect(() => generateTSPL(d)).not.toThrow();
            expect(() => generateDPL(d)).not.toThrow();
        });
    }

    it('a custom 38x25 stock lands on the canvas size and the wire size', async () => {
        const d = stocked({
            name: 'Custom', widthMm: 38, heightMm: 25, orientation: 'landscape',
            model: 'PD43', dpi: 203, columns: 1, rows: 1,
        });
        expect(d.labelSettings.width).toBe(38);
        expect(d.labelSettings.height).toBe(25);
        const { zpl } = generateZPL(d);
        expect(zpl).toContain(`^PW${dotsFor(38, 203)}`);
        expect(zpl).toContain(`^LL${dotsFor(25, 203)}`);
        const ipl = await generateIPL(d);
        expect(parseViewerIPL(ipl).issues.filter(i => i.level === 'error')).toEqual([]);
    });
});

describe('QW-WARN: ZPL names the dropped host-verify instead of going silent', () => {
    it('warns on host-verifies while still emitting e=N', async () => {
        const { parseZPL } = await import('../services/zpl/zplParser');
        const d = buildStockDesign({
            name: 'T', widthMm: 100, heightMm: 50, orientation: 'portrait',
            model: 'PD43', dpi: 203, columns: 1, rows: 1,
        });
        d.fields = [{
            id: 1, type: 'barcode', name: 'B', x: 10, y: 10, rotation: 0,
            dataSource: { type: 'fixed', data: 'ABC123' }, symbology: '0',
            humanReadable: 'none', h_mag: 50, w_mag: 2, code39_checkDigit: 'host-verifies',
        } as never];
        d.nextId = 2;
        const { zpl, warnings } = generateZPL(d);
        expect(warnings.some(w => w.includes('"B"') && w.toLowerCase().includes('host-verify'))).toBe(true);
        expect(zpl).toContain('^B3N,N,');
        // And the stream still parses — the warning changed nothing on the wire.
        expect(parseZPL(zpl).issues.filter(i => i.level === 'error')).toEqual([]);
    });
});
