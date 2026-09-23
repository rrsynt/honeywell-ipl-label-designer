import type { ContextMenuOption } from './components/ContextMenu';

// --- TYPE DEFINITIONS ---
export type FieldType = 'text' | 'barcode' | 'line' | 'box' | 'image';
export type DragMode = 'move' | 'rotate' | 'resize-br' | 'pan' | 'marquee' | 'drag-guide-h' | 'drag-guide-v' | null;
export type HRIPlacement = 'none' | 'below' | 'above';
export type Alignment = 'left' | 'hcenter' | 'right' | 'top' | 'vmiddle' | 'bottom';

export interface EditingState {
    id: number;
    data: string;
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: 0 | 90 | 180 | 270;
}

export type DateFormat = 'YY/MM/DD' | 'YYYY/MM/DD' | 'DD/MM/YY' | 'DD/MM/YYYY';
export type TimeFormat = 'HH:MM:SS 24hr' | 'HH:MM 24hr' | 'HH:MM:SS 12hr' | 'HH:MM 12hr' | 'HH:MM:SS am/pm' | 'HH:MM am/pm';

export type FieldDataSource = 
  | { type: 'fixed'; data: string }
  | { type: 'variable'; defaultData: string }
  | { type: 'date'; format: DateFormat }
  | { type: 'time'; format: TimeFormat }
  | { type: 'linked'; sourceId: string };


interface BaseField {
    id: number;
    type: FieldType;
    name: string;
    x: number; // in mm
    y: number; // in mm
    rotation: 0 | 90 | 180 | 270;
    locked?: boolean;
    visible?: boolean;
    /** Designer-only grouping (Batch O). Fields sharing a groupId select,
     *  drag and distribute as one unit; a click on any member selects the
     *  whole group. Ids come from the same nextId counter as field ids, so
     *  a groupId can never collide with an id. Absent = ungrouped; the key
     *  is dropped (not set to undefined) on ungroup so saved JSON stays
     *  clean. Ignored by the IPL generator — groups are not a print concept. */
    groupId?: number;
}

export interface TextField extends BaseField {
    type: 'text';
    dataSource: FieldDataSource;
    font: string;
    fontSize: number; // For outline fonts
    h_mag: number;    // For bitmap fonts
    w_mag: number;    // For bitmap fonts
    align?: 'left' | 'center' | 'right';
}

export interface BarcodeField extends BaseField {
    type: 'barcode';
    dataSource: FieldDataSource;
    symbology: string;
    humanReadable: HRIPlacement;
    h_mag: number; // Height in dots
    w_mag: number; // Narrow bar width in dots
    code39_checkDigit?: 'none' | 'printer-generated' | 'host-verifies';
    code128_subset?: 'auto' | 'a' | 'b' | 'c';
    hriFont?: string;
    hriFontSize?: number;
    hriAlign?: 'left' | 'center' | 'right';
    // Symbology modifiers (PRM c-syntax) carried through the designer so an
    // imported stream regenerates identically. Undefined = printer default
    // (the encoder owns the defaults; the generator only fills positional
    // gaps for values that follow an unset earlier modifier).
    /** c8,c16,m1 — HIBC format selector 0-6. */
    hibcMode?: number;
    /** c14,m1 — MaxiCode mode 2-6 (undefined = auto). */
    maxiMode?: number;
    /** c18,m1 — QR model 1|2. */
    qrModel?: number;
    /** c18,m2 — QR error-correction level. */
    qrEcl?: 'L' | 'M' | 'Q' | 'H';
    /** c18,m3 — QR mask 0-8 (8 = auto). */
    qrMask?: number;
    /** c19,m1 — MicroPDF417 data columns 0-4. */
    microColumns?: number;
    /** c19,m2 — MicroPDF417 data rows. */
    microRows?: number;
    /** c20,m1 — RSS/GS1 DataBar version 0-6. */
    rssVersion?: number;
    /** c20,m2 — separator-row height (stacked versions). */
    rssSepHeight?: number;
    /** c20,m3 — segments per row, even 2-22 (expanded-stacked). */
    rssSegments?: number;
}

export interface LineField extends BaseField {
    type: 'line';
    length: number; // in mm
    thickness: number; // in mm
    lineEnding?: 'none' | 'arrow';
}

export interface BoxField extends BaseField {
    type: 'box';
    width: number; // in mm
    height: number; // in mm
    thickness: number; // in mm
    cornerRadius?: number; // in mm
}

export interface ImageField extends BaseField {
    type: 'image';
    /** Monochrome bitmap: one string per row, top row first; '1' = ink,
     *  anything else = paper. JSON-safe (no binary), the storage form IPL
     *  graphics need anyway. */
    bitmap: string[];
    width: number; // mm as placed on the label
    height: number; // mm
    /** 1-254; pixels whose blended-on-white luminance is below it become ink.
     *  Kept on the field so the threshold survives design reloads. */
    threshold: number;
}

export type Field = TextField | BarcodeField | LineField | BoxField | ImageField;

export interface LabelSettings {
    width: number; // in mm
    height: number; // in mm
    columns: number;
    rows: number;
    unit: 'mm' | 'cm' | 'in';
    orientation: 'portrait' | 'landscape';
}

export interface PrinterSettings {
    model: string;
    dpi: 203 | 300 | 406;
    quantity: number;
    mediaType: 'thermal-transfer' | 'direct-thermal';
    mediaSenseMode: 'gap' | 'reflective' | 'continuous';
    printSpeed: number; // 1-11
    darkness: number; // 0-19
}

export interface DataSourceBase {
    id: string;
    name: string;
}
export interface VariableDataSource extends DataSourceBase {
    type: 'variable';
    sampleData: string;
}
export interface CounterDataSource extends DataSourceBase {
    type: 'counter';
    start: number;
    step: number;
    padding: number;
    /**
     * Batch Q: printer-side odometer. When true (and step ≠ 0), the generator
     * wraps the print-block data in <FS>…<FS> and sets <ESC>I<step> (or
     * <ESC>D|step|), so the PRINTER advances the number after every printed
     * label (PRM pp.98-99,104) — quantity 5 prints 0001,0002,…,0005. The
     * viewer's resolveLabelAtBatch simulates the same advance, so the stepper
     * and batch exports show it too. Undefined/false = legacy behavior: every
     * label prints the start value.
     */
    serial?: boolean;
}
export type DataSource = VariableDataSource | CounterDataSource;


export interface Design {
    name: string;
    labelSettings: LabelSettings;
    printerSettings: PrinterSettings;
    fields: Field[];
    dataSources: DataSource[];
    nextId: number;
    guides: {
        horizontal: number[]; // y-positions in mm
        vertical: number[];   // x-positions in mm
    };
}

export interface WorkspaceState {
    zoom: number;
    pan: { x: number; y: number };
}

export interface ContextMenuState {
    x: number;
    y: number;
    options: ContextMenuOption[];
}


export interface AppState {
    history: {
        past: Design[];
        present: Design;
        future: Design[];
        intermediate: Design | null; // For live updates like dragging
        // The exact design that was loaded/saved. History snapshots are
        // immutable, so `present !== baseline` is the dirty flag: an edit
        // flips it, an UNDO back to the loaded object clears it for free,
        // and DESIGN_SAVED / SET_DESIGN / DESIGN_DELETED re-baseline.
        baseline: Design;
    };
    selectedFieldIds: number[];
    savedDesigns: string[];
    clipboard: Field[] | null;
    originalDesignName: string | null; // Track name of loaded design for save logic
    contextMenu: ContextMenuState | null;
}