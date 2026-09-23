import { describe, it, expect } from 'vitest';
import { tokenizeFrames } from '../services/ipl/tokenizer';
import { parseViewerIPL, extractPrintBlockData } from '../services/ipl/viewerParser';
import { computeLabelExtent, elementVisualBox, estimateElementSize } from '../services/ipl/renderer';
import { ensureBarcodesReady } from '../services/ipl/barcodes';
import type { TextElement, BarcodeElement, GraphicElement } from '../services/ipl/types';

const DPI = 203;

const textEl = (label: ReturnType<typeof parseViewerIPL>, index = 0) =>
    label.elements.filter(e => e.kind === 'text')[index] as TextElement;
const barcodeEl = (label: ReturnType<typeof parseViewerIPL>, index = 0) =>
    label.elements.filter(e => e.kind === 'barcode')[index] as BarcodeElement;

describe('tokenizeFrames', () => {
    it('splits literal placeholder notation', () => {
        expect(tokenizeFrames('<STX>R<ETX><STX><ESC>P<ETX>')).toEqual(['R', '<ESC>P']);
    });

    it('accepts raw control characters', () => {
        const raw = '\x02R\x03\x02<ESC>P\x03';
        expect(tokenizeFrames(raw)).toEqual(['R', '<ESC>P']);
    });

    it('handles mixed notation and keeps unterminated tail', () => {
        const mixed = '\x02H0;o1,2<ETX><STX>B1;c6';
        expect(tokenizeFrames(mixed)).toEqual(['H0;o1,2', 'B1;c6']);
    });

    it('returns empty array for empty input', () => {
        expect(tokenizeFrames('')).toEqual([]);
    });
});

describe('parseViewerIPL', () => {
    const sample = [
        '<STX><ESC>C<SI>W812<SI>h<ETX>',
        '<STX><SI>L400<ETX>',
        '<STX><SI>T1<SI>g0<SI>S50<SI>d2<ETX>',
        '<STX><ESC>P<ETX>',
        '<STX>E1;F1;<ETX>',
        '<STX>H0;o35,40;f0;c25;k12;d3,Cat.;<ETX>',
        '<STX>H1;o35,70;c0;h2;w2;d0,255<ETX>',
        '<STX>B2;o35,120;c6,0,0,1;h80;w2;i2;d3,12345678<ETX>',
        '<STX>L3;o740,10;l130;w8<ETX>',
        '<STX>W4;o25,140;l275;h90;w8;r10<ETX>',
        '<STX>R<ETX>',
        '<STX><ESC>E1<CAN><ESC>F1<NUL>INVOICE-77<RS>4<ETB><FF><ETX>',
    ].join('\n');

    it('parses all field kinds with correct properties', () => {
        const label = parseViewerIPL(sample);

        expect(label.elements.map(e => e.kind)).toEqual(['text', 'text', 'barcode', 'line', 'box']);
        expect(label.widthDots).toBe(812);
        expect(label.heightDots).toBe(400);
        expect(label.settings).toMatchObject({
            mediaSenseMode: 'gap',
            mediaType: 'direct-thermal',
            printSpeed: 5,
            darknessAdjust: 2,
            quantity: 4,
        });

        const t0 = textEl(label, 0);
        expect(t0).toMatchObject({ id: 0, ox: 35, oy: 40, f: 0, font: '25', pointSize: 12 });
        expect(t0.source).toEqual({ type: 'fixed', data: 'Cat.' });
    });

    it('assigns print-block data to variable fields by field number', () => {
        const label = parseViewerIPL(sample);
        const t1 = textEl(label, 1);
        expect(t1.source).toEqual({ type: 'variable', data: 'INVOICE-77' });
        expect(label.settings.quantity).toBe(4);
    });

    it('reports no errors for a well-formed stream', () => {
        const label = parseViewerIPL(sample);
        expect(label.issues.filter(i => i.level === 'error')).toHaveLength(0);
        expect(label.issues.filter(i => i.level === 'warning')).toHaveLength(0);
    });

    it('parses a minimal single-frame format without terminators (regression)', () => {
        // The old modal's default sample: one giant frame, no R frame
        const legacy = `<STX><ESC>P;E1;F1;H1;o100,100;f0;c25;k12;d3,Hello World!;B2;o100,200;f0;c6;h50;w2;i1;d3,12345678;R<ETX>
<STX><ESC>E1<ETX>
<STX><ETB><ETX>`;
        const label = parseViewerIPL(legacy);
        expect(label.elements.map(e => e.kind)).toEqual(['text', 'barcode']);
        const b = barcodeEl(label);
        expect(b.symbology).toBe('6');
        expect(b.heightDots).toBe(50);
    });

    it('warns on unsupported commands inside the format', () => {
        const code = [
            '<STX><ESC>P<ETX>',
            '<STX>E1;F1<ETX>',
            '<STX>H0;o10,10;c25;d3,A<ETX>',
            '<STX>X9;weird<ETX>',
            '<STX>R<ETX>',
        ].join('\n');
        const label = parseViewerIPL(code);
        expect(label.elements).toHaveLength(1);
        const warn = label.issues.find(i => i.code === 'unknown-frame');
        expect(warn).toBeDefined();
        expect(warn!.command).toContain('X9');
    });

    it('flags missing origin but keeps parsing', () => {
        const code = ['<STX><ESC>P<ETX>', '<STX>E1;F1<ETX>', '<STX>H0;c25;d3,NoOrigin<ETX>', '<STX>R<ETX>'].join('\n');
        const label = parseViewerIPL(code);
        const t = textEl(label);
        expect(t.ox).toBe(0);
        expect(t.oy).toBe(0);
        expect(label.issues.some(i => i.code === 'missing-origin')).toBe(true);
    });

    it('errors gracefully on garbage input', () => {
        const label = parseViewerIPL('not ipl at all');
        expect(label.elements).toHaveLength(0);
        expect(label.issues[0].level).toBe('error');
    });
});

