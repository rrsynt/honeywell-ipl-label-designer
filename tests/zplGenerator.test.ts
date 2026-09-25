import { describe, expect, it } from 'vitest';
import type { Design, Field } from '../types';
import { generateZPL, escapeFd } from '../services/zpl/zplGenerator';
import { parseZPL } from '../services/zpl/zplParser';
import { elementVisualBox } from '../services/ipl/renderer';
import { generateIPL } from '../services/iplGenerator';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { appReducer } from '../App';
import type { AppState } from '../types';

const design = (fields: Field[], over: Partial<Design> = {}): Design => ({
    name: 'T',
    labelSettings: { width: 100, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields, dataSources: [], nextId: 10, guides: { horizontal: [], vertical: [] },
    ...over,
});

const text = (over: Partial<Field> = {}): Field => ({
    id: 1, type: 'text', name: 'T', x: 10, y: 8, rotation: 0,
    dataSource: { type: 'fixed', data: 'Hello' }, font: '25', fontSize: 12, h_mag: 1, w_mag: 1,
    ...over,
} as Field);

describe('escapeFd', () => {
    it('escapes the three characters that would end or start a command', () => {
        expect(escapeFd('a^b~c\\d')).toBe('a\\^b\\~c\\\\d');
        expect(escapeFd('a\nb')).toBe('a\\&b');
    });
});

describe('generateZPL', () => {
    it('wraps the label and sets its size from the design', () => {
        const { zpl } = generateZPL(design([text()]));
        expect(zpl.startsWith('^XA')).toBe(true);
        expect(zpl.endsWith('^XZ')).toBe(true);
        // 100mm x 50mm at 203 dpi (8 dots/mm).
        expect(zpl).toContain('^PW800');
        expect(zpl).toContain('^LL400');
    });

    it('swaps the axes for a landscape label', () => {
        const d = design([text()], { labelSettings: { width: 100, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'landscape' } });
        const { zpl } = generateZPL(d);
        expect(zpl).toContain('^PW400');
        expect(zpl).toContain('^LL800');
    });

    it('round-trips a text field back to the same visual position', () => {
        const { zpl } = generateZPL(design([text()]));
        const label = parseZPL(zpl);
        expect(label.elements).toHaveLength(1);
        const el = label.elements[0];
        expect(el.kind).toBe('text');
        expect(el.kind === 'text' && el.source).toEqual({ type: 'fixed', data: 'Hello' });
        // 10mm, 8mm at 8 dots/mm.
        const box = elementVisualBox(el, 203);
        expect([box.x, box.y]).toEqual([80, 64]);
    });

    it('escapes data that contains a caret so the field survives the round trip', () => {
        const { zpl } = generateZPL(design([text({ dataSource: { type: 'fixed', data: '2^3' } } as Partial<Field>)]));
        const label = parseZPL(zpl);
        const el = label.elements[0];
        expect(el.kind === 'text' && el.source).toEqual({ type: 'fixed', data: '2^3' });
    });

    it('keeps a rotated field at the same top-left the designer drew', () => {
        const { zpl } = generateZPL(design([text({ rotation: 90 })]));
        const el = parseZPL(zpl).elements[0];
        expect(el.f).toBe(1);
        const box = elementVisualBox(el, 203);
        // 90° CCW hangs the block to the LEFT of the anchor, so the visual
        // top-left is (x - height, y). The height is the font's line height.
        expect(box.y).toBe(64);
        expect(box.x).toBeLessThan(80);
    });

    it('emits a box and a line with ^GB', () => {
        const fields: Field[] = [
            { id: 1, type: 'box', name: 'B', x: 5, y: 5, rotation: 0, width: 20, height: 10, thickness: 0.5 } as Field,
            { id: 2, type: 'line', name: 'L', x: 5, y: 20, rotation: 0, length: 30, thickness: 0.5 } as Field,
        ];
        const { zpl, warnings } = generateZPL(design(fields));
        expect(warnings).toHaveLength(0);
        const label = parseZPL(zpl);
        expect(label.elements.map(e => e.kind)).toEqual(['box', 'line']);
        const box = label.elements[0];
        expect([box.kind === 'box' && box.widthDots, box.kind === 'box' && box.heightDots]).toEqual([160, 80]);
    });

    it('warns about a field type it cannot represent and still emits the rest', () => {
        const fields: Field[] = [
            text(),
            { id: 2, type: 'ellipse', name: 'E', x: 0, y: 0, rotation: 0, width: 10, height: 10, thickness: 1 } as Field,
        ];
        const { zpl, warnings } = generateZPL(design(fields));
        expect(warnings.some(w => w.includes('"E"') && w.includes('ellipse'))).toBe(true);
        expect(parseZPL(zpl).elements).toHaveLength(1);
    });

    it('prints a linked field through its transform, matching the screen', () => {
        const d = design(
            [text({ dataSource: { type: 'linked', sourceId: 's', column: 'SKU', transform: 'UPPER(value)' } } as Partial<Field>)],
            { dataSources: [{ id: 's', type: 'table', name: 'T', columns: ['SKU'], rows: [{ SKU: 'ab12' }], query: { filters: [], combine: 'and' } }] },
        );
        const label = parseZPL(generateZPL(d).zpl);
        const el = label.elements[0];
        expect(el.kind === 'text' && el.source).toEqual({ type: 'fixed', data: 'AB12' });
    });

    it('remembers the chosen language, and a design saved before ZPL existed stays IPL', () => {
        // language is optional on purpose: every design on disk predates it, and
        // treating "absent" as anything but IPL would relabel them all.
        const state = (d: Design): AppState => ({ history: { past: [], present: d, future: [], intermediate: null, baseline: d }, selectedFieldIds: [], savedDesigns: [], clipboard: null, originalDesignName: null, contextMenu: null }) as unknown as AppState;
        const set = appReducer(state(design([text()])), { type: 'UPDATE_SETTING', payload: { settingType: 'printerSettings', updates: { language: 'zpl' } } });
        expect(set.history.present.printerSettings.language).toBe('zpl');
        expect(design([text()]).printerSettings.language).toBeUndefined();
    });

    it('lands a text field at the same visual origin through both languages', async () => {
        // The plan's contract: one design, two languages, one place on the page.
        const d = design([text({ x: 12, y: 9 })]);
        const zplEl = parseZPL(generateZPL(d).zpl).elements[0];
        const iplEl = parseViewerIPL(await generateIPL(d)).elements[0];
        expect(elementVisualBox(zplEl, 203)).toEqual(elementVisualBox(iplEl, 203));
    });
});
