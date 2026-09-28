// Full outline-font coverage (PRM 2.70 p.206). Before this, only 10 of the 30
// documented outline ids were in FONT_MAP, so a stream using c31/c62/c67… got a
// spurious "unknown font" warning and painted with a fallback face.
import './golden/setup';
import { describe, it, expect } from 'vitest';
import { FONT_MAP, FONT_FAMILIES, fontStack } from '../constants';
import { parseViewerIPL, OUTLINE_FONTS } from '../services/ipl/viewerParser';
import { estimateElementSize } from '../services/ipl/renderer';
import { outlineTextBlockWidthDots } from '../services/ipl/fontMetrics';
import type { TextElement } from '../services/ipl/types';

const stx = (f: string) => `<STX>${f}<ETX>`;

/** Every id the 2.70 manual lists as an outline font.
 *
 *  c23/c24 are deliberately NOT here. The PRM table on p.206 is a single
 *  mixed list of resident fonts; the manual's own prose groups "Bitmap fonts
 *  recognized by optical character recognition" separately, and the Seagull
 *  driver agrees — its FontGroup.d places c23/c24 in `bitmap_ocr_203`. Listing
 *  them as outline is what caused them to be routed through the outline
 *  branch, where `h` is a point size instead of a magnification (see the
 *  bitmapMagnification test below and the note in constants.ts). */
const DOCUMENTED_OUTLINE_IDS = [
    '20', '21', '22', '25', '26', '28',
    '30', '31', '32', '33', '34', '35', '36', '37', '38', '39', '40', '41',
    '50', '51',
    '61', '62', '63', '64', '65', '66', '67', '68', '69', '70',
];

const textEl = (label: ReturnType<typeof parseViewerIPL>): TextElement =>
    label.elements.filter(e => e.kind === 'text')[0] as TextElement;

describe('outline font coverage (PRM 2.70 p.206)', () => {
    it('every documented outline id is known and typed as outline', () => {
        for (const id of DOCUMENTED_OUTLINE_IDS) {
            const def = FONT_MAP[id];
            expect(def, `c${id} missing from FONT_MAP`).toBeDefined();
            expect(def.type, `c${id} should be outline`).toBe('outline');
            expect(OUTLINE_FONTS.has(id), `c${id} not in OUTLINE_FONTS`).toBe(true);
        }
    });

    it('every documented outline id parses without an unknown-font warning', () => {
        for (const id of DOCUMENTED_OUTLINE_IDS) {
            const label = parseViewerIPL([
                stx('<ESC>P'), stx('E1;F1'),
                stx(`H0;o10,10;c${id};k12;d3,ABC`),
                stx('R'), stx('<ESC>E1'),
            ].join(''));
            const unknown = label.issues.filter(i => i.code === 'unknown-font');
            expect(unknown, `c${id} raised unknown-font: ${unknown[0]?.message ?? ''}`).toEqual([]);
        }
    });

    it('the fonts the generator can emit are all known', () => {
        // FONT_MAP is also the designer's font dropdown, so every entry must
        // round-trip. This guards the reverse direction of the check above.
        for (const id of Object.keys(FONT_MAP)) {
            const label = parseViewerIPL([
                stx('<ESC>P'), stx('E1;F1'),
                stx(`H0;o10,10;c${id};k12;d3,ABC`),
                stx('R'), stx('<ESC>E1'),
            ].join(''));
            expect(label.issues.filter(i => i.code === 'unknown-font'), `c${id}`).toEqual([]);
        }
    });
});

describe('nominal point sizes for the fixed-size families', () => {
    it('c20/c21/c22 carry their documented sizes', () => {
        expect(FONT_MAP['20'].defaultPointSize).toBe(8);
        expect(FONT_MAP['21'].defaultPointSize).toBe(12);
        expect(FONT_MAP['22'].defaultPointSize).toBe(20);
    });

    it('a field with no k falls back to the font’s nominal size', () => {
        // Without this, c20 and c22 would paint at an identical size and the
        // font id would carry no meaning.
        const at = (id: string) => textEl(parseViewerIPL([
            stx('<ESC>P'), stx('E1;F1'),
            stx(`H0;o10,10;c${id};d3,ABC`),
            stx('R'), stx('<ESC>E1'),
        ].join(''))).pointSize;

        expect(at('20')).toBe(8);
        expect(at('22')).toBe(20);
        expect(at('41')).toBe(36);
        expect(at('30')).toBe(6);
    });

    it('an explicit k still wins over the nominal size', () => {
        const el = textEl(parseViewerIPL([
            stx('<ESC>P'), stx('E1;F1'),
            stx('H0;o10,10;c20;k24;d3,ABC'),
            stx('R'), stx('<ESC>E1'),
        ].join('')));
        expect(el.pointSize).toBe(24);
    });

    it('a font with no documented size gets none (does not invent one)', () => {
        expect(FONT_MAP['25'].defaultPointSize).toBeUndefined();
        const el = textEl(parseViewerIPL([
            stx('<ESC>P'), stx('E1;F1'),
            stx('H0;o10,10;c25;d3,ABC'),
            stx('R'), stx('<ESC>E1'),
        ].join('')));
        expect(el.pointSize).toBeUndefined();
    });
});

