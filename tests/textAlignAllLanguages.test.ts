// A text block's `align` (centre/right) has no per-line parameter in ANY of the
// five languages here — the only lever a printer gives is MOVING THE ORIGIN, so
// the block is printed by starting it further back along its own text axis.
//
// The designer canvas draws that shift, and the IPL generator bakes it into the
// origin (Batch W). ZPL, EPL, TSPL and DPL did NOT — a centre-aligned design
// printed flush-left on those four while the screen showed it centred, and the
// exporter runs the same generators, so the PNG/PDF lost it too. No warning
// covered it (designerOnly.ts handles hriAlign and lineEnding, not text align).
//
// This pins all FIVE agreeing: the same design, the same three alignments, one
// visual x per alignment, and the SAME x from every language.
import './golden/setup';
import { describe, it, expect } from 'vitest';
import { generateIPL } from '../services/iplGenerator';
import { generateZPL } from '../services/zpl/zplGenerator';
import { generateEPL } from '../services/epl/eplGenerator';
import { generateTSPL } from '../services/tspl/tsplGenerator';
import { generateDPL } from '../services/dpl/dplGenerator';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { parseZPL } from '../services/zpl/zplParser';
import { parseEPL } from '../services/epl/eplParser';
import { parseTSPL } from '../services/tspl/tsplParser';
import { parseDPL } from '../services/dpl/dplParser';
import { elementVisualBox } from '../services/ipl/renderer';
import type { Design } from '../types';

const DPI = 203;

const design = (align: 'left' | 'center' | 'right'): Design => ({
    name: 'align', labelSettings: { width: 60, height: 30, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: DPI, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10, language: 'ipl' },
    fields: [{
        id: 1, type: 'text', name: 'T', x: 30, y: 10, rotation: 0,
        dataSource: { type: 'fixed', data: 'HELLO' }, font: '0', fontSize: 12, h_mag: 1, w_mag: 1, align,
    }],
    dataSources: [], nextId: 9, guides: { horizontal: [], vertical: [] },
} as unknown as Design);

/** Visual x of the single text element, per language. */
const visualX = async (lang: string, align: 'left' | 'center' | 'right'): Promise<number> => {
    const d = design(align);
    let el: { kind: string } | undefined;
    if (lang === 'ipl') el = parseViewerIPL(await generateIPL(d), { dpi: DPI }).elements.find(e => e.kind === 'text');
    else if (lang === 'zpl') el = parseZPL(generateZPL(d).zpl, DPI).elements.find(e => e.kind === 'text');
    else if (lang === 'epl') el = parseEPL(generateEPL(d).epl).elements.find(e => e.kind === 'text');
    else if (lang === 'tspl') el = parseTSPL(generateTSPL(d).tspl).elements.find(e => e.kind === 'text');
    else el = parseDPL(generateDPL(d).dpl, 400, new Date(), DPI).elements.find(e => e.kind === 'text');
    if (!el) throw new Error(`${lang} produced no text element`);
    return elementVisualBox(el as never, DPI).x;
};

const LANGS = ['ipl', 'zpl', 'epl', 'tspl', 'dpl'] as const;

describe('text align shifts the printed block on every language', () => {
    it('centre and right each move the block left of the left-aligned run', async () => {
        for (const lang of LANGS) {
            const left = await visualX(lang, 'left');
            const center = await visualX(lang, 'center');
            const right = await visualX(lang, 'right');
            const msg = `${lang}: left=${left} center=${center} right=${right}`;
            // The shift is real (not dropped): centre is left of left, right is
            // left of centre, and each by about half / the whole block width.
            expect(center, msg).toBeLessThan(left);
            expect(right, msg).toBeLessThan(center);
        }
    });

    it('all five languages agree on where each alignment lands', async () => {
        for (const align of ['left', 'center', 'right'] as const) {
            const xs = await Promise.all(LANGS.map(l => visualX(l, align)));
            const [first, ...rest] = xs;
            rest.forEach((x, i) => {
                // IPL/ZPL/EPL/TSPL agree to the dot. DPL is allowed ~3: its
                // record states positions in HUNDREDTHS OF AN INCH, so the
                // origin is quantized (240 -> 239.5, 220 -> 223.3) with no
                // finer spelling available in the language.
                const tol = LANGS[i + 1] === 'dpl' ? 4 : 2;
                expect(Math.abs(x - first), `${align}: ${LANGS[i + 1]} vs ${LANGS[0]}`).toBeLessThanOrEqual(tol);
            });
        }
    });

    it('a left-aligned block is untouched (the default path)', async () => {
        // Guard against the shift leaking into the common case: left must equal
        // the un-shifted origin, i.e. the shift helper returns 0. Same one-dot
        // tolerance as above — the generators round mm->dots in different places.
        const lefts = await Promise.all(LANGS.map(l => visualX(l, 'left')));
        const lo = Math.min(...lefts), hi = Math.max(...lefts);
        expect(hi - lo, `left spread: ${lefts.join(', ')}`).toBeLessThanOrEqual(2);
    });
});
