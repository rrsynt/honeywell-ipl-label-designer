// LATER FUN-06 (2026-10-06): a W1D (manual-format) QR record silently
// normalised to auto — model/ECL/mask vanished and the prefix stayed in the
// data. The manual (Honeywell Fiji Command Reference, pp. 219-221) gives the
// data structure as `[q,] [e [m] i,] cdata... term` where q = 1|2 model,
// e = H|Q|M|L error-correction, m = 0-8|none mask, i = A|a|M|m input mode,
// and cdata starts with a mode letter N|A|B|K. The parser now captures q/e/m
// and strips the prefix; an unrecognised prefix stays as data WITH a warning
// (the old silent behaviour, named).
import { describe, it, expect } from 'vitest';
import { parseDPL } from '../services/dpl/dplParser';
import { dplBarcodeFor } from '../services/dpl/dplBarcodes';

const PAGE = 800;

// a=1 b=W1D c=1 d=1 eee=000 ffff=0100 gggg=0100 then data, then quantity/end.
const qrStream = (data: string): string =>
    `\x02L\r1W1D1100001000100${data}\rQ0001\rE\r`;

const qrOf = (data: string): any =>
    parseDPL(qrStream(data), PAGE).elements.find(e => (e as any).kind === 'barcode') as any;

describe('W1D records keep their manual-format parameters', () => {
    it('dplBarcodeFor flags manual vs auto from the letter case', () => {
        expect(dplBarcodeFor('W1D')?.manual).toBe(true);
        expect(dplBarcodeFor('W1d')?.manual).toBe(false);
        expect(dplBarcodeFor('W1d')?.type.symbology).toBe('18');
    });

    it('captures model, ECL and input mode, and strips the prefix from data', () => {
        // q=1 (model 1), e=Q, i=A (auto ASCII), cdata=AHELLO (alphanumeric).
        const el = qrOf('1,Q,A,AHELLO');
        expect(el.symbology).toBe('18');
        expect(el.qrModel).toBe('1');
        expect(el.qrEcl).toBe('Q');
        expect(el.source.data).toBe('HELLO');
    });

    it('captures the mask when present', () => {
        const el = qrOf('2,M2A,AHELLO');
        expect(el.qrModel).toBe('2');
        expect(el.qrEcl).toBe('M');
        expect(el.qrMask).toBe('2');
        expect(el.source.data).toBe('HELLO');
    });

    it('a bare data record (no prefix) stays data with no params', () => {
        const el = qrOf('HELLO');
        expect(el.source.data).toBe('HELLO');
        expect(el.qrModel).toBeUndefined();
        expect(el.qrEcl).toBeUndefined();
    });

    it('an unrecognised prefix stays as data WITH a warning, not silently', () => {
        const label = parseDPL(qrStream('9,Z,Z,ZHELLO'), PAGE);
        const el = label.elements.find(e => (e as any).kind === 'barcode') as any;
        expect(el.source.data).toBe('9,Z,Z,ZHELLO');
        expect(label.issues.some(i => i.code === 'dpl-qr-manual-prefix')).toBe(true);
    });

    it('hex input mode is named: the bytes are not decoded', () => {
        // B is the binary mode letter (Bnnnn: byte count + bytes); the mode
        // letter is stripped like any other, but the hex pairs stay as
        // written — the printer converts each pair into one byte.
        const label = parseDPL(qrStream('2,M,a,B0048414648'), PAGE);
        const el = label.elements.find(e => (e as any).kind === 'barcode') as any;
        expect(el.source.data).toBe('0048414648');
        expect(el.qrEcl).toBe('M');
        expect(label.issues.some(i => i.code === 'dpl-qr-hex-input' && /hex/i.test(i.message))).toBe(true);
    });

    it('a comma inside ordinary data stays silent', () => {
        const label = parseDPL(qrStream('HELLO, WORLD'), PAGE);
        const el = label.elements.find(e => (e as any).kind === 'barcode') as any;
        expect(el.source.data).toBe('HELLO, WORLD');
        expect(label.issues.some(i => typeof i.code === 'string' && i.code.startsWith('dpl-qr'))).toBe(false);
    });

    it('W1d (auto) records are untouched: no params, no new warnings', () => {
        const auto = parseDPL(`\x02L\r1W1d1100001000100HELLO\rQ0001\rE\r`, PAGE);
        const el = auto.elements.find(e => (e as any).kind === 'barcode') as any;
        expect(el.source.data).toBe('HELLO');
        expect(el.qrModel).toBeUndefined();
        expect(auto.issues.some(i => typeof i.code === 'string' && i.code.startsWith('dpl-qr'))).toBe(false);
    });
});
