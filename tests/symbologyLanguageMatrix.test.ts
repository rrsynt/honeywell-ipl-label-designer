// The symbology × language matrix: every IR barcode id a language's PARSER can
// produce must also be EXPORTABLE by that language's generator — drawn, never
// dropped with a warning. It is the second axis of the field×language matrix
// (tests/fieldLanguageMatrix.test.ts), which walks field TYPES but only ever
// with symbology '0'.
//
// The bug this locks: minting an IR id only teaches the READ direction. Each
// generator keeps a reverse table (design id -> target letter/name) that is NOT
// derived from the IR, so ids 27-35 were minted and parsed back while every
// generator silently DROPPED them on export (commits 4b44f66 then 75d54a1).
// Parser-only tests and the viewer both read through the parser, so neither
// could see it.
//
// INVARIANT PER (language, id): if that language's parser can produce the id,
// the generator must DRAW it (no "left off the label" warning naming the field)
// and parse(stream) must return the same id. A language that genuinely has no
// form for a symbol is a DELIBERATE drop, listed in KNOWN_DROP and asserted to
// be named rather than silent.

import './golden/setup';
import { describe, it, expect, beforeAll } from 'vitest';
import { generateTSPL } from '../services/tspl/tsplGenerator';
import { parseTSPL } from '../services/tspl/tsplParser';
import { generateEPL } from '../services/epl/eplGenerator';
import { parseEPL } from '../services/epl/eplParser';
import { generateDPL } from '../services/dpl/dplGenerator';
import { parseDPL } from '../services/dpl/dplParser';
import { generateZPL } from '../services/zpl/zplGenerator';
import { parseZPL } from '../services/zpl/zplParser';
import { measureBarcode, ensureBarcodesReady } from '../services/ipl/barcodes';
import type { Design, BarcodeField } from '../types';

beforeAll(async () => { await ensureBarcodesReady(); });

const field = (sym: string, data: string): BarcodeField => ({
    id: 2, type: 'barcode', name: 'B', x: 10, y: 20, rotation: 0,
    dataSource: { type: 'fixed', data },
    symbology: sym, humanReadable: 'below', h_mag: 60, w_mag: 2,
} as unknown as BarcodeField);