describe('extractPrintBlockData', () => {
    it('extracts multiple fields in both notations', () => {
        const literal = '<STX><ESC>E1<CAN><ESC>F1<NUL>AAA<ESC>F2<NUL>BBB<ETB><FF><ETX>';
        const raw = '\x02\x1bE1\x18\x1bF1\x00AAA\x1bF2\x00BBB\x17\x0c\x03';
        for (const code of [literal, raw]) {
            const byFormat = extractPrintBlockData(code);
            const map = byFormat.get(1);
            expect(map, 'data keyed under format 1 (from <ESC>E1)').toBeDefined();
            expect(map!.get(1)).toBe('AAA');
            expect(map!.get(2)).toBe('BBB');
        }
    });

    it('scopes blocks by their <ESC>E id so formats reusing field ids keep separate data', () => {
        const code = '<STX><ESC>E1<CAN><ESC>F1<NUL>FROM-ONE<ETB><FF><ETX>'
            + '<STX><ESC>E2<CAN><ESC>F1<NUL>FROM-TWO<ETB><FF><ETX>';
        const byFormat = extractPrintBlockData(code);
        expect(byFormat.get(1)?.get(1)).toBe('FROM-ONE');
        expect(byFormat.get(2)?.get(1)).toBe('FROM-TWO');
    });
});

describe('estimateElementSize / extent / visual box', () => {
    it('estimates outline text size from point size', () => {
        const label = parseViewerIPL('<STX><ESC>P<ETX><STX>E1;F1<ETX><STX>H0;o10,10;c25;k12;d3,HELLO<ETX><STX>R<ETX>');
        const t = textEl(label);
        const size = estimateElementSize(t, DPI);
        const hDots = Math.round((12 / 72) * 203); // 34 dots
        expect(size.crossDots).toBe(Math.round(hDots * 1.15));
        expect(size.lengthDots).toBe(5 * hDots * 0.6);
    });

    it('computes rotated visual boxes per quadrant', () => {
        const el: TextElement = {
            kind: 'text', id: 1, ox: 100, oy: 100, f: 0, font: '0', hMag: 1, wMag: 1,
            source: { type: 'fixed', data: 'AB' },
        };
        // c0 cell is 7x9 with a 1-dot gap: 2 chars = 2*(7+1)-1 = 15 dots (PRM270 p.54)
        // f0: L=15, C=9
        expect(elementVisualBox(el, DPI)).toEqual({ x: 100, y: 100, w: 15, h: 9 });
        el.f = 1;
        expect(elementVisualBox(el, DPI)).toEqual({ x: 100, y: 85, w: 9, h: 15 });
        el.f = 2;
        expect(elementVisualBox(el, DPI)).toEqual({ x: 85, y: 91, w: 15, h: 9 });
        el.f = 3;
        expect(elementVisualBox(el, DPI)).toEqual({ x: 91, y: 100, w: 9, h: 15 });
    });

    it('computeLabelExtent falls back to content bounds when SI W/L absent', () => {
        const label = parseViewerIPL([
            '<STX><ESC>P<ETX>',
            '<STX>E1;F1<ETX>',
            '<STX>H0;o500,300;c25;k12;d3,XYZ<ETX>',
            '<STX>B1;o20,20;c6;h80;w2;d3,123<ETX>',
            '<STX>R<ETX>',
        ].join('\n'));
        const ext = computeLabelExtent(label, DPI);
        expect(ext.widthDots).toBeGreaterThanOrEqual(500 + 3 * Math.round((12 / 72) * 203) * 0.6 - 1);
        expect(ext.heightDots).toBeGreaterThanOrEqual(320);
    });
});

