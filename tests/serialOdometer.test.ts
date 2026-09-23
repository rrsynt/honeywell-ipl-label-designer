// Batch Q (2026-09-23): serial counters — printer-side odometer. A counter
// with serial:true wraps its print-block data in <FS>…<FS> and sets the job's
// <ESC>In/<ESC>Dn step, so the PRINTER advances the number after every printed
// label (PRM pp.98-99,104,111): quantity 5 prints 0001..0005 without a host
// loop. The viewer's resolveLabelAtBatch simulates the same advance, so the
// stepper, batch PDF and ZIP exports show it too. The designer importer
// rebuilds the counter from the stream (round-trip).
import './golden/setup'; // real canvas + bwip shims for generateIPL barcode paths
import { describe, it, expect, beforeAll } from 'vitest';
import { generateIPL } from '../services/iplGenerator';
import { parseIPL } from '../services/iplParser';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { resolveLabelAtBatch, totalLabelCount } from '../services/ipl/odometer';
import { ensureBarcodesReady } from '../services/ipl/barcodes';
import { newCounter } from '../services/dataSources';
import type { Design, CounterDataSource, DataSource, TextField, BarcodeField } from '../types';

beforeAll(async () => { await ensureBarcodesReady(); });

const counter = (extra: Partial<CounterDataSource> = {}): CounterDataSource => ({
    id: 'cnt1', type: 'counter', name: 'SN', start: 1, step: 1, padding: 4, ...extra,
});
const textLinked = (id: number, sourceId: string): TextField => ({
    id, type: 'text', name: `T${id}`, x: 5, y: 5, rotation: 0,
    dataSource: { type: 'linked', sourceId }, font: '25', fontSize: 12, h_mag: 1, w_mag: 1,
});
const barcodeLinked = (id: number, sourceId: string): BarcodeField => ({
    id, type: 'barcode', name: `B${id}`, x: 5, y: 20, rotation: 0,
    dataSource: { type: 'linked', sourceId }, symbology: '6', humanReadable: 'none', h_mag: 40, w_mag: 2,
});
const designOf = (fields: (TextField | BarcodeField)[], dataSources: DataSource[], quantity = 3): Design => ({
    name: 'SN Test',
    labelSettings: { width: 80, height: 50, columns: 1, rows: 1, unit: 'mm', orientation: 'portrait' },
    printerSettings: { model: 'PD43', dpi: 203, quantity, mediaType: 'direct-thermal', mediaSenseMode: 'gap', printSpeed: 6, darkness: 10 },
    fields, dataSources, nextId: 10, guides: { horizontal: [], vertical: [] },
});

describe('generateIPL serial emission', () => {
    it('serial counter -> <FS> region + <ESC>I step in the print block', async () => {
        const ipl = await generateIPL(designOf([textLinked(1, 'cnt1')], [counter({ serial: true })]));
        expect(ipl).toContain('<FS>0001<FS>');
        expect(ipl).toContain('<ESC>I1');
        expect(ipl).toContain('<RS>3'); // quantity still governs the run
    });

    it('legacy counter (no serial key) -> byte-identical to pre-Batch-Q: no FS, no ESC>I', async () => {
        const ipl = await generateIPL(designOf([textLinked(1, 'cnt1')], [counter()]));
        expect(ipl).toContain('0001');
        expect(ipl).not.toContain('<FS>');
        expect(ipl).not.toContain('<ESC>I');
    });

    it('serial:false explicitly disables the odometer', async () => {
        const ipl = await generateIPL(designOf([textLinked(1, 'cnt1')], [counter({ serial: false })]));
        expect(ipl).not.toContain('<FS>');
    });

    it('negative step emits <ESC>D|step| (decrement)', async () => {
        const ipl = await generateIPL(designOf([textLinked(1, 'cnt1')], [counter({ serial: true, start: 50, step: -5 })]));
        expect(ipl).toContain('<FS>0050<FS>');
        expect(ipl).toContain('<ESC>D5');
        expect(ipl).not.toContain('<ESC>I');
    });

    it('step 0 cannot advance — emits no odometer even with serial:true', async () => {
        const ipl = await generateIPL(designOf([textLinked(1, 'cnt1')], [counter({ serial: true, step: 0 })]));
        expect(ipl).not.toContain('<FS>');
        expect(ipl).not.toContain('<ESC>I');
    });

    it('two serial counters share one job-level step (lowest field id wins)', async () => {
        const d = designOf(
            [textLinked(1, 'a'), textLinked(2, 'b')],
            [counter({ id: 'a', serial: true, step: 2 }), counter({ id: 'b', serial: true, step: 7, start: 100 })],
        );
        const ipl = await generateIPL(d);
        expect(ipl).toContain('<FS>0001<FS>');
        expect(ipl).toContain('<FS>0100<FS>');
        expect(ipl).toContain('<ESC>I2');
        expect(ipl).not.toContain('<ESC>I7');
    });

    it('newCounter defaults to serial:true (a same-value counter is a constant)', () => {
        expect(newCounter('X').serial).toBe(true);
    });
});