// `h` is a MAGNIFICATION for bitmap faces, and the manual states the rule with
// numbers: PRM270 p.54 — "if you increase the height to 2 (h2) ... the field
// height doubles ... 79 dots long by 18 dots high. If you change the height
// magnification to h3, the field height triples, and the field prints 79 dots
// by 27 dots." c23/c24 were typed as outline, and the outline branch reads
// `h>4` as a POINT SIZE, so `h8` produced a 3pt field — roughly 8x too small,
// with no warning. These pin the magnification contract for the OCR ids and
// for the bitmap ids generally.
describe('bitmap height magnification (c23/c24 are bitmap, not outline)', () => {
    const estOf = (font: string, extra: string) => {
        const label = parseViewerIPL([
            stx('<ESC>P'), stx('<SI>W900<ETX>'), stx('<SI>L400<ETX>'), stx('E1;F1'),
            stx(`H0;o40,60;c${font};${extra};d3,ABCD`), stx('R'), stx('<ESC>E1'),
        ].join(''));
        const el = textEl(label) as TextElement & { hMag: number };
        return { el, size: estimateElementSize(el as never, 203) };
    };

    it('c23/c24 are typed bitmap', () => {
        expect(FONT_MAP['23'].type).toBe('bitmap');
        expect(FONT_MAP['24'].type).toBe('bitmap');
        expect(OUTLINE_FONTS.has('23')).toBe(false);
        expect(OUTLINE_FONTS.has('24')).toBe(false);
    });

    it('h8 magnifies 8x, it does not become a point size', () => {
        for (const id of ['23', '24']) {
            const { el, size } = estOf(id, 'h8');
            // The regression: an outline route leaves hMag at 1 and invents a
            // point size, so the height comes out ~9 dots instead of 72.
            expect(el.hMag, `c${id} h8 should stay a magnification`).toBe(8);
            expect(el.pointSize, `c${id} h8 must not be read as a point size`).toBeUndefined();
            expect(size.crossDots, `c${id} h8 height`).toBe(9 * 8);
        }
    });

    it('magnification is linear, as the manual example requires', () => {
        // h1/h2/h3 -> 1x/2x/3x, the shape PRM270 p.54 spells out for c0.
        for (const id of ['23', '24']) {
            const base = estOf(id, 'h1').size.crossDots;
            for (const m of [2, 3, 8]) {
                expect(estOf(id, `h${m}`).size.crossDots, `c${id} h${m}`).toBe(base * m);
            }
        }
    });

    it('w magnifies the advance too', () => {
        // 4 chars: width = 4 x (baseWidth + gap) x wMag - gap x wMag, i.e.
        // 34 x wMag for a 7+2 cell. w4 is therefore exactly 4x w1.
        const w1 = estOf('23', 'w1').size.lengthDots;
        expect(estOf('23', 'w4').size.lengthDots).toBe(4 * w1);
        expect(estOf('23', 'w8').size.lengthDots).toBe(8 * w1);
    });

    it('c69 stays outline — it is a scalable face, not a bitmap one', () => {
        // The fix is specific to the OCR ids. Letter Gothic is resolved by the
        // driver's outline group; do not sweep it into the bitmap branch.
        expect(FONT_MAP['69'].type).toBe('outline');
        expect(OUTLINE_FONTS.has('69')).toBe(true);
    });
});

