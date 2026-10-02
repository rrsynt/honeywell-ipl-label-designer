import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import type { Design, PrinterLanguage, PrinterSettings } from '../types';
import { parseIPL } from '../services/iplParser';
import { parseViewerIPL } from '../services/ipl/viewerParser';
import { parseZPL } from '../services/zpl/zplParser';
import { parseEPL } from '../services/epl/eplParser';
import { parseTSPL } from '../services/tspl/tsplParser';
import { parseDPL } from '../services/dpl/dplParser';
import { computeLabelExtent, renderLabel } from '../services/ipl/renderer';
import { ensureBarcodesReady } from '../services/ipl/barcodes';
import type { ViewerIssue } from '../services/ipl/types';
import { frameAtCaret, lookupHelpForFrame, type CommandHelp } from '../services/ipl/commandHelp';
import { resolveLabelAtBatch, totalLabelCount } from '../services/ipl/odometer';
import { streamBatchPages, batchPageCount, MAX_BATCH_EXPORT } from '../services/batchExport';
import { createZipBlob, zipEntryBytes, numberedPngName, sanitizeBaseName, type ZipEntry } from '../services/zipStore';
import { bytesToByteString, detectMojibake, convertDirectGraphicsToHex } from '../services/ipl/fileBytes';
import { describeCodePage, ensureCjkReady } from '../services/ipl/codePages';
import { notify, requestConfirm } from '../services/uiDialogs';
import { sendIplViaBridge, pingBridge } from '../services/bridgeSend';
import { getPrinterTarget, setPrinterTarget } from '../services/printerTarget';
import { PRINTER_MODELS, UNPRINTABLE_MARGIN_MM } from '../constants';

const DPI_OPTIONS: PrinterSettings['dpi'][] = [203, 300, 406];

/**
 * Which printer language a pasted stream is written in.
 *
 * ZPL starts with ^XA and IPL with <STX>, so those two are recognised from a
 * sigil. EPL and TSPL have NONE — they are bare commands — so their rules have
 * to be shaped instead, and they must not capture ordinary text or each other:
 *
 *   TSPL — `CLS` on its own line (the buffer clear; no other language here has
 *          it) AND a command that opens an object.
 *   EPL  — a line that IS an EPL command with numeric parameters. An earlier
 *          rule ALSO required a bare `N`, which silently mis-detected any real
 *          EPL file whose author left it out: `N` only clears the image buffer
 *          and is routinely omitted, so a valid label fell through to the IPL
 *          parser and reported nothing at all. Since `CLS` is handled above and
 *          never appears in EPL, an EPL command on its own is unambiguous.
 *
 * A stream that is none of them falls through to the IPL parser, whose "no
 * frames found" error is the most useful of the messages.
 *
 * Exported so the rule can be pinned by tests: it decides which parser reads
 * every stream that enters the app, and a wrong answer renders the wrong label.
 */
export const detectSourceLanguage = (code: string): PrinterLanguage => {
    if (/^\s*\^XA/i.test(code)) return 'zpl';
    // DPL opens label formatting with <STX>L, which no other language here
    // uses — IPL frames start with other letters and EPL/TSPL have no sigil.
    // Both spellings count, since a stream may carry raw bytes or the notation.
    if (/(?:\x02|<STX>)\s*L(?:\r|\n|$)/i.test(code)) return 'dpl';
    if (/^\s*CLS\s*$/mi.test(code) && /^(?:TEXT\s+\d+,\d+,\s*"|BARCODE\s+\d+,\d+,\s*"|SIZE\s+)/mi.test(code)) return 'tspl';
    if (/^(?:A\d+,\d+,|B[0-9A-Za-z]*\d*,\d+,|LO\d+,|LW\d+,|X\d+,\d+,|b\d+,\d+,|q\d+\s*$|Q\d+,)/m.test(code)) return 'epl';
    return 'ipl';
};

/** Upper bound for open-file payloads (captures are KB-scale; see loadFile). */
const MAX_IPL_FILE_BYTES = 2 * 1024 * 1024;

const SAMPLES: { name: string; code: string }[] = [
    {
        name: 'Product',
        code: `<STX><ESC>C<SI>W812<SI>h<ETX>
<STX><SI>L400<ETX>
<STX><SI>T1<SI>g1<SI>S50<SI>d2<ETX>
<STX><ESC>P<ETX>
<STX>E1;F1;<ETX>
<STX>H0;o35,40;f0;c25;k12;d3,Honeywell Europe;<ETX>
<STX>H1;o35,70;c25;k9;d3,712-xxx Rev A;<ETX>
<STX>B2;o60,120;c6,0,0,1;h100;w2;i1;d3,(10)12345678901<ETX>
<STX>L3;o35,250;l700;w4<ETX>
<STX>H4;o35,270;c22;k14;d3,PRODUCT LABEL<ETX>
<STX>R<ETX>
<STX><ESC>E1<CAN><RS>5<ETB><FF><ETX>`,
    },
    {
        name: 'Chained',
        code: `<STX><ESC>P;E1;F1;H1;o100,100;f0;c25;k12;d3,Hello World!;B2;o100,200;f0;c6;h80;w2;i1;d3,12345678;R<ETX>
<STX><ESC>E1<CAN><ETB><FF><ETX>`,
    },
    {
        name: 'External',
        code: `<STX><ESC>C<SI>W791<SI>h<ETX>
<STX><ESC>P<ETX>
<STX>E5;F5;<ETX>
<STX>H0;o35,40;c25;k12;d3,Cat.;<ETX>
<STX>B1;o35,120;c6,0,0,1;h80;w2;i2;d0,255<ETX>
<STX>L3;o25,240;l700;w4<ETX>
<STX>R<ETX>
<STX><ESC>E5<CAN><ESC>F1<NUL>432-3221<RS>2<ETB><FF><ETX>`,
    },
    {
        name: 'Box+Date',
        code: `<STX><ESC>C<SI>W640<SI>h<ETX>
<STX><SI>L400<ETX>
<STX><ESC>P<ETX>
<STX>E2;F2;<ETX>
<STX>H0;o20,20;c21;k10;d3,2026/09/25<ETX>
<STX>H1;o20,50;c25;k14;d3,14:30:00<ETX>
<STX>W2;o20,90;l600;h200;w4;r16<ETX>
<STX>B3;o40,120;c12;h140;w2;i0;d3,IPL VIEWER DEMO<ETX>
<STX>R<ETX>
<STX><ESC>E2<CAN><ETB><FF><ETX>`,
    },
];

const ISSUE_STYLES: Record<ViewerIssue['level'], string> = {
    error: 'border-l-red-500 bg-red-900/30',
    warning: 'border-l-amber-500 bg-amber-900/20',
    info: 'border-l-sky-600 bg-sky-900/10',
};

// --- URL hash sharing (base64url of UTF-8 IPL) ---

