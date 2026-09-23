// Batch F (2026-09-21): numbered-PNG export of a multi-label job, packaged
// as a ZIP. The ZIP writer is dependency-free (store method — PNGs are
// already compressed, so DEFLATE would buy nothing and cost a lib). Tests
// parse the archive bytes back and cross-check every CRC against Node's
// zlib.crc32, so the format is verified against an independent
// implementation rather than our own assumptions.
import { describe, it, expect } from 'vitest';
import { crc32 } from 'node:zlib';
import { createZipBlob, zipEntryBytes, numberedPngName, sanitizeBaseName, type ZipEntry } from '../services/zipStore';

const enc = new TextEncoder();

/** Minimal ZIP reader: returns entries keyed by name, plus EOCD facts. */
const readZip = (buf: Uint8Array) => {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    // EOCD sits at the end (22 bytes, no comment).
    const eocd = buf.length - 22;
    const sig = dv.getUint32(eocd, true);
    expect(sig).toBe(0x06054b50);
    const total = dv.getUint16(eocd + 10, true);
    const entries: { name: string; data: Uint8Array; crc: number }[] = [];
    // Walk the central directory.
    let off = dv.getUint32(eocd + 16, true);
    for (let i = 0; i < total; i++) {
        expect(dv.getUint32(off, true)).toBe(0x02014b50);
        const crc = dv.getUint32(off + 16, true);
        const compSize = dv.getUint32(off + 20, true);
        const nameLen = dv.getUint16(off + 28, true);
        const extraLen = dv.getUint16(off + 30, true);
        const commentLen = dv.getUint16(off + 32, true);
        const localOff = dv.getUint32(off + 42, true);
        const name = new TextDecoder().decode(buf.slice(off + 46, off + 46 + nameLen));
        // Local header at localOff: skip fixed 30 + its own name/extra lengths.
        expect(dv.getUint32(localOff, true)).toBe(0x04034b50);
        const lNameLen = dv.getUint16(localOff + 26, true);
        const lExtraLen = dv.getUint16(localOff + 28, true);
        const dataStart = localOff + 30 + lNameLen + lExtraLen;
        entries.push({ name, crc, data: buf.slice(dataStart, dataStart + compSize) });
        off += 46 + nameLen + extraLen + commentLen;
    }
    return { total, entries };
};

