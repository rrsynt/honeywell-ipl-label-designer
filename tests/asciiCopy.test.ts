import './golden/setup';
import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { newRealCanvas } from './golden/setup';
import { bytesToByteString, detectMojibake, convertDirectGraphicsToHex } from '../services/ipl/fileBytes';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { renderLabel, computeLabelExtent } from '../services/ipl/renderer';
import { ensureBarcodesReady } from '../services/ipl/barcodes';

beforeAll(async () => { await ensureBarcodesReady(); });

const read = (name: string) =>
    readFile(path.resolve('samples', name)).then(bytesToByteString);

const gfxOf = (src: string) =>
    parseViewerIPL(src).elements
        .filter(e => e.kind === 'graphic')
        .map(e => ({
            ox: e.ox, oy: e.oy,
            data: (e as unknown as { data: string }).data,
        }));

/** Renders a label to a 1-bit mask so two renders can be compared exactly. */
const renderMask = (src: string) => {
    const label = parseViewerIPL(src);
    const extent = computeLabelExtent(label, 203);
    const canvas = newRealCanvas(extent.widthDots, extent.heightDots);
    renderLabel(canvas as unknown as HTMLCanvasElement, label, extent,
        { dpi: 203, pxPerDot: 1, quality: 1, rotation: 0 });
    const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const mask = new Uint8Array(canvas.width * canvas.height);
    for (let i = 0; i < mask.length; i++) {
        const o = i * 4;
        if (d[o + 3] > 0 && d[o] < 128 && d[o + 1] < 128 && d[o + 2] < 128) mask[i] = 1;
    }
    return { mask, width: canvas.width, height: canvas.height };
};

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

/**
 * Goal #3 for BarTender's mode A: a stream printed with Direct Graphics off
 * arrives as pure ASCII, so copying it out of a text editor, into a chat, and
 * back changes nothing at all. The golden suite already pins how this stream
 * renders; what it cannot show is that the clipboard journey is lossless, which
 * is the part a user actually experiences.
 */
describe('BarTender mode A survives a clipboard round-trip', () => {
    it('bartender-logo is pure ASCII, so UTF-8 is a no-op on it', async () => {
        const raw = await readFile(path.resolve('samples', 'bartender-logo.ipl'));
        expect(raw.every((b) => b < 0x80), 'mode A sample carries a byte above ASCII')
            .toBe(true);

        const src = bytesToByteString(raw);
        // Decode the raw bytes exactly as a textarea would, rather than
        // encoding a string first: for ASCII the two agree, but only this form
        // models the file -> clipboard -> textarea path for a binary sample.
        const pasted = new TextDecoder('utf-8').decode(raw);
        expect(pasted).toBe(src);
        expect(detectMojibake(pasted).highCharCount).toBe(0);
    });

    it('renders identically after a paste, byte for byte', async () => {
        const raw = new Uint8Array(await readFile(path.resolve('samples', 'bartender-logo.ipl')));
        const src = bytesToByteString(raw);
        const before = renderMask(src);
        const after = renderMask(new TextDecoder('utf-8').decode(raw));

        expect(after.width).toBe(before.width);
        expect(after.height).toBe(before.height);
        expect(after.mask).toEqual(before.mask);
    }, 30000); // two full bwip + napi-canvas renders under parallel suite load

    it('survives an editor that rewrites line endings', async () => {
        // BarTender frames are delimited by \r\n, and a browser textarea
        // normalizes CRLF to LF on paste. The parser tolerates either, which is
        // what makes copy-paste work at all; the render must not move.
        const src = await read('bartender-logo.ipl');
        const before = renderMask(src);
        const lfOnly = src.replace(/\r\n/g, '\n');
        expect(lfOnly).not.toBe(src);

        const after = renderMask(lfOnly);
        expect(after.width).toBe(before.width);
        expect(after.height).toBe(before.height);
        expect(after.mask).toEqual(before.mask);
    });
});

/**
 * BarTender mode C -- binary Direct Graphics -- cannot survive a paste, and the
 * reason is arithmetic rather than a defect: the payloads carry bytes above
 * 0x7f, and a text channel either mangles them or drops them. The requirement
 * is therefore not that it survive, but that it never render as a plausible-
 * looking wrong label without saying so.
 */
describe('BarTender mode C: corrupt paste is detected, never silently rendered', () => {
    it('a lossy paste is detected and renders differently from the original', async () => {
        // A paste into a textarea hands the file's raw bytes to a UTF-8 decoder.
        // The g0 payloads carry bytes 0x80-0xFF, which are not valid UTF-8 on
        // their own, so each one decodes to U+FFFD. That is what
        // detectMojibake counts -- code points above U+00FF -- and it is why the
        // byte-exact file path exists at all.
        const raw = new Uint8Array(await readFile(path.resolve('samples', 'bartender-tes1.ipl')));
        const src = bytesToByteString(raw);
        expect(detectMojibake(src).highCharCount, 'byte-exact source is not mojibake')
            .toBe(0);

        const pasted = new TextDecoder('utf-8').decode(raw);
        expect(pasted).toContain('�');
        expect(detectMojibake(pasted).highCharCount, 'paste loss goes undetected')
            .toBeGreaterThan(50);

        // The point of the warning banner: the damaged render is visibly
        // different, so nothing is lost silently.
        const before = renderMask(src);
        const after = renderMask(pasted);
        expect([after.width, after.height]).not.toEqual([before.width, before.height]);
    });

    it('converting the damaged paste to g1 restores the original render', async () => {
        // The recovery the banner offers. It cannot work from a paste -- the
        // bytes are already gone -- so this starts from the byte-exact source
        // and proves the conversion itself is faithful, which is what makes the
        // banner's advice worth acting on.
        const src = await read('bartender-tes1.ipl');
        const { ipl, converted } = convertDirectGraphicsToHex(src);
        expect(converted).toBe(true);
        expect(detectMojibake(ipl).highCharCount).toBe(0);

        const after = renderMask(ipl);
        const before = renderMask(src);
        expect(after.width).toBe(before.width);
        expect(after.height).toBe(before.height);
        expect(after.mask).toEqual(before.mask);
    }, 30000); // two full bwip + napi-canvas renders under parallel suite load

    it('every binary sample is detected, and the ASCII one is not', async () => {
        // A regression guard on the detector itself: it must fire on all four
        // binary streams and stay silent on the mode A one, or the banner is
        // either crying wolf or asleep.
        for (const name of ['bartender-tes1', 'bartender-tes2', 'bartender-auto', 'bartender-parity-base']) {
            const raw = new Uint8Array(await readFile(path.resolve('samples', `${name}.ipl`)));
            const pasted = new TextDecoder('utf-8').decode(raw);
            expect(detectMojibake(pasted).hasCorruption, `${name} paste goes undetected`)
                .toBe(true);
        }
        const logo = new Uint8Array(await readFile(path.resolve('samples', 'bartender-logo.ipl')));
        expect(detectMojibake(new TextDecoder('utf-8').decode(logo)).hasCorruption,
            'mode A sample should paste cleanly').toBe(false);
    });
});