describe('viewer simulation of the generated stream', () => {
    it('resolveLabelAtBatch advances the serial per label — text and barcode', async () => {
        const ipl = await generateIPL(designOf(
            [textLinked(1, 'cnt1'), barcodeLinked(2, 'cnt1')],
            [counter({ serial: true, step: 3 })],
        ));
        const label = parseViewerIPL(ipl);
        expect(totalLabelCount(label)).toBe(3);
        const datas = (b: number) => [0, 1, 2].map(i =>
            (resolveLabelAtBatch(label, i, 203).elements
                .find(e => (e as { id: number }).id === b) as any).source.data);
        expect(datas(1)).toEqual(['0001', '0004', '0007']); // start 1, step 3
        expect(datas(2)).toEqual(['0001', '0004', '0007']); // barcode mirrors the same counter
        // batch 0 shows NO leftover control markers (printable text only)
        expect(datas(1)[0]).toBe('0001');
    });

    it('decrement stream counts down and wraps within the region width', async () => {
        const ipl = await generateIPL(designOf([textLinked(1, 'cnt1')], [counter({ serial: true, start: 2, step: -1 })], 4));
        const label = parseViewerIPL(ipl);
        const vals = [0, 1, 2, 3].map(i =>
            (resolveLabelAtBatch(label, i, 203).elements.find(e => (e as { id: number }).id === 1) as any).source.data);
        expect(vals).toEqual(['0002', '0001', '0000', '9999']); // odometer wrap (PRM)
    });
});

describe('designer importer rebuilds serial counters (round-trip)', () => {
    it('generate -> import restores a linked serial counter (start/step/padding)', async () => {
        const ipl = await generateIPL(designOf([textLinked(1, 'cnt1')], [counter({ serial: true, start: 42, step: 5, padding: 6 })]));
        const d = parseIPL(ipl, 203);
        const field = d.fields.find(f => f.id === 1)! as TextField;
        expect(field.dataSource.type).toBe('linked');
        const src = d.dataSources.find(s => s.id === (field.dataSource as { sourceId: string }).sourceId) as CounterDataSource;
        expect(src).toMatchObject({ type: 'counter', start: 42, step: 5, padding: 6, serial: true });
        // padding preserved from the printed width, not the number's digits
        expect('000042'.slice(-src.padding)).toBe('000042');
    });

    it('text + barcode sharing one serial rebuild into ONE counter (dedupe)', async () => {
        const ipl = await generateIPL(designOf(
            [textLinked(1, 'cnt1'), barcodeLinked(2, 'cnt1')],
            [counter({ serial: true })],
        ));
        const d = parseIPL(ipl, 203);
        const counters = d.dataSources.filter(s => s.type === 'counter');
        expect(counters).toHaveLength(1);
        const links = d.fields.map(f => (f as TextField).dataSource.type === 'linked' ? (f as any).dataSource.sourceId : null);
        expect(links[0]).toBe(links[1]);
    });

    it('raw-byte <FS> (\\x1c) streams import the same way (viewer Open File parity)', async () => {
        const literal = await generateIPL(designOf([textLinked(1, 'cnt1')], [counter({ serial: true, start: 7 })]));
        const raw = literal
            .replace(/<STX>/g, '\x02').replace(/<ETX>/g, '\x03').replace(/<ESC>/g, '\x1b')
            .replace(/<CAN>/g, '\x18').replace(/<NUL>/g, '\x00').replace(/<ETB>/g, '\x17')
            .replace(/<FF>/g, '\x0c').replace(/<RS>/g, '\x1e').replace(/<SI>/g, '\x0f')
            .replace(/<FS>/g, '\x1c');
        const d = parseIPL(raw, 203);
        const counters = d.dataSources.filter(s => s.type === 'counter');
        expect(counters).toHaveLength(1);
        expect(counters[0]).toMatchObject({ start: 7, serial: true });
    });

    it('mixed literal+region data (SN<FS>..) is NOT a full region -> markers stripped, stays variable text', async () => {
        const d = parseIPL([
            '<STX><ESC>C<SI>W400<SI>L300<ETX>', '<STX><ESC>P<ETX>', '<STX>E1;F1;<ETX>',
            '<STX>H0;o20,20;c25;k12;d0,255<ETX>', '<STX>R<ETX>',
            '<STX><ESC>E1<CAN><ESC>F0<NUL>SN<FS>0001<FS><ESC>I1<RS>3<ETB><FF><ETX>',
        ].join('\n'), 203);
        const f = d.fields[0] as TextField;
        expect(f.dataSource.type).toBe('variable');
        expect((f.dataSource as { defaultData: string }).defaultData).toBe('SN0001'); // no marker soup
        expect(d.dataSources).toHaveLength(0);
    });

    it('decrement round-trips to a negative step', async () => {
        const ipl = await generateIPL(designOf([textLinked(1, 'cnt1')], [counter({ serial: true, start: 9, step: -2 })]));
        const d = parseIPL(ipl, 203);
        expect(d.dataSources[0]).toMatchObject({ type: 'counter', step: -2 });
    });
});

describe('lot template is a working serial job', () => {
    it('quantity run prints 0001, 0002, 0003 through the viewer pipeline', async () => {
        const { getTemplate } = await import('../services/templates');
        const d = getTemplate('lot')!.build();
        d.printerSettings.quantity = 3;
        const label = parseViewerIPL(await generateIPL(d));
        const lotText = () => [0, 1, 2].map(i =>
            (resolveLabelAtBatch(label, i, 203).elements
                .find(e => (e as { kind: string }).kind === 'text' && (e as { id: number }).id === 2) as any).source.data);
        expect(lotText()).toEqual(['0001', '0002', '0003']);
        // and the barcode of the same counter mirrors it
        const lotBc = [0, 1, 2].map(i =>
            (resolveLabelAtBatch(label, i, 203).elements
                .find(e => (e as { kind: string }).kind === 'barcode') as any).source.data);
        expect(lotBc).toEqual(['0001', '0002', '0003']);
    });
});
