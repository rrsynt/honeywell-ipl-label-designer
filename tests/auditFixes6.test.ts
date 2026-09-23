import { describe, it, expect } from 'vitest';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import type { TextElement, BarcodeElement, BoxElement, LineElement } from '../services/ipl/types';

// Batch 6 audit remainder: d2 master/slave sources (T2), chained-frame d3
// greedy data (T-chain), <ESC>C dispatch semantics (T3, PRM-verified), and
// L/W line-thickness defaults + clamp (the `w` double meaning).

const stx = (f: string) => `<STX>${f}<ETX>`;
const texts = (code: string) =>
    parseViewerIPL(code).elements.filter(e => e.kind === 'text') as TextElement[];

describe('d2 master/slave sources (audit T2)', () => {
    // H1 fixed text master → H2 text slave; B4 barcode master → H5 text slave
    // (allowed direction); B6 barcode slave of H1 (PRM p.175 forbids this);
    // H7 slave of a missing field.
    const code = [
        stx('<ESC>P'), stx('E1;F1'),
        stx('H1;o10,10;c0;d3,MASTER'),
        stx('H2;o10,30;c0;d2,1'),
        stx('B4;o10,50;c0;h20;d3,98765'),
        stx('H5;o10,70;c0;d2,4'),
        stx('B6;o10,90;c0;h20;d2,1'),
        stx('H7;o10,110;c0;d2,42'),
        stx('R'),
    ].join('\n');
    const label = parseViewerIPL(code);
    const byId = new Map(label.elements.map(e => [e.id, e]));

    it('copies a fixed master into a text slave at end of parse', () => {
        const s = (byId.get(2) as TextElement).source;
        expect(s.type).toBe('variable');
        expect((s as { data: string }).data).toBe('MASTER');
    });
    it('a human-readable field CAN copy from a bar code master (PRM p.175)', () => {
        expect(((byId.get(5) as TextElement).source as { data: string }).data).toBe('98765');
    });
    it('a bar code field CANNOT copy from a human-readable master — warned, empty', () => {
        expect(((byId.get(6) as BarcodeElement).source as { data: string }).data).toBe('');
        expect(label.issues.some(i => i.code === 'master-field-direction')).toBe(true);
    });
    it('slave of a missing master renders empty with a warning, never silent', () => {
        const s = (byId.get(7) as TextElement).source;
        expect((s as { data: string }).data).toBe('');
        expect(label.issues.some(i => i.code === 'master-field-missing' && i.message.includes('42'))).toBe(true);
    });
    it('slave with an FS/GS element offset copies just that element', () => {
        const fsCode = [
            stx('<ESC>P'), stx('E1;F1'),
            stx('H1;o10,10;c0;d3,AAA\x1cBBB\x1cCCC'),
            stx('H2;o10,30;c0;d2,1,1'),
            stx('H3;o10,50;c0;d2,1,2'),
            stx('H4;o10,70;c0;d2,1,9'),
            stx('R'),
        ].join('\n');
        const fsLabel = parseViewerIPL(fsCode);
        const get = (id: number) => (fsLabel.elements.find(e => e.id === id) as TextElement).source as { data: string };
        expect(get(2).data).toBe('BBB');
        expect(get(3).data).toBe('CCC');
        expect(get(4).data).toBe('');
        expect(fsLabel.issues.some(i => i.code === 'master-offset-out-of-range')).toBe(true);
    });
    it('an offset-less d2 keeps the whole master value (default 0)', () => {
        const s = (byId.get(2) as TextElement).source as { data: string };
        expect(s.data).toBe('MASTER');
    });
    it('slave follows print-block data attached to a variable master', () => {
        const code2 = [
            stx('<ESC>P'), stx('E1;F1'),
            stx('H1;o10,10;c0;d0'),
            stx('H2;o10,30;c0;d2,1'),
            stx('R'),
            stx('<ESC>E1<CAN><ESC>F1<NUL>FROM-HOST<ETB><FF>'),
        ].join('\n');
        const s = (texts(code2).find(t => t.id === 2)!.source) as { type: string; data: string };
        expect(s.data).toBe('FROM-HOST');
    });
    it('chained frames resolve slaves too', () => {
        const s = texts(stx('<ESC>P;E1;F1;H1;o10,10;c0;d3,CHAIN;H2;o10,30;c0;d2,1;R'))
            .find(t => t.id === 2)!.source as { data: string };
        expect(s.data).toBe('CHAIN');
    });
    it('d1 (print-mode entry, same semantics as d0) is variable — not empty-slave', () => {
        const s = texts([
            stx('<ESC>P'), stx('E1;F1'), stx('H1;o10,10;c0;d1,25'), stx('R'),
        ].join('\n'))[0].source;
        expect(s.type).toBe('variable');
        expect((s as { data: string }).data).toBe('');
    });
});

