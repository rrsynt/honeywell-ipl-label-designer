import { describe, it, expect, beforeAll } from 'vitest';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { ensureBarcodesReady } from '../services/ipl/barcodes';

const wrap = (fields: string[], setup: string[] = ['<STX><ESC>P<ETX>']): string =>
    [...setup, '<STX>E1;F1<ETX>', ...fields, '<STX>R<ETX>'].join('\n');

describe('structural validation', () => {
    it('warns when a format is defined without program mode', () => {
        const label = parseViewerIPL(wrap(['<STX>H0;o10,10;c25;k12;d3,A<ETX>'], []));
        expect(label.issues.some(i => i.code === 'no-program-mode')).toBe(true);
        // The field itself still parses
        expect(label.elements).toHaveLength(1);
    });

    it('flags duplicate field ids and keeps the last definition', () => {
        const label = parseViewerIPL(wrap([
            '<STX>H0;o10,10;c25;k12;d3,FIRST<ETX>',
            '<STX>H0;o50,50;c25;k12;d3,SECOND<ETX>',
        ]));
        const dup = label.issues.find(i => i.code === 'duplicate-field-id');
        expect(dup).toBeDefined();
        expect(dup!.level).toBe('error');
        expect(label.elements.filter(e => e.kind === 'text')).toHaveLength(1);
        expect((label.elements[0] as { source: { data: string } }).source.data).toBe('SECOND');
    });

    it('last definition also wins when a page composes the format', () => {
        // The duplicate filter must reach the format bucket, not only
        // label.elements — with a page, composition rebuilds elements from
        // the bucket, so a stale bucket entry would resurface.
        const label = parseViewerIPL([
            '<STX><ESC>P<ETX>',
            '<STX>E1;F1<ETX>',
            '<STX>H0;o10,10;c25;k12;d3,FIRST<ETX>',
            '<STX>H0;o50,50;c25;k12;d3,SECOND<ETX>',
            '<STX>R<ETX>',
            '<STX>S1;Ma,1;O0,0<ETX>',
        ].join('\n'));
        const texts = label.elements.filter(e => e.kind === 'text');
        expect(texts).toHaveLength(1);
        expect((texts[0] as { source: { data: string } }).source.data).toBe('SECOND');
    });

    it('a duplicate inside format 2 never destroys format 1 (field ids are per-format)', () => {
        // H0 in format 1 and H0 in format 2 are DIFFERENT fields. Redefining
        // H0 twice within format 2 must evict only format 2's earlier H0 —
        // format 1's must survive (both in the live list and in its bucket,
        // where a later page composition would resurrect it).
        const label = parseViewerIPL([
            '<STX><ESC>P<ETX>',
            '<STX>E1;F1<ETX>',
            '<STX>H0;o10,10;c25;k12;d3,F1KEEP<ETX>',
            '<STX>R<ETX>',
            '<STX>E2;F2<ETX>',
            '<STX>H0;o5,5;c25;k12;d3,F2-FIRST<ETX>',
            '<STX>H0;o6,6;c25;k12;d3,F2-LAST<ETX>',
            '<STX>R<ETX>',
        ].join('\n'));
        const data = label.elements.filter(e => e.kind === 'text')
            .map(e => (e as { source: { data: string } }).source.data);
        expect(data).toEqual(['F1KEEP', 'F2-LAST']);
    });

    it('Dn delete then redefinition is not a false duplicate', () => {
        // <ESC>Dn removes field n from the open format (PRM p.174); defining
        // the same id afterwards must NOT raise duplicate-field-id.
        const label = parseViewerIPL([
            '<STX><ESC>P<ETX>',
            '<STX>E1;F1<ETX>',
            '<STX>H0;o10,10;c25;k12;d3,OLD<ETX>',
            '<STX>D0<ETX>',
            '<STX>H0;o20,20;c25;k12;d3,NEW<ETX>',
            '<STX>R<ETX>',
        ].join('\n'));
        expect(label.issues.filter(i => i.code === 'duplicate-field-id')).toHaveLength(0);
        const texts = label.elements.filter(e => e.kind === 'text');
        expect(texts).toHaveLength(1);
        expect((texts[0] as { source: { data: string } }).source.data).toBe('NEW');
    });

    it('does not flag distinct ids of different kinds', () => {
        const label = parseViewerIPL(wrap([
            '<STX>H1;o10,10;c25;k12;d3,T<ETX>',
            '<STX>B1;o10,60;c6;h50;w2;i1;d3,12345<ETX>',
            '<STX>L1;o10,140;l100;w4<ETX>',
            '<STX>W1;o300,10;l100;h100;w4<ETX>',
        ]));
        expect(label.issues.filter(i => i.code === 'duplicate-field-id')).toHaveLength(0);
        expect(label.elements).toHaveLength(4);
    });

    it('still warns for fields outside a format block', () => {
        const label = parseViewerIPL([
            '<STX><ESC>P<ETX>',
            '<STX>H9;o10,10;c25;k12;d3,EARLY<ETX>',
            '<STX>E1;F1<ETX>',
            '<STX>R<ETX>',
        ].join('\n'));
        expect(label.issues.some(i => i.code === 'field-outside-format')).toBe(true);
    });
});

