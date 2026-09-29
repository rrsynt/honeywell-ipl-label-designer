import { describe, it, expect } from 'vitest';
import { parseViewerIPL } from '../services/ipl/viewerParser';

const stx = (f: string) => `<STX>${f}<ETX>`;

/**
 * The wireless (`<SI>ws,…` / `<SI>wt,…`) and Bluetooth (`<SI>Bs,…` / `<SI>Bt,…`)
 * blocks are the largest family on the K10-only surface — 61 entries between
 * them, none of which PRM 2.70 carries.
 *
 * They cannot change a printed label, and the earlier sweeps' rule is that a
 * setting which cannot change the picture stays silent. So the question here is
 * NOT whether they warn. It is whether one of them is FALSELY CAUGHT by a
 * one-letter handler and silently rewrites a printer setting instead — every
 * `<SI>` handler in the parser is a single letter, while these are two.
 *
 * They are not caught: measured across every command and across arguments
 * shaped like real commands ("W999", "z1", "i1", "KVOID"), none changes the
 * label. These tests hold that, and the positive control that makes them
 * meaningful is in the first case below — without it, "no false catch" and "a
 * blind probe" look identical.
 */
describe('the wireless and Bluetooth SI blocks stay out of the picture', () => {
    const stream = (cmd: string) => [
        stx('<ESC>P'), stx('<SI>W812'), stx('<SI>L406'), cmd ? stx(cmd) : '',
        stx('E1;F1'), stx('H1;o10,10;c0;h2;w2;d3,ABC'), stx('R'), stx('<ESC>E1'),
    ].join('');

    it('has a working positive control first', () => {
        // If this stopped working the rest of the file would prove nothing.
        expect(parseViewerIPL(stream('<SI>W999')).widthDots).toBe(999);
        expect(parseViewerIPL(stream('<SI>L999')).heightDots).toBe(999);
        expect(parseViewerIPL(stream('')).widthDots).toBe(812);
    });

    it('never lets a two-letter command change the label geometry', () => {
        const CMDS = [
            // wireless, set and transmit
            '<SI>ws,SECURITY TYPE', '<SI>wt,ACCESS POINT MAC', '<SI>ws,CHANNEL',
            '<SI>ws,NETWORK NAME (SSID)', '<SI>wt,NETWORK NAME (SSID)',
            '<SI>ws,NETWORK KEY 1', '<SI>wt,NETWORK KEY 4', '<SI>ws,NETWORK KEY INDEX',
            '<SI>ws,POWER MODE', '<SI>wt,POWER MODE', '<SI>ws,ROAMING', '<SI>wt,ROAMING',
            '<SI>ws,VALIDATE CERTIFICATE', '<SI>wt,VALIDATE CERTIFICATE',
            '<SI>ws,USER NAME', '<SI>ws,USER PASSWORD', '<SI>ws,CLIENT KEY',
            '<SI>ws,CA CERTIFICATE', '<SI>ws,PAC', '<SI>ws,INNER AUTHENTICATION',
            '<SI>ws,ANONYMOUS NAME', '<SI>ws,ASSOCIATION', '<SI>ws,ACQUIRE PAC',
            '<SI>ws,SECURITY', '<SI>ws,RESERVE', '<SI>ws,HIDDEN SSID',
            '<SI>wt,SPEED', '<SI>wt,SIGNAL', '<SI>wt,.REGION', '<SI>wt,.SERVER COMMON NAME 1',
            // Bluetooth
            '<SI>Bt', '<SI>Bs,DEVICE NAME', '<SI>Bt,DEVICE ADDRESS',
            '<SI>Bs,DISCOVER', '<SI>Bt,DISCOVER', '<SI>Bs,ENCRYPT', '<SI>Bt,ENCRYPT',
            '<SI>Bs,.PASS KEY', '<SI>Bt,.PASS KEY', '<SI>Bs,RESERVE', '<SI>Bt,RESERVE',
            '<SI>Bs,SECURITY', '<SI>Bt,SECURITY',
        ];
        for (const cmd of CMDS) {
            const r = parseViewerIPL(stream(cmd));
            expect(r.widthDots, cmd).toBe(812);
            expect(r.heightDots, cmd).toBe(406);
            expect(r.elements, cmd).toHaveLength(1);
            expect((r.elements[0] as { source: { data: string } }).source.data, cmd).toBe('ABC');
        }
    });

    it('is not tripped by an argument shaped like a real command', () => {
        // The realistic false catch: a one-letter handler anchoring on the
        // letter alone would read "W999" out of "<SI>ws,W999".
        const TRAPS = [
            '<SI>ws,W999', '<SI>wt,L999', '<SI>ws,S1', '<SI>wt,d-5', '<SI>ws,z1',
            '<SI>wt,o0', '<SI>ws,i1', '<SI>wt,KVOID', '<SI>ws,C1', '<SI>wt,T1',
            '<SI>ws,X5,3', '<SI>wt,F20', '<SI>Bs,W999', '<SI>Bt,z1',
        ];
        for (const cmd of TRAPS) {
            const r = parseViewerIPL(stream(cmd));
            expect(r.widthDots, cmd).toBe(812);
            expect(r.heightDots, cmd).toBe(406);
            // None of the picture-changing reporters may fire either.
            const codes = r.issues.map(i => i.code);
            for (const forbidden of ['setup-not-modelled', 'rotation-invalid', 'unknown-data-source']) {
                expect(codes, `${cmd} triggered ${forbidden}`).not.toContain(forbidden);
            }
        }
    });

    it('leaves them silent, because they cannot change the picture', () => {
        // Silence is the correct answer for a network setting — a warning here
        // would train users to ignore the ones that matter.
        for (const cmd of ['<SI>ws,SECURITY TYPE', '<SI>wt', '<SI>Bt', '<SI>Bs,ENCRYPT']) {
            expect(parseViewerIPL(stream(cmd)).issues.map(i => i.code), cmd).not.toContain('setup-not-modelled');
        }
    });
});
