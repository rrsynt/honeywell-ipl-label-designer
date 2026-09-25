// IPL has no clock. `dn` documents only n=0..3 (PRM p.184 "Field Data, Define
// Source"), and no manual under docs/manuals/ describes a date or clock
// source, so `d4`/`d5` are not commands any printer understands.
//
// This app used to emit them anyway, and its own viewer answered with a
// plausible-looking [YY/MM/DD] placeholder — output that looked right and was
// wrong on paper. The designer keeps its live date preview; the GENERATOR now
// bakes the current value into the format as fixed data (d3), which every
// printer prints. These tests pin both halves plus the migration path for
// streams that already contain the old commands.
import { describe, it, expect } from 'vitest';
import { getFormattedDateTime } from '../services/dateTimeFormat';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { parseIPL } from '../services/iplParser';
import { generateIPL } from '../services/iplGenerator';
import type { Design, TextField } from '../types';

const stx = (f: string) => `<STX>${f}<ETX>`;
const DPI = 203;

/** Fixed instant so the expectations below are exact, not clock-dependent. */
const AT = new Date(2026, 8, 25, 14, 30, 45); // 2026-09-25 14:30:45 local

describe('getFormattedDateTime', () => {
    it('formats each documented date shape', () => {
        expect(getFormattedDateTime('date', 'YY/MM/DD', AT)).toBe('26/09/25');
        expect(getFormattedDateTime('date', 'YYYY/MM/DD', AT)).toBe('2026/09/25');
        expect(getFormattedDateTime('date', 'DD/MM/YY', AT)).toBe('25/09/26');
        expect(getFormattedDateTime('date', 'DD/MM/YYYY', AT)).toBe('25/09/2026');
    });

    it('formats each documented time shape', () => {
        expect(getFormattedDateTime('time', 'HH:MM:SS 24hr', AT)).toBe('14:30:45');
        expect(getFormattedDateTime('time', 'HH:MM 24hr', AT)).toBe('14:30');
        expect(getFormattedDateTime('time', 'HH:MM:SS 12hr', AT)).toBe('02:30:45');
        expect(getFormattedDateTime('time', 'HH:MM 12hr', AT)).toBe('02:30');
        expect(getFormattedDateTime('time', 'HH:MM:SS am/pm', AT)).toBe('02:30:45 pm');
        expect(getFormattedDateTime('time', 'HH:MM am/pm', AT)).toBe('02:30 pm');
    });

    it('handles the midnight and noon hours where 12-hour clocks go wrong', () => {
        // 0 -> 12 am and 12 -> 12 pm are the two cases a naive `H % 12`
        // gets wrong (it yields 0 am and 0 pm).
        expect(getFormattedDateTime('time', 'HH:MM am/pm', new Date(2026, 0, 1, 0, 5))).toBe('12:05 am');
        expect(getFormattedDateTime('time', 'HH:MM am/pm', new Date(2026, 0, 1, 12, 5))).toBe('12:05 pm');
        expect(getFormattedDateTime('time', 'HH:MM am/pm', new Date(2026, 0, 1, 23, 5))).toBe('11:05 pm');
    });

    it('falls back to a sensible shape for an unknown format', () => {
        expect(getFormattedDateTime('date', 'nonsense', AT)).toBe('26/09/25');
        expect(getFormattedDateTime('time', 'nonsense', AT)).toBe('14:30:45');
    });
});

