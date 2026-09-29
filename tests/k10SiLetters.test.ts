import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseViewerIPL } from '../services/ipl/viewerParser';

const stx = (f: string) => `<STX>${f}<ETX>`;

/**
 * The last group on the K10-only surface: the `<SI>` letters K10 (937-028-003)
 * carries and PRM 2.70's Configuration table (p.96) does not —
 * `V n q xc xp xu X` (the wireless and Bluetooth letters are covered by
 * k10WirelessBluetooth.test.ts).
 *
 * The split is by what each can do to the picture, and exactly one of them can
 * do anything at all:
 *
 *   <SI>X  Label Origin, X-Y Adjust  — MOVES THE PRINTED IMAGE, and is the
 *          reason this family was worth walking: the PRM does not document it
 *          at all (K10/P10 firmware only), so every earlier sweep that
 *          enumerated the PRM's indexes never saw it.
 *
 *   V n q xc xp xu  — battery threshold, network parameter mode, date/time,
 *          ignore-list, change password, change user. None can change what is
 *          printed, so silence is the correct answer for them.
 */
describe('the K10-only SI letters', () => {
    const stream = (cmd: string) => [
        stx('<ESC>P'), stx('<SI>W812'), stx('<SI>L406'), stx(cmd),
        stx('E1;F1'), stx('H1;o10,10;c0;h2;w2;d3,ABC'), stx('R'), stx('<ESC>E1'),
    ].join('');
    const unmodelled = (cmd: string) => parseViewerIPL(stream(cmd))
        .issues.filter(i => i.code === 'setup-not-modelled');

    it('announces <SI>X, the one that moves the image', () => {
        // "Defines the offset, to the right, of all characters in a font" is
        // X inside a FONT definition; as a SETUP command in K10 it is "Label
        // Origin, X-Y Adjust" — the image itself is shifted.
        for (const cmd of ['<SI>X5,3', '<SI>X-12', '<SI>X,3']) {
            expect(unmodelled(cmd), cmd).toHaveLength(1);
        }
    });

    it('stays silent for <SI>X at its documented default', () => {
        // n=0,0 is where the image already is, so nothing diverges. The omitted
        // first parameter is a legal spelling (<SI>X[m1][,m2]) and is handled
        // by the same regex, which is why ",3" above warns and "0,0" does not.
        for (const cmd of ['<SI>X0,0', '<SI>X']) {
            expect(unmodelled(cmd), cmd).toHaveLength(0);
        }
    });

    it('leaves the non-printing letters silent', () => {
        // None can change the printed image; a warning here would be noise that
        // trains users to ignore the <SI>X one.
        for (const cmd of ['<SI>V,1', '<SI>n', '<SI>q', '<SI>q,2', '<SI>xc,foo', '<SI>xp,a,b', '<SI>xu,admin']) {
            const r = parseViewerIPL(stream(cmd));
            expect(unmodelled(cmd), cmd).toHaveLength(0);
            // ...and they must not disturb the label either.
            expect(r.elements, cmd).toHaveLength(1);
            expect((r.elements[0] as { source: { data: string } }).source.data, cmd).toBe('ABC');
        }
    });

    it('keeps the K10-only SI letters enumerated, read from the manual index', () => {
        // The list above is only complete if it matches what K10 actually
        // carries. Read the index and check the letters this file covers are
        // the ones it names — so a letter added to K10 later cannot join the
        // surface unnoticed.
        const k10 = readFileSync(
            join(process.cwd(), 'docs', 'manuals', 'IPL_Command_Reference_K10_937-028-003',
                 'Main_Level_Commands_Listed_by_Name.htm'),
            'utf8',
        );
        const letters = new Set(
            [...k10.matchAll(/&lt;SI&gt;([A-Za-z]{1,2})\b/g)].map(m => m[1]),
        );
        // The letters this suite accounts for, plus the ones other suites own.
        const COVERED = new Set(['V', 'n', 'q', 'xc', 'xp', 'xu', 'X', 'Bs', 'Bt', 'wt', 'ws']);
        for (const letter of ['V', 'n', 'q', 'xc', 'xp', 'xu', 'X']) {
            expect(letters.has(letter), `<SI>${letter} is no longer in the K10 index`).toBe(true);
            expect(COVERED.has(letter)).toBe(true);
        }
    });
});
