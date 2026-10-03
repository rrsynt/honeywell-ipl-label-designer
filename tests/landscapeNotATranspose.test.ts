// Landscape is DESCRIPTIVE: a stock whose width exceeds its length, not a
// quarter turn. The canvas, IPL generator, sheet preview and importer all read
// it that way (services/stockFrame.ts records the decision; `ad26d1e` removed
// the transpose from IPL). ZPL, EPL, TSPL and DPL still swapped the label size
// for a landscape stock, so a design authored 96x48 printed a 48x96 label while
// every field stayed in the 96-wide coordinate frame — a field drawn near the
// right edge (x=90mm) landed OFF the declared label.
//
// The driver's own `btLandscape` fixture (samples/bartender-sweep-one-box-
// landscape.ipl) declares W388 for a 96x48 mm stock and prints the box where it
// was authored — no transpose. Each generator below must now declare the stock
// width and length exactly as written.
import { describe, expect, it } from 'vitest';
import type { Design, Field } from '../types';
import { generateZPL } from '../services/zpl/zplGenerator';
import { generateEPL } from '../services/epl/eplGenerator';
import { generateTSPL } from '../services/tspl/tsplGenerator';
import { generateDPL } from '../services/dpl/dplGenerator';

// 96 wide x 48 tall, landscape. 203 dpi -> 8 dots/mm: 768 x 384.
const landscape = (fields: Field[]): Design => ({
    name: 'T',
    labelSettings: { width: 96, height: 48, columns: 1, rows: 1, unit: 'mm', orientation: 'landscape' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'thermal-transfer', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields, dataSources: [], nextId: 9, guides: { horizontal: [], vertical: [] },
});

// A text field near the RIGHT edge of the 96mm span — off the label entirely if
// the stock is turned to 48 wide.
const rightEdge: Field = {
    id: 1, type: 'text', name: 'T1', x: 90, y: 10, rotation: 0,
    dataSource: { type: 'fixed', data: 'ABC' }, font: '0', fontSize: 12, h_mag: 2, w_mag: 1,
};

describe('a landscape stock is declared as written, not transposed', () => {
    it('ZPL: ^PW is the width, ^LL the length', () => {
        const { zpl } = generateZPL(landscape([]));
        expect(zpl).toContain('^PW768');
        expect(zpl).toContain('^LL384');
    });

    it('EPL: q is the width, Q the length', () => {
        const { epl } = generateEPL(landscape([]));
        expect(epl).toContain('q768');
        expect(epl).toContain('Q384');
    });

    it('TSPL: SIZE is width,length as written', () => {
        const { tspl } = generateTSPL(landscape([]));
        expect(tspl).toContain('SIZE 96 mm,48 mm');
    });

    it('DPL: the row flip counts from the declared length', () => {
        // A field at y=10mm on a 48mm-tall stock sits 35.75mm above the bottom
        // edge (48 - 10 - the 2.25mm text box) = 1.41in = row 0141. Under the
        // old transpose the length came from the WIDTH (96mm), which would put
        // the same field at 0330. Assert the row outright so a transpose cannot
        // pass by making landscape and portrait agree on the wrong number.
        const dpl = generateDPL(landscape([rightEdge])).dpl;
        const row = /^1[0-9]{6}(\d{4})/m.exec(dpl)?.[1];
        expect(row).toBe('0141');
    });

    it('a field near the right edge stays inside the declared stock', () => {
        // 90mm at 8 dots/mm = 720 dots, inside the 768-dot (96mm) width.
        const zpl = generateZPL(landscape([rightEdge])).zpl;
        const x = Number(/\^FO(\d+),/.exec(zpl)?.[1]);
        expect(x).toBe(720);
        // The width it must fit within:
        const pw = Number(/\^PW(\d+)/.exec(zpl)?.[1]);
        expect(x).toBeLessThan(pw);
    });
});