// VirtualPrinter — the explicit two-phase state machine behind the IPL parser
// (Labelize's model, ROADMAP Fase 1). Every piece of mutable parse state lives
// HERE, not scattered across the parser class: label-level settings, format
// capture buckets, seen-field bookkeeping, Direct Graphics mode, and the
// downloaded graphics store. The parser reads frames and calls intent-named
// operations on this object; commit-time invariants (e.g. "last definition
// wins" must reach every store) are enforced in ONE place.
//
// This is deliberately a dumb store with verbs — no frame parsing here. That
// keeps it testable without the tokenizer and makes the parser's remaining job
// purely translation from frames to operations.

import type { ViewerElement, ViewerIssue, ViewerLabel } from './types';
import type { DirectGraphic } from './directGraphics';

export interface DownloadedGraphic {
    name?: string;
    widthDots: number;
    heightDots: number;
    data: string[];
}

/** IPL command-letter per element kind (H/B/L/W/U) — field-directory keys. */
export const KIND_PREFIX: Record<ViewerElement['kind'], string> = {
    text: 'H',
    barcode: 'B',
    line: 'L',
    box: 'W',
    graphic: 'U',
    unknown: '?',
};

/**
 * One printer job's worth of mutable state. A fresh instance is constructed
 * per parse() call, so nothing leaks across labels (the IPL <ESC>E "clear
 * stored format" semantics are handled by re-opening a format, not by reuse).
 */
export class VirtualPrinter {
    readonly label: ViewerLabel = {
        widthDots: null,
        heightDots: null,
        elements: [],
        issues: [],
        settings: {},
    };

    /** In-format flag: field commands only count inside E#;F#...R. */
    inFormat = false;
    /** Program mode (<ESC>P) seen — formats before it are a warning condition. */
    programModeSeen = false;
    /** `K<id>` field keys already defined, for duplicate detection. */
    readonly seenFieldKeys = new Set<string>();
    /** Graphics downloaded via <ESC>G (id -> columns), referenced by U fields. */
    readonly downloadedGraphics = new Map<number, DownloadedGraphic>();
    /** Id of the most recently defined graphic (for split u-frame form). */
    lastGraphicId: number | null = null;
    /** u-index base (0 vs 1) detected from the first strip of the current graphic. */
    graphicColumnBase: 0 | 1 = 1;
    /** Source line of the frame currently being parsed, for issue reporting. */
    currentLine: number | undefined = undefined;

    /** Direct Graphics Mode state (PRM Appendix E).
     *  0 = `<ESC>g0` raw 8-bit payloads, 1 = `<ESC>g1` nibblized ASCII hex,
     *  null = mode not entered. */
    directGraphicsMode: 0 | 1 | null = null;
    directGraphicsFrames: string[] = [];
    /**
     * Decoded DG graphics awaiting placement. Their origins are measured from
     * the label's BOTTOM edge, so placement needs the final label height —
     * which may only be known after the whole stream is parsed.
     */
    pendingDirectGraphics: DirectGraphic[] = [];

    /**
     * Elements captured per format id (E#;F# opens one). A page (S frame)
     * composes these; without a page, format elements flow straight into
     * label.elements as before.
     */
    readonly formats = new Map<number, ViewerElement[]>();
    /** Format id currently capturing field definitions. */
    activeFormatId = 0;

    // -- label level ------------------------------------------------------

    issue(level: ViewerIssue['level'], code: string, message: string, command?: string): void {
        this.label.issues.push({ level, code, message, command, line: this.currentLine });
    }

    hasIssue(code: string): boolean {
        return this.label.issues.some(i => i.code === code);
    }

    // -- format / element capture ------------------------------------------

    /** Opens a format bucket and makes it the capture target. */
    openFormat(formatId: number): void {
        this.inFormat = true;
        this.activeFormatId = formatId;
        if (!this.formats.has(formatId)) this.formats.set(formatId, []);
    }

    /** Closes the current format (R frame). */
    closeFormat(): void {
        this.inFormat = false;
    }

    /**
     * Commits a parsed field element: into the active format's bucket AND the
     * label's live element list. Both stores hold the SAME object until page
     * composition replaces label.elements from the buckets.
     */
    commitElement(el: ViewerElement): void {
        const bucket = this.formats.get(this.activeFormatId);
        if (bucket) bucket.push(el);
        this.label.elements.push(el);
    }

    /**
     * "Last definition wins" for a duplicate field id, scoped to the ACTIVE
     * format (field ids are per-format: H0 in format 1 and H0 in format 2 are
     * different fields). Removes the stale element from the active bucket and,
     * by object identity, from the live list — so other formats' same-id
     * elements survive both stores.
     */
    evictField(matches: (el: ViewerElement) => boolean): void {
        const bucket = this.formats.get(this.activeFormatId);
        if (!bucket) return;
        // Identity set (not includes()) so the live-list filter stays O(n) and
        // compares by reference unambiguously.
        const doomed = new Set(bucket.filter(matches));
        if (doomed.size === 0) return;
        this.formats.set(this.activeFormatId, bucket.filter(el => !doomed.has(el)));
        this.label.elements = this.label.elements.filter(el => !doomed.has(el));
    }

    /**
     * <ESC>Dn / Dn frame: delete field n from the open format. Clears the
     * element from every store AND its duplicate-detection key, so redefining
     * the id afterwards is not a false duplicate (PRM p.174).
     */
    deleteField(id: number): void {
        const bucket = this.formats.get(this.activeFormatId);
        if (!bucket) return;
        const doomed = new Set(bucket.filter(e => e.id === id));
        if (doomed.size === 0) return;
        this.formats.set(this.activeFormatId, bucket.filter(e => e.id !== id));
        this.label.elements = this.label.elements.filter(e => !doomed.has(e));
        for (const el of doomed) {
            this.seenFieldKeys.delete(`${this.activeFormatId}:${KIND_PREFIX[el.kind]}${el.id}`);
        }
    }

    /** The duplicate-detection key for a field in a given format. */
    static fieldKey(formatId: number, kindChar: string, id: number): string {
        return `${formatId}:${kindChar}${id}`;
    }

    /** The bucket that defined `el`, found by identity (pre-composition only). */
    bucketOf(el: ViewerElement): ViewerElement[] | undefined {
        for (const bucket of this.formats.values()) {
            if (bucket.includes(el)) return bucket;
        }
        return undefined;
    }

    /**
     * Format an element was defined in, by identity — 0 when it predates any
     * open format (live list only). Print-block data is scoped by this.
     */
    formatIdOf(el: ViewerElement): number {
        for (const [id, bucket] of this.formats) {
            if (bucket.includes(el)) return id;
        }
        return 0;
    }

    /**
     * Closest element satisfying `pred` BEFORE `beforeIndex` within `bucket`
     * (pass bucket.length to search the whole thing). This is IPL's field
     * directory semantics: lookups are per-format and backwards.
     */
    findPrecedingIn(
        bucket: ViewerElement[] | undefined,
        beforeIndex: number,
        pred: (el: ViewerElement) => boolean,
    ): ViewerElement | undefined {
        if (!bucket) return undefined;
        for (let i = Math.min(beforeIndex, bucket.length) - 1; i >= 0; i--) {
            if (pred(bucket[i])) return bucket[i];
        }
        return undefined;
    }
}
