import { describe, it, expect } from 'vitest';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { parseIPL } from '../services/iplParser';

const stx = (f: string) => `<STX>${f}<ETX>`;
const stream = (frames: string[]) => [
    stx('<ESC>P'), stx('<SI>W812'), stx('<SI>L406'), ...frames.map(stx), stx('R'),
].join('');
const codes = (f: string[]) => parseViewerIPL(stream(f)).issues.map(i => i.code);
const els = (f: string[]) => parseViewerIPL(stream(f)).elements;

/**
 * RFID Tag Write Field — `Qn` (PRM 2.70 p.213).
 *
 * It is listed in the manual's own "Format Editing Commands" task table
 * (B D H I L Q U W, pp.92-95) and appears verbatim in the manual's RFID label
 * example, yet it reached the generic "Unrecognized command frame ignored" —
 * the same defect the bare `C` (Command Tables, Load) had, and for the same
 * reason: it is not a letter the /^[HBLWUG]/ test knows.
 *
 * The picture was not wrong, which is why this was invisible: the field writes
 * to a TAG, so the printer draws nothing for it. What was wrong was the
 * REPORT — a named, documented command described as unrecognized, which is the
 * failure mode this project exists to prevent.
 */
describe('Qn is an RFID field, not an unrecognized command', () => {
    it('parses the manual own RFID example without calling anything unrecognized', () => {
        // PRM 2.70 p.44, verbatim.
        const manual = [
            stx('<ESC>C'), stx('<ESC>P'), stx('E4;F4;'),
            stx('H0;o102,51;f0;c25;h20;w20;d0,30;'),
            stx('L1;o102,102;f0;l575;w5;'),
            stx('B2;o203,153;c0,0;h100;w2;i1;d0,10;'),
            stx('I2;h1;w1;c20;'),
            stx('Q3;a2,2,0,23;d3,MY FIRST RFID TAG WRITE;'),
            stx('R;'),
        ].join('');
        const label = parseViewerIPL(manual);
        expect(label.issues.map(i => i.code)).not.toContain('unknown-frame');
        // The four printable elements are still there, plus the RFID field.
        expect(label.elements.map(e => e.kind)).toEqual(
            expect.arrayContaining(['text', 'line', 'barcode', 'unknown']),
        );
    });

    it('does not raise a spurious missing-origin — o is not a Q parameter', () => {
        // The manual lists the Q field's parameters as a, d and n only
        // ("RFID Tag Write Field Default Parameters", p.213). Its own example
        // carries no `o`, so asking for one would warn on correct input.
        expect(codes(['E4;F4;', 'Q3;a2,2,0,23;d3,TEXT;'])).not.toContain('missing-origin');
    });

    it('reports what the field does rather than staying silent about it', () => {
        expect(codes(['E4;F4;', 'Q3;a2,2,0,23;d3,TEXT;'])).toContain('rfid-write-field');
    });

    it('keeps the field id in the format inventory', () => {
        const found = els(['E4;F4;', 'Q3;a2,2,0,23;d3,TEXT;']).find(e => e.kind === 'unknown');
        expect(found?.id).toBe(3);
    });

    it('is a chain command, so text behind it still parses', () => {
        // Q had to join COMMAND_START too, or a chained "Q3;…;H1;…" would have
        // read the whole field as a parameter of whatever came before.
        const got = els(['E4;F4;', 'Q3;a2,2,0,23;H1;o10,10;c0;h2;w2;d3,ABC']);
        expect(got.some(e => e.kind === 'unknown')).toBe(true);
        const text = got.find(e => e.kind === 'text') as { source: { data: string } };
        expect(text.source.data).toBe('ABC');
    });

    it('still knows the bare Q, which is a different command', () => {
        // "Print Quality Label, Print — Syntax: Q" (PRM p.220) prints the
        // PRINTER's own test label, not this job's, so no element appears.
        const r = parseViewerIPL(stream(['E4;F4;', 'Q']));
        expect(r.elements).toHaveLength(0);
        expect(r.issues.map(i => i.code)).toContain('print-quality-label');
    });

    it('treats a2 / n1 as RFID field parameters, not standalone commands', () => {
        // "RFID Tag Editing Commands" (PRM p.94) lists a, d and n as the
        // parameters OF an RFID field. Standing alone they are not commands,
        // so they are the fields they are written inside — nothing to report.
        expect(els(['E4;F4;', 'Q1;a2,2,0,23;n1;d3,X']).some(e => e.kind === 'unknown')).toBe(true);
    });
});

describe('the importer reports the RFID field it cannot hold', () => {
    // Same channel the orphan `In` uses: the designer has no RFID concept, so
    // the alternative to a notice is a silent drop.
    const notices = (frames: string[]): string[] => {
        const seen: string[] = [];
        parseIPL(stream(frames), 203, n => seen.push(`${n.command}|${n.message}`));
        return seen;
    };

    it('reports a Q field instead of dropping it silently', () => {
        const got = notices(['E4;F4;', 'Q3;a2,2,0,23;d3,TEXT;']);
        expect(got.some(n => n.startsWith('Q3|'))).toBe(true);
        expect(got.some(n => /RFID/i.test(n))).toBe(true);
    });

    it('does not invent a notice for a stream without RFID', () => {
        expect(notices(['E4;F4;', 'H1;o10,10;c0;h2;w2;d3,ABC;']).some(n => /RFID/i.test(n))).toBe(false);
    });
});