describe('fontStack', () => {
    it('resolves a family to its vendored stack', () => {
        expect(fontStack('sans-serif')).toContain('Liberation Sans');
        expect(fontStack('serif')).toContain('Liberation Serif');
        expect(fontStack('monospace')).toContain('Liberation Mono');
        // c67: Century Schoolbook's metric-exact GUST-licensed substitute.
        expect(fontStack('schoolbook')).toContain('TeX Gyre Schola');
    });

    // c50/c51 are the Kanji ids, and the vendored Latin faces carry no CJK
    // glyphs. Without a CJK name in the stack the ideographs go to whatever the
    // host falls back to and render NARROWER than the full em fontMetrics
    // charges them — measured at 0.75 em through the sans stack and 0.60 em
    // through the mono one, so every Kanji field metered wider than it painted.
    // Naming a CJK family restores the full em; the Latin advances are
    // unaffected because the Latin face still wins for Latin text.
    it('every stack can render CJK at a full em', () => {
        for (const family of ['monospace', 'sans-serif', 'serif', 'schoolbook',
            'univers-condensed', 'letter-gothic']) {
            const stack = fontStack(family);
            expect(stack, `family ${family} must name a CJK-capable face`)
                .toMatch(/Yu Gothic|MS Gothic|Malgun Gothic|SimSun|Noto Sans CJK|Meiryo/);
            // The CJK names must come AFTER the Latin face, or Latin text would
            // change appearance and its calibrated advance would stop applying.
            const latin = ['Liberation Mono', 'Liberation Sans', 'Liberation Serif',
                'TeX Gyre Schola', 'Arial Narrow', 'Inconsolata']
                .filter(n => stack.includes(n));
            const firstCjk = stack.search(/Yu Gothic|MS Gothic|Malgun Gothic|SimSun|Noto Sans CJK|Meiryo/);
            for (const l of latin) {
                expect(stack.indexOf(l), `${l} must precede the CJK fallback in ${family}`)
                    .toBeLessThan(firstCjk);
            }
        }
    });

    it('falls back to monospace for an unknown family', () => {
        expect(fontStack(undefined)).toContain('Liberation Mono');
        expect(fontStack('nonsense')).toContain('Liberation Mono');
    });

    it('never requests a bold face', () => {
        // See constants.ts: the ids whose names say "bold" are painted at
        // regular weight, matching the BarTender reference export.
        for (const family of ['monospace', 'sans-serif', 'serif', 'schoolbook', undefined]) {
            expect(fontStack(family)).not.toMatch(/^bold /);
        }
    });
});

// c67 used to resolve to the `serif` family, whose table is Times-compatible
// (CG Times, for c28/c66) and metered c67's fields ~10–13% narrow. Pinning the
// ROUTING here is what keeps that from quietly coming back: the table test
// below would still pass if c67 pointed at `serif`, because both tables are
// internally consistent — only the mapping was wrong.
describe('c67 Century Schoolbook routing', () => {
    it('is its own family, not the Times-compatible serif', () => {
        expect(FONT_MAP['67'].family).toBe('schoolbook');
    });

    it('sibling serif ids stay on the Times-compatible family', () => {
        // c28/c66 are CG Times, which descends from Times New Roman — the
        // serif table is genuinely right for them and must not be swept up.
        expect(FONT_MAP['28'].family).toBe('serif');
        expect(FONT_MAP['66'].family).toBe('serif');
    });

    it('every family a FONT_MAP id names has its own stack', () => {
        // Guards the silent-fallthrough class: a family with no FONT_FAMILIES
        // entry resolves to the monospace fallback (fontStack's `??`), i.e. the
        // field silently paints in the wrong face. Checked against the map
        // itself, not against fontStack's fallback — the fallback IS the
        // monospace stack, so comparing stacks would flag the legitimate
        // monospace family as missing.
        const checked = new Set<string>();
        for (const [id, def] of Object.entries(FONT_MAP)) {
            if (def.type !== 'outline' || !def.family || checked.has(def.family)) continue;
            checked.add(def.family);
            expect(FONT_FAMILIES[def.family], `c${id} → ${def.family} has no stack`).toBeDefined();
        }
        // Sanity: the loop actually saw the families it is meant to cover.
        expect(checked.size).toBeGreaterThanOrEqual(4);
    });
});

