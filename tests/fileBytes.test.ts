import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bytesToByteString } from '../services/ipl/fileBytes';
import { parseViewerIPL } from '../services/ipl/viewerParser';

describe('bytesToByteString (Open File decode)', () => {
    it('round-trips every byte value 0x00–0xFF', () => {
        const bytes = new Uint8Array(256).map((_, i) => i);
        const s = bytesToByteString(bytes);
        expect(s.length).toBe(256);
        for (let i = 0; i < 256; i++) expect(s.charCodeAt(i) & 0xff).toBe(i);
    });

    it('spans the chunk boundary without dropping bytes', () => {
        const n = 0x8000 * 2 + 7;
        const bytes = new Uint8Array(n).map((_, i) => (i * 31) & 0xff);
        const s = bytesToByteString(bytes);
        expect(s.length).toBe(n);
        expect(s.charCodeAt(0x8000) & 0xff).toBe((0x8000 * 31) & 0xff);
        expect(s.charCodeAt(n - 1) & 0xff).toBe(((n - 1) * 31) & 0xff);
    });

    it('preserves the Direct Graphics payload that UTF-8 decoding destroys', async () => {
        const buf = await readFile(path.resolve('samples/bartender-tes1.ipl'));
        const exact = bytesToByteString(buf);
        // UTF-8 decoding mangles this file: high bytes become U+FFFD.
        expect(buf.toString('utf8')).toContain('�');
        expect(exact).not.toContain('�');
        expect(exact.length).toBe(buf.length);

        // And the parser still finds the RLE graphic through this decode path.
        const label = parseViewerIPL(exact);
        expect(label.elements.some(e => e.kind === 'graphic')).toBe(true);
    });
});
