import { describe, it, expect } from 'vitest';
import { validateBarcode } from '../services/validator';
import { VirtualPrinter, KIND_PREFIX } from '../services/ipl/virtualPrinter';
import type { ViewerElement, BarcodeElement, TextElement } from '../services/ipl/types';

// Unit coverage for two modules that only ever ran through other suites
// (audit batch 4: coverage-gap closure).

describe('validateBarcode (designer-side regex gate)', () => {
    it('rejects empty data for every symbology', () => {
        for (const sym of ['0', '1', '2', '3', '4', '5', '6', '7', '12', '17']) {
            expect(validateBarcode('', sym)).toBe('Data cannot be empty.');
        }
    });

    it('Code 39 accepts its charset and rejects lowercase', () => {
        expect(validateBarcode('ABC-123 .$/+%', '0')).toBeNull();
        expect(validateBarcode('abc', '0')).toMatch(/invalid characters/);
    });

    it('ITF / Code 2 of 5 demand digits only', () => {
        expect(validateBarcode('12345', '2')).toBeNull();
        expect(validateBarcode('12A45', '2')).toMatch(/numeric/);
        expect(validateBarcode('12 34', '3')).toMatch(/numeric/);
    });

    it('Codabar needs A-D delimiters at both ends', () => {
        expect(validateBarcode('A12345B', '4')).toBeNull();
        expect(validateBarcode('12345', '4')).toMatch(/start and end/);
        expect(validateBarcode('A12345', '4')).toMatch(/start and end/); // missing stop char
        expect(validateBarcode('A12E45', '4')).toMatch(/invalid characters/); // E is outside the charset
    });

    it('Code 11 allows digits and hyphen only', () => {
        expect(validateBarcode('123-456', '5')).toBeNull();
        expect(validateBarcode('12A45', '5')).toMatch(/hyphen/);
    });

    it('EAN/UPC is digits-only', () => {
        expect(validateBarcode('4006381333931', '7')).toBeNull();
        expect(validateBarcode('400638133393X', '7')).toMatch(/numeric/);
    });

    it('2D and unknown ids never hard-fail rendering', () => {
        expect(validateBarcode('anything at all!', '6')).toBeNull();   // Code128
        expect(validateBarcode('anything', '12')).toBeNull();           // PDF417
        expect(validateBarcode('anything', '99')).toBeNull();           // unknown
    });
});

describe('VirtualPrinter store verbs', () => {
    const mk = (over: Partial<BarcodeElement>): BarcodeElement => ({
        kind: 'barcode', id: 0, ox: 0, oy: 0, f: 0, symbology: '0',
        heightDots: 40, moduleDots: 2, ratio: 1, hri: 0,
        source: { type: 'variable', data: '' }, ...over,
    });
    const mkText = (over: Partial<TextElement>): TextElement => ({
        kind: 'text', id: 0, ox: 0, oy: 0, f: 0, font: '0', hMag: 2, wMag: 2,
        source: { type: 'variable', data: '' }, ...over,
    });

    it('fieldKey separates formats, kinds and ids', () => {
        expect(VirtualPrinter.fieldKey(1, 'H', 0)).toBe('1:H0');
        expect(VirtualPrinter.fieldKey(1, 'H', 0)).not.toBe(VirtualPrinter.fieldKey(2, 'H', 0));
        expect(VirtualPrinter.fieldKey(1, 'H', 0)).not.toBe(VirtualPrinter.fieldKey(1, 'B', 0));
    });

    it('commitElement writes to the active bucket AND the live list (same object)', () => {
        const p = new VirtualPrinter();
        p.openFormat(1);
        const el = mk({ id: 3 });
        p.commitElement(el);
        expect(p.formats.get(1)).toEqual([el]);
        expect(p.label.elements[0]).toBe(el); // identity, not a copy
    });

    it('evictField is scoped to the ACTIVE format: other formats keep same-id elements', () => {
        const p = new VirtualPrinter();
        p.openFormat(1);
        const elF1 = mk({ id: 7 });
        p.commitElement(elF1);
        p.closeFormat();
        p.openFormat(2);
        const first = mk({ id: 7 });
        const second = mk({ id: 7 });
        p.commitElement(first);
        p.evictField(e => e.id === 7 && KIND_PREFIX[e.kind] === 'B');
        p.commitElement(second);
        expect(p.formats.get(1)).toEqual([elF1]); // untouched by format 2's eviction
        expect(p.formats.get(2)).toEqual([second]);
        expect(p.label.elements).toEqual([elF1, second]);
    });

    it('evictField removes from the live list by identity: live-only twins survive', () => {
        const p = new VirtualPrinter();
        p.openFormat(1);
        const inBucket = mk({ id: 1 });
        p.commitElement(inBucket);
        // Post-composition copies live in label.elements WITHOUT being in the
        // bucket; identity-based removal must not evict those.
        const twin = mk({ id: 1 });
        p.label.elements.push(twin);
        p.evictField(e => e.id === 1 && e.kind === 'barcode');
        expect(p.formats.get(1)).toEqual([]);
        expect(p.label.elements).toEqual([twin]);
    });

    it('deleteField clears stores and frees the duplicate key for redefinition', () => {
        const p = new VirtualPrinter();
        p.openFormat(1);
        const el = mk({ id: 4 });
        p.commitElement(el);
        p.seenFieldKeys.add(VirtualPrinter.fieldKey(1, 'B', 4));
        p.deleteField(4);
        expect(p.formats.get(1)).toEqual([]);
        expect(p.label.elements).toEqual([]);
        expect(p.seenFieldKeys.has(VirtualPrinter.fieldKey(1, 'B', 4))).toBe(false);
    });

    it('deleteField does not touch other formats', () => {
        const p = new VirtualPrinter();
        p.openFormat(1);
        const elF1 = mkText({ id: 2 });
        p.commitElement(elF1);
        p.closeFormat();
        p.openFormat(2);
        p.commitElement(mkText({ id: 2 }));
        p.deleteField(2); // active = format 2 only
        expect(p.formats.get(1)).toEqual([elF1]);
    });

    it('findPrecedingIn searches backwards and stops at beforeIndex', () => {
        const p = new VirtualPrinter();
        p.openFormat(1);
        const a = mk({ id: 1 });
        const b = mk({ id: 2 });
        const c = mk({ id: 3 });
        const bucket = [a, b, c];
        expect(p.findPrecedingIn(bucket, bucket.length, e => e.kind === 'barcode')).toBe(c);
        // beforeIndex is an EXCLUSIVE upper bound (used with indexOf(el) so a
        // field never resolves itself as its own host):
        expect(p.findPrecedingIn(bucket, 2, e => e.id === 1)).toBe(a);
        expect(p.findPrecedingIn(bucket, 0, e => e.id === 1)).toBeUndefined(); // nothing before index 0
        expect(p.findPrecedingIn(undefined, 0, () => true)).toBeUndefined();
    });

    it('bucketOf resolves an element to its defining format bucket', () => {
        const p = new VirtualPrinter();
        p.openFormat(1);
        const el = mk({ id: 1 });
        p.commitElement(el);
        p.openFormat(2);
        expect(p.bucketOf(el)).toBe(p.formats.get(1));
        expect(p.formatIdOf(el)).toBe(1);
        const orphan = mk({ id: 9 });
        p.label.elements.push(orphan);
        expect(p.bucketOf(orphan)).toBeUndefined();
        expect(p.formatIdOf(orphan)).toBe(0);
    });
});
