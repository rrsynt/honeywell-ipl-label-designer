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
    it('the paired format header E<n>;F<n> raises no unrecognized-frame warning', () => {
        // "E1;F1" is one format header, but the chain walker used to flush
        // "E1" on its own. parseFieldFrame does not know a bare format id, so
        // every chained stream warned "Unrecognized command frame ignored"
        // (command "E1") while rendering perfectly — the viewer's built-in
        // "Chained" sample showed it on load.
        const code = stx('<ESC>P;E1;F1;H1;o100,100;f0;c25;k12;d3,Hello World!;B2;o100,200;f0;c6;h80;w2;i1;d3,12345678;R');
        const label = parseViewerIPL(code);
        expect(label.elements.map(e => e.kind)).toEqual(['text', 'barcode']);
        expect(label.issues.filter(i => i.code === 'unknown-frame')).toEqual([]);
    });
    it('a bare format id without its F partner still warns', () => {
        // The pairing only swallows "E<n>" when "F…" follows. A lone "E1"
        // opens nothing, so the field after it is outside a format and the
        // stray id itself is reported — the fix must not hide real problems.
        const code = stx('<ESC>P;E1;H1;o10,10;c0;d3,OK;R');
        const label = parseViewerIPL(code);
        expect(label.elements).toHaveLength(0);
        const codes = label.issues.map(i => i.code);
        expect(codes).toContain('unknown-frame');
        expect(codes).toContain('field-outside-format');
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

// ---------------------------------------------------------------------------
// Setup commands inside a CHAINED frame
// ---------------------------------------------------------------------------
//
// A chain is a transport detail, not a different command set — but parseChained
// walked segments against its own COMMAND_START list, which knows only field
// and format headers. <SI> and <ESC> were neither that nor params of a buffered
// command, so every one of them fell through to the "no buffer" branch and
// vanished WITHOUT A WARNING while the label still rendered:
//
//   <STX><ESC>P;<SI>W812;<SI>L406;E1;F1;H1;…;R<ETX>
//
// lost the width, the height, the speed, the darkness and the printer language
// — so the preview drew the right fields at the wrong size, in the wrong
// character set, and said nothing. The built-in "Chained" sample never showed
// it because it carries no <SI> at all.
describe('setup commands inside a chained frame (2026-09-29)', () => {
    const chain = (setup: string) => stx(`<ESC>P;${setup};E1;F1;H1;o10,10;c25;k12;d3,AB;R`);
    const parse = (setup: string) => parseViewerIPL(chain(setup));

    it('applies the whole <SI> family, exactly as separate frames do', () => {
        const label = parse('<SI>W812;<SI>L406;<SI>S60;<SI>d5;<SI>l13;<SI>T1;<SI>g0');
        expect(label.widthDots, 'width').toBe(812);
        expect(label.heightDots, 'height').toBe(406);
        expect(label.settings.printSpeed, 'speed').toBe(6);
        expect(label.settings.darknessAdjust, 'darkness').toBe(5);
        expect(label.settings.codePage, 'language').toBe(13);
        expect(label.settings.mediaSenseMode, 'media sense').toBe('gap');
        expect(label.settings.mediaType, 'media type').toBe('direct-thermal');
    });

    it('gives the same result as the same commands in separate frames', () => {
        // The invariant that was broken: chaining must not change the meaning.
        const chained = parse('<SI>W812;<SI>L406');
        const separate = parseViewerIPL([
            stx('<ESC>P'), stx('<SI>W812'), stx('<SI>L406'),
            stx('E1;F1'), stx('H1;o10,10;c25;k12;d3,AB'), stx('R'),
        ].join(''));
        expect(chained.widthDots).toBe(separate.widthDots);
        expect(chained.heightDots).toBe(separate.heightDots);
        expect(chained.elements).toHaveLength(separate.elements.length);
    });

    it('dispatches a chained <ESC> command the same way', () => {
        // <ESC>C<SI>W640 carries inline setup, the shape BarTender emits.
        expect(parse('<ESC>C<SI>W640').widthDots).toBe(640);
    });

    it('keeps an <SI>-lookalike INSIDE d3 data as literal text', () => {
        // d3 is greedy to the frame end, so a segment in data position is text
        // even when it is shaped exactly like a command. Dispatching it would
        // silently reinterpret the label's own content.
        const label = parseViewerIPL(stx('<ESC>P;E1;F1;H1;o10,10;c25;k12;d3,LOT;<SI>W812;R'));
        const t = label.elements.find(e => e.kind === 'text') as TextElement;
        expect((t.source as { data: string }).data).toBe('LOT;<SI>W812');
        // widthDots is null until an <SI>W sets it — the point is that the
        // in-data lookalike did NOT set it.
        expect(label.widthDots, 'the in-data text must not set the width').toBeNull();
    });

    it('leaves the built-in Chained sample working', () => {
        const code = stx('<ESC>P;E1;F1;H1;o100,100;f0;c25;k12;d3,Hello World!;B2;o100,200;f0;c6;h80;w2;i1;d3,12345678;R');
        const label = parseViewerIPL(code);
        expect(label.elements.map(e => e.kind)).toEqual(['text', 'barcode']);
        expect(label.issues.filter(i => i.level !== 'info')).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Parameters AFTER the fixed data (the manual's own ordering)
// ---------------------------------------------------------------------------
//
// d3 is greedy because splitting it by ';' truncated real text like "A;B".
// But the manual also puts parameters after the data, and PRM 2.70 p.109 does
// exactly that: "<STX>H0;o35,40;c25;d3,Cat.;k12;<ETX>". Reading the whole
// tail as text made that field print "Cat.;k12" and silently dropped the
// point size — and h/w/r/f after d3 were dropped the same way, so the preview
// drew text and geometry the printer never produces.
//
// The fix separates only a TRAILING RUN of well-formed parameters, so text in
// the middle of intended data cannot be split.
describe('field parameters placed after the d3 data (PRM p.109)', () => {
    const textEl = (field: string) => {
        const l = parseViewerIPL([stx('<ESC>P'), stx('E5;F5;'), stx(field), stx('R')].join(''));
        return l.elements.find(e => e.kind === 'text') as TextElement;
    };

    it("parses the manual's own d3-then-k12 example as the manual intends", () => {
        // <STX>H0;o35,40;c25;d3,Cat.;k12;<ETX>
        const t = textEl('H0;o35,40;c25;d3,Cat.;k12;');
        expect((t.source as { data: string }).data, 'text').toBe('Cat.');
        expect(t.pointSize, 'point size from the trailing k12').toBe(12);
    });

    it('applies the other trailing parameters too, not just k', () => {
        expect(textEl('H0;o10,10;c25;k12;d3,AB;h3;').hMag).toBe(3);
        expect(textEl('H0;o10,10;c25;k12;d3,AB;w2;').wMag).toBe(2);
        expect(textEl('H0;o10,10;c25;k12;d3,AB;r1;').charRot).toBe(1);
        expect(textEl('H0;o10,10;c25;k12;d3,AB;f2;').f).toBe(2);
        // and several in a row
        const both = textEl('H0;o10,10;c25;k12;d3,AB;h3;w2;');
        expect(both.hMag).toBe(3);
        expect(both.wMag).toBe(2);
    });

    it('leaves real text containing ; alone', () => {
        // The greedy behaviour exists for these: an upper-case key, or letters
        // in the value, is not a parameter.
        for (const [field, want] of [
            ['H0;o10,10;c0;d3,A;B;', 'A;B'],
            ['H0;o10,10;c0;d3,LOT;ROLLS;', 'LOT;ROLLS'],
            ['H0;o10,10;c0;d3,X;B2;Y;', 'X;B2;Y'],
            ['H0;o10,10;c0;d3,BASIS WT. 39-4838;', 'BASIS WT. 39-4838'],
        ] as Array<[string, string]>) {
            expect((textEl(field).source as { data: string }).data, field).toBe(want);
        }
    });

    it('does not split a parameter-shaped segment in the MIDDLE of the data', () => {
        // Only a trailing run is stripped, so this stays one text value.
        const t = textEl('H0;o10,10;c0;d3,A;k12;B;');
        expect((t.source as { data: string }).data).toBe('A;k12;B');
    });

    it('is unchanged when d3 comes last, as the generator and BarTender emit', () => {
        const t = textEl('H0;o35,40;c25;k12;d3,Cat.;');
        expect((t.source as { data: string }).data).toBe('Cat.');
        expect(t.pointSize).toBe(12);
    });
});

// ---------------------------------------------------------------------------
// COMMAND_START must list every letter parseFieldFrame recognizes
// ---------------------------------------------------------------------------
//
// The chain walker keeps its own idea of what opens a segment. Two real field
// commands were missing from it while parseFieldFrame already handled both:
//
//   In  Interpretive Field, Edit (PRM p.200) — "Syntax: In"
//   Dn  Field, Delete         (PRM p.183) — "Syntax: Dn"
//
// A command the parser KNOWS how to handle was therefore treated as a
// parameter of whatever came before and silently dropped. This is the same
// shape as the chained-<SI> bug: recognized, then discarded without a word.
describe('field commands missing from COMMAND_START (2026-09-29)', () => {
    const P = (body: string) => parseViewerIPL(stx(`<ESC>P;${body}`));
    const kinds = (l: ReturnType<typeof parseViewerIPL>) =>
        l.elements.map(e => `${e.kind}${(e as { id?: number }).id ?? ''}`);

    it('keeps an interpretive field (In) in a chain', () => {
        // The chain produced ONE element where the same commands as separate
        // frames produced two — the interpretive field was gone.
        const chained = P('E1;F1;B1;o10,10;c3;h40;w2;d3,123;I1;o10,60;c0;h3;w3;R');
        const separate = parseViewerIPL([
            stx('<ESC>P'), stx('E1;F1'), stx('B1;o10,10;c3;h40;w2;d3,123'),
            stx('I1;o10,60;c0;h3;w3'), stx('R'),
        ].join(''));
        expect(kinds(chained)).toEqual(kinds(separate));
        expect(kinds(chained)).toEqual(['barcode1', 'text']);
    });

    it('deletes a field (Dn) from a chain', () => {
        // Dn takes NO origin param, so the "an o-param follows" boundary test
        // could never be satisfied for it: a chained "…;D2;R" was swallowed as
        // data and the field survived. It is exempt from that test.
        expect(kinds(P('E1;F1;H1;o10,10;c0;d0,10;H2;o10,50;c0;d0,10;D2;R'))).toEqual(['text1']);
        // …and it works whether or not earlier fields carried d3 data.
        expect(kinds(P('E1;F1;H1;o10,10;c0;d3,X;H2;o10,50;c0;d3,Y;D2;R'))).toEqual(['text1']);
    });

    it('keeps the accepted text cost of the D exemption pinned', () => {
        // Documented tradeoff, not an accident: with Dn exempt from the
        // o-param test, data that literally contains "…;D2;…" is split. It is
        // indistinguishable from a real delete by shape, no fixture contains
        // such text, and D0 does appear in real BarTender samples (so the
        // command genuinely occurs). If this ever needs to change, the rule to
        // revisit is the exemption, and this test is where it is recorded.
        const t = parseViewerIPL(stx('<ESC>P;E1;F1;H1;o10,10;c0;d3,A;D2;B;R'))
            .elements.find(e => e.kind === 'text') as TextElement;
        expect((t.source as { data: string }).data).toBe('A');
    });

    it('leaves the pre-existing d3 boundary rule alone for the other letters', () => {
        // A plain "A;B" is still one text value: the boundary needs an o-param,
        // and this shape does not have one.
        const t = parseViewerIPL(stx('<ESC>P;E1;F1;H1;o10,10;c0;d3,A;B;H2;o10,40;c0;d3,SECOND;R'));
        const first = t.elements.find(e => (e as { id?: number }).id === 1) as TextElement;
        expect((first.source as { data: string }).data).toBe('A;B');
    });
});
