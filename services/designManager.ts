import type { Design } from '../types';
import { notify } from './uiDialogs';

const DESIGN_LIST_KEY = 'ipl_designer_saved_designs';
const DESIGN_KEY_PREFIX = 'ipl_design_';

/**
 * localStorage holds JSON written by an older build (or edited by hand /
 * corrupted on disk). JSON.parse hands back whatever shape arrives — a string,
 * a number, or an object with a poisoned __proto__ key — and callers
 * immediately do .includes/.map/.filter over it, crashing the picker UI at
 * startup. Shape-guard everything that leaves storage.
 */
const parseStringArray = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : [];
  } catch (e) { console.error("Failed to get saved designs:", e); return []; }
};

export const getSavedDesigns = (): string[] => parseStringArray(localStorage.getItem(DESIGN_LIST_KEY));

/**
 * A stored design is only accepted when it structurally matches Design enough
 * to render: object with an array of fields. Primitives and array payloads
 * would otherwise flow into `design.fields.map(...)` at load time. The
 * object comes from JSON.parse (no live prototypes involved), but strip
 * __proto__/constructor/prototype keys defensively anyway — spreading one into
 * state is a classic pollution vector.
 */
const isDesignShape = (d: unknown): d is Design =>
  typeof d === 'object' && d !== null && !Array.isArray(d)
  && Array.isArray((d as { fields?: unknown }).fields);

const sanitize = <T extends object>(value: T): T => {
  for (const k of ['__proto__', 'constructor', 'prototype']) {
    if (k in value) delete (value as Record<string, unknown>)[k];
  }
  return value;
};

export const saveDesign = (design: Design): void => {
  try {
    localStorage.setItem(`${DESIGN_KEY_PREFIX}${design.name}`, JSON.stringify(design));
    const currentDesigns = getSavedDesigns();
    if (!currentDesigns.includes(design.name)) {
      localStorage.setItem(DESIGN_LIST_KEY, JSON.stringify([...currentDesigns, design.name].sort()));
    }
  } catch (e) { console.error("Failed to save design:", e); notify('Error saving design — it was not stored locally.'); }
};

export const loadDesign = (name: string): Design | null => {
  try {
    const designString = localStorage.getItem(`${DESIGN_KEY_PREFIX}${name}`);
    if (!designString) return null;
    const parsed: unknown = JSON.parse(designString);
    if (!isDesignShape(parsed)) {
      console.error(`Saved design "${name}" is malformed (no fields array); ignoring.`);
      return null;
    }
    return sanitize(parsed);
  } catch (e) { console.error(`Failed to load design "${name}":`, e); return null; }
};

export const deleteDesign = (name: string): void => {
    try {
        localStorage.removeItem(`${DESIGN_KEY_PREFIX}${name}`);
        const newDesigns = getSavedDesigns().filter(d => d !== name);
        localStorage.setItem(DESIGN_LIST_KEY, JSON.stringify(newDesigns));
    } catch(e) { console.error(`Failed to delete design "${name}":`, e); }
};
