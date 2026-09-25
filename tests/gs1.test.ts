import { describe, it, expect } from 'vitest';
import { buildGs1, gs1CheckDigit, gs1PairProblem, type Gs1Pair } from '../services/gs1';
import { buildBwipSpec, measureBarcode, ensureBarcodesReady } from '../services/ipl/barcodes';

// A real GTIN-14: the check digit is computed, not typed, so the fixture cannot
// drift from the rule it is testing.
const gtin = (() => {
    const body = '0031234567890';
    return body + gs1CheckDigit(body);
})();

const pairs: Gs1Pair[] = [
    { ai: '01', value: gtin },
    { ai: '17', value: '251231' },
    { ai: '10', value: 'LOT42' },
    { ai: '21', value: 'SN7' },
];

describe('GS1 Application Identifier builder', () => {
    it('writes every pair as (AI)value with nothing between them', () => {
        const built = buildGs1(pairs);
        expect(built.problems).toEqual([]);
        // The parentheses are the field boundaries. The encoder, not the
        // builder, decides where the FNC1 separators go.
        expect(built.data).toBe(`(01)${gtin}(17)251231(10)LOT42(21)SN7`);
    });

    it('strips the parentheses and spaces a user types into a value', () => {
        const built = buildGs1([{ ai: '10', value: '(LOT 42)' }]);
        expect(built.data).toBe('(10)LOT42');
    });

    it('rejects a bad check digit, a short value and an unknown AI', () => {
        expect(gs1PairProblem({ ai: '01', value: gtin.slice(0, -1) + '0' })?.message).toMatch(/check digit/);
        expect(gs1PairProblem({ ai: '17', value: '2512' })?.message).toMatch(/exactly 6/);
        expect(gs1PairProblem({ ai: '99', value: '1' })?.message).toMatch(/not one this builder knows/);
        // And a broken pair is left OUT of the encoding, not encoded wrong.
        const built = buildGs1([{ ai: '99', value: '1' }, { ai: '10', value: 'OK' }]);
        expect(built.problems).toHaveLength(1);
        expect(built.data).toBe('(10)OK');
    });

    it('the Code 128 spelling encodes, which is the bwip validator', async () => {
        await ensureBarcodesReady();
        const { data } = buildGs1(pairs);
        // Symbology 6 is Code 128. measureBarcode renders the symbol and returns
        // null when the encoder refuses the data, so a real width IS the pass.
        const measured = measureBarcode('6', data, {});
        expect(measured).not.toBeNull();
        expect(measured!.widthModules).toBeGreaterThan(0);
        // And it must have gone through the GS1 encoder, not literal parentheses.
        expect(buildBwipSpec('6', data)?.main.bcid).toBe('gs1-128');
    });

    it('the same data encodes as DataMatrix and QR', async () => {
        await ensureBarcodesReady();
        const { data } = buildGs1(pairs);
        // 17 is DataMatrix, 18 is QR. Both must take the GS1 variant so the
        // parentheses become AI markers instead of drawn characters.
        expect(buildBwipSpec('17', data)?.main.bcid).toBe('gs1datamatrix');
        expect(buildBwipSpec('18', data)?.main.bcid).toBe('gs1qrcode');
        for (const symbology of ['17', '18']) {
            const measured = measureBarcode(symbology, data, {});
            expect(measured, symbology).not.toBeNull();
            expect(measured!.widthModules).toBeGreaterThan(0);
        }
    });
});
