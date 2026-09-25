// Pitch `gn` (PRM p.197 / 2.70 p.206 / 4400 7-120), the last §15 item that
// could be closed from the manuals alone.
//
//   "Sets the pitch size that defines the size of the characters in
//    human-readable fields. ... When you use the pitch size command, you
//    disable the height and width magnification and point. Syntax: gn.
//    Default n = 12. 1 to 50. ... Pitch is characters per line. The higher
//    the pitch, the smaller the characters."
//
// Two things follow, and both are easy to get wrong:
//
//  * It is a THIRD sizing mode, not another parameter. A field carrying g must
//    ignore h, w AND k — so the parser must not let a stale point size leak in
//    from the outline path, and the renderer must not let fillText's own
//    advance win over the pitch.
//  * The manuals never tabulate a height per pitch value, so the only quantity
//    they define is the count. Sizing follows from that: n characters span the
//    label's width. anything else would be invented.
//
// Note the cheat sheet used to call `g` "intercharacter space in dots"; that is
// wrong and this file is the correction.

import './golden/setup';
import { describe, it, expect, beforeAll } from 'vitest';
import { newRealCanvas } from './golden/setup';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { renderLabel, computeLabelExtent, estimateElementSize } from '../services/ipl/renderer';
import type { TextElement } from '../services/ipl/types';

const stx = (f: string) => `<STX>${f}<ETX>`;

beforeAll(async () => { /* no barcode engine needed */ });

const LABEL_W = 800;

const parseField = (fieldParams: string) => parseViewerIPL([
    stx('<ESC>P'), stx(`<SI>W${LABEL_W}<ETX>`), stx('<SI>L600<ETX>'),
    stx('E1;F1'), stx(`H0;${fieldParams}`), stx('R'), stx('<ESC>E1'),
].join(''));

const textEl = (label: ReturnType<typeof parseViewerIPL>): TextElement =>
    label.elements.find(e => e.kind === 'text') as TextElement;

/** Ink width of a rendered field. */
const inkWidth = (label: ReturnType<typeof parseViewerIPL>) => {
    const extent = computeLabelExtent(label, 203);
    const canvas = newRealCanvas(extent.widthDots, extent.heightDots);
    renderLabel(canvas as unknown as HTMLCanvasElement, label, extent, { dpi: 203, pxPerDot: 1, quality: 1 });
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let minX = canvas.width, maxX = -1;
    for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
            if (data[(y * canvas.width + x) * 4] < 128) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
            }
        }
    }
    return { w: maxX - minX + 1, minX, maxX };
};

describe('pitch parsing', () => {
    it('records the advance the pitch implies across the label', () => {
        // 20 characters per line on an 800-dot label is 40 dots each.
        const el = textEl(parseField('o10,10;c0;g20;d3,ABCDEFGHIJKLMNOPQRST'));
        expect(el.pitchAdvanceDots).toBe(40);
    });

    it('defaults nothing: an absent g leaves the field alone', () => {
        const el = textEl(parseField('o10,10;c0;h2;w2;d3,AB'));
        expect(el.pitchAdvanceDots).toBeUndefined();
    });

    it('pitch disables h, w and k (manual: "you disable the height and width magnification and point")', () => {
        const el = textEl(parseField('o10,10;c25;k30;h9;w9;g25;d3,AB'));
        expect(el.pitchAdvanceDots).toBe(LABEL_W / 25);
        expect(el.hMag, 'magnification is neutralised').toBe(1);
        expect(el.wMag, 'magnification is neutralised').toBe(1);
        // An outline face still needs a canvas size; it must come from the
        // pitch, not from a stale k that would contradict it.
        expect(el.pointSize).toBeDefined();
        expect(el.pointSize).not.toBe(30);
    });

    it('warns and ignores a pitch outside 1-50', () => {
        for (const bad of ['0', '51']) {
            const label = parseField(`o10,10;c0;g${bad};d3,AB`);
            expect(textEl(label).pitchAdvanceDots, `g${bad}`).toBeUndefined();
            expect(label.issues.some(i => i.code === 'pitch-out-of-range'), `g${bad}`).toBe(true);
        }
    });

    it('warns when the stream never set a label width to size against', () => {
        const label = parseViewerIPL([
            stx('<ESC>P'), stx('E1;F1'), stx('H0;o10,10;c0;g20;d3,AB'), stx('R'), stx('<ESC>E1'),
        ].join(''));
        expect(textEl(label).pitchAdvanceDots).toBeUndefined();
        expect(label.issues.some(i => i.code === 'pitch-without-width')).toBe(true);
    });
});

