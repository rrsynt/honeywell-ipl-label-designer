import { describe, it, expect } from 'vitest';
import { parseViewerIPL } from '../services/ipl/viewerParser';

const stx = (f: string) => `<STX>${f}<ETX>`;
const stream = (frame: string) => [
    stx('<ESC>P'), stx('<SI>W812'), stx('<SI>L406'), stx('E1;F1'),
    stx(frame), stx('R'), stx('<ESC>E1'),
].join('');

/**
 * An unrecognized command at the head of a chained frame used to destroy the
 * whole frame.
 *
 * `parseFrame` tested /^[A-Z]/ BEFORE it tested for a chain, so any
 * upper-case head reached `parseFieldFrame` — which fails to match a field
 * header and returns. Everything behind it went with it:
 *
 *   <STX>Z40;H1;o10,10;c0;h2;w2;d3,ABC<ETX>   produced ZERO elements
 *
 * The valid text field inside was never parsed and only a generic
 * "unrecognized command frame" was reported, which points at Z40 but says
 * nothing about the field that vanished. Twelve heads were measured behaving
 * this way (Z X Q J N T A Y K P J …), found by sweeping the manual's Bitmap
 * UDF and Programming task tables (PRM 2.70 pp.92-95) — the same tables that
 * produced the Code 39 prefix and page-command findings.
 *
 * The head is now tested before the catch-all, and a segment in command
 * position with no header is dispatched through the plain-frame path so it
 * gets exactly the reporting it would get standing alone.
 */
describe('a chained frame survives an unrecognized head', () => {
    const els = (frame: string) => parseViewerIPL(stream(frame)).elements;
    const codes = (frame: string) => parseViewerIPL(stream(frame)).issues.map(i => i.code);
    const FIELD = 'H1;o10,10;c0;h2;w2;d3,ABC';

    it('keeps the field behind every unmodelled head', () => {
        // Each of these heads reaches the catch-all when it stands alone.
        for (const head of ['Z40', 'X2', 'Q1', 'J5', 'N', 'T3', 'K5', 'Y9', 'z5', 't65', 'j5', 'a2', 'n1']) {
            const got = els(`${head};${FIELD}`);
            expect(got, `head "${head}" ate the field behind it`).toHaveLength(1);
            expect((got[0] as { source: { data: string } }).source.data).toBe('ABC');
        }
    });

    it('reports the head instead of staying silent', () => {
        // Silence was the older failure mode for a lowercase head: `z5;…`
        // produced the field and said NOTHING about the command it dropped.
        for (const head of ['Z40', 'X2', 'z5', 't65', 'Q1']) {
            expect(codes(`${head};${FIELD}`), `head "${head}" was silent`).toContain('unknown-frame');
        }
    });

    it('leaves a frame headed by a real field command exactly as it was', () => {
        // The fix must not reroute these: a field head keeps parseFieldFrame's
        // own d3-greedy handling, and the named graphic header
        // ("G1,LOGO;x8;…") is ONE definition, not a chain.
        const twoTextFieldsSeparate = [
            stx('<ESC>P'), stx('E1;F1'), stx('H1;o10,10;c0;h2;w2;d3,ABC'),
            stx('H2;o10,60;c0;h2;w2;d3,XYZ'), stx('R'),
        ].join('');
        expect(parseViewerIPL(twoTextFieldsSeparate).elements).toHaveLength(2);

        // A graphic becomes an ELEMENT through the U field that places it; the
        // G frame alone is a definition.
        const namedGraphic = [
            stx('<ESC>P'), stx('E1;F1'), stx('G1,LOGO;x8;y8;u1,@A'),
            stx('U1;o10,10;f0;h1;w1;c1'), stx('R'),
        ].join('');
        const g = parseViewerIPL(namedGraphic).elements.find(e => e.kind === 'graphic') as { name?: string; widthDots?: number };
        expect(g?.name).toBe('LOGO');
        expect(g?.widthDots).toBe(8);
    });

    it('still reports a bare unrecognized command sent as its own frame', () => {
        // The standalone path must keep working: this is the shape the older
        // test in iplViewer.test.ts pins, and the reason /^[A-Z]/ exists.
        const r = parseViewerIPL(stream('X9;weird'));
        const warn = r.issues.find(i => i.code === 'unknown-frame');
        expect(warn).toBeDefined();
        expect(warn!.command).toContain('X9');
    });
});