describe('manual-default fidelity (spec §13.1)', () => {
    const barcodeEl = (label: ReturnType<typeof parseViewerIPL>, index = 0) =>
        label.elements.filter(e => e.kind === 'barcode')[index] as BarcodeElement | undefined;

    it('H field defaults: font 0 at h2/w2 when omitted', () => {
        const label = parseViewerIPL('<STX><ESC>P<ETX><STX>E1;F1<ETX><STX>H0;o10,10;d3,DEF<ETX><STX>R<ETX>');
        const t = textEl(label)!;
        expect(t.font).toBe('0');
        expect(t.hMag).toBe(2);
        expect(t.wMag).toBe(2);
        expect(t.pointSize).toBeUndefined();
    });

    it('B field defaults: h50, w1, ratio 3:1', () => {
        const label = parseViewerIPL('<STX><ESC>P<ETX><STX>E1;F1<ETX><STX>B1;o10,10;c6;d3,123456<ETX><STX>R<ETX>');
        const b = barcodeEl(label)!;
        expect(b.heightDots).toBe(50);
        expect(b.moduleDots).toBe(1);
        expect(b.ratio).toBe(1);
    });

    it('captures explicit ratio r and clamps out-of-range values', () => {
        const label = parseViewerIPL([
            '<STX><ESC>P<ETX>',
            '<STX>E1;F1<ETX>',
            '<STX>B1;o10,10;c0;r2;h60;w3;d3,ABC<ETX>',
            '<STX>B2;o10,200;c0;r7;h60;w3;d3,ABC<ETX>',
            '<STX>R<ETX>',
        ].join('\n'));
        expect(barcodeEl(label, 0)!.ratio).toBe(2);
        expect(barcodeEl(label, 1)!.ratio).toBe(1); // r7 undocumented -> default 3:1
    });

    it('c0 advance follows the 7x9 cell with 1-dot gap (10 chars = 79 dots)', () => {
        const el: TextElement = {
            kind: 'text', id: 0, ox: 0, oy: 0, f: 0, font: '0', hMag: 1, wMag: 1,
            source: { type: 'fixed', data: '0123456789' },
        };
        expect(estimateElementSize(el, DPI)).toEqual({ lengthDots: 79, crossDots: 9 });
    });

    it('applies I2of5 odd-length zero padding to rendered data', async () => {
        await ensureBarcodesReady();
        const label = parseViewerIPL('<STX><ESC>P<ETX><STX>E1;F1<ETX><STX>B1;o10,10;c2;h60;w2;d3,1234<ETX><STX>R<ETX>');
        const b = barcodeEl(label)!;
        expect(b.symbology).toBe('2');
        // measureBarcode on "1234" would fail (odd after pad? no - even). Use direct padding check:
        const { applyI2of5Padding } = await import('../services/ipl/barcodes');
        expect(applyI2of5Padding('2', '123')).toBe('0123');
        expect(applyI2of5Padding('2', '1234')).toBe('1234');
        expect(applyI2of5Padding('6', '123')).toBe('123'); // only I2of5 pads
        void b;
    });
});