const encodeIPLToHash = (code: string): string => {
    const bytes = new TextEncoder().encode(code);
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const decodeIPLFromHash = (): string | null => {
    const m = /[#&]ipl=([^&]+)/.exec(window.location.hash);
    if (!m) return null;
    try {
        const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
        const bin = atob(b64);
        const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
};

export const IPLViewerModal: React.FC<{ onClose: () => void; onImportDesign: (design: Design) => Promise<boolean>; }> = ({ onClose, onImportDesign }) => {
    const [iplCode, setIplCode] = useState(() => decodeIPLFromHash() ?? SAMPLES[0].code);
    const [debouncedCode, setDebouncedCode] = useState(iplCode);
    const [dpi, setDpi] = useState<PrinterSettings['dpi']>(203);
    const [zoomFactor, setZoomFactor] = useState(1);
    /**
     * Show the band the print head cannot reach. Default OFF, because the
     * viewer's contract is "preview === print": a mark that is not in the
     * printed output should not appear unless asked for. It is an overlay
     * ELEMENT rather than canvas drawing, so PNG/PDF export — which reads
     * `canvas.toDataURL()` — stays clean with it on.
     */
    const [showMargin, setShowMargin] = useState(false);
    const [basePxPerDot, setBasePxPerDot] = useState(0.5);
    const [copied, setCopied] = useState(false);
    const [safeCopied, setSafeCopied] = useState(false);
    const [exporting, setExporting] = useState(false);
    // Batch K: host/port hydrate from the persisted printer target (shared
    // with the designer's Send Job) and save back on Test/Send.
    const [sendHost, setSendHost] = useState(() => getPrinterTarget().host);
    const [sendPort, setSendPort] = useState(() => getPrinterTarget().port);
    const [bridgeStatus, setBridgeStatus] = useState<'idle' | 'checking' | 'ok' | 'fail'>('idle');
    /** Set when the user corrects the detected language. Null = trust detection. */
    const [langOverride, setLangOverride] = useState<PrinterLanguage | null>(null);
    const [sendState, setSendState] = useState<{ busy: boolean; ok?: boolean; msg?: string }>({ busy: false });
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    /** Name of the last opened file, shown next to the Open button. */
    const [openedFile, setOpenedFile] = useState<string | null>(null);
    const [dropActive, setDropActive] = useState(false);
    const [bwipReady, setBwipReady] = useState(false);
    /** Set once the CJK code page tables have loaded; re-runs the parse. */
    const [cjkReady, setCjkReady] = useState(false);
    const [caretHelp, setCaretHelp] = useState<CommandHelp | null>(null);
    const [previewBatch, setPreviewBatch] = useState(0);
    /** Warn about potential mojibake when user pastes cp1252/ANSI-encoded IPL into the textarea. */
    const [pasteWarning, setPasteWarning] = useState<string | null>(null);
    /** Manual paper size (mm). When set, overrides SI W/L and content bounds —
     * BarTender exports omit <SI>L so the real label height is otherwise lost.
     * Persisted in localStorage: real stock size rarely changes between sessions. */
    const [paperMm, setPaperMm] = useState<{ w: number; h: number } | null>(() => {
        try {
            const raw = localStorage.getItem('ipl-viewer-paper-mm');
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            return (parsed.w > 0 && parsed.h > 0) ? parsed : null;
        } catch { return null; }
    });
    /**
     * Page rotation preview, quarter-turns CCW (q-command space, PRM p.192).
     * 'auto' follows a standalone q frame in the stream. BarTender rotates via
     * page setup outside the IPL stream (see docs/HANDOFF-IPL-RENDER.md §2),
     * so matching its landscape exports means picking 90° CW (= 270 CCW) here.
     * Persisted: the stock orientation rarely changes between sessions. */
    const [rotationMode, setRotationMode] = useState<'auto' | 0 | 1 | 2 | 3>(() => {
        try {
            const raw = localStorage.getItem('ipl-viewer-rotation');
            if (raw === 'auto') return 'auto';
            const n = raw === null ? NaN : parseInt(raw, 10);
            return (n >= 0 && n <= 3) ? n as 0 | 1 | 2 | 3 : 'auto';
        } catch { return 'auto'; }
    });

    /**
     * Target printer model. Direct Graphics in a BarTender stream (no <SI>L)
     * are written in the DRIVER's centred frame, and undoing that needs
     * per-model constants the stream does not carry — so the model is an input,
     * never a guess. Unset means those graphics are placed label-relative, with
     * an info in the issue list saying so. Persisted: the target printer rarely
     * changes between sessions.
     */
    /**
     * Page orientation of the source document. The driver writes Direct
     * Graphics origins in a DIFFERENT frame per orientation and the stream
     * records neither, so this is an input. Portrait additionally needs the
     * paper height below, because its formula is anchored to the page's height.
     */
    const [pageOrientation, setPageOrientation] = useState<'portrait' | 'landscape' | ''>(() => {
        try {
            const raw = localStorage.getItem('ipl-viewer-orientation');
            return raw === 'portrait' || raw === 'landscape' ? raw : '';
        } catch { return ''; }
    });

    const [driverModel, setDriverModel] = useState<string>(() => {
        try { return localStorage.getItem('ipl-viewer-driver-model') ?? ''; } catch { return ''; }
    });

    // Persist paper size whenever it changes.
    useEffect(() => {
        try {
            if (paperMm && paperMm.w > 0 && paperMm.h > 0) localStorage.setItem('ipl-viewer-paper-mm', JSON.stringify(paperMm));
            else localStorage.removeItem('ipl-viewer-paper-mm');
        } catch { /* storage unavailable */ }
    }, [paperMm]);

    // Persist the printer model whenever it changes.
    useEffect(() => {
        try {
            if (driverModel) localStorage.setItem('ipl-viewer-driver-model', driverModel);
            else localStorage.removeItem('ipl-viewer-driver-model');
        } catch { /* storage unavailable */ }
    }, [driverModel]);

    // Persist the page orientation whenever it changes.
    useEffect(() => {
        try {
            if (pageOrientation) localStorage.setItem('ipl-viewer-orientation', pageOrientation);
            else localStorage.removeItem('ipl-viewer-orientation');
        } catch { /* storage unavailable */ }
    }, [pageOrientation]);

    // Persist the rotation choice whenever it changes.
    useEffect(() => {
        try { localStorage.setItem('ipl-viewer-rotation', String(rotationMode)); }
        catch { /* storage unavailable */ }
    }, [rotationMode]);

    // Resolve command help for whatever the caret sits on.
    const updateCaretHelp = useCallback(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        const hit = frameAtCaret(iplCode, ta.selectionStart);
        setCaretHelp(hit ? lookupHelpForFrame(hit.frame, hit.offsetInFrame) : null);
    }, [iplCode]);

    // Move the caret to the start of a 1-based line and focus the editor.
    const jumpToLine = useCallback((line: number) => {
        const ta = textareaRef.current;
        if (!ta) return;
        const offset = iplCode.split('\n').slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
        ta.focus();
        ta.setSelectionRange(offset, offset);
        // Approximate scroll so the target line is visible.
        const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 16;
        ta.scrollTop = Math.max(0, (line - 3) * lineHeight);
        updateCaretHelp();
    }, [iplCode, updateCaretHelp]);

    // Load the barcode encoder lazily; re-render once available.
    useEffect(() => {
        let alive = true;
        ensureBarcodesReady().then(() => { if (alive) setBwipReady(true); });
        return () => { alive = false; };
    }, []);

    // The four CJK code page tables are ~190 KB and load the same lazy way. A
    // stream that selects one (<SI>l30..33) parsed before they arrive keeps its
    // bytes raw, so the parse has to run AGAIN once they land — otherwise the
    // label stays mojibake for the rest of the session.
    useEffect(() => {
        let alive = true;
        ensureCjkReady().then(() => { if (alive) setCjkReady(true); });
        return () => { alive = false; };
    }, []);

    // Live parse while typing (debounced)
    useEffect(() => {
        const t = setTimeout(() => setDebouncedCode(iplCode), 300);
        return () => clearTimeout(t);
    }, [iplCode]);

    // bwipReady is a dependency on purpose: deep barcode validation only runs
    // once the encoder engine is up, so a stream parsed (or opened/shared)
    // before it finished loading would otherwise keep a stale, error-free
    // issue list until the user edits the text.
    //
    // ZPL starts with ^XA and IPL with <STX>, so those two are recognised from
    // a sigil. EPL and TSPL have NONE, so their rules must be stricter or they
    // would swallow ordinary text or each other:
    //
    //   EPL  — a line that is exactly `N`, AND a line shaped like an EPL
    //          command with numeric parameters.
    //   TSPL — a line that is exactly `CLS`, AND a line shaped like TSPL's
    //          `TEXT x,y,"font",…` or `BARCODE x,y,"type",…`. The quoted
    //          parameter is what separates it from EPL, which never quotes a
    //          type name.
    //
    // Either half alone is not enough (`N` and `CLS` are plausible text lines;
    // `A`, `B` and `TEXT` are ordinary words). A stream that is none of them
    // falls through to the IPL parser, whose "no frames found" error is the
    // most useful of the messages.
    const detectedLanguage = useMemo(() => detectSourceLanguage(debouncedCode), [debouncedCode]);
    // A wrong guess is still possible, and a silently mis-rendered label is the
    // kind of failure this project refuses — so the language is shown and one
    // click away from correct.
    const language = langOverride ?? detectedLanguage;
    const label = useMemo(
        () => (language === 'zpl' ? parseZPL(debouncedCode, dpi)
            : language === 'epl' ? parseEPL(debouncedCode)
            : language === 'tspl' ? parseTSPL(debouncedCode)
            // DPL measures every position UP from the label's bottom edge and
            // has no command that states the label length, so the stock height
            // has to be supplied. The manual "Paper mm" control is the only
            // place a person can give it — the same control, and the same gap,
            // the IPL parser has for its page height.
            : language === 'dpl' ? parseDPL(
                debouncedCode,
                paperMm && paperMm.h > 0 ? Math.round(paperMm.h / 25.4 * dpi) : undefined,
                undefined,
                // The resolution decides how many dots an inch of DPL becomes.
                // Without it every bar code, box and polygon is sized for a
                // 203 dpi machine whatever the reader has selected — a `eee=040`
                // bar code drew 81 dots at 300 dpi where its 0.40 in is 120.
                dpi,
            )
            : parseViewerIPL(debouncedCode, {
                model: driverModel || undefined,
                dpi,
                orientation: pageOrientation || undefined,
                // The page height the portrait frame is anchored to. Only the
                // manual "Paper mm" control can supply it — the stream never
                // carries a page height (a portrait stream says only
                // `<ESC>C<SI>W…`, with no <SI>L).
                pageHeightDots: paperMm && paperMm.h > 0 ? Math.round(paperMm.h / 25.4 * dpi) : undefined,
            })),
        [debouncedCode, language, bwipReady, cjkReady, driverModel, dpi, pageOrientation, paperMm],
    );
    // Importing a design back out of a stream is IPL-only: parseIPL is what the
    // button calls, and it reads one language. The other four have VIEWERS, so
    // the tab shows them — but a ZPL, EPL, TSPL or DPL stream put through the
    // IPL importer yields zero fields, and the button would do nothing at all.
    //
    // The flag used to be called `isZpl` and the message said "ZPL", which was
    // true when ZPL was the only other language. It now covers four, so both
    // the name and the message have to say what they mean — a DPL stream was
    // being told it was a ZPL one.
    const importUnsupported = language !== 'ipl';
    const totalLabels = totalLabelCount(label);
    const batch = Math.min(previewBatch, Math.max(0, totalLabels - 1));
    const previewLabel = useMemo(() => resolveLabelAtBatch(label, batch, dpi), [label, batch, dpi]);
    const extent = useMemo(() => {
        const base = computeLabelExtent(previewLabel, dpi);
        if (paperMm) {
            // Manual paper size wins: convert mm → dots at the chosen DPI.
            const wDots = Math.round(paperMm.w / 25.4 * dpi);
            const hDots = Math.round(paperMm.h / 25.4 * dpi);
            return { widthDots: Math.max(base.widthDots, wDots), heightDots: Math.max(base.heightDots, hDots) };
        }
        return base;
    }, [previewLabel, dpi, paperMm]);
    const errors = label.issues.filter(i => i.level === 'error');
    const warnings = label.issues.filter(i => i.level === 'warning');
    const infos = label.issues.filter(i => i.level === 'info');
    const hasContent = previewLabel.elements.length > 0;
    /** Effective quarter-turns CCW: manual override wins, else a standalone q frame. */
    const effectiveRotation = rotationMode === 'auto' ? (label.settings.formatDirection ?? 0) : rotationMode;

    // Reset the batch selector when the job becomes single-label.
    useEffect(() => {
        if (totalLabels <= 1) setPreviewBatch(0);
    }, [totalLabels]);

    // Recompute the fit-to-width baseline whenever content, DPI or the CONTAINER
    // size changes. The container matters as much as the content: this effect
    // runs before the modal has laid out, so a first-and-only pass measured a
    // near-zero box and left the preview at 40x19 CSS px. The ResizeObserver
    // below re-runs it once real dimensions exist, and again on every window or
    // pane resize.
    useEffect(() => {
        const el = scrollRef.current;
        if (!el || !hasContent) return;
        const fit = () => {
            const availW = el.clientWidth - 40;
            const availH = el.clientHeight - 40;
            if (availW <= 0 || availH <= 0) return;
            const swap = effectiveRotation === 1 || effectiveRotation === 3;
            const w = swap ? extent.heightDots : extent.widthDots;
            const h = swap ? extent.widthDots : extent.heightDots;
            setBasePxPerDot(Math.max(0.05, Math.min(availW / w, availH / h, 3)));
        };
        fit();
        const observer = new ResizeObserver(fit);
        observer.observe(el);
        return () => observer.disconnect();
    }, [extent, hasContent, effectiveRotation]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !hasContent) return;
        renderLabel(canvas, previewLabel, extent, { dpi, pxPerDot: Math.min(8, basePxPerDot * zoomFactor), quality: 2, rotation: effectiveRotation });
    }, [previewLabel, extent, dpi, basePxPerDot, zoomFactor, hasContent, bwipReady, effectiveRotation]);

    /**
     * The printable area, as a CSS-pixel rectangle over the canvas.
     *
     * `UNPRINTABLE_MARGIN_MM` is the head's own figure and carries WIDTH only,
     * so the band runs along the two edges of the head axis — which screen
     * edges those are depends on the rotation, exactly like the W axis in the
     * placement formula: at 0/180 the label's width axis is horizontal, at
     * 90/270 it is vertical. Insetting all four edges would claim a margin
     * along the feed that the driver's table does not state.
     *
     * Null when this model has no such band, when no model is chosen, or when
     * the label is too small for any printable area to be left.
     */
    const printableArea = useMemo(() => {
        const insetMm = UNPRINTABLE_MARGIN_MM[driverModel] ?? 0;
        if (!showMargin || insetMm <= 0) return null;
        const swap = effectiveRotation === 1 || effectiveRotation === 3;
        const wDots = swap ? extent.heightDots : extent.widthDots;
        const hDots = swap ? extent.widthDots : extent.heightDots;
        const inset = (insetMm / 25.4) * dpi;
        if (wDots <= inset * 2 || hDots <= inset * 2) return null;
        const pxPerDot = Math.min(8, basePxPerDot * zoomFactor);
        const band = inset * pxPerDot;
        // The head spans the stock's WIDTH, so the band is on that axis.
        const acrossWidth = !swap;
        return {
            left: acrossWidth ? band : 0,
            top: acrossWidth ? 0 : band,
            width: wDots * pxPerDot - (acrossWidth ? band * 2 : 0),
            height: hDots * pxPerDot - (acrossWidth ? 0 : band * 2),
        };
    }, [showMargin, driverModel, extent, dpi, basePxPerDot, zoomFactor, effectiveRotation]);

    const handleImport = useCallback(async () => {
        try {
            // Collect what the import could not represent. The designer model
            // has no interpretive field and no slot for an unknown command, so
            // those used to disappear with nothing said — the user would find
            // a missing field later, with no clue it had ever been there.
            const lost: string[] = [];
            const design = parseIPL(debouncedCode, dpi, n => lost.push(n.message));
            if (design.fields.length === 0) return;
            if (lost.length > 0) {
                notify(`Imported with ${lost.length} field${lost.length === 1 ? '' : 's'} not carried over. ${lost.join(' ')}`);
            }
            // Route through App's guarded action: importing replaces the canvas,
            // so unsaved work gets the same confirm as New/Load/Import. Only
            // close the modal when the replacement actually happened.
            if (await onImportDesign(design)) onClose();
        } catch {
            /* import stays disabled when the designer-side parser fails */
        }
    }, [debouncedCode, dpi, onImportDesign, onClose]);

    const canImport = (() => {
        try { return parseIPL(debouncedCode, dpi).fields.length > 0; } catch { return false; }
    })();

    const stepZoom = (dir: 1 | -1) =>
        setZoomFactor(z => Math.min(8, Math.max(0.1, +(z * (dir === 1 ? 1.25 : 0.8)).toFixed(3))));

    // --- Sharing & export ---

    // Batch J: bridge transport lives in services/bridgeSend.ts (shared
    // with the designer's CSV job sender); this component only maps the
    // result onto its status/send-state UI. Batch K: Test/Send persist the
    // host/port as the shared printer target (invalid values are rejected
    // by setPrinterTarget and surface as a message, never sent).
    // Review HIGH: return the CLEAN target, not just an error flag — React
    // state updates are async, so the raw sendHost/sendPort closure values
    // would otherwise flow into the send and its success message (showing
    // un-normalized " http://p:9100 : 9100 " garbage).
    const persistTarget = (): { clean?: { host: string; port: string }; error?: string } => {
        try {
            const clean = setPrinterTarget({ host: sendHost, port: sendPort });
            setSendHost(clean.host);
            setSendPort(clean.port);
            return { clean };
        } catch (e) {
            return { error: e instanceof Error ? e.message : String(e) };
        }
    };

    const handlePing = async () => {
        const { clean, error } = persistTarget();
        // Review MEDIUM: an invalid INPUT is not a bridge failure — leave
        // the status dot alone and just surface the message.
        if (!clean) { setSendState({ busy: false, ok: false, msg: error }); return; }
        setBridgeStatus('checking');
        setBridgeStatus(await pingBridge() ? 'ok' : 'fail');
    };

    const sendIPL = async () => {
        if (!hasContent) return;
        const { clean, error } = persistTarget();
        if (!clean) { setSendState({ busy: false, ok: false, msg: error }); return; }
        setSendState({ busy: true });
        const res = await sendIplViaBridge(debouncedCode, { host: clean.host, port: clean.port });
        setSendState({
            busy: false,
            ok: res.ok,
            msg: res.ok ? `Sent ${res.written ?? debouncedCode.length} bytes to ${clean.host}:${clean.port}.` : res.error,
        });
    };

    const downloadIplFile = () => {
        const blob = new Blob([debouncedCode], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'label.ipl';
        a.click();
        URL.revokeObjectURL(a.href);
    };

    // --- Open file (picker + drag & drop) ---

    /** Load one file into the editor, preserving raw bytes for Direct Graphics. */
    const loadFile = useCallback(async (file: File) => {
        try {
            // Real .ipl captures are KB-scale; this bound keeps a hostile
            // multi-MB drop-file from freezing the editor (string builder +
            // live-parse cost grows with size).
            if (file.size > MAX_IPL_FILE_BYTES) {
                notify(`File too large (${Math.round(file.size / 1024)} KB; limit ${MAX_IPL_FILE_BYTES / 1024} KB). It will not be opened.`);
                return;
            }
            const text = bytesToByteString(await file.arrayBuffer());
            setIplCode(text);
            setOpenedFile(file.name);
            setPreviewBatch(0);
            // A freshly opened file supersedes whatever the URL hash carried.
            if (window.location.hash.includes('ipl=')) window.location.hash = '';
        } catch {
            // Surface it — a silent swallow here is the failure mode the
            // whole project fights (user waits wondering if the open worked).
            setOpenedFile(null);
            notify(`Could not read "${file.name}" — the file was not opened.`);
        }
    }, []);

    const onFilePicked = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) void loadFile(file);
        // Reset so re-picking the same path fires onChange again.
        e.target.value = '';
    }, [loadFile]);

    /** Handle textarea changes with mojibake detection for pasted BarTender IPL. */
    const handleTextareaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const val = e.target.value;
        const { hasCorruption, highCharCount } = detectMojibake(val);

        if (highCharCount > 50) {
            // Show friendly warning when significant non-ASCII content detected
            setPasteWarning(
                `⚠️ Detected ${highCharCount} non-ASCII character(s). Your source may use Windows ANSI (cp1252) encoding. Pasting can corrupt raw binary data.`
            );
        } else if (hasCorruption) {
            // Low count but still present — show info message
            setPasteWarning(`ℹ️ Non-ASCII characters found (${highCharCount}). Graphics MAY be corrupted.`);
        } else {
            setPasteWarning(null);
        }

        setIplCode(val);
    }, []);

    const onDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setDropActive(false);
        const file = e.dataTransfer.files?.[0];
        if (file) void loadFile(file);
    }, [loadFile]);

    const handleCopyLink = async () => {
        const url = `${window.location.origin}${window.location.pathname}#ipl=${encodeIPLToHash(debouncedCode)}`;
        try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
        } catch {
            window.location.hash = `ipl=${encodeIPLToHash(debouncedCode)}`;
        }
    };

    /** Copy a clipboard-safe form of the IPL: binary Direct Graphics (<ESC>g0)
     * become nibblized hex (<ESC>g1), which is pure ASCII, prints identically,
     * and survives any UTF-8 paste. Streams without g0 copy unchanged. */
    const handleCopySafe = async () => {
        const { ipl } = convertDirectGraphicsToHex(debouncedCode);
        try {
            await navigator.clipboard.writeText(ipl);
            setSafeCopied(true);
            setTimeout(() => setSafeCopied(false), 1800);
        } catch {
            notify('Clipboard unavailable — copy blocked by the browser.');
        }
    };

    /** Replace the editor contents with the g1 rewrite, in place. Used by the
     * paste-warning banner: a binary g0 paste cannot render (its bytes were
     * already lost to UTF-8), but a still-intact g0 stream converts losslessly. */
    const handleConvertToHex = () => {
        const { ipl, converted } = convertDirectGraphicsToHex(iplCode);
        if (!converted) {
            notify('No binary Direct Graphics (<ESC>g0) found — nothing to convert. If this came from a paste, the bytes are already lost; open the file instead.');
            return;
        }
        setIplCode(ipl);
        setPasteWarning(null);
    };

    const getPngDataUrl = (): string | null => {
        const canvas = canvasRef.current;
        return canvas && hasContent ? canvas.toDataURL('image/png') : null;
    };

    const downloadPng = () => {
        const dataUrl = getPngDataUrl();
        if (!dataUrl) return;
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = `ipl-label-${dpi}dpi.png`;
        a.click();
    };

    const downloadPdf = async () => {
        const dataUrl = getPngDataUrl();
        if (!dataUrl) return;
        setExporting(true);
        try {
            const { jsPDF } = await import('jspdf');
            const swap = effectiveRotation === 1 || effectiveRotation === 3;
            const wPx = (swap ? extent.heightDots : extent.widthDots) / dpi * 72;   // points
            const hPx = (swap ? extent.widthDots : extent.heightDots) / dpi * 72;
            const pdf = new jsPDF({
                orientation: wPx >= hPx ? 'landscape' : 'portrait',
                unit: 'pt',
                format: [Math.max(28, wPx), Math.max(28, hPx)],
                // jsPDF embeds addImage rasters as uncompressed RGB without
                // this: no-compression rasters make a PDF ~2 orders of
                // magnitude larger for the same picture.
                compress: true,
            });
            pdf.addImage(dataUrl, 'PNG', 0, 0, wPx, hPx);
            pdf.save(`ipl-label-${dpi}dpi.pdf`);
        } finally {
            setExporting(false);
        }
    };

    /**
     * Batch E: every label of a multi-label job (<RS>×<US>, odometer-advanced)
     * as one multi-page PDF, sized per physical label at the chosen DPI.
     * Pages stream straight into jsPDF (peak memory = one page) with
     * event-loop yields so the tab stays responsive; the 300-page cap is
     * confirmed BEFORE the expensive render, and extent is only locked when
     * the user set a manual paper size (auto extent stays per-label so
     * widening odometer data never clips later pages).
     */
    const downloadBatchPdf = async () => {
        if (!hasContent || exporting) return;
        const pageCount = batchPageCount(label);
        if (pageCount === 0) return;
        if (totalLabels > pageCount) {
            const proceed = await requestConfirm({
                title: 'Large batch export',
                message: `This job prints ${totalLabels} labels, but PDF export is capped at ${pageCount} pages. Export the first ${pageCount}?`,
                confirmLabel: `Export ${pageCount} pages`,
            });
            if (!proceed) return;
        }
        setExporting(true);
        try {
            const { jsPDF } = await import('jspdf');
            let pdf: InstanceType<typeof jsPDF> | null = null;
            let emitted = 0;
            await streamBatchPages(label, dpi, effectiveRotation,
                { extentOverride: paperMm ? extent : undefined },
                (page) => {
                    if (!pdf) {
                        pdf = new jsPDF({
                            orientation: page.landscape ? 'landscape' : 'portrait',
                            unit: 'pt',
                            format: [Math.max(28, page.widthPt), Math.max(28, page.heightPt)],
                            // Same reason as the single-label export above:
                            // an uncompressed raster is ~330x the size here.
                            compress: true,
                        });
                    } else {
                        pdf.addPage([Math.max(28, page.widthPt), Math.max(28, page.heightPt)],
                            page.landscape ? 'landscape' : 'portrait');
                    }
                    pdf.addImage(page.dataUrl, 'PNG', 0, 0, page.widthPt, page.heightPt);
                    emitted++;
                });
            if (!pdf) return;
            pdf.save(`${sanitizeBaseName(openedFile)}-${emitted}x-${dpi}dpi.pdf`);
        } catch (e) {
            notify(`Batch PDF export failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setExporting(false);
        }
    };

    /**
     * Batch F: every label of the job as a numbered PNG inside one ZIP
     * (store method — the PNGs are already compressed). Same streaming and
     * cap semantics as the batch PDF; the ZIP is assembled from raw entry
     * bytes so peak memory is one decoded page plus the archive itself.
     */
    const downloadBatchPngs = async () => {
        if (!hasContent || exporting) return;
        const pageCount = batchPageCount(label);
        if (pageCount === 0) return;
        if (totalLabels > pageCount) {
            const proceed = await requestConfirm({
                title: 'Large batch export',
                message: `This job prints ${totalLabels} labels, but PNG export is capped at ${pageCount} files. Export the first ${pageCount}?`,
                confirmLabel: `Export ${pageCount} PNGs`,
            });
            if (!proceed) return;
        }
        setExporting(true);
        try {
            // sanitizeBaseName strips paths and Windows-illegal characters:
            // entry names double as on-disk paths when the ZIP is extracted.
            const baseName = sanitizeBaseName(openedFile);
            const entries: ZipEntry[] = [];
            await streamBatchPages(label, dpi, effectiveRotation,
                { extentOverride: paperMm ? extent : undefined },
                (page, i) => {
                    entries.push({ name: numberedPngName(baseName, i, pageCount), data: zipEntryBytes(page.dataUrl) });
                });
            if (entries.length === 0) return;
            const blob = createZipBlob(entries);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${baseName}-${entries.length}png-${dpi}dpi.zip`;
            a.click();
            // Large archives can take longer than a few seconds for the
            // download manager to start reading the blob — revoke late.
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } catch (e) {
            notify(`Batch PNG export failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setExporting(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
            <div className="bg-gray-800 rounded-lg shadow-2xl p-5 w-full max-w-6xl mx-4 text-gray-200 h-[92vh] flex flex-col" onClick={e => e.stopPropagation()}>

                <div className="flex justify-between items-center border-b border-gray-700 pb-3 mb-4 flex-shrink-0">
                    <h2 className="text-xl font-bold flex items-center gap-2">
                        <span className="material-icons">code</span>IPL Viewer
                        <span className="text-xs font-normal text-gray-400 ml-2">Intermec Printer Language</span>
                    </h2>
                    <div className="flex items-center gap-2">
                        <button onClick={handleCopyLink} title="Copy a shareable link containing this IPL"
                            className="text-xs px-2 py-1.5 rounded bg-gray-700 hover:bg-gray-600 flex items-center gap-1">
                            <span className="material-icons text-sm">{copied ? 'check' : 'link'}</span>{copied ? 'Copied' : 'Share'}
                        </button>
                        <button onClick={handleCopySafe} title="Copy with binary Direct Graphics rewritten as printer-supported hex (<ESC>g1): paste-safe and prints identically"
                            className="text-xs px-2 py-1.5 rounded bg-indigo-700 hover:bg-indigo-600 flex items-center gap-1">
                            <span className="material-icons text-sm">{safeCopied ? 'check' : 'content_copy'}</span>{safeCopied ? 'Copied' : 'Copy ASCII (g1)'}
                        </button>
                        <button onClick={() => { window.location.hash = ''; onClose(); }}
                            className="p-1 rounded-full hover:bg-gray-700"><span className="material-icons">close</span></button>
                    </div>
                </div>

                <div className="flex-1 flex gap-4 overflow-hidden min-h-0">
                    {/* Left: source */}
                    <div className="w-[42%] flex flex-col min-h-0">
                        <div className="flex items-center justify-between gap-2 mb-2">
                            <label className="block text-xs font-medium text-gray-400 flex items-center gap-1.5 min-w-0">
                                {/* Which language the text was read as. Shown, not
                                    assumed: detection is a guess and a wrong one
                                    would otherwise render the wrong label silently. */}
                                <select value={language} onChange={e => setLangOverride(e.target.value as PrinterLanguage)}
                                    aria-label="Source language"
                                    title={langOverride ? "Language chosen by hand" : "Detected from the stream"}
                                    className="flex-shrink-0 bg-gray-700 text-gray-200 text-[11px] rounded px-1 py-0.5 outline-none">
                                    <option value="ipl">IPL</option>
                                    <option value="zpl">ZPL</option>
                                    <option value="epl">EPL</option>
                                    <option value="tspl">TSPL</option>
                                    <option value="dpl">DPL</option>
                                </select>
                                <span className="flex-shrink-0">Source</span>
                                {langOverride && langOverride !== detectedLanguage && (
                                    <span className="text-[10px] text-amber-400 flex-shrink-0" title={`The stream looks like ${detectedLanguage.toUpperCase()}`}>overridden</span>
                                )}
                                {openedFile && (
                                    <span className="text-[10px] text-gray-500 truncate" title={openedFile}>· {openedFile}</span>
                                )}
                            </label>
                            <div className="flex items-center gap-1.5 flex-shrink-0">
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept=".ipl,.txt,.prn,.dat,text/plain"
                                    onChange={onFilePicked}
                                    className="hidden"
                                />
                                <button
                                    onClick={() => fileInputRef.current?.click()}
                                    title="Open an IPL/PRN file (raw bytes preserved) — or drop one on the editor"
                                    className="text-xs px-2 py-1.5 rounded bg-gray-700 hover:bg-gray-600 flex items-center gap-1"
                                >
                                    <span className="material-icons text-sm">folder_open</span>Open
                                </button>
                                <select value="" onChange={(e) => {
                                    const s = SAMPLES.find(x => x.name === e.target.value);
                                    if (s) { setIplCode(s.code); setOpenedFile(null); }
                                }} className="text-xs px-2 py-1.5 rounded bg-gray-700 border border-gray-600 outline-none">
                                    <option value="">Load sample…</option>
                                    {SAMPLES.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                                </select>
                            </div>
                        </div>
                        {pasteWarning && (
                            <div className="mb-3 rounded-md border-l-4 border-amber-500 bg-amber-900/20 p-3">
                                <div className="flex items-start gap-2">
                                    <span className="text-lg">⚠️</span>
                                    <div>
                                        <p className="text-sm font-semibold text-amber-400">{pasteWarning}</p>
                                        <p className="text-xs text-amber-300 mt-1">
                                            This stream carries binary Direct Graphics. A UTF-8 paste loses those bytes
                                            permanently — use{" "}
                                            <button
                                                onClick={() => fileInputRef.current?.click()}
                                                className="underline hover:text-blue-300"
                                            >
                                                Open File
                                            </button>{" "}
                                            or drag-drop for a byte-exact import. If the bytes are still intact,{" "}
                                            <button
                                                onClick={handleConvertToHex}
                                                className="underline hover:text-blue-300 font-semibold"
                                            >
                                                Convert to ASCII (g1)
                                            </button>{" "}
                                            rewrites them as printer-supported hex that pastes safely.
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}
                        <textarea
                            ref={textareaRef}
                            value={iplCode}
                            onChange={handleTextareaChange}
                            onSelect={updateCaretHelp}
                            onKeyUp={updateCaretHelp}
                            onClick={updateCaretHelp}
                            onDragOver={e => { e.preventDefault(); setDropActive(true); }}
                            onDragLeave={() => setDropActive(false)}
                            onDrop={onDrop}
                            spellCheck={false}
                            className={`w-full flex-grow p-2 font-mono text-xs leading-relaxed bg-gray-900 text-green-400 rounded-md border focus:ring-blue-500 focus:border-blue-500 resize-none ${dropActive ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-700'}`}
                            placeholder={`Paste IPL here (or drop a file), e.g.\n<STX><ESC>P<ETX>\n<STX>E1;F1<ETX>\n<STX>H0;o50,50;c25;k12;d3,HELLO<ETX>\n<STX>R<ETX>`}
                        />
                        <div className="mt-2 text-xs text-gray-500 flex-shrink-0">
                            {debouncedCode.length.toLocaleString()} chars · accepts raw control bytes or &lt;STX&gt;/&lt;ETX&gt;/&lt;ESC&gt; notation
                        </div>

                        {/* Command help (click-to-help): reflects the token under the caret */}
                        {caretHelp && (
                            <div className="mt-2 rounded-md border border-blue-800 bg-blue-950/40 p-2.5 flex-shrink-0">
                                <div className="flex items-baseline gap-2">
                                    <code className="text-xs font-bold text-blue-300">{caretHelp.token}</code>
                                    <span className="text-xs font-semibold text-gray-200">{caretHelp.title}</span>
                                    {caretHelp.page && <span className="ml-auto text-[10px] text-gray-500">{caretHelp.page}</span>}
                                </div>
                                <code className="block mt-1 text-[11px] text-blue-200/80">{caretHelp.syntax}</code>
                                <p className="mt-1 text-xs text-gray-300 leading-snug">{caretHelp.summary}</p>
                            </div>
                        )}

                        {/* Issues */}
                        <div className="mt-2 h-44 overflow-auto rounded-md border border-gray-700 bg-gray-900/60 flex-shrink-0">
                            {label.issues.length === 0 && (
                                <div className="p-3 text-xs text-emerald-400 flex items-center gap-2">
                                    <span className="material-icons text-sm">check_circle</span>No issues detected.
                                </div>
                            )}
                            {label.issues.map((issue, i) => (
                                <div key={i} className={`px-3 py-2 mb-1 border-l-4 ${ISSUE_STYLES[issue.level]}`}>
                                    <div className="flex items-start gap-2">
                                        <span className={`text-[10px] font-bold uppercase mt-0.5 ${issue.level === 'error' ? 'text-red-400' : issue.level === 'warning' ? 'text-amber-400' : 'text-sky-400'}`}>
                                            {issue.level}
                                        </span>
                                        {issue.line !== undefined && (
                                            <button
                                                onClick={() => jumpToLine(issue.line!)}
                                                title={`Jump to line ${issue.line}`}
                                                className="text-[10px] px-1 py-0.5 rounded bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 mt-0.5 whitespace-nowrap"
                                            >
                                                L{issue.line}
                                            </button>
                                        )}
                                        <span className="text-xs text-gray-300">{issue.message}</span>
                                        {issue.command && (
                                            <code className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 whitespace-nowrap">{issue.command}</code>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Right: preview */}
                    <div className="flex-1 flex flex-col min-h-0">
                        <div className="flex items-end gap-3 mb-2 flex-shrink-0 flex-wrap">
                            <div>
                                <label className="block text-xs font-medium text-gray-400 mb-1">DPI</label>
                                <select value={dpi} onChange={e => setDpi(parseInt(e.target.value) as PrinterSettings['dpi'])}
                                    className="w-24 text-sm p-1.5 bg-gray-700 rounded-md border border-gray-600 focus:ring-1 focus:ring-blue-500 outline-none">
                                    {DPI_OPTIONS.map(d => <option key={d} value={d}>{d}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-gray-400 mb-1"
                                    title="The printer the stream was made for. BarTender writes Direct Graphics in the driver's own frame and the stream does not say which model, so graphic placement needs this. Left unset, those graphics are placed label-relative and flagged in the issue list.">
                                    Printer
                                </label>
                                <select value={driverModel} onChange={e => setDriverModel(e.target.value)}
                                    className="w-28 text-sm p-1.5 bg-gray-700 rounded-md border border-gray-600 focus:ring-1 focus:ring-blue-500 outline-none">
                                    <option value="">(unset)</option>
                                    {Object.keys(PRINTER_MODELS).filter(m => m !== 'Generic').map(m =>
                                        <option key={m} value={m}>{m}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-gray-400 mb-1"
                                    title="Page orientation of the document the stream came from. The driver writes Direct Graphics origins in a different frame for portrait and landscape, and the stream records neither — so graphic placement needs this. Portrait also needs Paper mm's height, since its frame is anchored to the page height.">
                                    Page
                                </label>
                                <select value={pageOrientation} onChange={e => setPageOrientation(e.target.value as 'portrait' | 'landscape' | '')}
                                    className="w-28 text-sm p-1.5 bg-gray-700 rounded-md border border-gray-600 focus:ring-1 focus:ring-blue-500 outline-none">
                                    <option value="">(unset)</option>
                                    <option value="landscape">Landscape</option>
                                    <option value="portrait">Portrait</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-gray-400 mb-1">Zoom</label>
                                <div className="flex rounded-md overflow-hidden border border-gray-600">
                                    <button onClick={() => stepZoom(-1)} className="px-2.5 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm">−</button>
                                    <button onClick={() => setZoomFactor(1)} title="Fit to view"
                                        className="px-2 py-1.5 bg-gray-800 hover:bg-gray-600 text-xs w-16">{Math.round(zoomFactor * 100)}%</button>
                                    <button onClick={() => stepZoom(1)} className="px-2.5 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm">+</button>
                                </div>
                            </div>
                            {totalLabels > 1 && (
                                <div>
                                    <label className="block text-xs font-medium text-gray-400 mb-1">Label</label>
                                    <div className="flex items-center gap-1">
                                        <button onClick={() => setPreviewBatch(b => Math.max(0, b - 1))} disabled={batch === 0}
                                            className="px-2 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-md text-sm disabled:opacity-40">−</button>
                                        <span className="text-xs text-gray-300 w-14 text-center" title="Batch preview: <FS>/<GS> regions advance by the field increment per batch">
                                            {batch + 1}/{totalLabels}
                                        </span>
                                        <button onClick={() => setPreviewBatch(b => Math.min(totalLabels - 1, b + 1))} disabled={batch >= totalLabels - 1}
                                            className="px-2 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-md text-sm disabled:opacity-40">+</button>
                                    </div>
                                </div>
                            )}
                            <div>
                                <label className="block text-xs font-medium text-gray-400 mb-1" title="Real label stock size (mm). BarTender exports omit <SI>L so the height must be given manually.">
                                    Paper mm
                                </label>
                                <div className="flex items-center gap-1">
                                    <input type="number" min={5} max={400} value={paperMm?.w ?? ''}
                                        onChange={e => setPaperMm(m => ({ w: Math.max(5, +e.target.value || 0), h: m?.h ?? 0 }))}
                                        placeholder="W" className="w-14 text-xs p-1.5 bg-gray-900 border border-gray-700 rounded-md outline-none focus:border-blue-500" />
                                    <span className="text-xs text-gray-500">×</span>
                                    <input type="number" min={5} max={400} value={paperMm?.h ?? ''}
                                        onChange={e => setPaperMm(m => ({ w: m?.w ?? 0, h: Math.max(5, +e.target.value || 0) }))}
                                        placeholder="H" className="w-14 text-xs p-1.5 bg-gray-900 border border-gray-700 rounded-md outline-none focus:border-blue-500" />
                                </div>
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-gray-400 mb-1"
                                    title="Rotate the whole label preview (q-command space, CCW). 'auto' follows a standalone q frame in the stream. BarTender rotates via page setup outside the IPL stream — pick 90° CW to match its landscape exports.">
                                    Rotate
                                </label>
                                <div className="flex items-center gap-1">
                                    <button onClick={() => setRotationMode('auto')}
                                        title="Follow a q command in the stream (default 0°)"
                                        className={`text-xs px-2 py-1.5 rounded-md ${rotationMode === 'auto' ? 'bg-blue-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-200'}`}>
                                        auto
                                    </button>
                                    {([0, 1, 2, 3] as const).map(q => (
                                        <button key={q} onClick={() => setRotationMode(q)}
                                            title={q === 0 ? '0° (as authored)' : `${q * 90}° counterclockwise`}
                                            className={`text-xs px-2 py-1.5 rounded-md ${rotationMode === q ? 'bg-blue-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-200'}`}>
                                            {q === 0 ? '0°' : q === 1 ? '90↺' : q === 2 ? '180' : '90↻'}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div className="flex gap-1 ml-1">
                                <button onClick={() => setShowMargin(v => !v)}
                                    disabled={(UNPRINTABLE_MARGIN_MM[driverModel] ?? 0) <= 0}
                                    title={(UNPRINTABLE_MARGIN_MM[driverModel] ?? 0) > 0
                                        ? `Show the ${UNPRINTABLE_MARGIN_MM[driverModel]} mm band the print head cannot reach, from the driver's own model table. Not part of the printed label, and never included in PNG/PDF export.`
                                        : 'This printer model publishes no unprintable margin, so there is no band to show. Pick a model under Printer.'}
                                    className={`text-xs px-2.5 py-2 rounded flex items-center gap-1 ${showMargin ? 'bg-orange-600 hover:bg-orange-500 text-white' : 'bg-gray-700 hover:bg-gray-600'} disabled:opacity-40 disabled:cursor-not-allowed`}>
                                    <span className="material-icons text-sm">crop_free</span>Guide
                                </button>
                                <button onClick={downloadPng} disabled={!hasContent || exporting}
                                    className="text-xs px-2.5 py-2 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1">
                                    <span className="material-icons text-sm">image</span>{exporting ? '…' : 'PNG'}
                                </button>
                                <button onClick={downloadPdf} disabled={!hasContent || exporting}
                                    className="text-xs px-2.5 py-2 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1">
                                    <span className="material-icons text-sm">picture_as_pdf</span>{exporting ? '…' : 'PDF'}
                                </button>
                                {totalLabels > 1 && (
                                    <button onClick={downloadBatchPdf} disabled={!hasContent || exporting}
                                        title={`One multi-page PDF with all ${Math.min(totalLabels, MAX_BATCH_EXPORT)} labels of the job (<RS>×<US>, odometer advanced)`}
                                        className="text-xs px-2.5 py-2 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1">
                                        <span className="material-icons text-sm">auto_awesome_motion</span>{exporting ? '…' : `PDF ×${Math.min(totalLabels, MAX_BATCH_EXPORT)}`}
                                    </button>
                                )}
                                {totalLabels > 1 && (
                                    <button onClick={downloadBatchPngs} disabled={!hasContent || exporting}
                                        title={`ZIP with ${Math.min(totalLabels, MAX_BATCH_EXPORT)} numbered PNGs, one per label of the job`}
                                        className="text-xs px-2.5 py-2 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1">
                                        <span className="material-icons text-sm">folder_zip</span>{exporting ? '…' : `PNG ×${Math.min(totalLabels, MAX_BATCH_EXPORT)}`}
                                    </button>
                                )}
                            </div>
                            <div className="ml-auto text-right">
                                <div className="text-xs text-gray-400">
                                    {(() => {
                                        const swap = effectiveRotation === 1 || effectiveRotation === 3;
                                        const w = swap ? extent.heightDots : extent.widthDots;
                                        const h = swap ? extent.widthDots : extent.heightDots;
                                        return <>{w} × {h} dots{effectiveRotation ? ` · ${effectiveRotation * 90}° CCW` : ''}</>;
                                    })()}
                                </div>
                                <div className="text-[11px] text-gray-500">
                                    ≈ {(() => {
                                        const swap = effectiveRotation === 1 || effectiveRotation === 3;
                                        const w = swap ? extent.heightDots : extent.widthDots;
                                        const h = swap ? extent.widthDots : extent.heightDots;
                                        return `${(w / dpi * 25.4).toFixed(1)} × ${(h / dpi * 25.4).toFixed(1)}`;
                                    })()} mm @ {dpi}dpi
                                </div>
                            </div>
                        </div>

                        <div ref={scrollRef} className="flex-1 bg-gray-900 rounded-md p-4 overflow-auto workspace-bg">
                            {!hasContent ? (
                                <div className={`h-full flex items-center justify-center text-sm ${errors.length > 0 ? 'text-red-400' : 'text-gray-400'}`}>
                                    {errors.length > 0 ? errors[0].message : 'Type or paste IPL code to preview the label.'}
                                </div>
                            ) : (
                                <div className="relative inline-block">
                                    <canvas ref={canvasRef} className="shadow-2xl" style={{ imageRendering: 'pixelated' }} />
                                    {printableArea && (
                                        <div
                                            aria-hidden="true"
                                            className="absolute pointer-events-none border-2 border-dashed border-orange-400/90"
                                            style={{
                                                left: printableArea.left,
                                                top: printableArea.top,
                                                width: printableArea.width,
                                                height: printableArea.height,
                                            }}
                                        />
                                    )}
                                </div>
                            )}
                        </div>

                        <div className="mt-2 flex gap-4 text-xs text-gray-400 flex-shrink-0 flex-wrap">
                            <span>{label.elements.length} fields</span>
                            {label.page && (
                                <span title={label.page.placements.map(p => `${p.position}→F${p.formatId}${p.offsetX || p.offsetY ? ` @${p.offsetX},${p.offsetY}` : ''}`).join(', ')}>
                                    page {label.page.id}: {label.page.placements.length} formats
                                </span>
                            )}
                            {label.settings.codePage !== undefined && (
                                <span title="Printer Language, Select <SI>ln — the character set the printer applies to print data">
                                    Code page: {describeCodePage(label.settings.codePage)}
                                </span>
                            )}
                            {(label.settings.batchCount ?? 1) * (label.settings.quantity ?? 1) > 1 && (
                                <span title="Copies per batch × batches (<US> × <RS>)">
                                    {label.settings.batchCount ?? 1}×{label.settings.quantity ?? 1} labels
                                </span>
                            )}
                            {errors.length > 0 && <span className="text-red-400">{errors.length} errors</span>}
                            {warnings.length > 0 && <span className="text-amber-400">{warnings.length} warnings</span>}
                            {infos.length > 0 && <span className="text-sky-400">{infos.length} notes</span>}
                        </div>
                    </div>
                </div>

                <div className="mt-4 pt-3 border-t border-gray-700 flex-shrink-0">
                    {/* Send to printer / simulator */}
                    <div className="flex items-end gap-2 flex-wrap mb-3">
                        <div className="flex items-center gap-1.5 text-xs text-gray-400 self-center" title="Local bridge relays the stream to a printer or Honeywell simulator over raw TCP. Browsers cannot open TCP directly.">
                            <span className={`w-2 h-2 rounded-full ${bridgeStatus === 'ok' ? 'bg-emerald-500' : bridgeStatus === 'fail' ? 'bg-red-500' : bridgeStatus === 'checking' ? 'bg-amber-400 animate-pulse' : 'bg-gray-600'}`} />
                            Bridge
                        </div>
                        <button onClick={handlePing} className="text-xs px-2 py-2 rounded bg-gray-700 hover:bg-gray-600">Test</button>
                        <input value={sendHost} onChange={e => setSendHost(e.target.value)} placeholder="host"
                            className="w-28 text-xs p-2 bg-gray-900 border border-gray-700 rounded-md outline-none focus:border-blue-500" />
                        <input value={sendPort} onChange={e => setSendPort(e.target.value)} placeholder="9100" inputMode="numeric"
                            className="w-16 text-xs p-2 bg-gray-900 border border-gray-700 rounded-md outline-none focus:border-blue-500" />
                        <button onClick={sendIPL} disabled={!hasContent || sendState.busy || bridgeStatus !== 'ok'}
                            title={bridgeStatus === 'ok' ? `Send to ${sendHost}:${sendPort}` : 'Run the bridge first (Test)'}
                            className="text-xs px-3 py-2 rounded bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:cursor-not-allowed font-medium">
                            {sendState.busy ? 'Sending…' : 'Send ▶'}
                        </button>
                        <button onClick={downloadIplFile} disabled={!hasContent}
                            className="text-xs px-2 py-2 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-40">Download .ipl</button>
                        {sendState.msg && (
                            <span className={`text-xs ${sendState.ok ? 'text-emerald-400' : 'text-red-400'} max-w-md truncate`}>{sendState.msg}</span>
                        )}
                    </div>

                    <div className="flex justify-between items-center">
                        <p className="text-xs text-gray-500 max-w-xl">
                            <span className="material-icons text-[13px] align-middle mr-1 text-amber-500/80">info</span>
                            Approximate preview — fonts, barcode metrics, and spacing are estimated in the browser.
                            Confirm final output on the target printer or the Honeywell simulator
                            (docs/HONEYWELL-SIMULATOR.md); results vary by firmware and DPI.
                        </p>
                        <button onClick={handleImport} disabled={!canImport || importUnsupported}
                            title={importUnsupported
                                ? `${language.toUpperCase()} preview only — importing a design back is IPL-only, so a ${language.toUpperCase()} stream cannot be loaded onto the canvas. Use the IPL tab for that.`
                                : undefined}
                            className="bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-bold py-2 px-4 rounded transition-colors">
                            Import into Designer
                        </button>
                    </div>
                </div>
            </div >
        </div >
    );
};
