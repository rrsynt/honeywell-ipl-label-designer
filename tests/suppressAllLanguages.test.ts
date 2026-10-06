// NEXT (2026-10-06, audit FUN-02): a suppression condition held on screen but
// printed on ZPL/EPL/TSPL/DPL — only IPL evaluated it. The canvas skips
// field-suppressed AND group-suppressed fields (canvasDrawer.ts:502), so every
// generator must skip the same set: what you see is what prints, in every
// language. IPL keeps its own (richer: batch rows, conditional formats) path.
import './golden/setup';
import { describe, it, expect, beforeAll } from 'vitest';
import { ensureBarcodesReady } from '../services/ipl/barcodes';
import { generateIPL } from '../services/iplGenerator';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { generateZPL } from '../services/zpl/zplGenerator';
import { parseZPL } from '../services/zpl/zplParser';
import { generateEPL } from '../services/epl/eplGenerator';
import { generateTSPL } from '../services/tspl/tsplGenerator';
import { generateDPL } from '../services/dpl/dplGenerator';
import { parseDPL } from '../services/dpl/dplParser';
import type { Design, Field } from '../types';

beforeAll(async () => { await ensureBarcodesReady(); });

const design = (fields: Field[], over: Partial<Design> = {}): Design => ({
    name: 'T',
    labelSettings: { width: 100, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields, dataSources: [], nextId: 99, guides: { horizontal: [], vertical: [] },
    ...over,
});

const text = (over: Partial<Field> = {}): Field => ({
    id: 1, type: 'text', name: 'A', x: 5, y: 5, rotation: 0,
    dataSource: { type: 'fixed', data: 'HOME' }, font: '0', fontSize: 12, h_mag: 1, w_mag: 1,
    ...over,
} as Field);

// A condition that HOLDS for this field's own value ('HOME'), so the canvas
// hides it. A second field with no condition stays as the control.
const suppressedPair = (): Field[] => [
    text({ id: 1, name: 'Hidden', dataSource: { type: 'fixed', data: 'HOME' }, suppress: 'IF(value, "EQ", "HOME", "yes", "")' }),
    text({ id: 2, name: 'Shown', x: 5, y: 20, dataSource: { type: 'fixed', data: 'OTHER' } }),
];

describe('field-level suppress holds in every language', () => {
    it('IPL drops the suppressed field', async () => {
        const label = parseViewerIPL(await generateIPL(design(suppressedPair())));
        const dataOf = (e: unknown): string =>
            (e as { source?: { data?: string } }).source?.data ?? (e as { data?: string }).data ?? '';
        expect(label.elements.some(e => dataOf(e) === 'HOME')).toBe(false);
        expect(label.elements.some(e => dataOf(e) === 'OTHER')).toBe(true);
    });

    it('ZPL drops the suppressed field', () => {
        const label = parseZPL(generateZPL(design(suppressedPair())).zpl);
        const texts = label.elements.filter(e => e.kind === 'text');
        expect(texts).toHaveLength(1);
        expect(texts[0].kind === 'text' && (texts[0] as { source?: { data?: string } }).source?.data).toBe('OTHER');
    });

    it('EPL drops the suppressed field', () => {
        const { epl, warnings } = generateEPL(design(suppressedPair()));
        expect(epl).not.toContain('HOME');
        expect(epl).toContain('OTHER');
        expect(warnings.join(' ')).not.toMatch(/HOME/);
    });

    it('TSPL drops the suppressed field', () => {
        const { tspl } = generateTSPL(design(suppressedPair()));
        expect(tspl).not.toContain('HOME');
        expect(tspl).toContain('OTHER');
    });

    it('DPL drops the suppressed field', () => {
        const { dpl } = generateDPL(design(suppressedPair()));
        expect(dpl).not.toContain('HOME');
        expect(dpl).toContain('OTHER');
    });

    it('a condition that does NOT hold prints everywhere (no over-suppression)', () => {
        const fields: Field[] = [
            text({ id: 1, name: 'A', dataSource: { type: 'fixed', data: 'HOME' }, suppress: 'IF(value, "EQ", "EXPORT", "yes", "")' }),
        ];
        const d = design(fields);
        expect(generateZPL(d).zpl).toContain('HOME');
        expect(generateEPL(d).epl).toContain('HOME');
        expect(generateTSPL(d).tspl).toContain('HOME');
        expect(generateDPL(d).dpl).toContain('HOME');
    });
});

describe('group-level suppress holds in every language', () => {
    const grouped = (): { fields: Field[]; groupSuppress: { [id: number]: string } } => ({
        fields: [
            text({ id: 1, name: 'ExportOnly', groupId: 50, dataSource: { type: 'fixed', data: 'HOME' } }),
            text({ id: 2, name: 'Always', x: 5, y: 20, dataSource: { type: 'fixed', data: 'OTHER' } }),
        ],
        // Judged on the lowest-id member's value ('HOME') — holds, so the
        // whole group hides, exactly like the canvas.
        groupSuppress: { 50: 'IF(value, "EQ", "HOME", "yes", "")' },
    });

    it('ZPL/EPL/TSPL/DPL drop every member of a suppressed group', () => {
        const g = grouped();
        const d = design(g.fields, { groupSuppress: g.groupSuppress });
        expect(generateZPL(d).zpl).not.toContain('HOME');
        expect(generateEPL(d).epl).not.toContain('HOME');
        expect(generateTSPL(d).tspl).not.toContain('HOME');
        expect(generateDPL(d).dpl).not.toContain('HOME');
        expect(generateZPL(d).zpl).toContain('OTHER');
    });

    it('an unparseable group condition hides nothing anywhere (typo prints)', () => {
        const g = grouped();
        const d = design(g.fields, { groupSuppress: { 50: 'IF(broken' } });
        expect(generateZPL(d).zpl).toContain('HOME');
        expect(generateDPL(d).dpl).toContain('HOME');
    });
});
