// Fase 3: an uploaded font fills a per-glyph advance table, and the designer's
// measure of a line and the viewer's agree to within 1%.
//
// The uploaded face is Liberation Sans registered under a different name. That
// is deliberate: it is a font whose advances are already known (the sans table
// in fontMetrics.ts was measured from it), so the test can prove the uploaded
// path reproduces them rather than inventing a second measurement.
import './golden/setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { newRealCanvas } from './golden/setup';
import { GlobalFonts } from '@napi-rs/canvas';
import {
    measureAdvanceTable, nearestResidentFamily, averageAdvance, widthDelta,
    installFontFile, memoryFontBackend, setFontBackend,
} from '../services/fontStore';
import { outlineTextWidthDots, clearUploadedFontMetrics, getUploadedFontMetrics } from '../services/ipl/fontMetrics';
import { fontSubstitutions, generateIPL } from '../services/iplGenerator';
import type { Design, TextField } from '../types';

const FONT_FILE = path.resolve('public/fonts/LiberationSans-Regular.ttf');
// A name no resident family uses, so the lookup cannot fall through to one.
const FACE = 'Uploaded Test Sans';

beforeEach(() => {
    clearUploadedFontMetrics();
    setFontBackend(memoryFontBackend());
});

const measureCtx = () => newRealCanvas(10, 10).getContext('2d');

describe('advance table from an uploaded font', () => {
    it('measures one per-mille entry per printable ASCII glyph', () => {
        GlobalFonts.registerFromPath(FONT_FILE, FACE);
        const advances = measureAdvanceTable(measureCtx(), `"${FACE}"`);
        // 32 through 126 inclusive.
        expect(advances).toHaveLength(95);
        // Every glyph has a positive advance. A zero would mean measureText
        // resolved a missing glyph and the table is describing nothing.
        expect(advances.every(n => n > 0)).toBe(true);
    });

    it('agrees with the vendored sans table it was measured from', () => {
        GlobalFonts.registerFromPath(FONT_FILE, FACE);
        const advances = measureAdvanceTable(measureCtx(), `"${FACE}"`);
        // The resident sans average is 524 per-mille. Liberation Sans measured
        // the same way must land on it, or the two measurement paths diverged.
        expect(averageAdvance(advances)).toBeGreaterThan(450);
        expect(averageAdvance(advances)).toBeLessThan(600);
        expect(nearestResidentFamily(advances)).toBe('sans-serif');
    });

    it('a monospace face is recognised as monospace, not as the default', () => {
        const mono = path.resolve('public/fonts/LiberationMono-Regular.ttf');
        GlobalFonts.registerFromPath(mono, 'Uploaded Test Mono');
        const advances = measureAdvanceTable(measureCtx(), '"Uploaded Test Mono"');
        expect(nearestResidentFamily(advances)).toBe('monospace');
        // Mono is a flat 600, so its delta against the resident mono is ~0.
        expect(widthDelta(advances, 'monospace')).toBeLessThan(0.02);
    });
});

describe('designer and viewer measure the same width', () => {
    const install = async () => {
        GlobalFonts.registerFromPath(FONT_FILE, FACE);
        const file = new File([readFileSync(FONT_FILE)], `${FACE}.ttf`);
        return installFontFile(file, measureCtx());
    };

    it('installing populates the advance table the viewer reads', async () => {
        const stored = await install();
        expect(stored.advances).toHaveLength(95);
        expect(stored.nearest).toBe('sans-serif');
        // The registry the renderer consults, not just the stored record.
        const metrics = getUploadedFontMetrics(FACE);
        expect(metrics?.advances).toEqual(stored.advances);
    });

    it('the two widths agree to within 1%', async () => {
        await install();
        const ctx = measureCtx();
        const px = 100;
        ctx.font = `${px}px "${FACE}"`;
        const line = 'HELLO WORLD 123';

        // The designer measures with the canvas. Scale that to the same
        // dot height the viewer is asked for, so the two numbers share a unit.
        const hDots = 34;
        const designerDots = ctx.measureText(line).width / px * hDots;
        const viewerDots = outlineTextWidthDots(line, hDots, FACE);

        const delta = Math.abs(designerDots - viewerDots) / designerDots;
        expect(delta).toBeLessThanOrEqual(0.01);
    });

    it('the generator emits the resident font and reports the difference', async () => {
        const stored = await install();
        const field: TextField = {
            id: 1, type: 'text', name: 'T', x: 5, y: 5, rotation: 0,
            dataSource: { type: 'fixed', data: 'HELLO' },
            font: FACE, fontSize: 12, h_mag: 1, w_mag: 1,
        };
        const design = {
            name: 'T',
            labelSettings: { width: 100, height: 65, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
            printerSettings: { model: 'PD43', dpi: 203, quantity: 1, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
            fields: [field], dataSources: [], nextId: 2, guides: { horizontal: [], vertical: [] },
        } as Design;

        const subs = fontSubstitutions(design);
        expect(subs).toHaveLength(1);
        expect(subs[0].resident).toBe('sans-serif');
        expect(subs[0].delta).toBeGreaterThanOrEqual(0);

        // The stream must carry a resident id (c61 for sans), never the
        // uploaded name — a printer would reject `cUploaded Test Sans`.
        const ipl = await generateIPL(design);
        expect(ipl).toContain(';c61;');
        expect(ipl).not.toContain(FACE);
        // And the reported delta matches the face that was stored.
        expect(subs[0].delta).toBeCloseTo(widthDelta(stored.advances, 'sans-serif'), 5);
    });

    it('a design using only resident fonts reports no substitution', () => {
        const design = {
            name: 'T', fields: [{ id: 1, type: 'text', font: '25' }],
        } as Design;
        expect(fontSubstitutions(design)).toEqual([]);
    });
});
