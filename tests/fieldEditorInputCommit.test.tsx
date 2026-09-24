import { describe, it, expect, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import React from 'react';
import { FieldEditor } from '../components/FieldEditor';
import { getTemplate } from '../services/templates';
import type { Design, Field } from '../types';

// Same regression as rightPanelInputCommit, one component over. Every one of
// the 19 inputs in FieldEditor is built by usePropEditor, which used to commit
// only on blur — and FieldEditor is unmounted when the right panel switches
// tabs, where React fires no blur. So: set a barcode's bar height to 150,
// switch tab, save, and the design still said 40.

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
    if (root) act(() => root!.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
});

const mount = (design: Design, fields: Field[], dispatch: (a: unknown) => void) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
        root!.render(
            <FieldEditor
                fields={fields as never}
                design={design}
                dispatch={dispatch as never}
            />,
        );
    });
    return container;
};

/** The dispatch payload the editor sends: its `updates` object is nested. */
const updatesOf = (actions: any[]) =>
    actions.filter(a => a?.type === 'UPDATE_MULTIPLE_FIELD_PROPERTIES').map(a => a.payload.updates);

const inputByLabel = (el: HTMLElement, label: string) => {
    const holder = [...el.querySelectorAll('label')].find(l => l.textContent === label);
    return holder?.parentElement?.querySelector('input');
};

const typeInto = (input: HTMLInputElement, value: string) => {
    act(() => {
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
};

describe('FieldEditor commits props as they are typed', () => {
    it('a barcode bar height reaches the design without any blur', () => {
        const design = getTemplate('price').build();
        const ean = design.fields.find(f => f.name === 'EAN')!;
        const actions: any[] = [];
        const el = mount(design, [ean], (a) => actions.push(a));

        const input = inputByLabel(el, 'Bar Height (dots)');
        expect(input, 'bar height input not found').toBeTruthy();
        expect(input!.value).toBe('40');

        typeInto(input!, '150');

        const committed = updatesOf(actions).find(u => u.h_mag === 150);
        expect(committed, 'bar height was never committed').toBeTruthy();
    });

    it('an empty box is never written to the design', () => {
        const design = getTemplate('price').build();
        const ean = design.fields.find(f => f.name === 'EAN')!;
        const actions: any[] = [];
        const el = mount(design, [ean], (a) => actions.push(a));

        const input = inputByLabel(el, 'Bar Height (dots)')!;
        // A cleared box has no number to commit; blur snaps it back to 40.
        typeInto(input, '');

        expect(updatesOf(actions)).toHaveLength(0);
        expect(input.value).toBe('');
    });

    it('a field name is committed as it is typed', () => {
        const design = getTemplate('price').build();
        const ean = design.fields.find(f => f.name === 'EAN')!;
        const actions: any[] = [];
        const el = mount(design, [ean], (a) => actions.push(a));

        const input = inputByLabel(el, 'Name')!;
        typeInto(input, 'Retail EAN');

        expect(updatesOf(actions).find(u => u.name === 'Retail EAN')).toBeTruthy();
    });
});
