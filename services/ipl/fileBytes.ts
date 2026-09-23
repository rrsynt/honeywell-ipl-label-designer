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
