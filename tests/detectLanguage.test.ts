// Which parser reads a pasted stream.
//
// This rule decides the language for EVERY stream that enters the viewer, and a
// wrong answer renders the wrong label silently — so it is pinned here rather
// than left inside a component.
//
// The case that made this file necessary: an EPL label with no bare `N` line was
// detected as IPL and reported nothing. `N` clears the image buffer and is
// routinely omitted, so the rule that required it rejected valid files.

import { describe, it, expect } from 'vitest';
import { detectSourceLanguage } from '../components/IPLViewerModal';

describe('source language detection', () => {
    it('recognises ZPL from its ^XA sigil', () => {
        expect(detectSourceLanguage('^XA^FO50,50^FDHI^FS^XZ')).toBe('zpl');
        expect(detectSourceLanguage('  \n^XA^XZ')).toBe('zpl');
    });

    it('recognises IPL from its <STX> frames', () => {
        expect(detectSourceLanguage('<STX>H1;o35,70;c25;k9;d3,HI;<ETX>')).toBe('ipl');
    });

    it('recognises TSPL from CLS plus an object command', () => {
        expect(detectSourceLanguage('SIZE 100 mm,50 mm\nCLS\nQRCODE 10,10,L,4,A,0,"x"\nPRINT 1,1')).toBe('tspl');
        expect(detectSourceLanguage('SIZE 50 mm,25 mm\nGAP 3 mm,0\nCLS\nTEXT 56,24,"3",0,1,1,"ABC"\nPRINT 1,1')).toBe('tspl');
        // SIZE alone is not enough — TSPL is identified by CLS, which is the
        // command no other language here has.
        expect(detectSourceLanguage('SIZE 100 mm,50 mm\nPRINT 1,1')).toBe('ipl');
    });

    it('recognises EPL from an EPL command, WITH OR WITHOUT the N line', () => {
        // The regression this pins: `N` is optional in practice.
        expect(detectSourceLanguage('N\nA40,20,0,3,2,2,N,"HI"\nP1')).toBe('epl');
        expect(detectSourceLanguage('A40,20,0,3,2,2,N,"HI"\nP1')).toBe('epl');
        expect(detectSourceLanguage('b10,50,D,h4,"DM"')).toBe('epl');
        expect(detectSourceLanguage('LO50,200,400,20')).toBe('epl');
        expect(detectSourceLanguage('X20,240,4,340,300')).toBe('epl');
        expect(detectSourceLanguage('B40,70,0,3,2,4,70,B,"12345"')).toBe('epl');
    });

    it('does NOT mistake TSPL for EPL, even though both use x,y', () => {
        // TSPL's TEXT has a QUOTED font name; EPL's A does not. And CLS settles
        // it before the EPL rule is consulted.
        expect(detectSourceLanguage('CLS\nTEXT 10,10,"2",0,1,1,"X"')).toBe('tspl');
        // An EPL label that happens to contain the word SIZE in its data is
        // still EPL: SIZE is only part of the TSPL rule when CLS is present.
        expect(detectSourceLanguage('A10,10,0,2,1,1,N,"SIZE 100 mm"')).toBe('epl');
    });

    it('falls through to IPL for anything that is none of them', () => {
        // Prose is not a label; the IPL parser's "no frames found" is the most
        // useful of the available messages.
        expect(detectSourceLanguage('Hello, this is a note about labels.')).toBe('ipl');
        expect(detectSourceLanguage('')).toBe('ipl');
        expect(detectSourceLanguage('N')).toBe('ipl');   // a lone N is a plausible text line
    });
});
