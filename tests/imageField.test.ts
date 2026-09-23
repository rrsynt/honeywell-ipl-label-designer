// Batch O: image/logo fields. Locked contracts:
//  - ImageField stores the dot grid as rows of '1'/'0' (JSON-safe); mm are
//    always derived exactly as dots / DPI_MAP[dpi] (203dpi -> 8 dots/mm).
//  - an explicit size edit resamples the bitmap; a bitmap replacement
//    re-derives mm; a dpi switch re-derives mm only (asset untouched).
//  - generateIPL emits a G definition + U placement; parseIPL rebuilds the
//    identical field (round-trip); the viewer parser accepts the stream with
//    zero errors and yields a graphic element.
import { describe, it, expect } from 'vitest';
import { appReducer, isDesignDirty } from '../App';
import { generateIPL } from '../services/iplGenerator';
import { parseIPL } from '../services/iplParser';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { extractDirectGraphics } from '../services/ipl/directGraphics';
import {
    resampleBitmap, imageDataSourceToBitmap, rebaseImage,
    invertBitmap, placeholderImage, MAX_IMAGE_DOTS,
} from '../services/imageField';
import { getObjectBoundingBox } from '../services/geometry';
import type { AppState, Design, ImageField } from '../types';

// DPI_MAP['203'] = 8 dots per mm — the unit everything below converts with.
const DPM203 = 8;
const baseDesign: Design = {
    name: 'T', labelSettings: { width: 100, height: 65, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields: [], dataSources: [], nextId: 1, guides: { horizontal: [], vertical: [] },
};
const stateOf = (design: Design, sel: number[] = []): AppState => ({
    history: { past: [], present: design, future: [], intermediate: null, baseline: design },
    selectedFieldIds: sel, savedDesigns: [], clipboard: null, originalDesignName: null, contextMenu: null,
});
const img = (over: Partial<ImageField> = {}): ImageField => ({
    id: 1, type: 'image', name: 'Image 1', x: 5, y: 5, rotation: 0, locked: false, visible: true,
    bitmap: ['1100', '1100', '0011', '0011'], width: 4 / DPM203, height: 4 / DPM203, threshold: 128, ...over,
});

describe('bitmap math', () => {
    it('resampleBitmap doubles exactly (nearest-neighbour, ink-biased)', () => {
        expect(resampleBitmap(['10', '01'], 4, 4)).toEqual(['1100', '1100', '0011', '0011']);
    });
    it('and the inverse shrink of the same shape is stable', () => {
        expect(resampleBitmap(['1100', '1100', '0011', '0011'], 2, 2)).toEqual(['10', '01']);
    });
    it('imageDataSourceToBitmap thresholds luminance composited over white', () => {
        // 2x2 source: black, white, fully transparent, lum-127 grey.
        const data = new Uint8ClampedArray([
            0, 0, 0, 255,
            255, 255, 255, 255,
            0, 0, 0, 0,
            127, 127, 127, 255,
        ]);
        expect(imageDataSourceToBitmap(data, 2, 2, 2, 2, 128, false)).toEqual(['10', '01']);
    });
    it('invertBitmap swaps ink and paper', () => {
        expect(invertBitmap(['10', '01'])).toEqual(['01', '10']);
    });
});

describe('rebaseImage (property-panel consistency)', () => {
    const d = baseDesign;
    it('width-only edit widens the grid and KEEPS the height dots', () => {
        const f = img({ bitmap: ['10', '01'], width: 2 / DPM203, height: 2 / DPM203 });
        const out = rebaseImage(f, { width: 4 / DPM203 }, d) as ImageField;
        // 2x2 -> 4x2: nearest-neighbour stretches each column.
        expect(out.bitmap).toEqual(['1100', '0011']);
        expect(out.width).toBe(4 / DPM203);
        expect(out.height).toBe(2 / DPM203);
    });
    it('bitmap edit re-derives mm from the new grid', () => {
        const f = img({ bitmap: ['10', '01'], width: 1, height: 1 });
        const out = rebaseImage(f, { bitmap: ['1111'] }, d) as ImageField;
        expect(out.width).toBe(4 / DPM203);
        expect(out.height).toBe(1 / DPM203);
    });
    it('non-image fields pass straight through', () => {
        const t = { id: 2, type: 'text', name: 'A', x: 0, y: 0, rotation: 0 } as never;
        expect((rebaseImage(t, { name: 'B' }, d) as { name: string }).name).toBe('B');
    });
    it('MAX_IMAGE_DOTS caps a huge width edit', () => {
        const f = img({ bitmap: ['11', '11'], width: 2 / DPM203, height: 2 / DPM203 });
        const out = rebaseImage(f, { width: 100000 }, d) as ImageField;
        expect(out.bitmap[0].length).toBe(MAX_IMAGE_DOTS);
    });
});

describe('reducer: ADD_FIELD image + dpi + drag-commit', () => {
    it('the Image tool drops a 40x40 checkerboard placeholder (5mm at 203dpi)', () => {
        const s = appReducer(stateOf(baseDesign), { type: 'ADD_FIELD', payload: { type: 'image' } });
        const f = s.history.present.fields[0] as ImageField;
        expect(f.type).toBe('image');
        expect(f.bitmap).toHaveLength(40);
        expect(f.bitmap[0]).toHaveLength(40);
        expect(f.width).toBe(40 / DPM203);
        expect(s.history.present.nextId).toBe(2);
    });
    it('changing printer dpi keeps the bitmap but re-derives physical mm', () => {
        const d = { ...baseDesign, fields: [img({ bitmap: ['10', '01'], width: 2 / DPM203, height: 2 / DPM203 })] };
        const s = appReducer(stateOf(d), { type: 'UPDATE_SETTING', payload: { settingType: 'printerSettings', updates: { dpi: 300 } } });
        const f = s.history.present.fields[0] as ImageField;
        expect(f.bitmap).toEqual(['10', '01']);
        expect(f.width).toBeCloseTo(2 / 11.8, 10); // DPI_MAP['300'] = 11.8
    });
    it('drag-resize stays cheap in-flight; COMMIT resamples once', () => {
        const d = { ...baseDesign, fields: [img({ bitmap: ['10', '01'], width: 2 / DPM203, height: 2 / DPM203 })] };
        let s = stateOf(d);
        s = appReducer(s, { type: 'UPDATE_INTERMEDIATE', payload: { fields: [{ id: 1, width: 4 / DPM203, height: 4 / DPM203 }] } });
        expect((s.history.intermediate!.fields[0] as ImageField).bitmap).toEqual(['10', '01']);
        s = appReducer(s, { type: 'COMMIT_INTERMEDIATE' });
        const f = s.history.present.fields[0] as ImageField;
        expect(f.bitmap).toEqual(['1100', '1100', '0011', '0011']);
        expect(f.width).toBe(4 / DPM203);
    });
    it('image edits participate in dirty tracking', () => {
        const d = { ...baseDesign, fields: [img()] };
        expect(isDesignDirty(stateOf(d))).toBe(false);
        const s = appReducer(stateOf(d), { type: 'UPDATE_FIELD_PROPERTIES', payload: { fieldId: 1, updates: { threshold: 90 } } });
        expect(isDesignDirty(s)).toBe(true);
    });
});

describe('IPL round-trip', () => {
    const logo: ImageField = {
        ...img(), id: 3, name: 'Logo',
        bitmap: ['111011', '100001', '100000', '111110', '000000'],
        x: 12 / DPM203, y: 8 / DPM203, width: 6 / DPM203, height: 5 / DPM203,
    };
    const d: Design = {
        ...baseDesign,
        fields: [
            logo,
            { id: 4, type: 'text', name: 'T', x: 30 / DPM203, y: 30 / DPM203, rotation: 0, dataSource: { type: 'fixed', data: 'HI' }, font: '25', fontSize: 12, h_mag: 1, w_mag: 1 } as never,
        ],
    };

    it('generateIPL emits a G definition and a U placement', async () => {
        const ipl = await generateIPL(d);
        expect(ipl).toMatch(/<STX>G1,Logo;x6;y5;/);
        expect(ipl).toContain('<STX>U3;o12,8;f0;c1<ETX>');
        expect(ipl).toContain('<STX><ESC>P<ETX>'); // G frames land in program mode
    });
    it('parseIPL rebuilds the field bit-identically', async () => {
        const ipl = await generateIPL(d);
        const back = parseIPL(ipl, 203);
        const f = back.fields.find(x => x.type === 'image') as ImageField;
        expect(f.bitmap).toEqual(logo.bitmap);
        expect(f.width).toBe(logo.width);
        expect(f.height).toBe(logo.height);
        expect(f.x).toBeCloseTo(logo.x, 4);
        expect(f.y).toBeCloseTo(logo.y, 4);
    });
    it('the stream passes the VIEWER parser with zero errors and a graphic element', async () => {
        const ipl = await generateIPL(d);
        const label = parseViewerIPL(ipl);
        expect(label.issues.filter(i => i.level === 'error')).toEqual([]);
        const graphic = label.elements.filter(e => e.kind === 'graphic');
        expect(graphic).toHaveLength(1);
        expect(graphic[0]).toMatchObject({ widthDots: 6, heightDots: 5 });
    });
    it('rotated placement round-trips position + rotation', async () => {
        const rot = { ...d, fields: [{ ...logo, rotation: 90 as const }] };
        const ipl = await generateIPL(rot);
        // Batch W: identity placement — under the manual's CCW rule the
        // printed origin IS the unrotated top-left, so no height shift.
        expect(ipl).toContain('<STX>U3;o12,8;f1;c1<ETX>');
        const back = parseIPL(ipl, 203);
        const f = back.fields.find(x => x.type === 'image') as ImageField;
        expect(f.rotation).toBe(90);
        expect(f.x).toBeCloseTo(logo.x, 4);
        expect(f.y).toBeCloseTo(logo.y, 4);
    });
    it('Direct Graphics mode emits ASCII hex that decodes back to the same bitmap', async () => {
        const dg: Design = { ...d, printerSettings: { ...d.printerSettings, directGraphics: true } };
        const ipl = await generateIPL(dg);
        // No stored graphic, no binary: the payload is hex inside <ESC>g1.
        expect(ipl).not.toMatch(/<STX>G\d/);
        expect(ipl).toContain('<STX><ESC>g1<ETX>');
        expect(ipl).toMatch(/^[\x00-\x7f]*$/);

        // The clipboard path: UTF-8 encode then decode must not lose a byte.
        const pasted = new TextDecoder().decode(new TextEncoder().encode(ipl));
        expect(pasted).toBe(ipl);

        const label = parseViewerIPL(pasted);
        expect(label.issues.filter(i => i.level !== 'info')).toEqual([]);
        // The viewer reports the INK bounding box, which drops the logo's
        // all-white last row, so the graphic element's height cannot express the
        // full bitmap. Compare the decoded columns instead — they keep it.
        const payload = pasted.match(/<ESC>g1<ETX>\n<STX>([0-9A-F]+)/)![1];
        const [decodedDg] = extractDirectGraphics([payload], 1);
        expect(decodedDg.origin).toEqual([12, 65 * DPM203 - 8]);
        const cols = Array.from({ length: 6 }, (_, x) => decodedDg.pixels[12 + x].join(''));
        expect(cols).toEqual(['11110', '10010', '10010', '00010', '10010', '11000']);
    });
    it('an unresolvable U reference still yields an empty (re-pickable) image layer', () => {
        const stream = '<STX><ESC>P<ETX>\n<STX>E1;F1<ETX>\n<STX>U9;o10,10;f0;c99<ETX>\n<STX>R<ETX>';
        const f = parseIPL(stream, 203).fields.find(x => x.type === 'image') as ImageField;
        expect(f).toBeDefined();
        expect(f.bitmap).toEqual([]);
    });
    it('a BarTender split form (0-based u rows, swapped x/y) transposes upright', () => {
        // Header declares x=2 y=12 (print-head orientation) -> visual 12x2.
        // Rows stored bottom-up; LSB-first across (char i covers x=i*6..i*6+5):
        //   'a'=0x21 -> bits 0,5 -> "100001100001" (u0 = BOTTOM visual row)
        //   'A'=0x01 -> bit  0   -> "100000100000" (u1 = TOP row after the flip)
        const stream = [
            '<STX>G5;x2;y12<ETX>',
            '<STX>u0,aa<ETX>',
            '<STX>u1,AA<ETX>',
            '<STX>E1;F1<ETX>',
            '<STX>U5;o8,4;f0;c5<ETX>',
            '<STX>R<ETX>',
        ].join('\n');
        const f = parseIPL(stream, 203).fields.find(x => x.type === 'image') as ImageField;
        expect(f.bitmap).toEqual(['100000100000', '100001100001']);
        expect(f.width).toBeCloseTo(12 / DPM203, 10);
        expect(f.height).toBeCloseTo(2 / DPM203, 10);
    });
});

describe('designer geometry + persistence', () => {
    it('getObjectBoundingBox returns mm directly for images', () => {
        const bb = getObjectBoundingBox(img({ bitmap: ['11', '11'], width: 7.5, height: 2.5 }), baseDesign);
        expect(bb).toEqual({ width: 7.5, height: 2.5 });
    });
    it('a design with an image survives JSON (localStorage/clipboard) intact', () => {
        const original = img({ x: 3, y: 4 });
        const clone = JSON.parse(JSON.stringify(original)) as ImageField;
        const out = rebaseImage(clone, {}, baseDesign) as ImageField;
        expect(out).toEqual(original);
    });
    it('SET_DESIGN migrate does NOT bolt a dataSource onto image fields', () => {
        const legacy = JSON.parse(JSON.stringify({ ...baseDesign, fields: [img()] }));
        const s = appReducer(stateOf(baseDesign), { type: 'SET_DESIGN', payload: { design: legacy, originalDesignName: null } });
        const f = s.history.present.fields[0] as ImageField & { dataSource?: unknown };
        expect(f.dataSource).toBeUndefined();
        expect(f.bitmap).toEqual(img().bitmap);
    });
    it('placeholderImage agrees with the ADD_FIELD path', () => {
        const ph = placeholderImage(203);
        const s = appReducer(stateOf(baseDesign), { type: 'ADD_FIELD', payload: { type: 'image' } });
        expect((s.history.present.fields[0] as ImageField).bitmap).toEqual(ph.bitmap);
    });
});
