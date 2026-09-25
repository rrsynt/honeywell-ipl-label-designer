// Batch T (2026-09-24): the Labelary cross-check converter (tools/ipl2zpl.mjs)
// had two real bugs found by comparing our golden renders against Labelary's:
// (1) ^PW/^LL were only read from frames STARTING with <SI>, but this app's
// generator (and BarTender) emit the combined "<ESC>C<SI>W…<SI>h" config
// frame — so Labelary rendered every non-812-dot label on the wrong paper;
// (2) date/time placeholders were the generic [DATE]/[TIME] instead of the
// renderer's format-expanded "[DD/MM/YYYY]" etc. — inflating the text-width
// divergence for the wrong reason. Pinned offline here; the Labelary fetch
// itself stays in `npm run crosscheck` (network tool, not a test).
import { describe, it, expect } from 'vitest';
import { iplToZpl } from '../tools/ipl2zpl.mjs';

describe('ipl2zpl paper-size extraction (crosscheck bug 1)', () => {
    it('reads ^PW/^LL from the combined <ESC>C<SI>W… frame', () => {
        const zpl = iplToZpl([
            '<STX><ESC>C<SI>W640<SI>L320<ETX>',
            '<STX><ESC>P<ETX>',
            '<STX>E1;F1;<ETX>',
            '<STX>H0;o20,20;c25;k12;d3,HI<ETX>',
            '<STX>R<ETX>',
        ].join('\n'), 203);
        expect(zpl).toContain('^PW640');
        expect(zpl).toContain('^LL320');
    });

    it('reads them from a standalone <SI> frame too (BarTender style)', () => {
        const zpl = iplToZpl([
            '<STX><SI>W812<ETX>',
            '<STX><SI>L400<ETX>',
            '<STX><ESC>P<ETX>', '<STX>E1;F1;<ETX>', '<STX>H0;o20,20;c25;k12;d3,HI<ETX>', '<STX>R<ETX>',
        ].join('\n'), 203);
        expect(zpl).toContain('^PW812');
        expect(zpl).toContain('^LL400');
    });

    it('omits PW/LL when the stream declares none (Labelary default is fine)', () => {
        const zpl = iplToZpl([
            '<STX><ESC>P<ETX>', '<STX>E1;F1;<ETX>', '<STX>H0;o20,20;c25;k12;d3,HI<ETX>', '<STX>R<ETX>',
        ].join('\n'), 203);
        expect(zpl).not.toMatch(/\^PW\d/);
        expect(zpl).not.toMatch(/\^LL\d/);
    });
});

describe('ipl2zpl agrees with the viewer on d4/d5', () => {
    // d4/d5 are not IPL commands (PRM p.184 defines only d0-d3). Both sides
    // used to expand them into a [DD/MM/YYYY] placeholder, so the crosscheck
    // compared text no printer would ever produce and agreed with itself.
    it('emits no invented text for a d4/d5 field', () => {
        const zpl = iplToZpl([
            '<STX><ESC>P<ETX>', '<STX>E1;F1;<ETX>',
            '<STX>H0;o20,20;c25;k12;d4,3<ETX>',
            '<STX>H1;o20,50;c25;k14;d5,5<ETX>',
            '<STX>R<ETX>',
        ].join('\n'), 203);
        expect(zpl).not.toContain('[DD/MM/YYYY]');
        expect(zpl).not.toContain('[HH:MM am/pm]');
        expect(zpl).not.toContain('[DATE]');
        expect(zpl).not.toContain('[TIME]');
    });

    it('leaves a real fixed field alone', () => {
        const zpl = iplToZpl([
            '<STX><ESC>P<ETX>', '<STX>E1;F1;<ETX>',
            '<STX>H0;o20,20;c25;k12;d3,2026/09/25<ETX>',
            '<STX>R<ETX>',
        ].join('\n'), 203);
        expect(zpl).toContain('^FD2026/09/25^FS');
    });
});

describe('ipl2zpl keeps prior behavior', () => {
    it('chained frames expand into fields with origins preserved', () => {
        const zpl = iplToZpl('<STX><ESC>P;E1;F1;H1;o100,100;f0;c25;k12;d3,Hello World!;B2;o100,200;f0;c6;h80;w2;i1;d3,12345678;R<ETX>', 203);
        expect(zpl).toContain('^FO100,100');
        expect(zpl).toContain('^FDHello World!^FS');
        expect(zpl).toContain('^FO100,200');
        expect(zpl).toContain('^BCN');
    });

    it('quantity from <RS> carries to ^PQ', () => {
        const zpl = iplToZpl([
            '<STX><ESC>P<ETX>', '<STX>E1;F1;<ETX>', '<STX>H0;o20,20;c25;k12;d3,HI<ETX>', '<STX>R<ETX>',
            '<STX><ESC>E1<CAN><RS>4<ETB><FF><ETX>',
        ].join('\n'), 203);
        expect(zpl).toContain('^PQ4');
    });

    it('every golden converts without throwing and carries its declared size', async () => {
        const fs = await import('node:fs');
        for (const name of ['product', 'box-date', 'chained', 'external', 'codabar']) {
            const ipl = fs.readFileSync(`testdata/golden/${name}.ipl`, 'utf8');
            const zpl = iplToZpl(ipl, 203);
            expect(zpl.length, name).toBeGreaterThan(60);
            const w = /<SI>W(\d+)/.exec(ipl);
            if (w) expect(zpl, `${name} PW`).toContain(`^PW${w[1]}`);
        }
    });
});
