import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseViewerIPL } from '../services/ipl/viewerParser';

const stx = (f: string) => `<STX>${f}<ETX>`;

/**
 * Page-editing commands inside a chained frame — PRM 2.70 p.94,
 * "Page Editing Commands" (e M m O q), plus "Page, Create or Edit" S and
 * "Page, Delete" s from the Programming table (p.94).
 *
 * Found by sweeping the task tables the previous pass did not reach. The
 * failure was not that a command was dropped — it was that dropping it took the
 * REST OF THE FRAME with it, and said nothing:
 *
 *   <STX>S3;Ma,1;Mb,2<ETX>        composed the page
 *   <STX>s3;S3;Ma,1;Mb,2<ETX>     composed NOTHING, no warning
 *
 * `s3` is not a COMMAND_START letter, so it never opened a buffer; the page
 * frame that followed arrived as its PARAMETER and vanished into it. The
 * second form is not hypothetical — it is what the shipped
 * samples/bartender-auto.ipl sends, and the page it defines carries the top
 * format's placement offsets, so losing it moves real content.
 */
describe('page commands inside a chain reach their own parser', () => {
    const F1 = [stx('E1;F1'), stx('H1;o10,10;c0;h2;w2;d3,AAA'), stx('R')].join('');
    const F2 = [stx('E2;F2'), stx('H1;o10,10;c0;h2;w2;d3,BBB'), stx('R')].join('');
    const page = (ipl: string) => (parseViewerIPL(ipl) as unknown as { page?: { id: number; placements: unknown[] } }).page;

    it('composes the page whether or not a page-delete leads the chain', () => {
        const plain = page(F1 + F2 + stx('S3;Ma,1;Mb,2'));
        const chained = page(F1 + F2 + stx('s3;S3;Ma,1;Mb,2'));
        expect(plain?.placements).toHaveLength(2);
        expect(chained?.placements).toHaveLength(2);
        expect(chained).toEqual(plain);
    });

    it('keeps the placements when the page frame is rebuilt from a chain', () => {
        // The first version of the fix dispatched the bare "S3" segment, which
        // produced a page with NO placements — a lost page turned into an empty
        // one, still rendering the wrong label.
        const p = page(F1 + F2 + stx('s3;S3;Ma,1;Mb,2'));
        expect(p?.placements).toEqual([
            { position: 'a', formatId: 1, offsetX: 0, offsetY: 0, rotation: 0 },
            { position: 'b', formatId: 2, offsetX: 0, offsetY: 0, rotation: 0 },
        ]);
    });

    it('accepts an offset and a rotation as chain segments too', () => {
        const p = page(F1 + stx('S3;Ma,1;O5,7;q1'));
        expect(p?.placements).toEqual([
            { position: 'a', formatId: 1, offsetX: 5, offsetY: 7, rotation: 1 },
        ]);
    });

    it('deletes a page that the stream defined, and says so', () => {
        // "Page, Delete … Deletes page n" (PRM p.206). The printer drops the
        // composition; a preview still drawing it would show a label the
        // printer no longer holds, so this is reported rather than silent.
        for (const del of [stx('s3'), stx('s3;R')]) {
            const r = parseViewerIPL(F1 + F2 + stx('S3;Ma,1;Mb,2') + del);
            expect((r as unknown as { page?: unknown }).page).toBeUndefined();
            expect(r.issues.map(i => i.code)).toContain('page-deleted');
        }
    });

    it('stays silent when the deleted page is not the one this stream made', () => {
        const r = parseViewerIPL(F1 + F2 + stx('S3;Ma,1;Mb,2') + stx('s5'));
        expect((r as unknown as { page?: unknown }).page).toBeDefined();
        expect(r.issues.map(i => i.code)).not.toContain('page-deleted');
    });

    it('does not mistake an unknown "s" chain for a page delete', () => {
        // Only the documented `sn` shape is a command; a segment that merely
        // starts with the letter stays whatever it was.
        const r = parseViewerIPL(F1 + stx('S3;Ma,1;Sb,2'));
        expect(r.issues.map(i => i.code)).not.toContain('page-deleted');
    });
});

describe('the other two page commands reach a decision as well', () => {
    // Both are in the same Page Editing table (p.94) and were equally silent.
    const F1 = [stx('E1;F1'), stx('H1;o10,10;c0;h2;w2;d3,AAA'), stx('R')].join('');
    const F2 = [stx('E2;F2'), stx('H1;o10,10;c0;h2;w2;d3,BBB'), stx('R')].join('');
    const composed = F1 + F2 + stx('S3;Ma,1;Mb,2');
    const placements = (ipl: string) =>
        (parseViewerIPL(ipl) as unknown as { page?: { placements: { position: string; formatId: number }[] } }).page?.placements;

    it('mp removes the assigned position from the page', () => {
        // "Deletes the format position p from a page" (PRM p.194) — the format
        // it carried stops contributing, so this changes the printed label.
        expect(placements(composed + stx('ma'))).toEqual([{ position: 'b', formatId: 2, offsetX: 0, offsetY: 0, rotation: 0 }]);
        expect(placements(composed + stx('ma;R'))).toEqual([{ position: 'b', formatId: 2, offsetX: 0, offsetY: 0, rotation: 0 }]);
    });

    it('mp stays silent when the position is not assigned', () => {
        // Nothing is removed, so there is nothing to report.
        const r = parseViewerIPL(composed + stx('mz'));
        expect(placements(composed + stx('mz'))).toHaveLength(2);
        expect(r.issues.map(i => i.code)).not.toContain('page-position-deleted');
    });

    it('en is announced when it makes a format a slave of another', () => {
        // PRM p.183: n=1 makes the format a slave of the format at position m1.
        // Not modelled — the master's data arrives at print time — but silence
        // would hide a real divergence.
        for (const del of [stx('e1'), stx('e1;a')]) {
            expect(parseViewerIPL(composed + del).issues.map(i => i.code)).toContain('page-data-source-modelled');
        }
    });

    it('en with the documented default n=0 stays silent', () => {
        // n=0 means "format receives its data during Print mode" — what the
        // preview already assumes, so there is no divergence to report.
        for (const del of [stx('e0'), stx('e0,1,2')]) {
            expect(parseViewerIPL(composed + del).issues.map(i => i.code)).not.toContain('page-data-source-modelled');
        }
    });
});

describe('the shipped sample keeps the page it defines', () => {
    it('bartender-auto.ipl composes through its real s3;S3;... line', () => {
        // The regression that started this: the sample ships
        // "<STX>s3;S3;Ma,1;Mb,2<ETX>" and its page was being dropped silently.
        const raw = readFileSync('samples/bartender-auto.ipl', 'utf8');
        const r = parseViewerIPL(raw);
        const p = (r as unknown as { page?: { placements: unknown[] } }).page;
        expect(p).toBeDefined();
        expect(p?.placements).toHaveLength(2);
        // And it must be identical to what the same stream would compose if the
        // leading delete were written as its own frame.
        const equivalent = parseViewerIPL(raw.replace('<STX>s3;S3;Ma,1;Mb,2<ETX>', '<STX>S3;Ma,1;Mb,2<ETX>'));
        expect(p).toEqual((equivalent as unknown as { page?: unknown }).page);
    });
});
