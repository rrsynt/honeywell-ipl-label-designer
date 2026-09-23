import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { bytesToByteString } from '../services/ipl/fileBytes';

const samplesDir = path.resolve(__dirname, '../samples');
const sampleFiles = fs.readdirSync(samplesDir).filter(f => f.endsWith('.ipl'));

// Sample .ipl files are binary: Direct Graphics frames interleave raw RLE
// payloads with ASCII, so a UTF-8 read collapses every high byte to U+FFFD and
// destroys them. Always decode byte-exactly.
const readSample = (file: string): string =>
    bytesToByteString(fs.readFileSync(path.join(samplesDir, file)));

describe('sample gallery', () => {
    it('ships at least four sample streams', () => {
        expect(sampleFiles.length).toBeGreaterThanOrEqual(4);
    });

    it.each(sampleFiles)('%s parses without errors and yields fields', (file) => {
        const code = readSample(file);
        const label = parseViewerIPL(code);

        const errors = label.issues.filter(i => i.level === 'error');
        expect(errors, `${file}: ${JSON.stringify(errors)}`).toHaveLength(0);
        expect(label.elements.length, `${file} has no fields`).toBeGreaterThan(0);
    });

    it.each(sampleFiles)('%s converts to non-trivial ZPL or a graphic-only layout', (file) => {
        // Guard against the converter silently dropping fields. Graphic-only
        // streams (BarTender logo exports) legitimately emit a placeholder
        // box instead of ^FD data.
        const { iplToZpl } = require('../tools/ipl2zpl.mjs') as { iplToZpl: (s: string, dpi?: number) => string };
        const zpl = iplToZpl(readSample(file), 203);
        expect(zpl).toContain('^XA');
        expect(zpl).toContain('^XZ');
        const hasFields = (zpl.match(/\^FD/g)?.length ?? 0) > 0;
        const hasGraphic = /\^GB/.test(zpl);
        expect(zpl.length, `${file} produced a stub ZPL`).toBeGreaterThan(40);
        expect(hasFields || hasGraphic, `${file} lost all content`).toBe(true);
    });
});
