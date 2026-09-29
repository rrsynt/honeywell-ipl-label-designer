import { describe, it, expect } from 'vitest';
import { parseViewerIPL } from '../services/ipl/viewerParser';

const stx = (f: string) => `<STX>${f}<ETX>`;
const stream = (...frames: string[]) => [
    stx('<ESC>P'), stx('<SI>W812'), stx('<SI>L406'), stx('E1;F1'),
    stx('H1;o10,10;c0;h2;w2;d3,ABC'),
    ...frames.map(stx), stx('R'), stx('<ESC>E1'),
].join('');
const codes = (...frames: string[]) => parseViewerIPL(stream(...frames)).issues.map(i => i.code);

/**
 * K10 (937-028-003) is the manual for this project's printer generation, and it
 * carries commands PRM 2.70 does not — `QUITIPL`, `<ESC>.x` (Execute Shell
 * Commands), `<SI>xp`/`<SI>xu` (Change Password/User), and the wireless
 * settings block (`<SI>ws,…` / `<SI>wt,…`). Every earlier sweep enumerated the
 * PRM's own indexes, so this surface had never been walked.
 *
 * The result is a clean surface, and these tests hold it that way: none of
 * these commands can change the printed image, and every one leaves the label
 * around it intact. What is pinned here is that they stay that way.
 */
describe('the K10-only command surface', () => {
    it('never changes or drops the label it wraps', () => {
        const K10_ONLY = [
            'QUITIPL', '<ESC>.x', '<ESC>.x,whoami',
            '<SI>xp,old,new', '<SI>xu,admin', '<SI>xc,foo',
            '<SI>e1', '<SI>g2', '<SI>C1', '<SI>A0', '<SI>V,1', '<SI>t1',
                '<SI>ws,SECURITY TYPE', '<SI>wt,ACCESS POINT MAC',
        ];
        for (const cmd of K10_ONLY) {
            const r = parseViewerIPL(stream(cmd));
            expect(r.elements, cmd).toHaveLength(1);
            expect((r.elements[0] as { source: { data: string } }).source.data, cmd).toBe('ABC');
        }
    });

    it('leaves QUITIPL as unrecognized, because nothing documents it', () => {
        // QUITIPL appears ONCE in the whole manual set — as a name-and-syntax
        // row in K10's index, with no `<a href>` and therefore no page behind
        // it. It is absent from PRM 2.70, from the 4400 manual, and from
        // docs/manuals/chm_dir.json.
        //
        // So there is no definition to model, and none to quote. Reporting it
        // as recognized would mean inventing an effect, which is the one thing
        // this project's sweeps exist to avoid; the honest answer for a command
        // with a name but no documented behaviour is the generic warning.
        expect(codes('QUITIPL')).toContain('unknown-frame');
    });

    it('treats Cut (<SO>) as the media command it is', () => {
        // "Cut — Advances the label out to the cutter and cuts the label
        // stock" (PRM p.99), listed in the "Print Commands (t = 0)" table as
        // "Label Cut Command". It moves MEDIA, not the image, so the preview
        // is right to draw nothing — but it is a named command and must not be
        // reported as unrecognized.
        for (const form of ['<SO>', '\x0e']) {
            const got = parseViewerIPL(stream(form)).issues.map(i => i.code);
            expect(got, JSON.stringify(form)).not.toContain('unknown-frame');
            expect(got, JSON.stringify(form)).toContain('immediate-command');
        }
    });

    it('keeps the in-block cut intact — it is a control char, not text', () => {
        // The same character inside a print block is stripped as a control
        // character, and must never reach the label as literal text.
        const ipl = [
            stx('<ESC>P'), stx('E1;F1'), stx('H0;o10,10;c0;h2;w2;d0,20'), stx('R'),
            stx('<ESC>E1<CAN><ESC>F0<NUL>AB<SO>CD<ETB><FF>'),
        ].join('');
        const label = parseViewerIPL(ipl);
        const text = (label.elements[0] as { source: { data: string } }).source.data;
        expect(text).toBe('ABCD');
        expect(text).not.toContain('<SO>');
    });

    it('does not let a K10-only command break the rest of a chained frame', () => {
        // The frame-head lesson: an unmodelled head must not eat what follows.
        const r = parseViewerIPL(stream('QUITIPL;H2;o10,60;c0;h2;w2;d3,XYZ'));
        expect(r.elements.some(e => e.kind === 'text')).toBe(true);
    });

    it('names Cut the same way chained as it does standing alone', () => {
        // The immediate-command reporter runs for a chained segment too, so the
        // same character cannot get two different answers depending on how it
        // was transported. Without that, "<SO>;R" fell to the generic warning
        // while a bare "<SO>" was named correctly.
        for (const frame of ['<SO>', '<SO>;R']) {
            const got = parseViewerIPL(stream(frame)).issues.map(i => i.code);
            expect(got, frame).toContain('immediate-command');
            expect(got, frame).not.toContain('unknown-frame');
        }
    });
});
