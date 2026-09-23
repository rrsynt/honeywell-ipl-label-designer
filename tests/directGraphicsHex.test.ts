import { describe, it, expect } from 'vitest';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { extractDirectGraphics, nibblizedToByteString } from '../services/ipl/directGraphics';
import { bytesToByteString } from '../services/ipl/fileBytes';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Raw 8-bit byte string -> two uppercase hex digits per byte (g1 form). */
const nibblize = (raw: string): string =>
    [...raw].map(c => (c.charCodeAt(0) & 0xff).toString(16).padStart(2, '0').toUpperCase()).join('');

/**
 * Rewrites a g0 stream as g1: the <ESC>g0 command becomes <ESC>g1 and every
 * payload frame that follows is nibblized until the end-of-bitmap byte (0x28)
 * closes the graphic. Non-DG frames (literal-notation commands) pass through.
 */
const toG1 = (g0: string): string => {
    const parts = g0.split(/(<STX>|<ETX>|\x02|\x03)/);
    let mode: 'off' | 'payload' = 'off';
    return parts.map(part => {
        if (part === '<STX>' || part === '<ETX>' || part === '\x02' || part === '\x03') return part;
        // Whitespace-only fragments are the CRLF the tokenizer strips between
        // frames — not payload, and nibblizing them would inject 0x0D/0x0A
        // bytes into the bitmap.
        if (part.trim() === '') return part;
        if (mode === 'off') {
            if (/^<ESC>g0$/.test(part)) mode = 'payload';
            return part.replace(/^<ESC>g0$/, '<ESC>g1');
        }
        if (/^<[A-Z]+>|^<ESC>[A-Za-z]/.test(part)) return part;
        const hex = nibblize(part);
        if (part.includes('\x28')) mode = 'off';
        return hex;
    }).join('');
};

describe('<ESC>g1 nibblized Direct Graphics', () => {
    it('round-trips the manual origin example through hex', () => {
        const raw = String.fromCharCode(0x21, 0x80, 0x43, 0xc2, 0x28);
        const { bytes, oddNibble } = nibblizedToByteString(nibblize(raw));
        expect(oddNibble).toBe(false);
        expect(extractDirectGraphics([bytes])).toEqual(extractDirectGraphics([raw]));
    });

    it('ignores whitespace and newlines an editor inserts into the hex stream', () => {
        const raw = String.fromCharCode(0x21, 0x41, 0xd8, 0x46, 0x97, 0x25, 0x83, 0x22, 0x28);
        const wrapped = nibblize(raw).replace(/(.{4})/g, '$1\r\n ');
        const [g] = extractDirectGraphics([nibblizedToByteString(wrapped).bytes]);
        const [expected] = extractDirectGraphics([raw]);
        expect(g).toEqual(expected);
        expect(g.origin).toEqual([216, 791]);
    });

    it('reports an odd trailing nibble instead of shifting the stream', () => {
        const { bytes, oddNibble } = nibblizedToByteString('218043C228F');
        expect(oddNibble).toBe(true);
        expect(bytes).toBe(String.fromCharCode(0x21, 0x80, 0x43, 0xc2, 0x28));
    });

    it('bartender-tes1: a g1 rewrite decodes to the same graphics as the binary original', async () => {
        const g0 = bytesToByteString(await readFile(path.resolve('samples/bartender-tes1.ipl')));
        const binary = parseViewerIPL(g0);
        const hex = parseViewerIPL(toG1(g0));

        const gfx = (label: typeof binary) =>
            label.elements.filter(e => e.kind === 'graphic').map(e => ({
                ox: e.ox, oy: e.oy,
                w: (e as unknown as { widthDots: number }).widthDots,
                h: (e as unknown as { heightDots: number }).heightDots,
                data: (e as unknown as { data: string }).data,
            }));
        expect(gfx(hex)).toEqual(gfx(binary));
        expect(hex.elements).toHaveLength(binary.elements.length);
        expect(hex.issues.filter(i => i.level === 'error')).toHaveLength(0);
        expect(hex.issues.some(i => i.code === 'direct-graphics')).toBe(true);
    });

    it('bartender-tes2: g1 rewrite matches the binary decode', async () => {
        const g0 = bytesToByteString(await readFile(path.resolve('samples/bartender-tes2.ipl')));
        const binary = parseViewerIPL(g0);
        const hex = parseViewerIPL(toG1(g0));
        const gfx = (label: typeof binary) => label.elements.filter(e => e.kind === 'graphic');
        expect(gfx(hex).map(e => [e.ox, e.oy])).toEqual(gfx(binary).map(e => [e.ox, e.oy]));
        expect(gfx(hex)).toHaveLength(4);
    });

    it('survives a UTF-8 paste round-trip and editor line wrapping', async () => {
        const g0 = bytesToByteString(await readFile(path.resolve('samples/bartender-tes2.ipl')));
        // What a chat window does to a long line: wrap every 76 chars, CRLF.
        // Only the hex payload lines are long enough to wrap, and the cut lands
        // on a hex-pair boundary — a wrap that sliced through "<ETX>" would be
        // a broken paste regardless of graphics mode.
        const pasted = toG1(g0).split('\n').map(line =>
            /^[0-9A-F]+$/i.test(line.trim()) ? (line.match(/.{1,76}/g) || []).join('\r\n') : line,
        ).join('\n');
        const throughUtf8 = new TextDecoder().decode(new TextEncoder().encode(pasted));
        expect(throughUtf8).toBe(pasted);

        const hex = parseViewerIPL(throughUtf8);
        const binary = parseViewerIPL(g0);
        const gfx = (label: typeof binary) => label.elements.filter(e => e.kind === 'graphic');
        expect(gfx(hex).map(e => [e.ox, e.oy, (e as unknown as { data: string }).data]))
            .toEqual(gfx(binary).map(e => [e.ox, e.oy, (e as unknown as { data: string }).data]));
    });

    it('warns once on an odd nibble and on an unsupported mode, without crashing', () => {
        const odd =
            '<STX><ESC>g1<ETX><STX>218043C228F<ETX>';
        const oddLabel = parseViewerIPL(odd);
        expect(oddLabel.issues.filter(i => i.code === 'direct-graphics-odd-nibble')).toHaveLength(1);

        const bad = parseViewerIPL('<STX><ESC>g7<ETX><STX>E1;F1<ETX><STX>H0;o10,10;c0;d3,HI<ETX><STX>R<ETX>');
        expect(bad.issues.some(i => i.code === 'direct-graphics-unknown-mode')).toBe(true);
        // The mode was rejected, so the following field still parses normally.
        expect(bad.elements.map(e => e.kind)).toEqual(['text']);
    });
});
