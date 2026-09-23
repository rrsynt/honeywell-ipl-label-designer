import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { bytesToByteString } from '../services/ipl/fileBytes';
import { parseViewerIPL } from '../services/ipl/viewerParser';

/**
 * Pins the two facts the 2026-09-23 BarTender audit settled by measuring
 * testdata/bartender-tes1-export.png (see docs/research/BARTENDER-COMMAND-AUDIT.md):
 * the box `w` parameter is border thickness, and a barcode that omits `i`
 * prints no interpretive of its own — BarTender sends separate H fields.
 */
describe('BarTender stream audit', () => {
    it('tes1: box border thickness comes from w, and no barcode doubles its HRI', async () => {
        const label = parseViewerIPL(bytesToByteString(await readFile('samples/bartender-tes1.ipl')));

        const box = label.elements.find(e => e.kind === 'box');
        expect(box).toMatchObject({ widthDots: 492, heightDots: 770, thicknessDots: 3 });

        const barcodes = label.elements.filter(e => e.kind === 'barcode');
        expect(barcodes.length).toBeGreaterThan(0);
        expect(barcodes.every(e => e.kind === 'barcode' && e.hri === 0)).toBe(true);

        // tes1's stream carries exactly 17 H fields and nothing else that
        // could become text — no doubled interpretive sneaks in.
        const texts = label.elements.filter(e => e.kind === 'text');
        expect(texts).toHaveLength(17);
        expect(texts.every(e => e.kind === 'text' && e.font === '26')).toBe(true);
        expect(label.issues.filter(i => i.level !== 'info')).toHaveLength(0);
    });

    it('tes1 and tes2: the print block asks for exactly one label', async () => {
        for (const name of ['bartender-tes1.ipl', 'bartender-tes2.ipl']) {
            const label = parseViewerIPL(bytesToByteString(await readFile('samples/' + name)));
            expect(label.settings.quantity).toBe(1);
            expect(label.settings.batchCount).toBe(1);
        }
    });
});
