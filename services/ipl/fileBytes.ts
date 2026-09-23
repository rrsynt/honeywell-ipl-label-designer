import { tokenizeFramesWithLines } from './tokenizer';

// Byte-exact decoding of uploaded IPL files.
//
// IPL streams from BarTender interleave ASCII commands with raw Direct Graphics
// RLE payloads, so opening a file must be byte-preserving. `File.text()` assumes
// UTF-8 and collapses every high byte to U+FFFD; `TextDecoder('latin1')` is
// aliased to windows-1252 by the WHATWG encoding spec (0x85 → U+2026), which is
// equally lossy. Only a manual charCode mapping round-trips through the
// `charCodeAt(0) & 0xff` reads in directGraphics.ts.

/** Chunk size for the spread call — keeps us under the argument-count limit. */
const CHUNK = 0x8000;

/** Decode bytes to a string with one char per byte (U+0000–U+00FF). */
export function bytesToByteString(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let out = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return out;
}

/** Detect potential mojibake/corruption in a JS string.
 *
 * When users paste IPL code from files saved as Windows ANSI (cp1252) or other
 * non-UTF-8 encodings, the browser's UTF-8 decode will fail and produce ``
 * replacement characters. Since we only control client-side here, we cannot
 * recover lost bytes — but we can detect the condition early and warn the user.
 *
 * Returns true if string contains high-byte values (charCode > 0xFF), which
 * indicate either:
 *   - UTF-8 decode failures (one or more bytes became U+FFFD)
 *   - Double-encoded cp1252 sequences (e.g., ' becomes U+2018)
 *   - Raw RLE payload that was NOT decoded by UTF-8 (edge case where paste
 *     somehow preserved binary data correctly)
 *
 * For BarTender-generated IPL, >100 high chars is a strong signal of corruption.
 * Pure ASCII labels (product.ipl, etc.) should have 0 high chars.
 */
export function detectMojibake(code: string): { hasCorruption: boolean; highCharCount: number } {
    let count = 0;
    for (let i = 0; i < code.length; i++) {
        if (code.charCodeAt(i) > 0xFF) {
            count++;
        }
    }
    return { hasCorruption: count > 0, highCharCount: count };
}

const toHexByte = (ch: string): string =>
    (ch.charCodeAt(0) & 0xff).toString(16).padStart(2, '0').toUpperCase();

/**
 * Rewrite binary Direct Graphics (`<ESC>g0`) as printer-supported nibblized hex
 * (`<ESC>g1`, PRM Appendix E m=1: two ASCII hex digits per byte).
 *
 * g0 payloads are raw 8-bit bytes, so they die in any UTF-8 clipboard or chat
 * paste. g1 is pure printable ASCII, decodes to the identical bitmap (see
 * `extractDirectGraphics` mode 1), and a printer accepts it unchanged — unlike
 * the earlier `\xHH` escape form, which nothing on either end understood.
 *
 * Conversion walks the official frame tokenizer. After a g0 command, payload
 * frames are nibblized until the end-of-bitmap byte (0x28) closes the graphic;
 * every other frame is copied verbatim and raw STX/ETX bytes become literal
 * `<STX>`/`<ETX>` notation so the result contains no byte above 0x7F.
 *
 * Returns `converted: false` when the stream has no g0 payload — the caller
 * should not pretend a rewrite happened.
 */
export function convertDirectGraphicsToHex(code: string): { ipl: string; converted: boolean } {
    const frames = tokenizeFramesWithLines(code);
    const out: string[] = [];
    let inPayload = false;
    let converted = false;

    for (const frame of frames) {
        const body = frame.content;
        if (!inPayload) {
            if (/^<ESC>g0$/.test(body)) {
                inPayload = true;
                converted = true;
                out.push('<STX><ESC>g1<ETX>');
            } else {
                out.push(`<STX>${body}<ETX>`);
            }
            continue;
        }
        // Commands interleaved with the bitmap (the same ones the decoder
        // skips) stay commands; everything else is payload.
        if (/^<[A-Z]+>|^<ESC>[A-Za-z]/.test(body)) {
            out.push(`<STX>${body}<ETX>`);
            continue;
        }
        out.push('<STX>' + [...body].map(toHexByte).join('') + '<ETX>');
        for (let i = 0; i < body.length; i++) {
            if ((body.charCodeAt(i) & 0xff) === 0x28) { inPayload = false; break; }
        }
    }
    return { ipl: out.join('\r\n'), converted };
}
