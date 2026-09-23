import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bytesToByteString, detectMojibake, convertDirectGraphicsToHex } from '../services/ipl/fileBytes';
import { parseViewerIPL } from '../services/ipl/viewerParser';

const read = (name: string) =>
    readFile(path.resolve('samples', name)).then(bytesToByteString);

const gfxOf = (src: string) =>
    parseViewerIPL(src).elements
        .filter(e => e.kind === 'graphic')
        .map(e => ({
            ox: e.ox, oy: e.oy,
            data: (e as unknown as { data: string }).data,
        }));

describe('convertDirectGraphicsToHex (Copy ASCII g1)', () => {
    it('rewrites bartender-tes1 to pure ASCII that decodes identically', async () => {
        const src = await read('bartender-tes1.ipl');
        const { ipl, converted } = convertDirectGraphicsToHex(src);

        expect(converted).toBe(true);
        expect(detectMojibake(ipl).highCharCount).toBe(0);
        expect(ipl).toContain('<ESC>g1');
        expect(ipl).not.toContain('<ESC>g0');
        // No byte above ASCII anywhere, so a UTF-8 paste changes nothing.
        expect(new TextDecoder().decode(new TextEncoder().encode(ipl))).toBe(ipl);

        expect(gfxOf(ipl)).toEqual(gfxOf(src));
        expect(parseViewerIPL(ipl).elements).toHaveLength(parseViewerIPL(src).elements.length);
    });

    it('rewrites every g0 region of bartender-tes2', async () => {
        const src = await read('bartender-tes2.ipl');
        const { ipl, converted } = convertDirectGraphicsToHex(src);
        expect(converted).toBe(true);
        expect(detectMojibake(ipl).highCharCount).toBe(0);
        expect(ipl.match(/<ESC>g1/g)).toHaveLength(4);
        expect(gfxOf(ipl)).toEqual(gfxOf(src));
    });

    it('leaves a stream without direct graphics untouched apart from notation', () => {
        const src = '<STX><ESC>P<ETX><STX>E1;F1<ETX><STX>H0;o10,10;c0;d3,HI<ETX><STX>R<ETX>';
        const { ipl, converted } = convertDirectGraphicsToHex(src);
        expect(converted).toBe(false);
        expect(ipl.replace(/\r\n/g, '')).toBe(src);
        expect(parseViewerIPL(ipl).elements.map(e => e.kind)).toEqual(['text']);
    });

    it('keeps a d3 payload containing semicolons and control-like text verbatim', () => {
        const src = '<STX>E1;F1<ETX><STX>H0;o10,10;c0;d3,A;B <RS>50<ETX><STX>R<ETX>';
        const { ipl, converted } = convertDirectGraphicsToHex(src);
        expect(converted).toBe(false);
        expect(ipl).toContain('d3,A;B <RS>50');
    });

    it('does not nibblize commands interleaved inside a graphics region', () => {
        const payload = String.fromCharCode(0x21, 0x80, 0x8a, 0x25, 0x83, 0x22, 0x28);
        const src = `<STX><ESC>g0<ETX><STX><SI>l13<ETX><STX>${payload}<ETX>`;
        const { ipl } = convertDirectGraphicsToHex(src);
        expect(ipl).toContain('<STX><SI>l13<ETX>');
        expect(ipl).toContain('<STX>' + [...payload].map(c =>
            (c.charCodeAt(0) & 0xff).toString(16).padStart(2, '0').toUpperCase()).join('') + '<ETX>');
        expect(gfxOf(ipl)).toEqual(gfxOf(src));
    });
});
