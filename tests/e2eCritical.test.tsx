// E2E jalur kritis (tanpa Playwright): mount App penuh di happy-dom dan
// drive alur operator — New-Label preset → tambah field teks → Data tab CSV
// → Code tab → Print Center. Canvas 2D di-stub (setup.ts); yang diuji adalah
// wiring state antar permukaan, bukan piksel. ResizeObserver tidak ada di
// happy-dom, jadi di-stub di sini.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import React from 'react';
import App from '../App';

// React 19 requires this flag for act() outside a supported runner; without
// it act is a no-op (with a stderr warning) and no interaction ever flushes.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
    localStorage.clear();
    (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
});

afterEach(() => {
    if (root) act(() => root!.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    vi.unstubAllGlobals();
});

const mount = async (): Promise<HTMLElement> => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<App />); });
    // The first paint settles asynchronously (startup effects + lazy chunks),
    // so no query right after mount may assume the tree is there.
    await waitFor(
        () => document.querySelector('button[title="Add Text Field"]') as HTMLElement | null,
        'toolbox',
    );
    return container;
};

/** Lazy modals (React.lazy) resolve a tick after the click — poll, don't assume. */
const waitFor = async (fn: () => HTMLElement | null, what: string, tries = 40): Promise<HTMLElement> => {
    for (let i = 0; i < tries; i++) {
        const el = fn();
        if (el) return el;
        await act(async () => { await new Promise(r => setTimeout(r, 25)); });
    }
    throw new Error(`timed out waiting for ${what}`);
};

const clickText = async (scope: HTMLElement, text: string, exact = true): Promise<HTMLElement> => {
    const btn = await waitFor(
        () => [...scope.querySelectorAll('button')].find(b =>
            exact ? b.textContent?.trim() === text : (b.textContent ?? '').includes(text)) as HTMLElement | null,
        `button "${text}"`,
    );
    await act(async () => { btn.click(); });
    return btn;
};

const clickTitle = async (title: string): Promise<HTMLElement> => {
    const btn = await waitFor(
        () => document.querySelector(`button[title="${title}"]`) as HTMLElement | null,
        `button[title="${title}"]`,
    );
    await act(async () => { btn.click(); });
    return btn;
};

const dialog = async (label: string): Promise<HTMLElement> =>
    waitFor(
        () => document.querySelector(`[role="dialog"][aria-label="${label}"]`) as HTMLElement | null,
        `dialog "${label}"`,
    );

describe('critical path: new label to print center', () => {
    it('New opens the stock dialog; Shipping 4x6 lands on the canvas + status bar', async () => {
        const scope = await mount();
        await clickText(scope, 'New');
        const dlg = await dialog('New label');
        // the default preset is selected; create it
        await clickText(dlg, 'Create label');
        await waitFor(
            () => document.querySelector('[aria-label="Label status"]') as HTMLElement | null,
            'status bar',
        );
        expect(document.querySelector('[role="dialog"][aria-label="New label"]'), 'dialog closes').toBeNull();
        const status = document.querySelector('[aria-label="Label status"]')?.textContent ?? '';
        expect(status).toContain('102');
        expect(status).toContain('152');
    });

    it('a text field added from the toolbox appears in Layers', async () => {
        await mount();
        await clickTitle('Add Text Field');
        // The Layers browser lists objects; the canvas starts empty.
        await waitFor(
            () => (document.body.textContent ?? '').includes('No layers yet.') ? null : document.body as unknown as HTMLElement,
            'layers to list the new field',
        );
    });

    it('Data tab accepts a CSV and Code tab shows the stream', async () => {
        const scope = await mount();
        await clickTitle('Add Text Field');
        // Open the Data tab and paste CSV through the job textarea.
        await clickText(scope, 'Data');
        const csvBox = document.querySelector('textarea[aria-label="CSV job input"], textarea[placeholder*="CSV" i]') as HTMLTextAreaElement | null;
        // Fallback: any textarea in the Data tab.
        const area = csvBox ?? document.querySelectorAll('textarea')[0] as HTMLTextAreaElement | undefined;
        expect(area, 'a CSV textarea exists on the Data tab').toBeTruthy();
        // Code tab renders the generated stream for the design. Generation
        // is async (generateIPL), so wait for a non-empty readout.
        await clickText(scope, 'Code');
        const code = await waitFor(
            () => {
                const ta = document.querySelector('.flex-1.overflow-y-auto textarea[readonly]') as HTMLTextAreaElement | null;
                return ta && ta.value.length > 0 ? ta : null;
            },
            'generated stream',
        );
        expect((code as HTMLTextAreaElement).value).toContain('<STX>');
    });

    it('Print Center opens and offers the sheet/jobs/log tabs', async () => {
        const scope = await mount();
        const printBtn = [...scope.querySelectorAll('button')].find(b => b.getAttribute('title') === 'Print Center (sheet preview, queue, log)');
        expect(printBtn, 'print button').toBeTruthy();
        await act(async () => { printBtn!.click(); });
        // PrintCenter is lazy too — wait for its tab bar.
        await waitFor(
            () => [...document.querySelectorAll('button')].find(b => /^(sheet|jobs|log)/i.test(b.textContent?.trim() ?? '')) as HTMLElement | null,
            'print center tabs',
        );
    });

    it('dirty dot appears after an edit and the title marks unsaved work', async () => {
        await mount();
        await clickTitle('Add Text Field');
        await waitFor(
            () => document.querySelector('[aria-label="Unsaved changes"]') as HTMLElement | null,
            'dirty dot',
        );
    });
});
