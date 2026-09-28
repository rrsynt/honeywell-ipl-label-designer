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

    it('each serial counter carries its OWN step, not one job-level step', async () => {
        // The step belongs to the field it follows (PRM p.104, "Sets the
        // increment value for the selected field"), so two counters keep
        // different steps — and different directions.
        const d = designOf(
            [textLinked(1, 'a'), textLinked(2, 'b')],
            [counter({ id: 'a', serial: true, step: 2 }), counter({ id: 'b', serial: true, step: -7, start: 100 })],
        );
        const ipl = await generateIPL(d);
        expect(ipl).toContain('<FS>0001<FS>');
        expect(ipl).toContain('<FS>0100<FS>');
        // Each step rides inside its own field's slice, so it cannot leak
        // across fields.
        expect(ipl).toContain('<ESC>F1<NUL><FS>0001<FS><ESC>I2');
        expect(ipl).toContain('<ESC>F2<NUL><FS>0100<FS><ESC>D7');
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

    it('two counters with different steps advance independently', async () => {
        const ipl = await generateIPL(designOf(
            [textLinked(1, 'a'), textLinked(2, 'b')],
            [counter({ id: 'a', serial: true, step: 2 }), counter({ id: 'b', serial: true, step: -7, start: 100 })],
        ));
        const label = parseViewerIPL(ipl);
        const at = (b: number, id: number) =>
            (resolveLabelAtBatch(label, b, 203).elements.find(e => (e as { id: number }).id === id) as any).source.data;
        // Each field uses its own step AND its own direction.
        expect([at(0, 1), at(1, 1), at(2, 1)]).toEqual(['0001', '0003', '0005']);
        expect([at(0, 2), at(1, 2), at(2, 2)]).toEqual(['0100', '0093', '0086']);
    });

    it('a field without its own step does not inherit another field\'s step', async () => {
        // Only field 1 was given <ESC>I5. Field 2 must not move by 5 — the leak
        // that made every field in a job share one step. It falls back to the
        // documented default of 1 (PRM p.104 "Printer Default Values for n:
        // All n = 1"), not to field 1's value.
        const label = parseViewerIPL([
            '<STX><ESC>P<ETX>',
            '<STX>E1;F1;<ETX>',
            '<STX>H1;o10,10;c0;d0,20<ETX>',
            '<STX>H2;o10,30;c0;d0,20<ETX>',
            '<STX>R<ETX>',
            '<STX><ESC>E1<CAN><ESC>F1<NUL><FS>0001<FS><ESC>I5<ESC>F2<NUL><FS>0100<FS><RS>3<ETB><FF><ETX>',
        ].join('\n'));
        const at = (b: number, id: number) =>
            (resolveLabelAtBatch(label, b, 203).elements.find(e => (e as { id: number }).id === id) as any).source.data;
        expect(at(1, 1)).toBe('0006'); // 0001 + 5
        expect(at(1, 2)).toBe('0101'); // + the default 1, NOT field 1's 5
        expect(at(1, 2)).not.toBe('0106');
    });

    it('advances a RAW capture, where <FS> arrives as the \x1c byte', async () => {
        // The viewer keeps a raw printer capture's control bytes as bytes, so a
        // region can be \x1c…\x1c rather than the <FS>…<FS> placeholder. The
        // delimiters are control markers either way and must be stripped from
        // the display; missing this left raw captures frozen at their start.
        const label = parseViewerIPL([
            '\x02\x1bP\x03',
            '\x02E1;F1;\x03',
            '\x02H0;o10,10;c0;d0,20\x03',
            '\x02R\x03',
            '\x02\x1bE1\x18\x1bF0\x00\x1c0001\x1c\x1bI5\x1e3\x17\x0c\x03',
        ].join('\n'));
        const at = (b: number) => (resolveLabelAtBatch(label, b, 203).elements[0] as any).source.data;
        expect(at(0)).toBe('0001'); // markers stripped, not printed
        expect(at(1)).toBe('0006');
    });

    it('<ESC>N cancels the field it was sent for', async () => {
        // PRM p.109: "Resets any increment or decrement flags for the current
        // field." Field 1 keeps its step; field 2's is cleared by <ESC>N.
        const label = parseViewerIPL([
            '<STX><ESC>P<ETX>',
            '<STX>E1;F1;<ETX>',
            '<STX>H1;o10,10;c0;d0,20<ETX>',
            '<STX>H2;o10,30;c0;d0,20<ETX>',
            '<STX>R<ETX>',
            '<STX><ESC>E1<CAN><ESC>F1<NUL><FS>0001<FS><ESC>I5<ESC>F2<NUL><FS>0100<FS><ESC>D9<ESC>N<RS>3<ETB><FF><ETX>',
        ].join('\n'));
        const at = (b: number, id: number) =>
            (resolveLabelAtBatch(label, b, 203).elements.find(e => (e as { id: number }).id === id) as any).source.data;
        expect(at(1, 1)).toBe('0006'); // survives
        expect(at(1, 2)).toBe('0100'); // <ESC>N cleared it, so it does not move
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
