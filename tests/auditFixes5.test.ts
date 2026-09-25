import { describe, it, expect } from 'vitest';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { generateIPL } from '../services/iplGenerator';
import { appReducer } from '../App';
import type { AppState, Design, Field } from '../types';

// Batch 5 audit fixes: greedy d3 payloads, generator batch printing,
// mutation-free rounded boxes, bounded history, cached barcode rasters.

const stx = (f: string) => `<STX>${f}<ETX>`;

const frame = (id: number, data: string) => stx(`H${id};o10,${10 + id * 20};c0;d3,${data}`);
const format = [
    stx('<ESC>P'), stx('E1;F1'),
    frame(0, 'SERIAL;NO;9'),      // semicolons mid-payload
    frame(1, 'NoTrailingSemi'),   // no customary frame separator at all
    frame(2, 'Trailing;'),        // exactly one trailing separator → stripped
    frame(3, 'A;B;'),             // data separator + trailing separator
    stx('H4;o10,100;c0;d4,2'),    // non-d3 sources must stay untouched
    stx('R'),
].join('\n');

describe('d3 fixed-data is greedy over ";" (audit chain-parse defect)', () => {
    const label = parseViewerIPL(format);
    const texts = label.elements.filter(e => e.kind === 'text') as { id?: number; source: { type: string; data?: string } }[];
    const dataOf = (id: number) => texts.find(t => t.id === id)!.source.data;

    it('keeps semicolons inside the payload', () => {
        expect(dataOf(0)).toBe('SERIAL;NO;9');
    });
    it('handles d3 with no trailing separator', () => {
        expect(dataOf(1)).toBe('NoTrailingSemi');
    });
    it('strips exactly the customary trailing separator, keeping data ones', () => {
        expect(dataOf(2)).toBe('Trailing');
        expect(dataOf(3)).toBe('A;B');
    });
    it('reports d4 as unsupported rather than inventing a date', () => {
        // d4/d5 are not IPL commands (PRM p.184 defines only d0-d3). The field
        // must not silently become a fabricated [YY/MM/DD] placeholder.
        expect(texts.find(t => t.id === 4)!.source).toEqual({ type: 'fixed', data: '' });
        expect(label.issues.some(i => i.code === 'unknown-data-source')).toBe(true);
    });
});

const baseDesign = (fields: Field[]): Design => ({
    name: 'T',
    labelSettings: { width: 100, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields, dataSources: [], nextId: 10, guides: { horizontal: [], vertical: [] },
});

describe('generateIPL batch rows (audit: batchData was a dead stub)', () => {
    const design = baseDesign([
        { id: 1, type: 'text', name: 'A', x: 5, y: 5, rotation: 0, dataSource: { type: 'variable', defaultData: 'DEF' }, font: '25', fontSize: 12, h_mag: 1, w_mag: 1 },
        { id: 2, type: 'barcode', name: 'B', x: 5, y: 20, rotation: 0, dataSource: { type: 'variable', defaultData: '' }, symbology: '6', humanReadable: 'none', h_mag: 50, w_mag: 1 },
    ] as Field[]);

    it('emits one print invocation per row with mapped column data', async () => {
        const ipl = await generateIPL(design, {
            rows: [['ALPHA', '111'], ['BETA', '222']],
            mappings: { 1: 0, 2: 1 },
            headers: ['TEXT', 'CODE'],
        });
        const blocks = ipl.split('\n').filter(l => l.includes('<CAN>'));
        expect(blocks).toHaveLength(2);
        expect(blocks[0]).toContain('<ESC>F1<NUL>ALPHA');
        expect(blocks[0]).toContain('<ESC>F2<NUL>111');
        expect(blocks[1]).toContain('<ESC>F1<NUL>BETA');
        expect(blocks[1]).toContain('<ESC>F2<NUL>222');
        expect(blocks[0]).toContain('<RS>1');
    });

    it('falls back to the field default for unmapped fields', async () => {
        const ipl = await generateIPL(design, { rows: [['ONLY']], mappings: { 1: 0 }, headers: ['TEXT'] });
        expect(ipl).toContain('<ESC>F1<NUL>ONLY');
        // field 2 default is '' → its NUL section is empty:
        expect(ipl).toContain('<ESC>F2<NUL><RS>1');
    });
});

describe('generateIPL does not mutate input state (audit: _graphicId write-back)', () => {
    it('rounded boxes get resource ids via a local map only', async () => {
        const box = { id: 3, type: 'box', name: 'X', x: 5, y: 5, rotation: 0, width: 20, height: 10, thickness: 1, cornerRadius: 2 };
        const design = baseDesign([box as unknown as Field]);
        const ipl = await generateIPL(design);
        expect((box as Record<string, unknown>)._graphicId).toBeUndefined();
        // The U field references the G resource generated for this box:
        expect(ipl).toMatch(/<STX>G1,/);
        expect(ipl).toMatch(/<STX>U3;[^<]*;c1<ETX>/);
    });
});

describe('undo history cap (audit: unbounded past[])', () => {
    it('caps past at 100 snapshots, keeping the newest', () => {
        const start = baseDesign([]);
        let s: AppState = {
            history: { past: [], present: start, future: [], intermediate: null, baseline: start },
            selectedFieldIds: [], savedDesigns: [], clipboard: null, originalDesignName: null, contextMenu: null,
        };
        for (let i = 0; i < 150; i++) {
            s = appReducer(s, { type: 'UPDATE_SETTING', payload: { settingType: 'labelSettings', updates: { width: 100 + i } } });
        }
        expect(s.history.past.length).toBe(100);
        // i=0 (width 100) was a no-op change; pushes ran for widths 100→248,
        // so the kept window is the last 100: 149..248, contiguous & ascending:
        expect(s.history.past[s.history.past.length - 1].labelSettings.width).toBe(248);
        expect(s.history.past[0].labelSettings.width).toBe(149);
    });
});

// (Batch D, 2026-09-21) the JsBarcode raster path and its cache were retired:
// the designer now paints through services/ipl/barcodes.ts, whose paint-raster
// cache is pinned by tests/designerBarcodeParity.test.ts instead.
