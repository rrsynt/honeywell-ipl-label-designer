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

    it('sizes a bitmap font by h_mag/w_mag and an outline font by point size', () => {
        // The designer (and EPL/TSPL) size a bitmap font from its cell x
        // magnification and hide the point-size editor for one; ZPL read
        // fontSize for both, so a bitmap field drawn 7x18 dots exported at a
        // default 34x34. ^A0 is h,w — cell height x w_mag, cell width x w_mag.
        const sizeOf = (over: Partial<Field>) => {
            const f = { id: 1, type: 'text', name: 'T', x: 10, y: 10, rotation: 0,
                dataSource: { type: 'fixed', data: 'Hi' }, font: '0', fontSize: 12, h_mag: 1, w_mag: 1, ...over } as Field;
            return ((generateZPL(design([f])).zpl.match(/\^A0[^\^]*/) ?? [''])[0]).trim();
        };
        // Font 0 is 7x9; h_mag 2, w_mag 3 -> 9*2=18 tall, 7*3=21 wide.
        expect(sizeOf({ h_mag: 2, w_mag: 3 })).toBe('^A0N,18,21');
        // A bitmap field ignores fontSize even when it is set.
        expect(sizeOf({ font: '0', fontSize: 99, h_mag: 1, w_mag: 1 })).toBe('^A0N,9,7');
        // An outline font (25, the designer default) still uses the point size.
        expect(sizeOf({ font: '25', fontSize: 20 })).toBe('^A0N,56,56');
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

    it('round-trips the Code 39 printer check digit through ^B3 e', () => {
        // ^B3 is o,e,h,f,g; e is the mod-43 check digit. The generator wrote e=N
        // always and the parser read the slot as "nothing", so a designer Code 39
        // with a printer-generated check digit lost it in both directions.
        const barcode = (ck?: 'none' | 'printer-generated' | 'host-verifies'): Field => ({
            id: 1, type: 'barcode', name: 'B', x: 10, y: 10, rotation: 0,
            dataSource: { type: 'fixed', data: 'ABC123' }, symbology: '0', humanReadable: 'none',
            h_mag: 50, w_mag: 2, code39_checkDigit: ck,
        } as Field);

        const on = parseZPL(generateZPL(design([barcode('printer-generated')])).zpl).elements[0] as { code39Mode?: string };
        expect(on.code39Mode, 'e=Y survives to the parser').toBe('1');
        // Default (no check digit) and host-verify both emit e=N and read back
        // as no mode — e=Y does not mean "verify".
        const off = parseZPL(generateZPL(design([barcode()])).zpl).elements[0] as { code39Mode?: string };
        expect(off.code39Mode).toBeUndefined();
        const host = parseZPL(generateZPL(design([barcode('host-verifies')])).zpl).elements[0] as { code39Mode?: string };
        expect(host.code39Mode).toBeUndefined();
    });

    it('writes the HEIGHT into the height slot of every 1D command', () => {
        // ^BC/^B2 are o,h,f,g and ^B3 is o,e,h,f,g — the height is a NUMBER
        // slot, and the HRI flag is a separate Y/N slot. The generator put the
        // HRI flag IN the height slot and never wrote the height, so an
        // HRI-enabled barcode went out as ^B2N,Y,N,N,N: a one-dot bar height,
        // which prints an invisible symbol. Labelary confirms ^B2N,60,... is
        // 60-dot bars while ^B2N,1,Y,... is 1-dot bars plus a text row.
        const barcode = (sym: string, hri: 'none' | 'below'): Field => ({
            id: 1, type: 'barcode', name: 'B', x: 10, y: 10, rotation: 0,
            dataSource: { type: 'fixed', data: '12345678' }, symbology: sym, humanReadable: hri,
            h_mag: 200, w_mag: 2,
        } as Field);
        const cmd = (sym: string, hri: 'none' | 'below') =>
            (generateZPL(design([barcode(sym, hri)])).zpl.match(/\^B[23C][^\^]*/) ?? [''])[0];

        // h_mag 200 dots is the height the slot must carry, in every case.
        expect(cmd('0', 'none')).toBe('^B3N,N,200,N,N');
        expect(cmd('0', 'below')).toBe('^B3N,N,200,Y,N');
        expect(cmd('2', 'none')).toBe('^B2N,200,N,N,N');
        expect(cmd('2', 'below')).toBe('^B2N,200,Y,N,N');
        expect(cmd('6', 'none')).toBe('^BCN,200,N,N,N');
        // ^BC no longer hard-codes Y: an HRI of 'none' must not print a line.
        expect(cmd('6', 'below')).toBe('^BCN,200,Y,N,N');
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

    it('DRAWS an ellipse rather than warning about it', () => {
        // This used to assert the opposite — that an ellipse was named as
        // unsupported and left off the label. The ZPL PARSER had drawn ^GE
        // since 6dadfb9 (its parameter order settled by probing Labelary); the
        // generator simply never emitted it, so the test was pinning a gap
        // that only existed on one side of the same language.
        const fields: Field[] = [
            text(),
            { id: 2, type: 'ellipse', name: 'E', x: 0, y: 0, rotation: 0, width: 10, height: 10, thickness: 1 } as Field,
        ];
        const { zpl, warnings } = generateZPL(design(fields));
        expect(warnings.filter(w => w.includes('ellipse'))).toEqual([]);
        expect(zpl).toContain('^GE');
        // and it round-trips: the parser reads back the shape the generator wrote
        const kinds = parseZPL(zpl).elements.map(e => e.kind);
        expect(kinds).toContain('text');
        expect(kinds).toContain('ellipse');
    });

    it('still warns for a shape no ZPL command expresses', () => {
        // A polygon is genuinely outside the language — ZPL has no free-point
        // outline — so the warning has to survive for it.
        const fields: Field[] = [
            text(),
            { id: 2, type: 'polygon', name: 'P', x: 0, y: 0, rotation: 0, width: 20, height: 20, sides: 5, radius: 10, thickness: 1 } as unknown as Field,
        ];
        const { zpl, warnings } = generateZPL(design(fields));
        expect(warnings.some(w => w.includes('"P"') && w.includes('polygon'))).toBe(true);
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

    // ^GF: the parser has drawn it since a1a49fa, where the parameters were
    // settled against the Labelary oracle and the render came out
    // PIXEL-IDENTICAL — the strongest verification in this project. The
    // generator still had no image branch, so the designer's Image tool
    // exported "ZPL output does not support yet" about the one command whose
    // reading we had proved exactly. The payload asserted below was confirmed
    // against Labelary: it drew ink bbox (40,40)-(47,47) with per-row counts
    // 1,2,3,4,5,6,7,8 — the same shape our own renderer produced.
    const image = (over: Partial<Field> = {}): Field => {
        const bitmap = [
            '1000000000000000', '1100000000000000', '1110000000000000', '1111000000000000',
            '1111100000000000', '1111110000000000', '1111111000000000', '1111111100000000',
        ];
        return {
            id: 3, type: 'image', name: 'Logo', x: 5, y: 5, rotation: 0, threshold: 128,
            bitmap, width: bitmap[0].length / (203 / 25.4), height: bitmap.length / (203 / 25.4),
            ...over,
        } as unknown as Field;
    };

    it('emits ^GF with the bitmap packed MSB-first, bytes-per-row fixing the shape', () => {
        const { zpl, warnings } = generateZPL(design([image()]));
        expect(warnings.join(' '), 'images are no longer unsupported').not.toMatch(/does not support/);
        // 16 dots wide = 2 bytes per row, 8 rows = 16 bytes. A row that is not
        // a whole number of bytes is padded, so the shape never spills over.
        const m = /\^GFA,(\d+),(\d+),(\d+),([0-9A-F]+)\^FS/.exec(zpl);
        expect(m, 'a ^GF record is emitted').not.toBeNull();
        expect(m![3], 'bytes per row').toBe('2');
        expect(m![1], 'total bytes counted').toBe(String(2 * 8));
        // The diagonal: each row adds one ink dot from the left, so the high
        // byte goes 0x80, 0xC0, 0xE0 … A bit order reversed in the byte would
        // come out mirrored and this pins it.
        expect(m![4]).toBe('8000C000E000F000F800FC00FE00FF00');
    });

    it('round-trips: the parser reads the bitmap back dot for dot', () => {
        // What catches a transposed read or a reversed bit order — neither of
        // which a "does it emit ^GF" assertion would ever see.
        const back = parseZPL(generateZPL(design([image()])).zpl);
        const el = back.elements[0] as unknown as { kind: string; rows: string[]; widthDots: number; heightDots: number };
        expect(el.kind).toBe('graphic');
        expect(el.widthDots).toBe(16);
        expect(el.heightDots).toBe(8);
        expect(back.issues, 'and nothing is complained about').toEqual([]);
        const bits = el.rows.map(r => [...r].map(c => c.charCodeAt(0).toString(2).padStart(8, '0')).join(''));
        expect(bits[0].slice(0, 16)).toBe('1000000000000000');
        expect(bits[7].slice(0, 16)).toBe('1111111100000000');
    });

    it('says so when an image has no bitmap, rather than emitting an empty ^GF', () => {
        const { zpl, warnings } = generateZPL(design([image({ bitmap: [] } as Partial<Field>)]));
        expect(warnings.join(' ')).toMatch(/no bitmap data/);
        expect(zpl).not.toContain('^GF');
    });
});