// c69 (Letter Gothic) is a 12-pitch face: every glyph advances exactly
// 500/1000 em, per URW's own AFM (`ulgb8a.afm`, where every character is WX 500)
// and per the arithmetic of the design (12 chars/inch against a 1/6" em).
//
// It used to be metered at the monospace 600, inherited from Andale Mono, so
// every c69 field was 20% too wide — and the correction was blocked because the
// renderer draws through fillText: at a 500 advance, 25 of Liberation Mono's 94
// glyphs are wider than their own cell and collide. The fix is a face whose own
// advance IS 500 (Inconsolata, vendored), so this is now measured rather than
// announced. These pin the number and the absence of the old warning.
describe('c69 Letter Gothic uses the measured 500/1000 em advance', () => {
    const parseWith = (font: string) => parseViewerIPL([
        stx('<ESC>P'), stx('E1;F1'),
        stx(`H0;o10,10;c${font};k12;d3,ABC`),
        stx('R'), stx('<ESC>E1'),
    ].join(''));

    it('c69 resolves to the letter-gothic family, not monospace', () => {
        expect(FONT_MAP['69'].type).toBe('outline');
        expect(FONT_MAP['69'].family).toBe('letter-gothic');
        // The face must be one the renderer can actually draw through.
        expect(fontStack('letter-gothic')).toContain('Inconsolata');
    });

    it('meters c69 at 500 per-mille, not the monospace 600', () => {
        // Three chars at a 1000-dot em: 3 * 500/1000 * 1000 = 1500 dots.
        expect(outlineTextBlockWidthDots(['ABC'], 1000, 'letter-gothic')).toBe(1500);
        // And it must differ from what the old mapping produced.
        expect(outlineTextBlockWidthDots(['ABC'], 1000, 'letter-gothic'))
            .not.toBe(outlineTextBlockWidthDots(['ABC'], 1000, 'monospace'));
        expect(outlineTextBlockWidthDots(['ABC'], 1000, 'monospace')).toBe(1800);
    });

    it('no longer raises the letter-gothic-advance warning', () => {
        // The defect it announced is fixed; leaving the warning would now be a
        // false alarm on every correct c69 field.
        expect(parseWith('69').issues.filter(i => i.code === 'letter-gothic-advance')).toEqual([]);
    });

    it('c69 still renders', () => {
        const label = parseWith('69');
        const el = label.elements.find(e => e.kind === 'text');
        expect(el).toBeDefined();
        expect((el as { pointSize?: number }).pointSize).toBe(12);
    });
});

// c63/c65 are the printer's condensed cuts. They used to be drawn at the
// regular sans width — announced, not fixed, because no metric source for
// Univers had been found. Adobe's own AFM for the family was then located, so
// the width is now measured and the warning is gone. These pin the fix.
describe('c63/c65 condensed cuts use measured Univers advances', () => {
    const parseWith = (font: string) => parseViewerIPL([
        stx('<ESC>P'), stx('E1;F1'),
        stx(`H0;o10,10;c${font};k12;d3,ABC`),
        stx('R'), stx('<ESC>E1'),
    ].join(''));

    it('both resolve to the condensed family', () => {
        for (const id of ['63', '65']) {
            expect(FONT_MAP[id].family, `c${id}`).toBe('univers-condensed');
            expect(OUTLINE_FONTS.has(id)).toBe(true);
        }
    });

    it('they are measured NARROWER than the regular sans ids, not equal to them', () => {
        // The defect was that c63 was metered exactly like c61/c68. If these
        // ever match again, the condensed table has stopped being applied.
        const size = (id: string) => {
            const el = parseWith(id).elements.find(e => e.kind === 'text')!;
            return estimateElementSize(el, 203).lengthDots;
        };
        const condensed = size('63');
        const regular = size('61');
        expect(condensed, 'c63 must be narrower than c61').toBeLessThan(regular);
        // "ABC" in the AFM: 611+611+556 = 1778 per-mille vs Arial's 667+667+722
        // = 2056, i.e. ~86.5%.
        expect(condensed / regular).toBeGreaterThan(0.8);
        expect(condensed / regular).toBeLessThan(0.9);
    });

    it('no longer warns — the width is now measured, not estimated', () => {
        for (const id of ['63', '65']) {
            expect(parseWith(id).issues.filter(i => i.code === 'univers-condensed-width'),
                `c${id} should no longer warn`).toEqual([]);
        }
    });

    it('the regular Univers ids keep the sans family', () => {
        // Only the condensed cuts move. c61/c62/c68 are still unmeasured, but
        // they are regular-width Helvetica-metric faces, which is what the sans
        // table is, so they stay put until a source turns up.
        for (const id of ['61', '62', '68']) {
            expect(FONT_MAP[id].family, `c${id}`).toBe('sans-serif');
        }
    });
});

