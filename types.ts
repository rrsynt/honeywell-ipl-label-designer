import type { ContextMenuOption } from './components/ContextMenu';

// --- TYPE DEFINITIONS ---
export type FieldType = 'text' | 'barcode' | 'line' | 'box' | 'image' | 'ellipse' | 'polygon' | 'triangle';
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
  | {
      type: 'linked';
      sourceId: string;
      /**
       * Fase 2: which COLUMN of a table source this field prints. Absent for
       * variable/counter links (they have one value). A table link without it
       * falls back to the field's own name as the column, then to nothing —
       * so old designs, which never set it, behave exactly as before.
       */
      column?: string;
      /**
       * Fase 2: transform applied to the linked value before it prints, e.g.
       * `UPPER(SUBSTR(value, 1, 3))`. Parsed by services/tableSource.ts; an
       * expression that doesn't parse prints the raw value and warns, so a
       * typo can never blank a label. Absent = print verbatim.
       */
      transform?: string;
    };


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
    /**
     * Fase 4: don't print this field when the condition holds. Written in the
     * same small language as a linked field's transform, but it must end in a
     * true/false: `IF(value, "EQ", "EXPORT", "yes", "")`. A condition that
     * doesn't parse never suppresses — a typo prints the field, it doesn't
     * silently drop it. Absent = always print.
     */
    suppress?: string;
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

/**
 * Fase 3 shapes. IPL has no ellipse, polygon or triangle command, so none of
 * these is emitted as one: the generator rasterizes the shape at the printer's
 * dpi and downloads it as a stored graphic (the same G/U path a rounded box
 * already takes), and the parser reads that graphic back as an image field.
 * The shape therefore survives a generate→parse round trip as its bitmap, and
 * the printer never sees a command it does not have.
 */
interface ShapeBase extends BaseField {
    width: number; // mm
    height: number; // mm
    /** Stroke width in mm. 0 paints the shape solid. */
    thickness: number;
}

export interface EllipseField extends ShapeBase {
    type: 'ellipse';
}

export interface PolygonField extends ShapeBase {
    type: 'polygon';
    /** Vertices, at least 3. Fewer than 3 cannot be drawn, so the generator
     *  emits nothing for it rather than a degenerate graphic. */
    sides: number;
}

export interface TriangleField extends ShapeBase {
    type: 'triangle';
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
    /**
     * Fase 3: how a colour image becomes the 1-bit bitmap a thermal head can
     * print. 'threshold' cuts on luminance; 'floyd-steinberg' spreads the
     * rounding error to neighbouring pixels, which keeps a photograph's tones
     * instead of posterizing them. Absent means 'threshold' — every image field
     * saved before this existed must keep converting exactly as it did.
     */
    dither?: 'threshold' | 'floyd-steinberg';
}

export type Field = TextField | BarcodeField | LineField | BoxField | ImageField | EllipseField | PolygonField | TriangleField;

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
    /**
     * Emit image fields as nibblized Direct Graphics (<ESC>g1) instead of
     * stored-format G/U graphics. g1 is pure ASCII hex, so the stream survives
     * clipboard paste and UTF-8 transport where binary g0 cannot. Optional and
     * off by default: saved designs predate it and must keep generating G/U.
     */
    directGraphics?: boolean;
    /**
     * Which printer language the Code panel and the download button emit.
     * Absent means IPL — every design saved before the others existed must
     * keep producing IPL, and the canvas is unaffected either way.
     */
    language?: PrinterLanguage;
}

/**
 * The printer languages this app speaks. ONE alias rather than an inline union
 * at every site: a language added in one place and missed in another produces a
 * target that silently emits the WRONG language, which is a ruined label rather
 * than a type error.
 */
export type PrinterLanguage = 'ipl' | 'zpl' | 'epl';

export interface DataSourceBase {
    id: string;
    name: string;
}
export interface VariableDataSource extends DataSourceBase {
    type: 'variable';
    sampleData: string;
}
/**
 * Fase 2: which rows of a table source print. Saved ON the data source, not
 * in component state, so "rows 10-50 where Status = OK" survives a reload.
 * `fromRow`/`toRow` are 1-based and inclusive over the filtered rows.
 */
export interface DataQuery {
    filters: { column: string; op: 'eq' | 'neq' | 'empty' | 'notEmpty'; value: string }[];
    /** Ignored when filters is empty. */
    combine: 'and' | 'or';
    sortColumn?: string;
    sortDir?: 'asc' | 'desc';
    fromRow?: number;
    toRow?: number;
}

/**
 * A whole table of rows stored inside the design (BarTender's "embedded
 * database", minus the database). Rows are keyed by column name so a renamed
 * column is an explicit edit, not a silent shift. Imported from CSV or .xlsx;
 * the file itself is NOT kept, only the rows.
 */
export interface TableDataSource extends DataSourceBase {
    type: 'table';
    columns: string[];
    rows: Record<string, string>[];
    query: DataQuery;
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
export type DataSource = VariableDataSource | CounterDataSource | TableDataSource;


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
    /**
     * Fase 4: one suppression condition per group, keyed by groupId. Every
     * member of the group is hidden on a record where the condition holds, so
     * one design can carry several label variants (domestic vs export) without
     * a second layout. Written in the same language as a field's `suppress`,
     * and judged the same way: a condition that doesn't parse hides nothing.
     * Absent groups are always shown. Groups are otherwise a designer concept
     * the generator ignores — this is the one exception.
     */
    groupSuppress?: { [groupId: number]: string };
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