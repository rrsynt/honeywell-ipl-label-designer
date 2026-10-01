// The field type × language matrix: the invariant that caught the whole
// generator↔parser asymmetry family (see the `image` chain: ebcc63c, 5d8c2d4,
// 332c63f, 1f1c5d0, c17263f).
//
// A field a language cannot express must be NAMED in the warnings. A field
// that leaves the label with neither a command NOR a warning is a SILENT DROP
// — the failure mode this project exists to prevent ("user waits wondering if
// the open worked"). This test walks every field type through every language
// and fails if any cell is silently empty.
//
// It also pins the EXPECTED support boundary, so a language quietly gaining or
// losing a shape fails loudly rather than passing because the invariant alone
// cannot tell "warned" from "used to draw it".

import './golden/setup';
import { describe, it, expect, beforeAll } from 'vitest';
import { generateIPL } from '../services/iplGenerator';
import { generateZPL } from '../services/zpl/zplGenerator';
import { generateEPL } from '../services/epl/eplGenerator';
import { generateTSPL } from '../services/tspl/tsplGenerator';
import { generateDPL } from '../services/dpl/dplGenerator';
import { ensureBarcodesReady } from '../services/ipl/barcodes';
import type { Design, Field } from '../types';

beforeAll(async () => { await ensureBarcodesReady(); });

const design = (fields: Field[]): Design => ({
    name: 'Matrix',
    labelSettings: { width: 80, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields, dataSources: [], nextId: 20, guides: { horizontal: [], vertical: [] },
});

const mk = (o: Record<string, unknown>) => ({ id: 1, name: 'F', x: 10, y: 10, rotation: 0, ...o }) as unknown as Field;
const FIELD_TYPES: [string, Field][] = [
    ['text', mk({ type: 'text', font: '2', fontSize: 12, h_mag: 2, w_mag: 2, dataSource: { type: 'fixed', data: 'Hi' } })],
    ['barcode', mk({ type: 'barcode', y: 20, symbology: '0', humanReadable: 'below', h_mag: 60, w_mag: 2, dataSource: { type: 'fixed', data: 'ABC123' } })],
    ['line', mk({ type: 'line', y: 30, length: 30, thickness: 0.5 })],
    ['box', mk({ type: 'box', y: 35, width: 20, height: 10, thickness: 0.5 })],
    ['ellipse', mk({ type: 'ellipse', x: 40, width: 20, height: 20, thickness: 1 })],
    ['polygon', mk({ type: 'polygon', x: 40, y: 25, width: 20, height: 20, sides: 6, radius: 10, thickness: 1 })],
    ['triangle', mk({ type: 'triangle', x: 60, y: 25, width: 20, height: 20, thickness: 1 })],
    ['image', mk({ type: 'image', x: 60, threshold: 128, bitmap: ['10000000', '11000000', '11100000', '11110000'], width: 8 / (203 / 25.4), height: 4 / (203 / 25.4) })],
];

// Which field types each language DRAWS (vs names in a warning). Pinned so a
// silent loss fails here. `image` is drawn by the parser in all five, but the
// GENERATORS emit it only where the language has an ASCII hex form (IPL g1,
// DPL I F, ZPL ^GF) and NAME it where the command is raw-binary-only (EPL GW,
// TSPL BITMAP) — see the commits named at the top of this file.
const DRAWS: Record<string, string[]> = {
    IPL: ['text', 'barcode', 'line', 'box', 'ellipse', 'polygon', 'triangle', 'image'],
    ZPL: ['text', 'barcode', 'line', 'box', 'ellipse', 'image'],
    EPL: ['text', 'barcode', 'line', 'box'],
    TSPL: ['text', 'barcode', 'line', 'box', 'ellipse'],
    DPL: ['text', 'barcode', 'line', 'box', 'ellipse', 'polygon', 'triangle', 'image'],
};

/** Every generator as a (stream, warnings) pair. IPL has no warning channel —
 *  it draws everything, so a miss there is a throw, not a warning. */
const GENERATORS: Record<string, (d: Design) => Promise<{ stream: string; warnings: string[] }>> = {
    IPL: async (d) => ({ stream: await generateIPL(d), warnings: [] }),
    ZPL: async (d) => { const r = generateZPL(d); return { stream: r.zpl, warnings: r.warnings }; },
    EPL: async (d) => { const r = generateEPL(d); return { stream: r.epl, warnings: r.warnings }; },
    TSPL: async (d) => { const r = generateTSPL(d); return { stream: r.tspl, warnings: r.warnings }; },
    DPL: async (d) => { const r = generateDPL(d); return { stream: r.dpl, warnings: r.warnings }; },
};

describe('field type x language matrix', () => {
    for (const [fname, field] of FIELD_TYPES) {
        for (const [lang, gen] of Object.entries(GENERATORS)) {
            const draws = DRAWS[lang].includes(fname);
            it(`${lang} ${draws ? 'draws' : 'names'} a ${fname}`, async () => {
                const { stream, warnings } = await gen(design([field]));
                const named = warnings.some(w => w.includes(field.name));
                if (draws) {
                    expect(named, `${lang} should draw the ${fname}, not warn about it: ${warnings.join(' / ')}`).toBe(false);
                    expect(stream.length, 'a drawn field produces output').toBeGreaterThan(0);
                } else {
                    // The invariant: not drawn ⇒ NAMED. Never silent.
                    expect(named, `${lang} leaves the ${fname} off the label, so it MUST name it — a silent drop is the failure this guards`).toBe(true);
                }
            });
        }
    }
});