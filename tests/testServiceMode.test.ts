import { describe, it, expect } from 'vitest';
import { parseViewerIPL } from '../services/ipl/viewerParser';

const stx = (f: string) => `<STX>${f}<ETX>`;
const stream = (chain: string) => [
    stx('<ESC>P'), stx('<SI>W812'), stx('<SI>L406'), stx(chain), stx('<ESC>E1'),
].join('');
const codes = (chain: string) => parseViewerIPL(stream(chain)).issues.map(i => i.code);

/**
 * Test and Service Mode, Enter — `<ESC>T` (PRM 2.70 p.117).
 *
 * Found by sweeping the one task table no earlier pass had touched: "Test and
 * Service Commands" (p.82). Two things fell out.
 *
 * 1. `<ESC>T` had NO decision path, and neither did anything chained after it.
 *    The manual's own reset example is `<STX><ESC>T;D;R;<ETX>` (p.219) — both
 *    commands behind the mode-enter were dropped, with no word about either.
 *    Measured across all 52 letters, the only `<ESC>` commands that carried a
 *    chain at all were P and C.
 *
 * 2. Chaining it through parseChained — the obvious fix — would have been
 *    WRONG. The letters are a different command set here (p.82): B is Printhead
 *    Resistance Test, not Bar Code Field; T is Label Taken Sensor, not the mode
 *    enter; C is Pitch Label, not Advanced Mode. Probed with <ESC>P as a proxy,
 *    "D" came back "Unrecognized command frame ignored" — a fresh false alarm
 *    on correct input.
 *
 * So the chain is read against ITS OWN table, and split by what it does to the
 * picture: the entries named "…, Print" print the PRINTER's own labels, and the
 * rest transmit a value to the host. Neither draws this job's label, so no
 * element appears either way — but nothing is silent.
 */
describe('Test and Service mode has a decision path', () => {
    it('reports the manual own reset example instead of dropping it', () => {
        // <STX><ESC>T;D;R;<ETX> — PRM p.219.
        expect(codes('<ESC>T;D;R;')).toContain('test-service-query');
    });

    it('says when a test command prints a PRINTER label, not this job one', () => {
        // The manual names these "…, Print": they produce a printer's own test
        // document, which is a different label from the one being previewed.
        for (const letter of ['B', 'C', 'f', 'g', 'h', 'p', 'Q', 's', 't']) {
            expect(codes(`<ESC>T;${letter};`), `letter ${letter}`).toContain('test-service-print');
        }
    });

    it('does not warn about the sensor queries, which print nothing', () => {
        // A D G K L M P R S T U V transmit a value to the HOST. They cannot
        // change any label, so warning would be noise — but they are not
        // silent either: the info names what each one does.
        for (const letter of ['A', 'D', 'G', 'K', 'L', 'M', 'P', 'R', 'S', 'T', 'U', 'V']) {
            const got = codes(`<ESC>T;${letter};`);
            expect(got, `letter ${letter}`).toContain('test-service-query');
            expect(got, `letter ${letter}`).not.toContain('test-service-print');
        }
    });

    it('does not mistake a real format chain for Test and Service commands', () => {
        // These are BARE single letters ("Syntax: U", "Syntax: f"). A segment
        // that carries an id belongs to something else — reading its first
        // letter here warned on correct input.
        const got = codes('<ESC>T;E1;F1;H1;o10,10;c0;h2;w2;d3,ABC');
        expect(got).not.toContain('test-service-print');
        expect(got).not.toContain('test-service-query');
    });

    it('stays quiet for a bare <ESC>T with nothing chained', () => {
        expect(codes('<ESC>T')).not.toContain('test-service-print');
        expect(codes('<ESC>T')).not.toContain('test-service-query');
    });

    it('reports each distinct command once, not once per repeat', () => {
        const msgs = parseViewerIPL(stream('<ESC>T;D;D;D;R;')).issues
            .filter(i => i.code === 'test-service-query').map(i => i.message);
        expect(msgs.filter(m => /Factory Defaults/.test(m))).toHaveLength(1);
    });
});