describe('the generator bakes date/time into fixed data', () => {
    const designFor = (dataSource: TextField['dataSource']): Design => ({
        name: 'bake',
        labelSettings: { width: 100, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
        fields: [{
            id: 1, type: 'text', name: 'D', x: 5, y: 5, rotation: 0,
            font: '25', fontSize: 12, h_mag: 2, w_mag: 2, align: 'left',
            dataSource,
        } as TextField],
        dataSources: [],
        printerSettings: {
            dpi: DPI, speed: 2, darkness: 10, mediaType: 'direct-thermal',
            mediaSenseMode: 'gap', printSpeed: 2, quantity: 1, directGraphics: false,
        },
    } as unknown as Design);

    it('emits d3 with a real date, never d4', async () => {
        const ipl = await generateIPL(designFor({ type: 'date', format: 'DD/MM/YYYY' }));
        expect(ipl).not.toMatch(/d4[,;]/);
        const m = ipl.match(/d3,(\d{2}\/\d{2}\/\d{4})/);
        expect(m, 'a baked DD/MM/YYYY value').toBeTruthy();
    });

    it('emits d3 with a real time, never d5', async () => {
        const ipl = await generateIPL(designFor({ type: 'time', format: 'HH:MM 24hr' }));
        expect(ipl).not.toMatch(/d5[,;]/);
        expect(ipl).toMatch(/d3,\d{2}:\d{2}/);
    });

    it('the baked value survives the viewer round trip', async () => {
        const ipl = await generateIPL(designFor({ type: 'date', format: 'YYYY/MM/DD' }));
        const label = parseViewerIPL(ipl);
        const text = label.elements.find(e => e.kind === 'text') as { source: { data?: string } };
        expect(text.source.data ?? '').toMatch(/^\d{4}\/\d{2}\/\d{2}$/);
        // And nothing complains, because nothing is unsupported any more.
        expect(label.issues.filter(i => i.code === 'unknown-data-source')).toEqual([]);
    });
});

describe('the viewer reports d4/d5 instead of inventing a value', () => {
    it('warns and draws nothing for d4', () => {
        const label = parseViewerIPL([
            stx('<ESC>P'), stx('E1;F1'), stx('H0;o10,10;c25;k12;d4,3'), stx('R'), stx('<ESC>E1'),
        ].join(''));
        const text = label.elements.find(e => e.kind === 'text') as { source: unknown };
        expect(text.source).toEqual({ type: 'fixed', data: '' });
        expect(label.issues.some(i => i.code === 'unknown-data-source')).toBe(true);
    });

    it('warns and draws nothing for d5', () => {
        const label = parseViewerIPL([
            stx('<ESC>P'), stx('E1;F1'), stx('H0;o10,10;c25;k12;d5,5'), stx('R'), stx('<ESC>E1'),
        ].join(''));
        expect(label.issues.some(i => i.code === 'unknown-data-source')).toBe(true);
    });

    it('does not flag a legitimate d40-style value as a date source', () => {
        // The check is anchored (`/^[45](,|$)/`), so a longer number that only
        // STARTS with 4 or 5 must not be swallowed as date/time.
        const label = parseViewerIPL([
            stx('<ESC>P'), stx('E1;F1'), stx('H0;o10,10;c25;k12;d40'), stx('R'), stx('<ESC>E1'),
        ].join(''));
        expect(label.issues.some(i => i.code === 'unknown-data-source')).toBe(false);
    });
});

describe('legacy streams carrying d4/d5 still migrate', () => {
    it('imports d4 as a designer date field and re-exports it baked', async () => {
        // A .ipl produced by an older version of this app must not become
        // unfixable: the importer still reads d4/d5 as a date/time source, and
        // generating from that design writes the real value as d3.
        const legacy = [
            stx('<ESC>P'), stx('E1;F1'), stx('H0;o20,20;c25;k12;d4,3'), stx('R'),
        ].join('');
        const parsed = parseIPL(legacy, DPI);
        expect((parsed.fields[0] as TextField).dataSource).toEqual({ type: 'date', format: 'DD/MM/YYYY' });

        const design = {
            name: 'migrated',
            labelSettings: { width: 100, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
            fields: parsed.fields,
            dataSources: [],
            printerSettings: parsed.printerSettings,
        } as unknown as Design;
        const regenerated = await generateIPL(design);
        expect(regenerated).not.toMatch(/d4[,;]/);
        expect(regenerated).toMatch(/d3,\d{2}\/\d{2}\/\d{4}/);
    });
});
