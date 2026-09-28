import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeCodePage, ensureCjkReady, isCjkReady, cjkTable, CODE_PAGES } from '../services/ipl/codePages';
import { decodeDbcs, type DbcsTable } from '../services/ipl/dbcs';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import type { TextElement } from '../services/ipl/types';

const stx = (f: string) => `<STX>${f}<ETX>`;

/** One char per byte, the shape the whole pipeline carries. */
const bytes = (...v: number[]) => String.fromCharCode(...v);

const textEl = (label: ReturnType<typeof parseViewerIPL>, i = 0) =>
    label.elements.filter(e => e.kind === 'text')[i] as TextElement;

/** The four pages, with the browser label each must reproduce. */
const PAGES = [
    { n: 30, whatwg: 'shift_jis' },
    { n: 31, whatwg: 'gbk' },
    { n: 32, whatwg: 'euc-kr' },
    { n: 33, whatwg: 'big5' },
] as const;

/**
 * The four Big5 slots where Chromium disagrees with its own specification.
 * Chromium emits U+0093 U+DF04 (a C1 control plus a LONE SURROGATE — not
 * well-formed) for pointer 1133; the standard says U+00CA U+0304, and GNU
 * iconv's BIG5-HKSCS and Python's big5hkscs both agree with the standard.
 * These slots are excluded from the Chromium comparison and pinned separately.
 */
const BIG5_SPEC_DIVERGENCE: Record<string, [number, number]> = {
    '8862': [0x00ca, 0x0304],
    '8864': [0x00ca, 0x030c],
    '88a3': [0x00ea, 0x0304],
    '88a5': [0x00ea, 0x030c],
};

beforeAll(async () => { await ensureCjkReady(); });

const golden = (n: number) => JSON.parse(
    readFileSync(join(__dirname, '..', 'testdata', 'codepages', `${n}.json`), 'utf8'),
) as { n: number; whatwg: string; leads: string; flat: string; singles: string; special?: string };

