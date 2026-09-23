// Batch P (2026-09-23): designer image export. The whole point is that the
// designer's PNG/PDF/ZIP buttons render through the SAME viewer pipeline
// (generateIPL → parseViewerIPL → streamBatchPages) that the golden tests
// pin — so these tests assert the mapping (label count, page size, cap), the
// parity against the viewer path, and the download plumbing. Pixels belong
// to batchExport/golden; jspdf/zipStore have their own suites.
import './golden/setup'; // real canvas + bwip node shims (module level!)
import { describe, it, expect, vi, afterEach } from 'vitest';
import { designJobLabelCount, streamDesignPages, downloadDesignPng, downloadDesignPdf, downloadDesignZip, MAX_BATCH_EXPORT } from '../services/designExport';
import { generateIPL } from '../services/iplGenerator';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { buildBatchPages } from '../services/batchExport';
import type { Design } from '../types';

// jsPDF is mocked at module level: downloadDesignPdf imports it dynamically,
// and vi.mock intercepts dynamic imports too. Our contract is the CALL
// SEQUENCE (one addImage per label, addPage between, save name), not the
// library's own correctness.
const pdfCalls: string[] = [];
vi.mock('jspdf', () => ({
    jsPDF: class {
        constructor() { pdfCalls.push('ctor'); }
        addPage() { pdfCalls.push('addPage'); }
        addImage() { pdfCalls.push('addImage'); }
        save(name: string) { pdfCalls.push(`save:${name}`); }
    },
}));

const design = (quantity: number): Design => ({
    name: 'Export Test',
    labelSettings: { width: 80, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields: [
        { id: 1, type: 'text', name: 'T', x: 5, y: 5, rotation: 0, dataSource: { type: 'fixed', data: 'HELLO' }, font: '25', fontSize: 12, h_mag: 1, w_mag: 1 },
        { id: 2, type: 'barcode', name: 'B', x: 5, y: 20, rotation: 0, dataSource: { type: 'fixed', data: '12345678' }, symbology: '6', humanReadable: 'none', h_mag: 50, w_mag: 2 },
    ],
    dataSources: [], nextId: 3, guides: { horizontal: [], vertical: [] },
});

describe('designJobLabelCount', () => {
    it('maps printer quantity to job labels (the <RS>n the generator emits)', async () => {
        expect(await designJobLabelCount(design(1))).toBe(1);
        expect(await designJobLabelCount(design(3))).toBe(3);
    }, 20000);
});

describe('streamDesignPages', () => {
    it('renders one page per label with physical page size at the design DPI', async () => {
        const pages: { widthPt: number; heightPt: number; landscape: boolean; dataUrl: string }[] = [];
        const n = await streamDesignPages(design(2), {}, (p) => pages.push(p));
        expect(n).toBe(2);
        for (const p of pages) {
            expect(p.dataUrl.startsWith('data:image/png')).toBe(true);
            // 80mm at 203dpi = 640 dots -> 640/203*72 ≈ 227pt; 50mm ≈ 142pt
            expect(p.widthPt).toBeCloseTo(640 / 203 * 72, 0);
            expect(p.heightPt).toBeCloseTo(400 / 203 * 72, 0);
            expect(p.landscape).toBe(true);
        }
    }, 30000);

    it('respects maxPages (the export cap contract)', async () => {
        let count = 0;
        const n = await streamDesignPages(design(5), { maxPages: 2 }, () => count++);
        expect(n).toBe(2);
        expect(count).toBe(2);
    }, 30000);

    it('is the viewer pipeline verbatim — same bytes as buildBatchPages on the generated IPL', async () => {
        const d = design(2);
        const viaService: string[] = [];
        await streamDesignPages(d, {}, (p) => viaService.push(p.dataUrl));
        const viaViewer = await buildBatchPages(parseViewerIPL(await generateIPL(d)), 203, 0, {});
        expect(viaService).toEqual(viaViewer.map(p => p.dataUrl));
    }, 60000);

    it('empty design yields NO page (the viewer empty-job guard — App notifies instead)', async () => {
        const blank = design(1);
        blank.fields = [];
        let count = 0;
        const n = await streamDesignPages(blank, {}, () => count++);
        expect(n).toBe(0);
        expect(count).toBe(0);
    }, 20000);
});

// ── download plumbing ─────────────────────────────────────────────────────
// happy-dom lacks URL.createObjectURL, and the anchor click is the only
// observable of "a file left the page" — capture both.

const setupDownloads = () => {
    const clicks: { href: string; download: string }[] = [];
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string, ...rest: any[]) => {
        const el = origCreate(tag as any, ...rest) as any;
        if (tag === 'a') {
            el.click = () => clicks.push({ href: String(el.href), download: String(el.download) });
        }
        return el;
    });
    (URL as any).createObjectURL = vi.fn(() => 'blob:stub');
    (URL as any).revokeObjectURL = vi.fn();
    return clicks;
};

afterEach(() => { vi.restoreAllMocks(); pdfCalls.length = 0; });

describe('downloadDesignPng', () => {
    it('clicks exactly one PNG download named after the design and DPI', async () => {
        const clicks = setupDownloads();
        const n = await downloadDesignPng(design(4)); // quantity 4 must NOT multiply the PNG
        expect(n).toBe(1);
        expect(clicks).toHaveLength(1);
        expect(clicks[0].download).toBe('Export Test-203dpi.png');
        expect(clicks[0].href.startsWith('data:image/png')).toBe(true);
    }, 20000);
});

describe('downloadDesignPdf', () => {
    it('one page + addImage per label, save name carries the page count', async () => {
        const clicks = setupDownloads();
        const n = await downloadDesignPdf(design(3));
        expect(n).toBe(3);
        expect(pdfCalls).toEqual(['ctor', 'addImage', 'addPage', 'addImage', 'addPage', 'addImage', 'save:Export Test-3x-203dpi.pdf']);
        expect(clicks).toHaveLength(0); // the mock owns save(); our anchor path stays unused
    }, 45000);
});

describe('downloadDesignZip', () => {
    it('bundles one numbered PNG per label into a single ZIP download', async () => {
        const clicks = setupDownloads();
        const zipMod = await import('../services/zipStore');
        const createZip = vi.spyOn(zipMod, 'createZipBlob');
        const n = await downloadDesignZip(design(3));
        expect(n).toBe(3);
        expect(clicks).toHaveLength(1);
        expect(clicks[0].download).toBe('Export Test-3png-203dpi.zip');
        const entries = createZip.mock.calls[0][0];
        expect(entries.map(e => e.name)).toEqual([
            'Export Test-label-01.png', 'Export Test-label-02.png', 'Export Test-label-03.png',
        ]);
        for (const e of entries) expect(e.data.length).toBeGreaterThan(100); // real PNG bytes
    }, 45000);

    it('honors the export cap passed by the caller', async () => {
        setupDownloads();
        const n = await downloadDesignZip(design(10), 2);
        expect(n).toBe(2);
        expect(MAX_BATCH_EXPORT).toBe(300); // the confirm threshold App mirrors
    }, 30000);
});
