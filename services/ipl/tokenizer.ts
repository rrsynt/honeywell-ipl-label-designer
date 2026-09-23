// Splits a raw IPL stream into command frames.
//
// IPL frames are delimited by STX (0x02) and ETX (0x03). Human-authored and
// tool-generated listings frequently spell these as literal <STX>/<ETX>
// placeholders, so both notations are accepted (and mixed freely).

const LITERAL_STX = '<STX>';
const LITERAL_ETX = '<ETX>';

/** Normalize raw control characters to their literal placeholder notation. */
export function normalizeControlChars(code: string): string {
    return code
        .replace(/\x02/g, LITERAL_STX)
        .replace(/\x03/g, LITERAL_ETX);
}

/**
 * Full control-byte normalization: every control character the parsers speak
 * about in literal notation also arrives as a raw byte from BarTender
 * captures and printer traffic. Line endings are deliberately EXCLUDED: LF
 * and CR must stay whitespace so frame trimming removes them — mapping CR to
 * <CR> text would inject untrimmable literals into d3 payloads of CRLF
 * streams. parseIPL (the designer importer) runs this at entry; the viewer
 * parser handles raw bytes per-regex instead and must keep doing so (Direct
 * Graphics payloads are read byte-wise).
 */
const RAW_TO_LITERAL: { [byte: string]: string } = {
    '\x00': '<NUL>', '\x02': '<STX>', '\x03': '<ETX>', '\x0c': '<FF>',
    '\x0f': '<SI>', '\x17': '<ETB>', '\x18': '<CAN>',
    '\x1a': '<SUB>', '\x1b': '<ESC>', '\x1c': '<FS>', '\x1d': '<GS>',
    '\x1e': '<RS>', '\x1f': '<US>',
};
export function normalizeAllControlChars(code: string): string {
    return code.replace(/[\x00\x02\x03\x0c\x0f\x17\x18\x1a\x1b\x1c\x1d\x1e\x1f]/g,
        ch => RAW_TO_LITERAL[ch]);
}

/**
 * Blank every `d3,` fixed-text payload for job-command scanning. IPL treats
 * everything from `d3,` to the frame end as raw text (both parsers' greedy
 * rule), so a literal `<RS>50` or `<ESC>I9` inside fixed data is TEXT — the
 * whole-stream job regexes must not read it as a command (a design whose
 * label says "CODE <RS>50 END" would otherwise print quantity 50).
 * Print-block frames (those carrying <CAN>/\x18) are skipped: their data is
 * <ESC>F-delimited, `d3,` there is just text, and the real <RS>/<ESC>I sit
 * after it. Frames without ETX (truncated tails) are left as-is.
 */
export function maskFieldPayloads(code: string): string {
    return code.replace(/(<STX>|\x02)([\s\S]*?)(<ETX>|\x03)/g, (m, open, body, close) =>
        /<CAN>|\x18/.test(body)
            ? m
            // Keep the ';' that precedes d3, — dropping it would glue the
            // payload's removal onto the previous param ("o20,20;c25" would
            // lose the c25 font param). (?<=) avoids re-consuming it.
            : open + body.replace(/(;?)d3,[\s\S]*$/, '$1') + close);
}

/**
 * Returns the frame contents (without the STX/ETX delimiters), in order.
 * An unterminated trailing frame is returned as well; empty frames are dropped.
 */
export function tokenizeFrames(code: string): string[] {
    return tokenizeFramesWithLines(code).map(f => f.content);
}

/** A frame plus the 1-based source line its STX started on. */
export interface FrameSpan {
    content: string;
    /** 1-based line number in the ORIGINAL (un-normalized) source. */
    line: number;
}

/**
 * Like tokenizeFrames but also reports the source line each frame began on,
 * so the linter can point users at the offending line. Line numbers are
 * counted in the original text (raw control bytes and literal <STX> both
 * occupy their real positions; a normalized copy preserves offsets because
 * \x02 and <STX> are replaced 1:1 without changing newline positions... except
 * <STX> is longer, so we count newlines in the original text at the matching
 * offset). To stay correct we track newlines directly on the normalized
 * string and map back: normalization only swaps single control bytes for
 * multi-char placeholders, which never introduces or removes newlines, so the
 * count of '\n' up to a normalized offset equals the count in the original.
 */
export function tokenizeFramesWithLines(code: string): FrameSpan[] {
    const normalized = normalizeControlChars(code);
    const frames: FrameSpan[] = [];
    let pos = 0;

    // Incremental line counting: frames are discovered in ascending offset
    // order, so one forward cursor over the whole string is O(n) total.
    // (Re-scanning from 0 per frame was O(n²) — minutes on a 2 MB capture.)
    let lineCursor = 0;
    let lineNumber = 1;
    const lineAt = (offset: number): number => {
        const limit = Math.min(offset, normalized.length);
        for (; lineCursor < limit; lineCursor++) {
            if (normalized[lineCursor] === '\n') lineNumber++;
        }
        return lineNumber;
    };

    while (pos < normalized.length) {
        const start = normalized.indexOf(LITERAL_STX, pos);
        if (start < 0) break;
        const end = normalized.indexOf(LITERAL_ETX, start + LITERAL_STX.length);
        if (end < 0) {
            const tail = normalized.slice(start + LITERAL_STX.length).trim();
            if (tail) frames.push({ content: tail, line: lineAt(start) });
            break;
        }
        const content = normalized.slice(start + LITERAL_STX.length, end).trim();
        if (content) frames.push({ content, line: lineAt(start) });
        pos = end + LITERAL_ETX.length;
    }

    return frames;
}