const u16 = (b64: string): Uint16Array => {
    const bin = Buffer.from(b64, 'base64').toString('binary');
    const out = new Uint16Array(bin.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
    return out;
};

const TRAILS: number[] = [];
for (let t = 0x40; t <= 0xfe; t++) if (t !== 0x7f) TRAILS.push(t);
const slotOf = (t: number) => t - 0x40 - (t > 0x7f ? 1 : 0);

const leadList = (g: { leads: string }): number[] => {
    const out: number[] = [];
    for (let i = 0; i < g.leads.length; i += 2) out.push(parseInt(g.leads.substr(i, 2), 16));
    return out;
};

describe('the CJK tables reproduce the browser', () => {
    // The whole point of committing a table is that Node and the browser agree.
    // Node's TextDecoder does NOT implement these labels correctly (see the
    // module header in codePages.ts), so the source of truth is the golden that
    // tools/gen-cjk-codepages.mjs builds from the WHATWG index — and these tests
    // check our decoder against that golden for every reachable byte sequence,
    // not a sample.
    for (const { n, whatwg } of PAGES) {
        const g = golden(n);
        const table = (): DbcsTable => {
            const t = cjkTable(n);
            if (!t) throw new Error(`no table for n=${n}`);
            return t;
        };

        it(`n=${n} (${whatwg}) decoded table matches its golden`, () => {
            expect(g.whatwg).toBe(whatwg);
            expect(table().whatwg).toBe(whatwg);
            const flat = u16(g.flat);
            expect(table().flat.length).toBe(flat.length);
            for (let i = 0; i < flat.length; i++) {
                if (table().flat[i] !== flat[i]) {
                    throw new Error(`slot ${i} (lead row ${Math.floor(i / 190)}, trail ${i % 190}): table=${table().flat[i]} golden=${flat[i]}`);
                }
            }
        });

        it(`n=${n} decodes every single byte exactly as the golden says`, () => {
            const singles = u16(g.singles);
            for (let b = 0x80; b <= 0xff; b++) {
                const want = singles[b - 0x80];
                // A lone byte with no single mapping is an error, not a char.
                const expected = want === 0xffff ? '�' : String.fromCodePoint(want);
                expect(`${b.toString(16)}=${decodeCodePage(bytes(b), n)}`)
                    .toBe(`${b.toString(16)}=${expected}`);
            }
        });

        it(`n=${n} decodes mapped pairs and never silently drops a byte`, () => {
            const flat = u16(g.flat);
            const specialSlots = new Set<number>();
            if (g.special) {
                const bin = Buffer.from(g.special, 'base64');
                for (let i = 0; i < bin.length; i += 12) specialSlots.add(bin.readUInt32LE(i));
            }
            let row = 0;
            for (const lead of leadList(g)) {
                for (const trail of TRAILS) {
                    const slot = row + slotOf(trail);
                    const key = `${lead.toString(16).padStart(2, '0')}${trail.toString(16).padStart(2, '0')}`;
                    const got = decodeCodePage(bytes(lead, trail), n);
                    if (specialSlots.has(slot)) continue; // covered by the Big5 pair test

                    const v = flat[slot];
                    if (v !== 0xffff) {
                        const want = String.fromCodePoint(v);
                        if (got !== want) throw new Error(`${key}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
                        continue;
                    }
                    // Unmapped. The spec's rule: emit one error, and if the
                    // trail was ASCII, "restore byte to ioQueue" — so it comes
                    // back as itself. A test expecting a bare U+FFFD here would
                    // be pinning a decoder that swallows a real character.
                    const want = '�' + (trail < 0x80 ? String.fromCharCode(trail) : '');
                    if (got !== want) throw new Error(`${key}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
                }
                row += 190;
            }
        });
    }
});

describe('sequence rules that a per-pair test cannot see', () => {
    // These pin the decoder's loop, where the failure mode is not a wrong
    // character but a wrong NUMBER of them: consuming the wrong byte shifts
    // everything after it, and a byte reprocessed that should have been
    // consumed turns one error into two.
    it('reprocesses an ASCII trail but consumes a non-ASCII one', () => {
        // 'A' is 0x41, a valid trail for CP932, so this is a mapped pair.
        // 0x20 is not a trail: the lead errors and the space survives.
        expect(decodeCodePage(bytes(0x81, 0x20), 30)).toBe('� ');
        // 0xFD is not a trail and not ASCII: it goes with the lead, so one
        // error comes out, not two.
        expect(decodeCodePage(bytes(0x81, 0xfd), 30)).toBe('�');
        expect(decodeCodePage(bytes(0x81, 0xff), 30)).toBe('�');
    });

    it('reports a lone lead byte at the end as one error', () => {
        for (const { n } of PAGES) {
            expect(decodeCodePage(bytes(0x81), n)).toBe('�');
        }
    });

    it('keeps a valid character before and after a bad pair', () => {
        // 日 (0x93FA) then a broken pair then 'A'. Three characters out.
        expect(decodeCodePage(bytes(0x93, 0xfa, 0x81, 0x20, 0x41), 30)).toBe('日� A');
    });

    it('decodes a whole Japanese string', () => {
        // 日本語 in Shift JIS.
        expect(decodeCodePage(bytes(0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea), 30)).toBe('日本語');
        // Katakana, where the small kana alternate with the large ones: 0x8341
        // is 'ア' but 0x8342 is 'ィ'. A decoder that got the trail offset wrong
        // would still produce katakana and only this sequence would catch it.
        expect(decodeCodePage(bytes(0x83, 0x41, 0x83, 0x43, 0x83, 0x45, 0x83, 0x47), 30)).toBe('アイウエ');
        expect(decodeCodePage(bytes(0x83, 0x42), 30)).toBe('ィ');
    });

    it('decodes the single-byte ranges each page defines', () => {
        // CP932 passes 0x80 through and maps 0xA1-0xDF to halfwidth katakana.
        expect(decodeCodePage(bytes(0xb1, 0xb2, 0xb3), 30)).toBe('ｱｲｳ');
        expect(decodeCodePage(bytes(0x80), 30)).toBe('\u0080');
        // CP936 has exactly one: the Euro.
        expect(decodeCodePage(bytes(0x80), 31)).toBe('€');
        // CP949 and CP950 have none — a lone high byte is an error.
        expect(decodeCodePage(bytes(0x80), 32)).toBe('�');
        expect(decodeCodePage(bytes(0x80), 33)).toBe('�');
    });

    it('decodes a whole Korean string', () => {
        // 한국어 in CP949.
        expect(decodeCodePage(bytes(0xc7, 0xd1, 0xb1, 0xb9, 0xbe, 0xee), 32)).toBe('한국어');
    });

    it('decodes a whole Simplified Chinese string', () => {
        // 中文 in GBK.
        expect(decodeCodePage(bytes(0xd6, 0xd0, 0xce, 0xc4), 31)).toBe('中文');
    });

    it('decodes a whole Traditional Chinese string', () => {
        // 中文 in Big5.
        expect(decodeCodePage(bytes(0xa4, 0xa4, 0xa4, 0xe5), 33)).toBe('中文');
    });

    it('passes real text through instead of folding it into bytes', () => {
        // Chars above U+00FF are unambiguously text, not bytes.
        expect(decodeCodePage('Preis 5€', 30)).toBe('Preis 5€');
        expect(decodeCodePage('日本語', 30)).toBe('日本語');
    });

    it('does not swallow real text that follows a stray lead byte', () => {
        // The lead byte is an error; the characters after it are the user's own
        // text and must survive. A decoder that treats "not a trail" as "consume
        // two" drops the Euro here — silently deleting a character the user
        // typed, with no error to show for it. Found by walking the loop, not
        // by a per-pair test: it needs a lead byte AND a following real char.
        const lead = bytes(0x81); // a lead byte for CP932 and CP949 alike
        expect(decodeCodePage(lead + '€87', 30)).toBe('�€87');
        expect(decodeCodePage(lead + '日', 30)).toBe('�日');
        expect(decodeCodePage(lead + '😀', 30)).toBe('�😀');
        for (const n of [31, 32, 33]) {
            expect(decodeCodePage(lead + '€87', n)).toBe('�€87');
        }
    });

    it('leaves ASCII alone on every page', () => {
        for (const { n } of PAGES) {
            expect(decodeCodePage('ABC-123 xyz', n)).toBe('ABC-123 xyz');
        }
    });
});

describe('the four Big5 slots where Chromium is wrong', () => {
    // Pinned to the SPEC, deliberately, with the divergence recorded rather
    // than silently matched. See BIG5_SPEC_DIVERGENCE for the evidence.
    for (const [hex, [cp1, cp2]] of Object.entries(BIG5_SPEC_DIVERGENCE)) {
        it(`${hex} decodes to the two code points the standard names`, () => {
            const lead = parseInt(hex.substr(0, 2), 16);
            const trail = parseInt(hex.substr(2, 2), 16);
            const got = decodeCodePage(bytes(lead, trail), 33);
            const want = String.fromCodePoint(cp1) + String.fromCodePoint(cp2);
            expect([...got].map(c => c.codePointAt(0))).toEqual([cp1, cp2]);
            expect(got).toBe(want);
            // And it really is the well-formed answer Chromium fails to give:
            // the combining mark must not be a lone surrogate. (Checked by hand
            // rather than via String.prototype.isWellFormed, which needs a newer
            // lib target than this project compiles against.)
            for (const ch of got) {
                const cp = ch.codePointAt(0)!;
                expect(cp >= 0xd800 && cp <= 0xdfff).toBe(false);
            }
        });
    }
});

describe('codePagesCjkData is loaded lazily', () => {
    it('decodes CJK only after ensureCjkReady resolves', async () => {
        expect(isCjkReady()).toBe(true); // beforeAll has run
        // The table for a page that does not exist is absent, not an error.
        expect(cjkTable(99)).toBeUndefined();
    });

    it('names the pages in CODE_PAGES without claiming a single-byte table', () => {
        for (const { n, whatwg } of PAGES) {
            expect(CODE_PAGES[n].dbcs).toBe(whatwg);
            expect(CODE_PAGES[n].table).toBeUndefined();
            expect(CODE_PAGES[n].resident).toBeUndefined();
        }
    });
});

describe('<SI>l parsing with a CJK page', () => {
    it('decodes fixed d3 data under the selected page', () => {
        const label = parseViewerIPL(
            [stx('<ESC>P'), stx('<SI>l30'), stx('E1;F1'),
             stx('H0;o10,10;c25;k12;d3,' + bytes(0x93, 0xfa, 0x96, 0x7b)), stx('R'), stx('<ESC>E1')].join(''),
        );
        expect(label.settings.codePage).toBe(30);
        expect(textEl(label).source).toEqual({ type: 'fixed', data: '日本' });
    });

    it('decodes print-block variable data under the selected page', () => {
        const label = parseViewerIPL(
            [stx('<ESC>P'), stx('<SI>l32'), stx('E1;F1'), stx('H0;o10,10;c25;k12;d1'), stx('R'),
             stx('<ESC>E1<CAN><ESC>F0<NUL>' + bytes(0xc7, 0xd1, 0xb1, 0xb9) + '<ETB><FF>')].join(''),
        );
        expect(textEl(label).source).toEqual({ type: 'variable', data: '한국' });
    });

    it('no longer warns that a CJK page is undecoded', () => {
        const label = parseViewerIPL(
            [stx('<ESC>P'), stx('<SI>l30'), stx('E1;F1'), stx('H0;o10,10;c25;k12;d3,ABC'), stx('R'), stx('<ESC>E1')].join(''),
        );
        expect(label.issues.some(i => i.code === 'code-page-cjk')).toBe(false);
        expect(label.issues.filter(i => i.level === 'warning')).toHaveLength(0);
    });

    it('still warns for an undocumented page number', () => {
        const label = parseViewerIPL(
            [stx('<ESC>P'), stx('<SI>l77'), stx('E1;F1'), stx('H0;o10,10;c25;k12;d3,ABC'), stx('R'), stx('<ESC>E1')].join(''),
        );
        expect(label.issues.some(i => i.code === 'code-page-unknown')).toBe(true);
    });

    it('warns when a CJK page meets a resident bitmap font', () => {
        // PRM p.134: code pages 11..33 do not work with resident fonts. The
        // range covers 30..33, and this is the case where a stream says
        // <SI>l30 but the field uses c0 — the bytes reach the font's own table.
        const label = parseViewerIPL(
            [stx('<ESC>P'), stx('<SI>l30'), stx('E1;F1'), stx('H0;o10,10;c0;d3,ABC'), stx('R'), stx('<ESC>E1')].join(''),
        );
        expect(label.issues.some(i => i.code === 'code-page-resident-font')).toBe(true);
    });

    it('describes a CJK page without saying it is undecoded', () => {
        expect(CODE_PAGES[31].label).toContain('CP936');
    });
});