describe('fase 2 completion: interpretive, border, inc/dec', () => {
    it('I<n> interpretive field anchors 2 dots below its barcode and inherits data', () => {
        const label = parseViewerIPL([
            '<STX><ESC>P<ETX>',
            '<STX>E1;F1<ETX>',
            '<STX>B1;o30,40;c0;h60;w2;d3,ABC123<ETX>',
            '<STX>I1<ETX>',
            '<STX>R<ETX>',
        ].join('\n'));
        const interp = textEl(label)!;
        expect(interp.interpretiveOf).toBe(1);
        expect(interp.ox).toBe(30);
        expect(interp.oy).toBe(40 + 60 + 2); // left edge + h + 2-dot gap (PRM p.192)
        expect(interp.source).toEqual({ type: 'fixed', data: 'ABC123' });
        expect(interp.font).toBe('0');
        expect(interp.hMag).toBe(2);
    });

    it('I<n> with explicit origin overrides the derived anchor', () => {
        const label = parseViewerIPL([
            '<STX><ESC>P<ETX>',
            '<STX>E1;F1<ETX>',
            '<STX>B1;o30,40;c6;h60;w2;d3,123<ETX>',
            '<STX>I1;o100,200;f1;c25;k10;d3,OVR<ETX>',
            '<STX>R<ETX>',
        ].join('\n'));
        const interp = textEl(label)!;
        expect(interp.ox).toBe(100);
        expect(interp.oy).toBe(200);
        expect(interp.f).toBe(1);
        expect(interp.font).toBe('25');
        expect(interp.pointSize).toBe(10);
        expect(interp.source).toEqual({ type: 'fixed', data: 'OVR' });
    });

    it('warns when I<n> references an undefined barcode', () => {
        const label = parseViewerIPL('<STX><ESC>P<ETX><STX>E1;F1<ETX><STX>I7<ETX><STX>R<ETX>');
        expect(label.issues.some(i => i.code === 'interpretive-no-host')).toBe(true);
    });

    it('border b renders as borderDots on the text element', () => {
        const label = parseViewerIPL('<STX><ESC>P<ETX><STX>E1;F1<ETX><STX>H0;o10,10;b8;c25;k14;d3,HEADER<ETX><STX>R<ETX>');
        const t = textEl(label)!;
        expect(t.borderDots).toBe(8);
    });

    it('captures batch count <US> and increment/decrement steps', () => {
        const code = [
            '<STX><ESC>C<ETX>',
            '<STX><ESC>P<ETX>',
            '<STX>E1;F1;<ETX>',
            '<STX>H0;o10,10;c0;d0<ETX>',
            '<STX>R<ETX>',
            '<STX><ESC>E1<CAN><ESC>F0<NUL>001<CAN>0<SUB><CR>009<FS><ESC>I5<ETB><US>3<RS>2<FF><ETX>',
        ].join('\n');
        const label = parseViewerIPL(code);
        expect(label.settings.batchCount).toBe(3);
        expect(label.settings.quantity).toBe(2);
        expect(label.settings.increment).toBe(5);
        void code;
    });
});

