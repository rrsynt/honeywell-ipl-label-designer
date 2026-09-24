import { describe, it, expect, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import React from 'react';
import { RightPanel } from '../components/RightPanel';
import { createDefaultDesign } from '../services/templates';
import type { Design } from '../types';

// Regression: the settings editors committed their numeric inputs only in
// onBlur, and a tab switch unmounts them without React ever firing blur. So
// typing a value and clicking another tab silently discarded it -- reproduce:
// set quantity 9, click the Code tab, save -> the design still had quantity 1.
// These tests drive the real component, because the failure is a React
// lifecycle fact (no blur on unmount) that no pure-state test can express.

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
    if (root) act(() => root!.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
});

const mount = (design: Design, dispatch: (a: unknown) => void) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
        root!.render(
            <RightPanel activeDesign={design} selectedFieldIds={[]} dispatch={dispatch as never} />,
        );
    });
    return container;
};

const clickTab = (el: HTMLElement, name: string) => {
    const tab = [...el.querySelectorAll('button')].find(b => b.textContent === name)!;
    expect(tab, `tab ${name} not found`).toBeTruthy();
    act(() => tab.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

const typeInto = (el: HTMLElement, title: string, value: string) => {
    const input = el.querySelector<HTMLInputElement>(`input[title="${title}"]`)!;
    expect(input, `input ${title} not found`).toBeTruthy();
    act(() => {
        input.focus();
        // React tracks the previous value on the DOM node; a plain assignment
        // would be swallowed as "unchanged", so go through the native setter.
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
};

describe('RightPanel numeric inputs survive a tab switch', () => {
    it('quantity reaches the design without any blur', () => {
        const dispatched: any[] = [];
        const design = createDefaultDesign();
        const el = mount(design, (a) => dispatched.push(a));

        clickTab(el, 'Printer');
        typeInto(el, 'Number of copies to print', '9');

        const update = dispatched.find(
            d => d?.type === 'UPDATE_SETTING' && d.payload.settingType === 'printerSettings',
        );
        expect(update, 'quantity was never dispatched to the design').toBeTruthy();
        expect(update.payload.updates).toMatchObject({ quantity: 9 });

        // The exact user gesture that used to lose the value: switch away
        // while the input still holds focus.
        clickTab(el, 'Code');
    });

    it('label width and grid rows reach the design without any blur', () => {
        const dispatched: any[] = [];
        const design = createDefaultDesign();
        const el = mount(design, (a) => dispatched.push(a));

        // Properties is the default tab, so the label editor is already up.
        typeInto(el, 'Total width of the label stock', '120');
        typeInto(el, 'Number of labels vertically down the stock', '3');

        const updates = dispatched
            .filter(d => d?.type === 'UPDATE_SETTING' && d.payload.settingType === 'labelSettings')
            .map(d => d.payload.updates);
        expect(updates.some(u => Math.round(u.width) === 120), 'width not committed').toBe(true);
        expect(updates.some(u => u.rows === 3), 'grid rows not committed').toBe(true);

        clickTab(el, 'Data');
    });

    it('a half-typed value is never written to the design', () => {
        const dispatched: any[] = [];
        const design = createDefaultDesign();
        const el = mount(design, (a) => dispatched.push(a));

        clickTab(el, 'Printer');
        // The "1" of "150", and the empty box a user passes through while
        // clearing the field. Neither is a finished quantity.
        typeInto(el, 'Number of copies to print', '1');
        typeInto(el, 'Number of copies to print', '');

        const quantityUpdates = dispatched.filter(
            d => d?.payload?.updates && 'quantity' in d.payload.updates,
        );
        expect(quantityUpdates).toHaveLength(0);
    });
});
