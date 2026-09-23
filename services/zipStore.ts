// Batch F (2026-09-21): dependency-free ZIP writer for the viewer's
// numbered-PNG export. ZIP "store" (method 0) is deliberate: PNG is already
// DEFLATE-compressed, so re-compressing buys nothing and would drag in a
// library. The format is pinned by tests/zipExport.test.ts, which parses the
// archive back and cross-checks every CRC against Node's zlib.crc32.

export interface ZipEntry {
    name: string;
    data: Uint8Array;
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

const crc32 = (bytes: Uint8Array): number => {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};

/** Decodes a base64 data URL (any mime) into raw bytes for a zip entry. */
export const zipEntryBytes = (dataUrl: string): Uint8Array => {
    const comma = dataUrl.indexOf(',');
    const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
};

/** "label-01.png" style name: padded to the width of the total (min 2). */
export const numberedPngName = (base: string, index: number, total: number): string => {
    const width = Math.max(2, String(total).length);
    return `${base}-label-${String(index + 1).padStart(width, '0')}.png`;
};

/**
 * Turns a user-supplied file name into a safe ZIP entry / download prefix:
 * strips any path (zip-slip), the extension, and characters illegal on
 * Windows filesystems or reserved in ZIP specs. Never empty.
 */
export const sanitizeBaseName = (filename: string | null | undefined): string => {
    if (!filename) return 'ipl-job';
    const noPath = filename.replace(/^.*[\\/]/, '');
    const noExt = noExtOf(noPath);
    const safe = noExt.replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
    return safe || 'ipl-job';
};
const noExtOf = (name: string): string => name.replace(/\.[^.]+$/, '');

const dosDateTime = (d: Date): { time: number; date: number } => ({
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2)),
    date: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
});

/**
 * Builds a ZIP Blob (store method) from entries. Local headers + central
 * directory + EOCD, little-endian, per APPNOTE 4.3.x. Names are UTF-8
 * encoded and flagged as such (general-purpose bit 11) so non-ASCII file
 * names survive extraction on Windows. Payload bytes are passed to the
 * Blob as separate parts — never copied into a per-entry buffer — so peak
 * memory stays at one archive, not three. Sizes stay under 4 GB per entry
 * and per archive (well within the 32-bit fields; a 300-page ~800 dpi job
 * is tens of MB).
 */
const FLAG_UTF8 = 0x0800; // APPNOTE 4.4.4: general-purpose bit 11

export const createZipBlob = (entries: ZipEntry[]): Blob => {
    const enc = new TextEncoder();
    const now = dosDateTime(new Date());
    const parts: BlobPart[] = [];
    const centrals: Uint8Array[] = [];
    let offset = 0;

    entries.forEach((entry) => {
        const nameBytes = enc.encode(entry.name);
        const crc = crc32(entry.data);
        const size = entry.data.length;

        // Local header (30 fixed + name); the payload follows as its own
        // Blob part so entry.data is referenced, not copied.
        const localHeader = new Uint8Array(30 + nameBytes.length);
        const lv = new DataView(localHeader.buffer);
        lv.setUint32(0, 0x04034b50, true);   // local file header sig
        lv.setUint16(4, 20, true);           // version needed
        lv.setUint16(6, FLAG_UTF8, true);    // flags: UTF-8 names
        lv.setUint16(8, 0, true);            // method: store
        lv.setUint16(10, now.time, true);
        lv.setUint16(12, now.date, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, size, true);        // compressed size
        lv.setUint32(22, size, true);        // uncompressed size
        lv.setUint16(26, nameBytes.length, true);
        lv.setUint16(28, 0, true);           // extra len
        localHeader.set(nameBytes, 30);
        parts.push(localHeader, entry.data);

        const central = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(central.buffer);
        cv.setUint32(0, 0x02014b50, true);   // central dir sig
        cv.setUint16(4, 20, true);           // version made by
        cv.setUint16(6, 20, true);           // version needed
        cv.setUint16(8, FLAG_UTF8, true);    // flags: UTF-8 names
        cv.setUint16(10, 0, true);           // method: store
        cv.setUint16(12, now.time, true);
        cv.setUint16(14, now.date, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, size, true);
        cv.setUint32(24, size, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint16(30, 0, true);           // extra
        cv.setUint16(32, 0, true);           // comment
        cv.setUint16(34, 0, true);           // disk number
        cv.setUint16(36, 0, true);           // internal attrs
        cv.setUint32(38, 0, true);           // external attrs
        cv.setUint32(42, offset, true);      // local header offset
        central.set(nameBytes, 46);
        centrals.push(central);

        offset += localHeader.length + size;
    });

    const centralSize = centrals.reduce((s, c) => s + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);           // central dir offset
    ev.setUint16(20, 0, true);                // comment len

    return new Blob([...parts, ...centrals, eocd], { type: 'application/zip' });
};
