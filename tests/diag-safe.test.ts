import './golden/setup';
import { describe, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { encodeRlePayloadsAsHex, decodeHexToBytes, detectMojibake } from '../services/ipl/fileBytes';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { computeLabelExtent } from '../services/ipl/renderer';
import { ensureBarcodesReady } from '../services/ipl/barcodes';

describe('safe export', () => {
    it('round-trips bartender tes1 through hex escape + reparse', async () => {
        await ensureBarcodesReady();
        const bytes = await readFile(path.resolve(__dirname, '../samples/bartender-tes1.ipl'));
        const byteExact = String.fromCharCode(...bytes);
        const safe = encodeRlePayloadsAsHex(byteExact);
        const utf8Roundtrip = new TextDecoder().decode(new TextEncoder().encode(safe)); // browser paste proof
        console.log(`safe: high chars ${detectMojibake(safe).highCharCount}, after utf8 ${detectMojibake(utf8Roundtrip).highCharCount}`);
        const ext = computeLabelExtent(parseViewerIPL(utf8Roundtrip), 203);
        console.log(`safe-pasted extent=${ext.widthDots}x${ext.heightDots}`);
        const back = decodeHexToBytes(safe);
        const ext2 = computeLabelExtent(parseViewerIPL(back), 203);
        console.log(`decoded-back extent=${ext2.widthDots}x${ext2.heightDots}`);
        console.log(safe.slice(0, 200));
    }, 60000);
});
