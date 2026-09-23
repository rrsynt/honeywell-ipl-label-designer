// UCC-128 SSCC (c6,m1/m2, PRM p.144) — encode, validate and interpretive rules.
// Imports the golden setup at module level for the canvas + bwip shims.
import './golden/setup';
import { describe, it, expect } from 'vitest';
import { raw as bwipRaw } from 'bwip-js/browser'; // the harness mock's real-default raw
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { buildBwipSpec, measureBarcode, interpretiveText, ensureBarcodesReady, type BwipSpec } from '../services/ipl/barcodes';
import { decodeCode128, code128Check, START_C, FNC1, STOP } from './golden/code128Decode';

// Decode the symbol a spec actually encodes (not the text string handed to
// bwip — a wrong escape still yields a string, which is how the '\f1' bug hid).
const codewords = (spec: BwipSpec): number[] => {
    const sym = (bwipRaw as unknown as (o: Record<string, unknown>) => { sbs: number[] }[])({
        bcid: spec.main.bcid, text: spec.main.text, ...spec.main.opts,
    })[0];
    return decodeCode128(sym);
};

describe('UCC-128 SSCC (c6,1,m2)', () => {
    const SSCC19 = '1234567890123456789'; // 19 numeric chars per PRM p.144

    it('parses c6,1 and c6,1,1 mode flags onto the element', () => {
        const label = parseViewerIPL(
            `<STX><ESC>P;E1;F1;B1;o10,10;c6,1;h60;w2;d3,${SSCC19};B2;o10,100;c6,1,1;h60;w2;d3,${SSCC19};R<ETX>`);
        const b1 = label.elements.filter(e => e.kind === 'barcode')[0];
        const b2 = label.elements.filter(e => e.kind === 'barcode')[1];
        expect((b1 as { code128Ucc?: string }).code128Ucc).toBe('1');
        expect((b2 as { code128Ucc?: string; code128KeepInterpretive?: string }).code128Ucc).toBe('1');
        expect((b2 as { code128KeepInterpretive?: string }).code128KeepInterpretive).toBe('1');
    });

    it('c6,1 encodes Start-C + FNC1 + forced-00 SSCC (GS1-compliant)', async () => {
        await ensureBarcodesReady();
        const spec = buildBwipSpec('6', SSCC19, { code128Ucc: '1' })!;
        expect(spec.main.bcid).toBe('code128');
        const cw = codewords(spec);
        // The GS1-mandated head: subset C start immediately followed by FNC1.
        expect(cw[0]).toBe(START_C);
        expect(cw[1]).toBe(FNC1);
        // Then the forced-00 SSCC: '00' + digits[2..] = 19 digits -> 9 pairs
        // + a single trailing digit via SW-B. Verify the leading pair is 00.
        expect(cw[2]).toBe(0);
        // And the whole symbol's mod-103 check digit is self-consistent.
        expect(cw[cw.length - 1]).toBe(STOP);
        expect(cw[cw.length - 2]).toBe(code128Check(cw.slice(0, cw.length - 2)));
    });

    it('c6,1 accepts GS1-style parentheses/spaces but does not encode them', async () => {
        await ensureBarcodesReady();
        // "(00)" + 17 digits strips to exactly 19 numeric chars.
        const spec = buildBwipSpec('6', '(00) 12345678901234567', { code128Ucc: '1' })!;
        const cw = codewords(spec);
        expect(cw[0]).toBe(START_C);
        expect(cw[1]).toBe(FNC1);
    });

    it('c6,1 with 20+ digits after stripping is rejected', () => {
        const spec = buildBwipSpec('6', '(00) 1234567890123456789', { code128Ucc: '1' });
        expect(spec).toBeNull();
    });

    it('c6,1 rejects non-19-digit data as barcode-data-invalid', () => {
        const label = parseViewerIPL(
            '<STX><ESC>P;E1;F1;B1;o10,10;c6,1;h60;w2;d3,1234567890;R<ETX>');
        const err = label.issues.find(i => i.code === 'barcode-data-invalid');
        expect(err?.level).toBe('error');
        expect(err?.message).toContain('19 numeric');
    });

    it('c6,1 measurement distinguishes from plain c6 of the same digits', async () => {
        await ensureBarcodesReady();
        const ucc = measureBarcode('6', SSCC19, { code128Ucc: '1' });
        const plain = measureBarcode('6', SSCC19, {});
        expect(ucc).not.toBeNull();
        expect(plain).not.toBeNull();
        expect(ucc!.widthModules).toBeGreaterThan(plain!.widthModules); // FNC1 codeword added
    });

    it('c6,0,1 strips parentheses/spaces from the symbol but not the interpretive', async () => {
        await ensureBarcodesReady();
        // m2=1 removes the DELIMITERS only: the AI digits stay, so "(10)ABC 123"
        // encodes as "10ABC123".
        const spec = buildBwipSpec('6', '(10)ABC 123', { code128KeepInterpretive: '1' })!;
        expect(spec.main.text).toBe('10ABC123');
        expect(interpretiveText('6', '(10)ABC 123', { code128KeepInterpretive: '1' })).toBe('(10)ABC 123');
        // without m2=1 both the symbol and the interpretive keep everything
        expect(buildBwipSpec('6', '(10)ABC 123', {})?.main.text).toBe('(10)ABC 123');
    });

    it('interpretive for c6,1,0 is the normalized forced-00 SSCC', () => {
        expect(interpretiveText('6', SSCC19, { code128Ucc: '1' })).toBe('00' + SSCC19.slice(2));
        // c6,1,1 keeps the host data verbatim
        expect(interpretiveText('6', SSCC19, { code128Ucc: '1', code128KeepInterpretive: '1' })).toBe(SSCC19);
    });

    it('interpretive leaves invalid UCC data verbatim instead of garbling it', () => {
        // too short: cannot be a forced-00 SSCC, so print what the host sent
        expect(interpretiveText('6', '1234567890', { code128Ucc: '1' })).toBe('1234567890');
        expect(interpretiveText('6', 'ABCDEFGHIJKLMNOPQRS', { code128Ucc: '1' })).toBe('ABCDEFGHIJKLMNOPQRS');
    });

    it('m3 start-subset is ignored with m1=1 (warning emitted)', () => {
        const label = parseViewerIPL(
            `<STX><ESC>P;E1;F1;B1;o10,10;c6,1,0,2;h60;w2;d3,${SSCC19};R<ETX>`);
        expect(label.issues.find(i => i.code === 'code128-mode-conflict')?.level).toBe('warning');
        // the symbol still encodes as UCC (Start-C + FNC1), not subset-B-start
        const spec = buildBwipSpec('6', SSCC19, { code128Ucc: '1', code128StartSubset: '2' })!;
        const cw = codewords(spec);
        expect(cw[0]).toBe(START_C);
        expect(cw[1]).toBe(FNC1);
    });

    it('I<n> interpretive field mirrors the host UCC normalization', () => {
        const textEls = (label: ReturnType<typeof parseViewerIPL>) =>
            label.elements.filter(e => e.kind === 'text') as { source: { type: string; data?: string } }[];
        const mk = (c: string, data: string) => parseViewerIPL([
            '<STX><ESC>P<ETX>', '<STX>E1;F1<ETX>',
            `<STX>B1;o10,10;${c};h60;w2;d3,${data}<ETX>`,
            '<STX>I1<ETX>', '<STX>R<ETX>',
        ].join('\n'));
        // c6,1 (m2=0): I field shows the normalized forced-00 SSCC
        expect(textEls(mk('c6,1', SSCC19))[0].source).toEqual({ type: 'fixed', data: '00' + SSCC19.slice(2) });
        // c6,1,1: verbatim host data
        expect(textEls(mk('c6,1,1', SSCC19))[0].source).toEqual({ type: 'fixed', data: SSCC19 });
        // invalid host data: verbatim, never a garbled 00-form
        expect(textEls(mk('c6,1', '1234567890'))[0].source).toEqual({ type: 'fixed', data: '1234567890' });
        // non-UCC host: plain inheritance unchanged
        expect(textEls(mk('c0', 'ABC123'))[0].source).toEqual({ type: 'fixed', data: 'ABC123' });
    });

    it('I<n> mirrors print-block data attached to the host barcode', () => {
        // host is variable (d0) and gets its SSCC from the print block; the
        // I field must show the normalized form of THAT data, not stay empty.
        const label = parseViewerIPL(
            `<STX><ESC>P;E1;F1;B1;o10,10;c6,1;h60;w2;d0<ETX><STX>I1<ETX><STX>R<ETX>` +
            `<STX><ESC>E1<CAN><ESC>F1\x001234567890123456789<ETB><FF><ETX>`);
        const textEls = label.elements.filter(e => e.kind === 'text') as
            { source: { type: string; data?: string } }[];
        expect(textEls[0].source).toEqual({ type: 'fixed', data: '00' + '1234567890123456789'.slice(2) });
    });

    it('I<n> never resolves a barcode from another format', () => {
        // Format 1 defines B1; format 2 defines I1 WITHOUT its own B1.
        // Field ids are per-format, so I1 must warn (no host) rather than
        // mirror across the format boundary.
        const label = parseViewerIPL([
            '<STX><ESC>P<ETX>',
            '<STX>E1;F1<ETX>',
            '<STX>B1;o10,10;c0;h60;w2;d3,FMT1DATA<ETX>',
            '<STX>I1<ETX>',
            '<STX>R<ETX>',
            '<STX>E2;F2<ETX>',
            '<STX>I1<ETX>',
            '<STX>R<ETX>',
        ].join('\n'));
        const texts = label.elements.filter(e => e.kind === 'text') as
            { interpretiveOf?: number; source: { type: string; data?: string } }[];
        expect(texts.length).toBe(2);
        // Format 1's I1 mirrors normally.
        expect(texts[0].interpretiveOf).toBe(1);
        expect(texts[0].source).toEqual({ type: 'fixed', data: 'FMT1DATA' });
        // Format 2's I1 has no host: no mirroring, and the warning fires.
        expect(texts[1].interpretiveOf).toBeUndefined();
        expect(texts[1].source).toEqual({ type: 'variable', data: '' });
        expect(label.issues.filter(i => i.code === 'interpretive-no-host').length).toBe(1);
    });
});