const design = (f: BarcodeField): Design => ({
    name: 'Sym Matrix',
    labelSettings: { width: 100, height: 60, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields: [f], dataSources: [], nextId: 20, guides: { horizontal: [], vertical: [] },
} as unknown as Design);

/** Data that produces a VALID symbol for each id, so the encoder lays ink. */
const DATA: Record<string, string> = {
    '0': 'ABC123', '1': 'ABC123', '2': '1234567890', '3': '1234567890',
    '4': 'A123456B', '5': '12345678', '6': 'ABC123', '8': 'ABC123',
    '10': 'CODE49DATA', '11': '123456789', '22': '12345678901',
    '12': 'PDFDATA', '14': 'MAXICODE DATA', '17': 'DMdata', '18': 'QRdata',
    '19': 'MicroPDFdata', '23': 'Aztecdata', '24': 'Codablockdata',
    '25': '12', '26': '12345', '27': '1234567890', '28': '1234567890',
    '29': '12345678901', '30': '1234567890123', '31': 'Telepen',
    '32': '1234567890123', '33': '1234567890', '34': '123456789',
    '35': '0952876543210',
};
const dataFor = (id: string) => DATA[id] ?? '1234567890';

/** The "no form here" warning shared by all four generators. */
const isDrop = (warnings: string[]) => warnings.some(w => w.includes('B') && /left off the label/.test(w));

/** For each language: the ids its PARSER can produce, and ids it deliberately
 *  cannot DRAW (named rather than silent). '7' (EAN/UPC) is resolved from the
 *  DATA LENGTH, not a fixed letter, so it is exercised separately below. */
interface Lang {
    id: string;
    gen: (f: BarcodeField) => { stream: string; warnings: string[] };
    read: (stream: string) => string | undefined;
    ids: string[];
    drop: string[];
}

const barcodeSym = (els: { kind?: string; symbology?: string }[]) =>
    (els.find(e => e.kind === 'barcode') ?? els[0])?.symbology;

const LANGS: Lang[] = [
    {
        id: 'TSPL',
        gen: f => { const r = generateTSPL(design(f)); return { stream: r.tspl, warnings: r.warnings }; },
        read: s => barcodeSym(parseTSPL(s).elements),
        // Linear types plus the 2D commands (TSPL_2D_COMMAND).
        ids: ['0', '1', '2', '3', '4', '5', '6', '10', '11', '22', '27', '28', '29', '30',
            '31', '32', '33', '35', '17', '18', '12', '19', '14', '23', '24'],
        drop: [],
    },
    {
        id: 'EPL',
        gen: f => { const r = generateEPL(design(f)); return { stream: r.epl, warnings: r.warnings }; },
        read: s => barcodeSym(parseEPL(s).elements),
        ids: ['0', '1', '2', '4', '6', '11', '22', '27', '29', '32', '34', '17'],
        drop: [],
    },
    {
        id: 'DPL',
        gen: f => { const r = generateDPL(design(f)); return { stream: r.dpl, warnings: r.warnings }; },
        read: s => barcodeSym(parseDPL(s, 406).elements),
        ids: ['0', '1', '2', '4', '6', '8', '11', '12', '14', '17', '18', '19', '23',
            '25', '26', '27', '31', '21'],
        // FIM (id 21) has no encoder anywhere in bwip, so a design cannot carry
        // it and DPL is right to name it rather than print nothing.
        drop: ['21'],
    },
    {
        id: 'ZPL',
        gen: f => { const r = generateZPL(design(f)); return { stream: r.zpl, warnings: r.warnings }; },
        read: s => barcodeSym(parseZPL(s).elements),
        // ZPL's subset is narrower, but it must be CONSISTENT: the five ids its
        // parser reads are the five its generator emits.
        ids: ['0', '2', '6', '17', '18'],
        drop: [],
    },
];

describe('symbology x language matrix', () => {
    for (const lang of LANGS) {
        describe(`${lang.id}: parser-reachable ids round-trip through the generator`, () => {
            for (const sym of lang.ids) {
                const deliberate = lang.drop.includes(sym);
                it(`${lang.id} ${deliberate ? 'names' : 'draws'} id ${sym}`, () => {
                    const f = field(sym, dataFor(sym));
                    const { stream, warnings } = lang.gen(f);
                    if (deliberate) {
                        expect(isDrop(warnings), `${lang.id} must NAME id ${sym}, not drop it silently`).toBe(true);
                        return;
                    }
                    // Drawn, never dropped-with-a-warning: the class 75d54a1 fixed.
                    expect(isDrop(warnings), `${lang.id} drops id ${sym}: ${warnings.join(' / ')}`).toBe(false);
                    // and the stream it wrote reads back as the SAME id, so a
                    // design saved and reloaded keeps its symbology.
                    expect(lang.read(stream), `${lang.id} id ${sym} must round-trip`).toBe(sym);
                });
            }
        });

        it(`${lang.id} draws every id it emits (the encoder really lays ink)`, () => {
            // A spec that is well-formed is not proof the encoder accepts it —
            // the MaxiCode lesson. The positive control is Code 39.
            for (const sym of lang.ids) {
                if (lang.drop.includes(sym)) continue;
                expect(measureBarcode(sym, dataFor(sym)), `${lang.id}: id ${sym} must encode`).not.toBeNull();
            }
            expect(measureBarcode('0', 'ABC123'), 'positive control: Code 39 encodes').not.toBeNull();
        });
    }

    // '7' is EAN/UPC, whose variant the printer infers from the DATA LENGTH —
    // a representation every one of the four languages carries but whose id is
    // not a fixed letter, so it cannot go through the loop above.
    it('EAN/UPC (id 7) keeps its id through every language that carries it', () => {
        const ean13 = '1234567890128';
        const langs: [string, () => { stream: string; warnings: string[] }, (s: string) => string | undefined][] = [
            ['TSPL', () => { const r = generateTSPL(design(field('7', ean13))); return { stream: r.tspl, warnings: r.warnings }; }, s => barcodeSym(parseTSPL(s).elements)],
            ['EPL', () => { const r = generateEPL(design(field('7', ean13))); return { stream: r.epl, warnings: r.warnings }; }, s => barcodeSym(parseEPL(s).elements)],
            ['DPL', () => { const r = generateDPL(design(field('7', ean13))); return { stream: r.dpl, warnings: r.warnings }; }, s => barcodeSym(parseDPL(s, 406).elements)],
        ];
        for (const [name, gen, read] of langs) {
            const { stream, warnings } = gen();
            expect(isDrop(warnings), `${name} drops EAN-13: ${warnings.join(' / ')}`).toBe(false);
            expect(read(stream), `${name} must read EAN/UPC back as id 7`).toBe('7');
        }
    });
});