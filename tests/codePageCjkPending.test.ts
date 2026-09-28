// The CJK tables arrive by dynamic import, so there is a window — between
// module load and the import resolving — in which a stream that says <SI>l30
// is parsed while the tables are absent.
//
// That window is worth its own test FILE rather than a case in
// codePageCjk.test.ts: vitest gives each file a fresh module registry, so the
// `beforeAll(ensureCjkReady)` over there is what makes every test in it run in
// the loaded state. Here nothing awaits the import, so this file observes the
// module exactly as a cold app does.
//
// It exists because the loaded-state tests missed a real crash: `cjkTable`
// indexed the raw table map before checking it was non-null, so the first
// CJK decode on a cold start threw a TypeError out of the parser. 1331 tests
// were green and the app was broken on the very first label. Nothing here may
// await ensureCjkReady.

import { describe, it, expect } from 'vitest';
import { decodeCodePage, isCjkReady } from '../services/ipl/codePages';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import type { TextElement } from '../services/ipl/types';

const stx = (f: string) => `<STX>${f}<ETX>`;
const bytes = (...v: number[]) => String.fromCharCode(...v);

describe('before the CJK tables have loaded', () => {
    it('has not loaded them yet', () => {
        // Guards the test itself: if something up-stack awaited the import,
        // every assertion below would pass vacuously and prove nothing.
        expect(isCjkReady()).toBe(false);
    });

    it('passes CJK bytes through instead of throwing', () => {
        // The bytes are what the viewer showed before this feature existed —
        // not a fabricated character, and above all not a crash.
        for (const n of [30, 31, 32, 33]) {
            expect(decodeCodePage(bytes(0x93, 0xfa), n)).toBe(bytes(0x93, 0xfa));
        }
    });

    it('parses a CJK stream without throwing', () => {
        const ipl = [stx('<ESC>P'), stx('<SI>l30'), stx('E1;F1'),
                     stx('H0;o10,10;c50;k12;d3,' + bytes(0x93, 0xfa)), stx('R'), stx('<ESC>E1')].join('');
        const label = parseViewerIPL(ipl);
        const el = label.elements.find(e => e.kind === 'text') as TextElement;
        expect(el).toBeTruthy();
        // Raw bytes, and the label still rendered something rather than dying.
        expect(el.source).toEqual({ type: 'fixed', data: bytes(0x93, 0xfa) });
    });

    it('reports the pending state as info, never as a warning', () => {
        // A transient load is not a defect in the stream, and a warning here
        // would teach users to ignore the warning list.
        const ipl = [stx('<ESC>P'), stx('<SI>l31'), stx('E1;F1'),
                     stx('H0;o10,10;c25;k12;d3,ABC'), stx('R'), stx('<ESC>E1')].join('');
        const label = parseViewerIPL(ipl);
        expect(label.issues.filter(i => i.level === 'warning')).toHaveLength(0);
        expect(label.issues.some(i => i.code === 'code-page-cjk-pending')).toBe(true);
    });

    it('still catches an undocumented page number', () => {
        // The unknown-page warning is not part of the deferred family and must
        // keep firing on a cold start.
        const ipl = [stx('<ESC>P'), stx('<SI>l77'), stx('E1;F1'),
                     stx('H0;o10,10;c25;k12;d3,ABC'), stx('R'), stx('<ESC>E1')].join('');
        expect(parseViewerIPL(ipl).issues.some(i => i.code === 'code-page-unknown')).toBe(true);
    });
});