describe('fase 4: line tracking + command help', () => {
    it('tokenizeFramesWithLines reports the source line of each frame', async () => {
        const { tokenizeFramesWithLines } = await import('../services/ipl/tokenizer');
        const code = [
            '<STX><ESC>P<ETX>',      // line 1
            '<STX>E1;F1<ETX>',       // line 2
            '<STX>H0;o10,10;c25;d3,X<ETX>', // line 3
        ].join('\n');
        const spans = tokenizeFramesWithLines(code);
        expect(spans.map(s => s.line)).toEqual([1, 2, 3]);
        expect(spans[2].content).toContain('H0');
    });

    it('attaches line numbers to parser issues', () => {
        const code = [
            '<STX><ESC>P<ETX>',
            '<STX>E1;F1<ETX>',
            '<STX>H0;c25;d3,NoOrigin<ETX>', // missing-origin on line 3
            '<STX>R<ETX>',
        ].join('\n');
        const label = parseViewerIPL(code);
        const issue = label.issues.find(i => i.code === 'missing-origin');
        expect(issue?.line).toBe(3);
    });

    it('frameAtCaret + lookupHelpForFrame resolve field and parameter help', async () => {
        const { frameAtCaret, lookupHelpForFrame } = await import('../services/ipl/commandHelp');
        const code = '<STX>H0;o35,40;c25;k12;d3,Hello<ETX>';
        // Caret on the leading H -> field help.
        const atH = frameAtCaret(code, code.indexOf('H0'))!;
        expect(lookupHelpForFrame(atH.frame, atH.offsetInFrame)?.token).toBe('H');
        // Caret inside the "c25" segment -> font parameter help.
        const atC = frameAtCaret(code, code.indexOf('c25') + 1)!;
        expect(lookupHelpForFrame(atC.frame, atC.offsetInFrame)?.token).toBe('c');
        // Caret inside "k12" -> point-size help.
        const atK = frameAtCaret(code, code.indexOf('k12') + 1)!;
        expect(lookupHelpForFrame(atK.frame, atK.offsetInFrame)?.token).toBe('k');
    });

    it('resolves control-frame help (<ESC>P, <SI>W)', async () => {
        const { frameAtCaret, lookupHelpForFrame } = await import('../services/ipl/commandHelp');
        const esc = frameAtCaret('<STX><ESC>P<ETX>', 6)!;
        expect(lookupHelpForFrame(esc.frame, esc.offsetInFrame)?.token).toBe('<ESC>P');
        const si = frameAtCaret('<STX><SI>W812<ETX>', 8)!;
        expect(lookupHelpForFrame(si.frame, si.offsetInFrame)?.token).toBe('<SI>W');
    });
});

describe('fase 4: page composition (S/M/O/q)', () => {
    const pageStream = [
        '<STX><ESC>C<ETX>',
        '<STX><ESC>P<ETX>',
        '<STX>E1;F1;<ETX>',
        '<STX>H0;o10,10;c0;d3,FORMAT-ONE<ETX>',
        '<STX>B1;o10,60;c0;h60;w2;d3,123<ETX>',
        '<STX>R<ETX>',
        '<STX><ESC>P<ETX>',
        '<STX>E2;F2;<ETX>',
        '<STX>H0;o5,5;c0;d3,FMT2<ETX>',
        '<STX>R<ETX>',
        '<STX>S1;Ma,1;O0,0;Mb,2;O300,0<ETX>',
        '<STX>R<ETX>',
        '<STX><ESC>G1<CAN><ETX>',
    ].join('\n');

    it('parses the S frame into placements', () => {
        const label = parseViewerIPL(pageStream);
        expect(label.settings.pageNumber).toBe(1);
        expect(label.page!.placements).toEqual([
            { position: 'a', formatId: 1, offsetX: 0, offsetY: 0, rotation: 0 },
            { position: 'b', formatId: 2, offsetX: 300, offsetY: 0, rotation: 0 },
        ]);
    });

    it('composes placed formats with offsets into page coordinates', () => {
        const label = parseViewerIPL(pageStream);
        // Format 1: H0 at (10,10), B1 at (10,60); format 2: H0 at (5,5)+300x offset.
        const texts = label.elements.filter(e => e.kind === 'text');
        expect(texts.map(t => [t.ox, t.oy]).sort((a, b) => a[0] - b[0])).toEqual([[10, 10], [305, 5]]);
        const barcodes = label.elements.filter(e => e.kind === 'barcode');
        expect(barcodes[0].ox).toBe(10);
    });

    it('warns when a placement references an undefined format', () => {
        const label = parseViewerIPL('<STX>S9;Ma,7;O0,0<ETX>');
        expect(label.issues.some(i => i.code === 'page-format-missing')).toBe(true);
        expect(label.elements).toHaveLength(0);
    });

    it('applies page rotation q to placed formats', () => {
        const label = parseViewerIPL([
            '<STX><ESC>P<ETX>',
            '<STX>E1;F1;<ETX>',
            '<STX>H0;o10,10;c0;d3,R<ETX>',
            '<STX>R<ETX>',
            '<STX>S1;Ma,1;O100,0;q1<ETX>',
        ].join('\n'));
        // q1 = 90° CCW: origin (10,10) -> (-10,10), +offset (100,0) -> (90,10)
        const t = label.elements[0];
        expect([t.ox, t.oy]).toEqual([90, 10]);
        expect(t.f).toBe(1);
    });

    it('records a standalone q frame as the job format direction', () => {
        const label = parseViewerIPL([
            '<STX><ESC>P<ETX>',
            '<STX>E1;F1;<ETX>',
            '<STX>H0;o10,10;c0;d3,R<ETX>',
            '<STX>R<ETX>',
            '<STX>q3<ETX>',
        ].join('\n'));
        // A bare q frame does not move elements — it declares the orientation
        // the viewer applies as a preview rotation.
        expect(label.settings.formatDirection).toBe(3);
        expect(label.elements[0].ox).toBe(10);
        expect(label.issues.some(i => i.code === 'unknown-frame' && i.command === 'q3')).toBe(false);
    });

    it('clamps and flags an out-of-range standalone q', () => {
        const label = parseViewerIPL('<STX>q7<ETX>');
        expect(label.settings.formatDirection).toBe(3);
        expect(label.issues.some(i => i.code === 'rotation-invalid')).toBe(true);
    });
});