describe('pitch changes the drawn size', () => {
    it('the sample text fills the label exactly once at its own pitch', () => {
        // 20 characters at pitch 20 on an 800-dot label = one full line.
        const ink = inkWidth(parseField('o0,10;c0;g20;d3,ABCDEFGHIJKLMNOPQRST'));
        expect(ink.w, `ink width ${ink.w} should span the 800-dot label`).toBeGreaterThan(LABEL_W * 0.85);
        expect(ink.w).toBeLessThanOrEqual(LABEL_W);
    });

    it('a higher pitch draws smaller characters — the manual\'s own words', () => {
        const wide = inkWidth(parseField('o0,10;c0;g10;d3,ABCDE'));
        const narrow = inkWidth(parseField('o0,10;c0;g40;d3,ABCDE'));
        expect(narrow.w, `g40 ${narrow.w} < g10 ${wide.w}`).toBeLessThan(wide.w);
    });

    it('the spacing is the pitch, not the font\'s own advance', () => {
        // Ten characters at pitch 10 on an 800-dot label must span ~800 dots.
        // c0's native advance is 8 dots, which would give ~80 — if fillText's
        // own advance leaked through, this would collapse to that.
        const ink = inkWidth(parseField('o0,10;c0;g10;d3,ABCDEFGHIJ'));
        expect(ink.w).toBeGreaterThan(700);
    });

    it('the reported size is the pitched field box, and the ink fits inside it', () => {
        // estimateElementSize drives anchors, extent and hit-testing, and what
        // it reports is the FIELD box: n characters per line means the line
        // occupies n x advance, which is the whole label at this pitch. The
        // drawn ink stops short of that by the last cell's unused right-hand
        // side, exactly as the bitmap path does (`maxChars * advance - gap`) —
        // so the assertion is containment, not equality.
        const label = parseField('o0,10;c0;g20;d3,ABCDEFGHIJKLMNOPQRST');
        const size = estimateElementSize(textEl(label), 203);
        const ink = inkWidth(label);
        expect(size.lengthDots).toBe(LABEL_W);
        expect(ink.w).toBeLessThanOrEqual(size.lengthDots);
        // ...and close enough that the field is not wildly over-reserved.
        expect(size.lengthDots - ink.w, 'unused right edge').toBeLessThan(size.lengthDots / 10);
    });
});

describe('pitch interacts correctly with the other text features', () => {
    it('pitch + r1 puts the pitch advance along the glyph axis', () => {
        // r1 turns each glyph in place; the advance still runs along the field
        // axis, so the drawn span is unchanged from the r0 case.
        const flat = inkWidth(parseField('o0,10;c0;g20;r0;d3,ABCDEFGHIJKLMNOPQRST'));
        const turned = inkWidth(parseField('o0,10;c0;g20;r1;d3,ABCDEFGHIJKLMNOPQRST'));
        expect(Math.abs(turned.w - flat.w)).toBeLessThanOrEqual(4);
    });

    it('a pitched field keeps the border box around the pitched text', () => {
        const label = parseField('o10,10;c0;g20;b3;d3,ABCDEFGHIJ');
        const el = textEl(label);
        expect(el.borderDots).toBe(3);
        expect(inkWidth(label).w).toBeGreaterThan(100);
    });
});
