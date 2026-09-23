// Batch L (2026-09-21): ready-made label templates. Nobody starts from a
// blank canvas — the gallery (TopBar "Templates") applies one of these
// Designs so a first print is seconds away. Pure data + builders (no DOM),
// every template must produce a valid, in-bounds, id-consistent Design that
// generateIPL accepts — pinned by tests/templates.test.ts.
import type { Design, Field, BarcodeField, TextField, LineField, BoxField, DataSource } from '../types';

export interface LabelTemplate {
    id: string;
    name: string;
    description: string;
    build: () => Design;
}

const printer = (over: Partial<Design['printerSettings']> = {}): Design['printerSettings'] => ({
    model: 'PD43', dpi: 203, quantity: 1, mediaType: 'thermal-transfer',
    mediaSenseMode: 'gap', printSpeed: 6, darkness: 10, ...over,
});

const base = (name: string, width: number, height: number, orientation: 'portrait' | 'landscape' = 'portrait'): Design => ({
    name,
    labelSettings: { width, height, columns: 1, rows: 1, unit: 'mm', orientation },
    printerSettings: printer(),
    fields: [],
    dataSources: [],
    nextId: 1,
    guides: { horizontal: [], vertical: [] },
});

const text = (id: number, name: string, x: number, y: number, dataSource: TextField['dataSource'], fontSize = 12, font = '25'): TextField => ({
    id, type: 'text', name, x, y, rotation: 0, dataSource, font, fontSize, h_mag: 1, w_mag: 1,
});

const barcode = (id: number, name: string, x: number, y: number, dataSource: BarcodeField['dataSource'], symbology: string, h_mag: number, w_mag: number, humanReadable: BarcodeField['humanReadable'] = 'below'): BarcodeField => ({
    id, type: 'barcode', name, x, y, rotation: 0, dataSource, symbology, humanReadable, h_mag, w_mag,
});

const line = (id: number, x: number, y: number, length: number, thickness = 0.5): LineField => ({
    id, type: 'line', name: `Line ${id}`, x, y, rotation: 0, length, thickness,
});

const box = (id: number, x: number, y: number, width: number, height: number, thickness = 0.5): BoxField => ({
    id, type: 'box', name: `Box ${id}`, x, y, rotation: 0, width, height, thickness,
});

const finish = (d: Design): Design => {
    d.nextId = Math.max(0, ...d.fields.map(f => f.id)) + 1;
    return d;
};