describe('fase 4: odometer (multi-label inc/dec preview)', () => {
    const incCode = [
        '<STX><ESC>P<ETX>',
        '<STX>E1;F1;<ETX>',
        '<STX>H0;o10,10;c0;d0,20<ETX>',
        '<STX>R<ETX>',
        '<STX><ESC>E1<CAN><ESC>F0<NUL>Lot <FS>000100<FS> ok<ESC>I5<US>2<RS>3<ETB><FF><ETX>',
    ].join('\n');

    it('advances numeric <FS> regions by the increment per batch', async () => {
        const { resolveLabelAtBatch, totalLabelCount } = await import('../services/ipl/odometer');
        const label = parseViewerIPL(incCode);
        expect(totalLabelCount(label)).toBe(6); // 3 batches x 2 copies
        const data = (b: number) => (resolveLabelAtBatch(label, b, 203).elements[0] as TextElement).source as { type: string; data: string };
        expect(data(0).data).toBe('Lot 000100 ok');
        expect(data(1).data).toBe('Lot 000105 ok');
        expect(data(2).data).toBe('Lot 000110 ok');
    });

    it('advances alphanumeric <GS> regions with Z→A carry', async () => {
        const { resolveLabelAtBatch } = await import('../services/ipl/odometer');
        const label = parseViewerIPL([
            '<STX><ESC>P<ETX>',
            '<STX>E1;F1;<ETX>',
            '<STX>H0;o10,10;c0;d0,20<ETX>',
            '<STX>R<ETX>',
            '<STX><ESC>E1<CAN><ESC>F0<NUL><FS>ZZ99<GS><ESC>I1<RS>2<ETB><FF><ETX>',
        ].join('\n'));
        const data = (b: number) => (resolveLabelAtBatch(label, b, 203).elements[0] as TextElement).source as { data: string };
        // Alphabet is 0-9 then A-Z: ZZ99 + 1 = ZZ9A (9 rolls into A).
        expect(data(1).data).toBe('ZZ9A');
    });

    it('wraps alphanumeric odometer ZZZZ → 0000', async () => {
        const { resolveLabelAtBatch } = await import('../services/ipl/odometer');
        const label = parseViewerIPL([
            '<STX><ESC>P<ETX>',
            '<STX>E1;F1;<ETX>',
            '<STX>H0;o10,10;c0;d0,20<ETX>',
            '<STX>R<ETX>',
            '<STX><ESC>E1<CAN><ESC>F0<NUL><FS>ZZZZ<GS><ESC>I1<RS>2<ETB><FF><ETX>',
        ].join('\n'));
        const data = (b: number) => (resolveLabelAtBatch(label, b, 203).elements[0] as TextElement).source as { data: string };
        expect(data(1).data).toBe('0000');
    });

    it('strips in-block <ESC> commands from field data', () => {
        const label = parseViewerIPL(incCode);
        const t = label.elements[0] as TextElement;
        expect((t.source as { data: string }).data).not.toContain('ESC');
    });

    it('decrements when only <ESC>D is present', async () => {
        const { resolveLabelAtBatch } = await import('../services/ipl/odometer');
        const label = parseViewerIPL([
            '<STX><ESC>P<ETX>',
            '<STX>E1;F1;<ETX>',
            '<STX>H0;o10,10;c0;d0,20<ETX>',
            '<STX>R<ETX>',
            '<STX><ESC>E1<CAN><ESC>F0<NUL><FS>000050<FS><ESC>D10<RS>2<ETB><FF><ETX>',
        ].join('\n'));
        const data = (b: number) => (resolveLabelAtBatch(label, b, 203).elements[0] as TextElement).source as { data: string };
        expect(data(1).data).toBe('000040');
    });
});