// c52..c56 are the resident CJK bitmap faces. Unlike c23/c24 — whose cell width
// is an admitted assumption — these ids NAME their cell, so the metrics are
// published values rather than inference: "Katakana 12 x 16 bitmap" states the
// 12 and the 16. The driver's c52.pfm..c56.pfm agree (bytes 0x1b/0x16 read
// 12/16, 16/24, 24/36, 16/16, 24/24), so the two sources corroborate.
//
// These pin those cells, because they are what every layout calculation for a
// CJK field is built from.
describe('c52..c56 CJK bitmap cells (PRM 2.70 p.206, stated in the id names)', () => {
    const CELLS: Record<string, [number, number]> = {
        '52': [12, 16],   // Katakana 12 x 16
        '53': [16, 24],   // Katakana 16 x 24
        '54': [24, 36],   // Katakana 24 x 36
        '55': [16, 16],   // Kanji 16 x 16
        '56': [24, 24],   // Kanji 24 x 24
    };

    it('each id carries the cell its own name states', () => {
        for (const [id, [w, h]] of Object.entries(CELLS)) {
            const def = FONT_MAP[id];
            expect(def, `c${id} missing from FONT_MAP`).toBeDefined();
            expect(def.type, `c${id} is a bitmap face`).toBe('bitmap');
            expect(def.baseWidth, `c${id} width`).toBe(w);
            expect(def.baseHeight, `c${id} height`).toBe(h);
            // The id's own name is the source, so they must not drift apart.
            expect(def.name, `c${id} name must state its cell`).toContain(`${w} x ${h}`);
        }
    });

    it('they are bitmap, so `h` magnifies instead of setting a point size', () => {
        // The exact defect c23/c24 had: typed as outline, `h` is read as a point
        // size, so h8 painted a 3pt field rather than magnifying 8x.
        for (const id of Object.keys(CELLS)) {
            const label = parseViewerIPL([
                stx('<ESC>P'), stx('E1;F1'),
                stx(`H0;o10,10;c${id};h8;w8;d3,カナ`), stx('R'), stx('<ESC>E1'),
            ].join(''));
            const el = textEl(label);
            expect(el.pointSize, `c${id} must not read h8 as a point size`).toBeUndefined();
            expect(el.hMag, `c${id} h8 magnifies`).toBe(8);
            expect(OUTLINE_FONTS.has(id), `c${id} is not an outline id`).toBe(false);
        }
    });

    it('a three-character field meters 3 cells at h1/w1', () => {
        // advance = width + gap, and the last gap is dropped — the same rule the
        // 86XX cells use, pinned there by the manual's 79-dot c0 example
        // (10 chars of c0 = 10 * 8 - 1 = 79). "カナカ" is exactly three.
        const THREE = 'カナカ';
        expect([...THREE], 'the fixture must be 3 characters').toHaveLength(3);
        for (const [id, [w, h]] of Object.entries(CELLS)) {
            const label = parseViewerIPL([
                stx('<ESC>P'), stx('E1;F1'),
                stx(`H0;o10,10;c${id};h1;w1;d3,${THREE}`), stx('R'), stx('<ESC>E1'),
            ].join(''));
            const size = estimateElementSize(textEl(label), 203);
            const gap = FONT_MAP[id].gapWidth ?? 2;
            expect(size.lengthDots, `c${id} length`).toBe(3 * (w + gap) - gap);
            expect(size.crossDots, `c${id} height`).toBe(h);
        }
    });

    it('they no longer raise unknown-font', () => {
        for (const id of Object.keys(CELLS)) {
            const label = parseViewerIPL([
                stx('<ESC>P'), stx('E1;F1'),
                stx(`H0;o10,10;c${id};k12;d3,カナ`), stx('R'), stx('<ESC>E1'),
            ].join(''));
            expect(label.issues.filter(i => i.code === 'unknown-font'),
                `c${id} should be known now`).toEqual([]);
        }
    });
});

// c57..c60 (Kanji / Korean / Traditional Chinese / Simplified Chinese) stay OUT
// on purpose, exactly as c27 does. PRM 2.70 p.206 jumps from 56 straight to 61,
// and none of the four manuals in docs/manuals/ lists 57-60. The Seagull driver
// names them, but alongside their own font GROUP FILES and Honeywell part
// numbers — the signature of a downloadable language option, not a resident
// face — and the manual's per-printer table gives PD43-era printers the range
// "0 to 28, 30 to 41", with the 50s only "with the Kanji option".
//
// This test exists so a future session does not "complete" the range by
// inventing metrics for fonts the printer may not have. Warning is the honest
// outcome; a wrong cell would be silently wrong printing.
describe('c57..c60 stay unknown — not in the authoritative font table', () => {
    it('they are absent from FONT_MAP', () => {
        for (const id of ['57', '58', '59', '60']) {
            expect(FONT_MAP[id], `c${id} must not be added without a source`).toBeUndefined();
        }
    });

    it('a field using one warns rather than rendering silently', () => {
        for (const id of ['57', '58', '59', '60']) {
            const label = parseViewerIPL([
                stx('<ESC>P'), stx('E1;F1'),
                stx(`H0;o10,10;c${id};k12;d3,ABC`), stx('R'), stx('<ESC>E1'),
            ].join(''));
            const unknown = label.issues.filter(i => i.code === 'unknown-font');
            expect(unknown, `c${id} must warn, not pass silently`).toHaveLength(1);
        }
    });
});