describe('d3 fixed data with ";" inside chained frames (audit T-chain)', () => {
    it('keeps semicolons in d3 text when the next command is a real header', () => {
        const code = stx('<ESC>P;E1;F1;H1;o10,10;c0;d3,A;B;H2;o10,40;c0;d3,SECOND;R');
        const ts = parseViewerIPL(code).elements.filter(e => e.kind === 'text') as TextElement[];
        expect((ts.find(t => t.id === 1)!.source as { data: string }).data).toBe('A;B');
        expect((ts.find(t => t.id === 2)!.source as { data: string }).data).toBe('SECOND');
    });
    it('a bare header-shaped text segment stays data unless an o-param follows', () => {
        // "B2" mid-text with no origin param after it: still data.
        const code = stx('<ESC>P;E1;F1;H1;o10,10;c0;d3,X;B2;Y;H2;o10,40;c0;d3,OK;R');
        const ts = parseViewerIPL(code).elements.filter(e => e.kind === 'text') as TextElement[];
        expect((ts.find(t => t.id === 1)!.source as { data: string }).data).toBe('X;B2;Y');
        expect((ts.find(t => t.id === 2)!.source as { data: string }).data).toBe('OK');
    });
    it('R after d3 data still terminates the chain', () => {
        const code = stx('<ESC>P;E1;F1;H1;o10,10;c0;d3,TAIL;DATA;R');
        const label = parseViewerIPL(code);
        const t = label.elements.filter(e => e.kind === 'text')[0] as TextElement;
        expect((t.source as { data: string }).data).toBe('TAIL;DATA');
    });
});

describe('<ESC>C dispatch — Advanced Mode, Select (audit T3, PRM p.91)', () => {
    it('bare <ESC>C closes the open format and selects Advanced mode', () => {
        // <ESC>C is NOT "clear stored format": a following R still commits.
        const code = [
            stx('<ESC>P'), stx('E1;F1'), stx('H1;o10,10;c0;d3,X'), stx('R'),
            stx('<ESC>C'),
        ].join('\n');
        const label = parseViewerIPL(code);
        expect(label.elements.some(e => e.kind === 'text')).toBe(true);
        expect(label.issues.some(i => i.code === 'esc-command' && i.message.includes('C'))).toBe(false);
    });
    it('dot-size parameter <ESC>C0/<ESC>C1 is the same mode select, not an unknown command', () => {
        for (const c of ['<ESC>C0', '<ESC>C1']) {
            const label = parseViewerIPL([stx('<ESC>P'), stx('E1;F1'), stx('H1;o10,10;c0;d3,X'), stx('R'), stx(c)].join('\n'));
            expect(label.issues.some(i => i.code === 'esc-command')).toBe(false);
            expect(label.elements).toHaveLength(1);
        }
    });
    it('inline setup after the dot size still parses (<ESC>C1<SI>W812)', () => {
        const label = parseViewerIPL(stx('<ESC>C1<SI>W812'));
        expect(label.widthDots).toBe(812);
    });
    it('<ESC>Fn print-data is unaffected: F stays a no-op command, data attaches via the print block', () => {
        // <ESC>Fn is "Field, Select" (PRM p.113) — never a format terminator.
        // <ESC>En is the print invocation; it closes the format.
        const code = [
            stx('<ESC>P'), stx('E1;F1'), stx('H1;o10,10;c0;d0'), stx('R'),
            stx('<ESC>E1<CAN><ESC>F1<NUL>DATA<ETB><FF>'),
        ].join('\n');
        const t = texts(code)[0];
        expect((t.source as { data: string }).data).toBe('DATA');
    });
});

describe('L/W default line thickness = 1 dot (PRM p.193 / p.169) and w clamp', () => {
    it('L frame without w defaults to thickness 1 and w is clamped like other dims', () => {
        const label = parseViewerIPL([
            stx('<ESC>P'), stx('E1;F1'),
            stx('L1;o10,10;l100'),
            stx('L2;o10,40;l100;w999999'),
            stx('R'),
        ].join('\n'));
        const l1 = label.elements.find(e => e.id === 1 && e.kind === 'line') as LineElement;
        const l2 = label.elements.find(e => e.id === 2 && e.kind === 'line') as LineElement;
        expect(l1.thicknessDots).toBe(1);
        expect(l2.thicknessDots).toBe(20000);
        expect(label.issues.some(i => i.code === 'dimension-clamped' && i.message.includes('L.w'))).toBe(true);
    });
    it('W frame without w defaults to border thickness 1; huge w is clamped, not silent', () => {
        const label = parseViewerIPL([
            stx('<ESC>P'), stx('E1;F1'),
            stx('W1;o10,10;l50;h40'),
            stx('W2;o10,60;l50;h40;w999999'),
            stx('R'),
        ].join('\n'));
        const w1 = label.elements.find(e => e.id === 1 && e.kind === 'box') as BoxElement;
        const w2 = label.elements.find(e => e.id === 2 && e.kind === 'box') as BoxElement;
        expect(w1.thicknessDots).toBe(1);
        expect(w2.thicknessDots).toBe(20000);
        expect(label.issues.some(i => i.code === 'dimension-clamped' && i.message.includes('W.w'))).toBe(true);
    });
    it('explicit w values are honored', () => {
        const label = parseViewerIPL([
            stx('<ESC>P'), stx('E1;F1'),
            stx('W1;o10,10;l50;h40;w8'),
            stx('R'),
        ].join('\n'));
        expect((label.elements[0] as BoxElement).thicknessDots).toBe(8);
    });
});