describe('parameter range validation', () => {
    it('warns on unknown font ids', () => {
        const label = parseViewerIPL(wrap(['<STX>H0;o10,10;c99;k12;d3,X<ETX>']));
        const issue = label.issues.find(i => i.code === 'unknown-font');
        expect(issue).toBeDefined();
        expect(issue!.command).toBe('H0');
    });

    it('warns on out-of-range outline sizes and bitmap magnifications', () => {
        const label = parseViewerIPL(wrap([
            '<STX>H0;o10,10;c25;k999;d3,A<ETX>',
            '<STX>H1;o10,40;c0;h0;w0;d3,B<ETX>',
        ]));
        expect(label.issues.some(i => i.code === 'size-out-of-range')).toBe(true);
        expect(label.issues.some(i => i.code === 'magnification-invalid')).toBe(true);
    });

    it('warns on out-of-range barcode height/module width', () => {
        const label = parseViewerIPL(wrap([
            '<STX>B0;o10,10;c6;h20000;w99;i1;d3,123<ETX>',
        ]));
        expect(label.issues.some(i => i.code === 'height-out-of-range')).toBe(true);
        expect(label.issues.some(i => i.code === 'module-width-out-of-range')).toBe(true);
    });

    it('warns on negative origins and invalid rotations without crashing', () => {
        const label = parseViewerIPL(wrap([
            '<STX>H0;o-5,-5;f7;c25;k12;d3,R<ETX>',
        ]));
        expect(label.issues.some(i => i.code === 'origin-negative')).toBe(true);
        expect(label.issues.some(i => i.code === 'rotation-invalid')).toBe(true);
        // f7 clamps to 3
        expect((label.elements[0] as { f: number }).f).toBe(3);
    });

    it('warns on non-positive line/box sizes and oversized corner radius', () => {
        const label = parseViewerIPL(wrap([
            '<STX>L0;o10,10;l0;w4<ETX>',
            '<STX>W1;o10,40;l100;h100;w4;r90<ETX>',
        ]));
        expect(label.issues.filter(i => i.code === 'nonpositive-size')).toHaveLength(1);
        expect(label.issues.some(i => i.code === 'radius-out-of-range')).toBe(true);
    });
});

describe('barcode data validation', () => {
    beforeAll(async () => { await ensureBarcodesReady(); });

    it('rejects Code 39 data with illegal characters (regex layer)', () => {
        const label = parseViewerIPL(wrap([
            '<STX>B0;o10,10;c0;h80;w2;i1;d3,BAD@DATA!<ETX>',
        ]));
        const issue = label.issues.find(i => i.code === 'barcode-data-invalid');
        expect(issue).toBeDefined();
        expect(issue!.level).toBe('error');
    });

    it('accepts valid Code 128 and I2of5 data cleanly', () => {
        const label = parseViewerIPL(wrap([
            '<STX>B0;o10,10;c6;h80;w2;i1;d3,ABC-123<ETX>',
            '<STX>B1;o10,200;c2;h80;w2;i0;d3,12345678<ETX>',
        ]));
        expect(label.issues.filter(i => i.code === 'barcode-data-invalid')).toHaveLength(0);
    });

    it('catches EAN/UPC length problems via the encoder layer', () => {
        const label = parseViewerIPL(wrap([
            '<STX>B2;o10,360;c7;h80;w2;i0;d3,12345<ETX>', // too short for any EAN/UPC
        ]));
        expect(label.issues.some(i => i.code === 'barcode-data-invalid')).toBe(true);
    });
});