export const TEMPLATES: LabelTemplate[] = [
    {
        id: 'blank',
        name: 'Blank label',
        description: 'Empty canvas — the classic "New".',
        build: () => base('Untitled Design', 100, 65),
    },
    {
        id: 'shipping',
        name: 'Shipping 4×6"',
        description: 'Ship-to / from blocks, tracking Code 128, origin box and print date.',
        build: () => {
            const d = base('Shipping Label', 102, 152);
            d.fields = [
                text(1, 'Ship To', 8, 6, { type: 'fixed', data: 'SHIP TO' }, 10),
                text(2, 'Consignee', 8, 13, { type: 'variable', defaultData: 'ACME Corporation' }, 18),
                text(3, 'Address 1', 8, 23, { type: 'variable', defaultData: 'Jl. Industri No. 88' }, 12),
                text(4, 'Address 2', 8, 30, { type: 'variable', defaultData: 'Bekasi 17101, JABAR' }, 12),
                line(5, 8, 40, 86),
                text(6, 'From', 8, 44, { type: 'fixed', data: 'FROM' }, 10),
                text(7, 'Sender', 8, 51, { type: 'variable', defaultData: 'PT Sentosa Abadi' }, 12),
                text(8, 'Sender Addr', 8, 58, { type: 'variable', defaultData: 'Jakarta 12340' }, 10),
                line(9, 8, 66, 86),
                barcode(10, 'Tracking', 8, 72, { type: 'variable', defaultData: '1Z999AA10123456784' }, '6', 80, 2),
                box(11, 8, 92, 86, 24),
                text(12, 'Contents', 12, 96, { type: 'variable', defaultData: '1x spare part' }, 12),
                text(13, 'Weight', 12, 104, { type: 'variable', defaultData: '2.4 kg' }, 12),
                text(14, 'Print Date', 8, 122, { type: 'date', format: 'YYYY/MM/DD' }, 10),
                barcode(15, 'QR route', 78, 116, { type: 'variable', defaultData: 'RT-BKS-088' }, '18', 60, 2, 'none'),
            ];
            return finish(d);
        },
    },
    {
        id: 'price',
        name: 'Price tag 50×25',
        description: 'Product name, big price, EAN-13 barcode.',
        build: () => {
            const d = base('Price Tag', 50, 25);
            // stacked vertically: 16pt price spans ~33mm and would sit on
            // top of a right-side EAN-13 (review HIGH) — one band per row.
            d.fields = [
                text(1, 'Product', 3, 2, { type: 'variable', defaultData: 'Kopi Arabika 250g' }, 9),
                text(2, 'Price', 3, 7, { type: 'variable', defaultData: 'Rp 45.000' }, 14),
                barcode(3, 'EAN', 3, 14, { type: 'variable', defaultData: '4006381333931' }, '7', 40, 2),
            ];
            return finish(d);
        },
    },
    {
        id: 'asset',
        name: 'Asset tag 30×30',
        description: 'QR code with human-readable asset number below.',
        build: () => {
            const d = base('Asset Tag', 30, 30);
            d.fields = [
                // bwip rasterizes QR at 2px/module, and the viewer (golden-
                // locked) stretches each raster px by w — so a v1 QR at w2
                // renders 84 dots ≈ 10.5mm. h_mag matches that real extent
                // (review MEDIUM: 96/63 mismatches left phantom gaps; the
                // fit test measures the viewer pipeline, not my assumption).
                barcode(1, 'Asset QR', 4, 3, { type: 'variable', defaultData: 'AST-2026-0042' }, '18', 84, 2, 'none'),
                text(2, 'Asset No', 4, 15, { type: 'variable', defaultData: 'AST-2026-0042' }, 8),
            ];
            return finish(d);
        },
    },
    {
        id: 'lot',
        name: 'Lot sticker 40×20',
        description: 'Counter-driven lot number (linked data source) as text + Code 128, plus date & time.',
        build: () => {
            const d = base('Lot Sticker', 40, 20);
            // Batch Q: this counter is a real odometer — the generator wraps
            // its print data in <FS>…<FS> + <ESC>I1, so quantity N prints
            // 0001..000N on the PRINTER without a host loop.
            const lot: DataSource = { id: 'tpl-lot', name: 'LotNo', type: 'counter', start: 1, step: 1, padding: 4, serial: true };
            d.dataSources = [lot];
            // Review HIGH: the viewer renders [HH:MM:SS 24hr] (16 chars) for
            // time sources — 8pt at x=26 overflowed the 40mm stock. Worst
            // case now: HH:MM 24hr placeholder (12 chars) at 7pt ends ~38mm.
            d.fields = [
                text(1, 'Lot', 3, 2, { type: 'fixed', data: 'LOT' }, 8),
                text(2, 'LotNo', 9, 2, { type: 'linked', sourceId: lot.id }, 10),
                barcode(3, 'Lot barcode', 9, 7, { type: 'linked', sourceId: lot.id }, '6', 36, 1, 'none'),
                text(4, 'Mfg date', 3, 15, { type: 'date', format: 'YY/MM/DD' }, 7),
                text(5, 'Mfg time', 20, 15, { type: 'time', format: 'HH:MM 24hr' }, 7),
            ];
            return finish(d);
        },
    },
];

export const getTemplate = (id: string): LabelTemplate | undefined =>
    TEMPLATES.find(t => t.id === id);

/** The app's defaultDesign AND the 'blank' template share this factory
 *  (review MEDIUM: two literals drifted risk). */
export const createDefaultDesign = (): Design => getTemplate('blank')!.build();