describe('createZipBlob (store method)', () => {
    it('empty file list is a valid empty archive', async () => {
        const blob = createZipBlob([]);
        const buf = new Uint8Array(await blob.arrayBuffer());
        expect(buf.length).toBe(22); // EOCD only
        expect(new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true)).toBe(0x06054b50);
    });

    it('sets general purpose bit 11 (UTF-8) and round-trips non-ASCII names', async () => {
        // Review HIGH: names are UTF-8 encoded via TextEncoder; without the
        // flag, Windows Explorer decodes them as CP437 and extracts mojibake.
        const name = 'ünload-karty-dużego-01.png';
        const blob = createZipBlob([{ name, data: enc.encode('test') }]);
        const buf = new Uint8Array(await blob.arrayBuffer());
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        expect(dv.getUint16(6, true) & 0x0800).toBe(0x0800);      // local header
        const eocd = buf.length - 22;
        const centralOff = dv.getUint32(eocd + 16, true);
        expect(dv.getUint16(centralOff + 8, true) & 0x0800).toBe(0x0800); // central dir
        const { entries } = readZip(buf);
        expect(entries[0].name).toBe(name);
    });

    it('local header fields match the central directory (CRC + sizes)', async () => {
        const data = enc.encode('cross-check payload');
        const buf = new Uint8Array(await createZipBlob([{ name: 'x.bin', data }]).arrayBuffer());
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        // First local header sits at offset 0.
        expect(dv.getUint32(14, true)).toBe(crc32(Buffer.from(data)) >>> 0);
        expect(dv.getUint32(18, true)).toBe(data.length);
        expect(dv.getUint32(22, true)).toBe(data.length);
        const { entries } = readZip(buf);
        expect(entries[0].crc >>> 0).toBe(dv.getUint32(14, true));
        expect(entries[0].data).toEqual(data);
    });

    it('round-trips two files with independent CRC cross-checks', async () => {
        const a = enc.encode('label one payload');
        const b = enc.encode('label two payload, longer: ' + 'x'.repeat(500));
        const blob = createZipBlob([
            { name: 'label-01.png', data: a },
            { name: 'label-02.png', data: b },
        ]);
        const buf = new Uint8Array(await blob.arrayBuffer());
        const { total, entries } = readZip(buf);
        expect(total).toBe(2);
        expect(entries.map(e => e.name)).toEqual(['label-01.png', 'label-02.png']);
        expect(entries[0].data).toEqual(a);
        expect(entries[1].data).toEqual(b);
        // CRCs must match Node's zlib.crc32 — independent implementation.
        expect(entries[0].crc >>> 0).toBe(crc32(Buffer.from(a)) >>> 0);
        expect(entries[1].crc >>> 0).toBe(crc32(Buffer.from(b)) >>> 0);
    });

    it('handles empty and single-byte payloads (boundary sizes)', async () => {
        const files = [
            { name: 'zero.bin', data: new Uint8Array(0) },
            { name: 'one.bin', data: new Uint8Array([0xff]) },
        ];
        const buf = new Uint8Array(await createZipBlob(files).arrayBuffer());
        const { entries } = readZip(buf);
        expect(entries[0].data.length).toBe(0);
        expect(entries[1].data).toEqual(files[1].data);
        expect(entries[0].crc >>> 0).toBe(crc32(Buffer.alloc(0)) >>> 0);
    });

    it('zipEntryBytes decodes base64 data URLs to raw bytes', () => {
        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
        const b64 = btoa(String.fromCharCode(...png));
        expect(zipEntryBytes(`data:image/png;base64,${b64}`)).toEqual(png);
    });
});

describe('numberedPngName', () => {
    it('pads to the width of the total, minimum two digits', () => {
        expect(numberedPngName('carton', 0, 6)).toBe('carton-label-01.png');
        expect(numberedPngName('carton', 5, 6)).toBe('carton-label-06.png');
        expect(numberedPngName('carton', 9, 300)).toBe('carton-label-010.png');
        expect(numberedPngName('carton', 299, 300)).toBe('carton-label-300.png');
        expect(numberedPngName('x', 0, 1)).toBe('x-label-01.png');
    });
});

describe('sanitizeBaseName (review MEDIUM: zip-slip + illegal chars)', () => {
    it('null/empty/degenerate inputs fall back to ipl-job', () => {
        expect(sanitizeBaseName(null)).toBe('ipl-job');
        expect(sanitizeBaseName('')).toBe('ipl-job');
        expect(sanitizeBaseName('.ipl')).toBe('ipl-job'); // extension-only -> empty stem
    });

    it('strips path components (zip-slip) and the extension', () => {
        expect(sanitizeBaseName('../../etc/passwd.ipl')).toBe('passwd');
        expect(sanitizeBaseName('C:\\Users\\x\\label.ipl')).toBe('label');
        expect(sanitizeBaseName('dir/sub/carton.ipl')).toBe('carton');
    });

    it('replaces Windows-illegal characters with underscores', () => {
        expect(sanitizeBaseName('a:b*c?.ipl')).toBe('a_b_c_');
        expect(sanitizeBaseName('bad<>|"name.ipl')).toBe('bad____name');
        expect(sanitizeBaseName('ctrl\x01char.ipl')).toBe('ctrl_char');
    });

    it('keeps legitimate unicode and spaces (UTF-8 flag covers them)', () => {
        expect(sanitizeBaseName('karty-dużego étiquette 标签.ipl')).toBe('karty-dużego étiquette 标签');
    });

    it('never yields a trailing dot or space (Windows reserved)', () => {
        expect(sanitizeBaseName('evil..ipl')).toBe('evil');
        expect(sanitizeBaseName('spaced .ipl')).toBe('spaced');
    });
});
