// Full outline-font coverage (PRM 2.70 p.206). Before this, only 10 of the 30
// documented outline ids were in FONT_MAP, so a stream using c31/c62/c67… got a
// spurious "unknown font" warning and painted with a fallback face.
import './golden/setup';
import { describe, it, expect } from 'vitest';
import { FONT_MAP, FONT_FAMILIES, fontStack } from '../constants';
import { parseViewerIPL, OUTLINE_FONTS } from '../services/ipl/viewerParser';
import type { TextElement } from '../services/ipl/types';

const stx = (f: string) => `<STX>${f}<ETX>`;

/** Every id the 2.70 manual lists as an outline font. */
const DOCUMENTED_OUTLINE_IDS = [
    '20', '21', '22', '23', '24', '25', '26', '28',
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

describe('fontStack', () => {
    it('resolves a family to its vendored stack', () => {
        expect(fontStack('sans-serif')).toContain('Liberation Sans');
        expect(fontStack('serif')).toContain('Liberation Serif');
        expect(fontStack('monospace')).toContain('Liberation Mono');
        // c67: Century Schoolbook's metric-exact GUST-licensed substitute.
        expect(fontStack('schoolbook')).toContain('TeX Gyre Schola');
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