describe('BarTender-generated IPL compatibility', () => {
    // Real output from BarTender 10.1 + Intermec IPL driver (print-to-file).
    const btStyle = [
        '<STX>R<ETX>',
        '<STX><ESC>C<SI>W780<ETX>',
        '<STX><ESC>P<ETX>',
        '<STX>F*<ETX>',
        '<STX>B1;f3;o459,35;c6,0,0,2;w7;h403;d3,SBY001<ETX>',
        '<STX>H2;f3;o59,329;c26;b0;h17;w17;d3,SBY001<ETX>',
        '<STX>D0<ETX>',
        '<STX>R<ETX>',
        '<STX><SI>l13<ETX>',
        '<STX><ESC>E*,1<CAN><ETX>',
        '<STX><RS>1<US>1<ETB><ETX>',
    ].join('\n');

    it('parses F* (temp format create) and its fields', () => {
        const label = parseViewerIPL(btStyle);
        expect(label.elements.map(e => e.kind)).toEqual(['barcode', 'text']);
        expect(label.widthDots).toBe(780);
    });

    it('honors D0 field deletion inside a format', () => {
        const label = parseViewerIPL([
            '<STX><ESC>P<ETX>',
            '<STX>F1<ETX>',
            '<STX>H0;o10,10;c0;d3,KEEP<ETX>',
            '<STX>H1;o10,50;c0;d3,DROP<ETX>',
            '<STX>D1<ETX>',
            '<STX>R<ETX>',
        ].join('\n'));
        expect(label.elements.map(e => (e as TextElement).source).map(s => (s as { data: string }).data)).toEqual(['KEEP']);
    });

    it('reads quantity/batch from combined <RS>..<US>..<ETB> frames', () => {
        const label = parseViewerIPL(btStyle.replace('<RS>1<US>1<ETB>', '<RS>4<US>2<ETB>'));
        expect(label.settings.quantity).toBe(4);
        expect(label.settings.batchCount).toBe(2);
    });
});

describe('graphic/UDC path (BarTender G/U export)', () => {
    it('parses single-frame G definition with 1-based u columns', async () => {
        const { decodeGraphicColumns, encodeBitmapColumns } = await import('../services/ipl/graphics');
        const bitmap: number[][] = [];
        for (let y = 0; y < 8; y++) bitmap.push(Array.from({ length: 8 }, (_, x) => (x === y || x === y + 1) ? 1 : 0));
        const cols = encodeBitmapColumns(bitmap);
        const uParams = cols.map((c, i) => `u${i + 1},${c}`).join(';');
        const stream = `<STX><ESC>P<ETX><STX>E1;F1;<ETX><STX>G1,LOGO;x8;y8;${uParams}<ETX><STX>U1;o10,10;f0;h1;w1;c1<ETX><STX>R<ETX>`;
        const label = parseViewerIPL(stream);
        const g = label.elements.find(e => e.kind === 'graphic') as GraphicElement;
        expect(g).toBeDefined();
        expect(g.name).toBe('LOGO');
        expect(g.widthDots).toBe(8);
        expect(g.data).toHaveLength(8);
        // bitmap round-trips exactly
        const decoded = decodeGraphicColumns(g.widthDots, g.heightDots, g.data!);
        expect(decoded).toEqual(bitmap);
    });

    it('U field with c<n> references the G definition', () => {
        const stream = '<STX><ESC>P<ETX><STX>E1;F1;<ETX><STX>G1;x4;y4;u1,@A<ETX><STX>U2;o5,5;f0;h1;w1;c1<ETX><STX>R<ETX>';
        const label = parseViewerIPL(stream);
        const g = label.elements.find(e => e.kind === 'graphic') as GraphicElement;
        expect(g.graphicId).toBe(1);
        expect(g.widthDots).toBe(4);
    });
});
