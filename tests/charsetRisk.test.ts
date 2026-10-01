// The send path encodes every stream as UTF-8 (services/bridgeSend.ts posts
// text/plain; tools/ipl-bridge.mjs does Buffer.from(body, 'utf8')), while four
// of the five languages print through a SINGLE-BYTE character set — IPL declares
// CP1252, ZPL declares UTF-8, and EPL/TSPL/DPL declare nothing at all. So a
// design holding anything above U+00FF was written into a stream that cannot
// carry it, and nothing said so.
//
// These tests pin the boundary: what survives, what does not, and which language
// is exempt. The mismatch itself is NOT fixed — which encoding a given printer
// accepts is firmware-dependent and cannot be settled without one — so the
// contract here is that the code panel SAYS SO.
import { describe, it, expect } from 'vitest';
import { charsetRisks, charsetWarning } from '../services/charsetRisk';
import { generateEPL } from '../services/epl/eplGenerator';
import { generateZPL } from '../services/zpl/zplGenerator';
import { generateTSPL } from '../services/tspl/tsplGenerator';
import { generateDPL } from '../services/dpl/dplGenerator';
import type { Design } from '../types';

const design = (data: string): Design => ({
    name: 'Charset Test',
    labelSettings: { width: 80, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields: [
        { id: 1, type: 'text', name: 'T1', x: 5, y: 5, rotation: 0, dataSource: { type: 'fixed', data }, font: '25', fontSize: 12, h_mag: 1, w_mag: 1 },
        { id: 2, type: 'barcode', name: 'B1', x: 5, y: 20, rotation: 0, dataSource: { type: 'fixed', data: '12345678' }, symbology: '6', humanReadable: 'none', h_mag: 50, w_mag: 2 },
    ],
    dataSources: [], nextId: 3, guides: { horizontal: [], vertical: [] },
});

describe('charsetRisk: what a single-byte page can hold', () => {
    it('passes text up to U+00FF, including accented letters', () => {
        // CP1252 has é, so a stream declaring it prints this correctly. A check
        // that warned on every non-ASCII byte would be noise on the common case.
        expect(charsetRisks(design('Café')).characters).toEqual([]);
        expect(charsetRisks(design('Straße')).characters).toEqual([]);
        expect(charsetRisks(design('ÀÉÎÕÜ')).characters).toEqual([]);
    });

    it('catches what no single-byte page has', () => {
        expect(charsetRisks(design('Prix €')).characters, 'the euro sign').toEqual(['€']);
        expect(charsetRisks(design('中文')).characters).toEqual(['中', '文']);
        expect(charsetRisks(design('A😀')).characters, 'an astral-plane character').toEqual(['😀']);
    });

    it('names the field the characters were found in', () => {
        expect(charsetRisks(design('中文')).fields).toEqual(['T1']);
    });
});

describe('charsetRisk: which languages are affected', () => {
    it('exempts ZPL, which declares UTF-8', () => {
        // ^CI28 is emitted at the head of every ZPL stream, so the bytes the
        // send path produces are exactly what the printer is told to expect.
        expect(charsetWarning(design('中文'), 'zpl')).toBeNull();
        expect(generateZPL(design('中文')).warnings.filter(w => w.includes('UTF-8'))).toEqual([]);
    });

    it('warns for the four that do not', () => {
        for (const lang of ['ipl', 'epl', 'tspl', 'dpl']) {
            expect(charsetWarning(design('中文'), lang), lang).not.toBeNull();
        }
    });

    it('says nothing when the design is inside the range', () => {
        for (const lang of ['ipl', 'epl', 'tspl', 'dpl', 'zpl']) {
            expect(charsetWarning(design('Café'), lang), lang).toBeNull();
        }
    });
});

describe('charsetRisk: the warning reaches the code panel', () => {
    it('is carried on each generator\'s own warnings array', () => {
        const d = design('中文');
        for (const [lang, warns] of [
            ['epl', generateEPL(d).warnings],
            ['tspl', generateTSPL(d).warnings],
            ['dpl', generateDPL(d).warnings],
        ] as const) {
            expect(warns.some(w => w.includes('UTF-8')), lang).toBe(true);
        }
    });

    it('names the characters and where they are', () => {
        const msg = charsetWarning(design('Prix €'), 'epl')!;
        expect(msg).toContain('€');
        expect(msg).toContain('T1');
        expect(msg).toContain('UTF-8');
        // and does not overstate: it says the range that IS safe
        expect(msg).toContain('U+00FF');
    });
});
