// DPL bar code IDs, from the Datamax *Class Series Programmer's Manual*
// (88-2316-01 Rev H, Appendix F Table F-1 and Appendix G), cross-checked
// against the Honeywell *DPL Command Reference for Fiji Platform Printers*
// (which lists B/b UPC-A, D/d I2of5, E/e Code 128, F/f EAN-13, G/g EAN-8).
//
// THE SHIFTED TABLE — this is the finding that made the manual necessary:
//
// The one secondary source in the repo (nokka_dpl.py) lists
//   A=Code39 B=UPC-A C=UPC-E D=I2of5 E=Code128 F=EAN-13 G=EAN-8 ...
// but BOTH official manuals say
//   A=Code39 B=UPC-A C=UPC-E D=I2of5 E=Code128 F=EAN-13 G=EAN-8 ...
// with the SAME letters meaning the SAME symbologies from A to B, and then
// diverging: the manual's C is UPC-E where the source has EAN-13, and every
// letter from C onwards is shifted by one in the source.
//
// A label built from the secondary table would print the wrong symbology on
// every bar code from C up, silently. This is exactly the failure EPL and TSPL
// each proved once already, which is why the project refused to build DPL
// until an authoritative manual was available.
//
// Case is the human-readable flag: "Values A through T (uppercase) will print
// bar codes with human-readable interpretations. Values a through z (lowercase)
// will print bar codes only" (manual p. 133). The IR carries that as `hri`
// rather than as a second table, so this maps case-insensitively and reports
// the case separately.

export interface DplBarcodeType {
    /** The IR's symbology id (see services/ipl/barcodes.ts). */
    symbology: string;
    name: string;
    /** True when the lower-case form is NOT valid (no human-readable form). */
    lowerOnly?: boolean;
    /** True when the UPPER-case form is not valid either. */
    noHumanReadable?: boolean;
    /**
     * Which member of the EAN/UPC family this letter draws, as the IR's
     * `eanUpcVersion` (see services/ipl/barcodes.ts).
     *
     * The LETTER is the variant, and without saying so the encoder has to guess
     * it from the digit count — which it does by stripping every non-digit and
     * counting, so the manual's own 11-digit UPC-A record ("If the user provides
     * 11 digits, the printer will compute the checksum") resolved to nothing at
     * all, and a 12-digit payload under `F` drew a UPC-A while claiming to be an
     * EAN-13. B/C/F/G are four different symbols sharing one symbology id.
     *
     * M and N are the 2- and 5-digit addenda, which are symbols in their own
     * right rather than members of that family; bwip-js encodes them as `ean2`
     * and `ean5`.
     */
    eanVariant?: number;
    /** A standalone EAN/UPC add-on, encoded as its own symbol. */
    addon?: 'ean2' | 'ean5';
    /**
     * True when this type's human-readable line prints ABOVE the symbol rather
     * than below.
     *
     * Appendix G says so in words for Q, R, S, M and N ("Human readable
     * characters for this barcode symbology are printed above the symbol"), and
     * the manual's own figures show it: the M sample prints "42" over the
     * bars, the N sample "01234" over them, while L's control figure sits its
     * text underneath. The uppercase letter alone says only that a line is
     * printed; for these five it is not below, which is what the IR's hri 0/1/2
     * has to carry.
     */
    hriAbove?: boolean;
    /**
     * Set when bwip-js has no encoder for this symbol at all, so the record
     * cannot be drawn by any path. The parser names it instead of emitting an
     * element that paints nothing — a symbol dropped without a word is the one
     * failure this project exists to prevent.
     */
    noEncoder?: string;
}

/**
 * The single-letter IDs. The manual's own note: "Other bar codes without a
 * human-readable counterpart include u (MaxiCode) and z (PDF417)", and Postnet
 * (`p`) likewise — for those the lowercase letter is the only valid form.
 */
export const DPL_BARCODES: Record<string, DplBarcodeType> = {
    A: { symbology: '0', name: 'Code 39' },
    // The EAN/UPC family all share the IR's symbology '7'; the variant is what
    // tells them apart (see eanVariant above).
    B: { symbology: '7', name: 'UPC-A', eanVariant: 3 },
    C: { symbology: '7', name: 'UPC-E', eanVariant: 4 },
    D: { symbology: '2', name: 'Interleaved 2 of 5' },
    E: { symbology: '6', name: 'Code 128' },
    F: { symbology: '7', name: 'EAN-13', eanVariant: 2 },
    G: { symbology: '7', name: 'EAN-8', eanVariant: 1 },
    H: { symbology: '8', name: 'HIBC' },
    I: { symbology: '4', name: 'Codabar' },
    J: { symbology: '2', name: 'Interleaved 2 of 5, mod-10' },
    // K is PLESSEY, and '1' is Code 93 — a different symbol entirely, so a
    // Plessey record drew a Code 93 bar code with nothing said. Table F-1
    // lists K as "Plessey" and O as "Code 93"; they were never the same symbol.
    //
    // It goes to id 27 (bwip `msi`), NOT 28 (`plessey`): this appendix marks K
    // "48-57 Numeric only", while bwip's `plessey` is Plessey UK and takes hex.
    // The manual's Plessey is the MSI family, as EPL spells out in
    // "Plessey (MSI-1)".
    K: { symbology: '27', name: 'Plessey' },
    L: { symbology: '2', name: 'Interleaved 2 of 5, mod-10 + bearer bars' },
    // M and N are the addenda THEMSELVES, not a main symbol: the id is 25/26,
    // and giving them '7' made the encoder ask for an EAN/UPC with no version,
    // which draws nothing at all.
    M: { symbology: '25', name: '2-digit UPC addendum', addon: 'ean2', hriAbove: true },
    N: { symbology: '26', name: '5-digit UPC addendum', addon: 'ean5', hriAbove: true },
    O: { symbology: '1', name: 'Code 93' },
    P: { symbology: '11', name: 'Postnet', noHumanReadable: true },
    Q: { symbology: '6', name: 'UCC/EAN Code 128', hriAbove: true },
    R: { symbology: '6', name: 'UCC/EAN Code 128 K-Mart', hriAbove: true },
    S: { symbology: '6', name: 'UCC/EAN Code 128 Random Weight', hriAbove: true },
    // '21' is the IR's EAN.UCC Composite id — a different family, and one whose
    // encoder needs a linear component the record does not carry, so a Telepen
    // record resolved to no spec and drew nothing. 31 is the Telepen encoder.
    T: { symbology: '31', name: 'Telepen' },
    U: { symbology: '14', name: 'UPS MaxiCode', noHumanReadable: true },
    // '21' is the composite id, which needs a linear component this record does
    // not carry — the same mis-mapping T had. Unlike T there is no encoder to
    // point at: bwip-js ships none for FIM, so the record is NAMED instead.
    V: { symbology: '21', name: 'FIM', noHumanReadable: true, noEncoder: 'FIM' },
    Z: { symbology: '12', name: 'PDF417', noHumanReadable: true },
};

/**
 * Appendix I Table I-1: the single-byte code pages, by their Datamax identifier.
 *
 * Scalable fonts "are mapped through a symbol set sometimes referred to as a
 * `code page`", and the mapping decides what every byte prints: "in the code
 * page (CP), character code 0xE4 causes Φ to be printed. In CP E7, the
 * character code 0xE4 causes δ."
 *
 * Read from the RENDERED page. The table's identifier column and its description
 * column extract as separate text runs with no shared coordinate, so pairing
 * them from the text alone would have been a guess — and the first attempt at
 * exactly that mispaired every row in the lower half. The rendered page and the
 * text runs then agreed row for row, which is what makes this table safe to ship.
 */
export const DPL_CODE_PAGE_IDS: Record<string, string> = {
    AR: 'Arabic-8', CP: 'PC Cyrillic',
    D1: 'ITC Zapf Dingbats/100', D2: 'ITC Zapf Dingbats/200', D3: 'ITC Zapf Dingbats/300',
    DN: 'ISO 60 Danish / Norwegian', DS: 'PS ITC Zapf Dingbats', DT: 'DeskTop',
    E1: 'ISO 8859/1 Latin 1', E2: 'ISO 8859/2 Latin 2', E5: 'ISO 8859/9 Latin 5',
    E6: 'ISO 8859/10 Latin 6', E7: 'ISO 8859/7 Latin/Greek', E9: 'ISO 8859/15 Latin 9',
    EG: 'ISO 8859/7 Latin/Greek', EH: 'ISO 8859/8 Latin/Hebrew',
    ER: 'ISO 8859/5 Latin/Cyrillic', FR: 'ISO 69: French',
    G8: 'Greek-8', GK: 'PC-8 Greek', GR: 'ISO 21: German',
    H0: 'Hebrew-7', H8: 'Hebrew-8', IT: 'ISO 15: Italian',
    'L$': 'HP4000 ITC Zapf Dingbats', LG: 'Legal',
    M8: 'Math-8', MC: 'Macintosh', MS: 'PS Math',
    P9: 'PC-858 Multilingual', PB: 'Microsoft Publishing', PC: 'PC-8, Code Page 437',
    PD: 'PC-8 D/N, Code Page 437N', PE: 'PC-852 Latin 2', PG: 'PC-851 Latin/Greek',
    PH: 'PC-862 Latin/Hebrew', PI: 'Pi Font', PM: 'PC-850 Multilingual',
    PR: 'PC-864 Latin/Arabic', PT: 'PC-8 TK, Code Page 437T', PU: 'PC-1004',
    PV: 'PC-775 Baltic', PX: 'PTXT3000', PY: 'Non-UGL, Generic Pi Font',
    R8: 'Roman-8', R9: 'Roman-9', SP: 'ISO 17: Spanish', SW: 'ISO 11: Swedish',
    SY: 'Symbol', TK: 'Turkish-8', TS: 'PS Text', UK: 'ISO 4: United Kingdom',
    US: 'ISO 6: ASCII', VI: 'Ventura International', VM: 'Ventura Math',
    VU: 'Ventura US', W1: 'Windows 3.1 Latin 1', WA: 'Windows Latin/Arabic',
    WD: 'Wingdings', WE: 'Windows 3.1 Latin 2', WG: 'Windows Latin/Greek',
    WI: 'Windows 3.1 Baltic (Latv, Lith)', WN: 'Windows', WO: 'Windows 3.0 Latin 1',
    WR: 'Windows Latin/Cyrillic', WT: 'Windows 3.1 Latin 5',
};

/**
 * Appendix I Table I-2: the DOUBLE-BYTE character maps, selected by a different
 * command from the single-byte pages — `<STX>yUxx` against `<STX>ySxx` — which
 * the manual notes "affects an independent database selection and has no impact
 * on the other".
 */
export const DPL_CHAR_MAP_IDS: Record<string, string> = {
    B5: 'BIG 5 (Taiwan) Encoded', EU: 'EUC (Extended UNIX Code)',
    GB: 'Government Bureau Industry Standard; Chinese (PRC)',
    JS: 'JIS (Japanese Industry Standard)', SJ: 'Shift JIS',
    UC: 'Unicode (including Korean)',
};

/**
 * The two-character `Wxx` expansion IDs (manual p. 133: "Value W requires two
 * additional characters to specify the Bar Code/Font ID").
 */
export const DPL_W_BARCODES: Record<string, DplBarcodeType> = {
    W1C: { symbology: '17', name: 'DataMatrix', noHumanReadable: true },
    W1D: { symbology: '18', name: 'QR Code', noHumanReadable: true },
    W1F: { symbology: '23', name: 'Aztec', noHumanReadable: true },
    // W1z / W1Z is MicroPDF417 — NOT the single-letter `z`/`Z`, which is
    // PDF417 (Table 8-4: "z PDF417", "Z PDF417 w/ Byte Count", "W1z
    // MicroPDF417", "W1Z MicroPDF417 w/ Byte Count"). Mapping W1Z to PDF417
    // made a MicroPDF417 stream read back as the wrong symbol, and made the
    // generator export a PDF417 design as a MicroPDF417 one.
    W1Z: { symbology: '19', name: 'MicroPDF417', noHumanReadable: true },
};

/**
 * A parsed W1D (manual-format) QR data prefix: `[q,] [e [m] i,] cdata...`
 * (Fiji Command Reference pp. 220-221). q = model 1|2, e = H|Q|M|L
 * error-correction, m = 0-8|none mask, i = A|a|M|m input mode, then the data
 * starting with its mode letter N|A|B|K. Every group is optional; a record
 * carrying none of them is bare data, not a broken prefix.
 */
export interface DplQrManual {
    qrModel?: string;
    qrEcl?: string;
    qrMask?: string;
    /** Input mode letter as written (A|a|M|m). Hex modes (a|m) are NAMED by
     *  the caller: the bytes are left undecoded. */
    inputMode?: string;
    /** The data with the prefix (and the mode letter) stripped. */
    data: string;
    /** Set when the record LOOKS prefixed but no group parses — the caller
     *  keeps the data whole and warns instead of guessing. */
    unparsed?: boolean;
}

export const parseQrManualPrefix = (data: string): DplQrManual | null => {
    // No comma before the first mode letter means no prefix at all: plain
    // data, including data that merely starts with a digit or a mode letter.
    // A Bnnnn byte-count without a preceding format group is the same case —
    // B is also a data-mode letter, and splitting it would eat real data.
    const comma = data.indexOf(',');
    if (comma < 0) return null;
    const head = data.slice(0, comma);
    const rest = data.slice(comma + 1);
    // q alone: "2,..." — but a bare number is also plausible data, so only
    // treat it as a model when what follows parses as the rest of a prefix.
    const qMatch = /^([12])$/.exec(head.trim());
    let qrModel: string | undefined;
    let afterQ = data;
    if (qMatch) {
        qrModel = qMatch[1];
        afterQ = rest;
    }
    // e[m]i group, two spellings: solid ("M2A," — the manual's spaces are
    // readability fiction) or comma-separated ("M,2,A," / "M,A,"), because
    // `[e [m] i,]` does not say where the commas fall and both read
    // naturally. ECL, optional mask, input mode.
    const tail = qrModel !== undefined ? afterQ : data;
    const group = /^([HQML])(\d)?([AaMm]),(.*)$/s.exec(tail)
        ?? /^([HQML]),(?:(\d),)?([AaMm]),(.*)$/s.exec(tail);
    if (!group) {
        // A leading "q," with nothing after it is still a claim of manual
        // format — keep the data whole and say the prefix did not parse. So
        // is any short head before the first comma (1-2 alphanumerics): a
        // real attempt at q/e that matches neither spelling. Longer heads are
        // ordinary data that happens to contain a comma ("HELLO, WORLD") and
        // stay silent — warning there would cry wolf on every such label.
        if (qrModel !== undefined || /^[A-Za-z0-9]{1,2}$/.test(head.trim())) {
            return { ...(qrModel !== undefined ? { qrModel } : {}), data, unparsed: true };
        }
        return null;
    }
    const [, ecl, mask, inputMode, payload] = group;
    // The data starts with its mode letter N|A|B|K; strip exactly one.
    const modeMatch = /^([NABK])(.*)$/s.exec(payload);
    const cleanData = modeMatch ? modeMatch[2] : payload;
    return {
        ...(qrModel !== undefined ? { qrModel } : {}),
        qrEcl: ecl,
        ...(mask !== undefined ? { qrMask: mask } : {}),
        inputMode,
        data: cleanData,
    };
};

/**
 * Resolves a DPL `b` field into its symbology, its human-readable flag, and
 * the letters consumed — two for the `Wxx` form, one otherwise.
 */
export const dplBarcodeFor = (
    b: string,
): { type: DplBarcodeType; hri: 0 | 1; consumed: number; manual: boolean } | null => {
    if (b.length === 0) return null;
    if (b[0].toUpperCase() === 'W') {
        const key = b.slice(0, 3).toUpperCase();
        const type = DPL_W_BARCODES[key];
        if (!type) return null;
        // For the `Wxx` ids the case is NOT the human-readable flag — it picks
        // a FORMAT VARIANT (Table 8-4): W1d QR = Auto format, W1D QR = Manual
        // format; W1c DataMatrix plain, W1C "w/ Byte Count"; W1f Aztec plain,
        // W1F with a byte count. None of these 2D symbols prints a human-
        // readable line at all, so no `Wxx` form carries HRI. The manual flag
        // matters only for QR: a W1D import used to normalise silently to auto.
        const manual = b.slice(0, 3) === 'W1D';
        return { type, hri: 0, consumed: 3, manual };
    }
    const letter = b[0];
    const type = DPL_BARCODES[letter.toUpperCase()];
    if (!type) return null;
    const isUpper = letter === letter.toUpperCase() && letter !== letter.toLowerCase();
    return { type, hri: isUpper && !type.noHumanReadable ? 1 : 0, consumed: 1, manual: false };
};

export interface DplMicroPdfEntry {
    hi: string;
    cols: number;
    rows: number;
    iChar: string;
    maxBin: number;
    maxAlpha: number;
    maxNum: number;
}

/**
 * Appendix G Table G-7: MicroPDF417 Characteristics Index (manual p. 133 / 143).
 * Lists all 34 valid symbol configurations (columns x rows), their selection
 * indices (h, i), and maximum data capacity.
 */
export const DPL_MICRO_PDF_TABLE: readonly DplMicroPdfEntry[] = [
    { hi: '10', cols: 1, rows: 11, iChar: '0', maxBin: 3, maxAlpha: 6, maxNum: 8 },
    { hi: '11', cols: 1, rows: 14, iChar: '1', maxBin: 7, maxAlpha: 12, maxNum: 17 },
    { hi: '12', cols: 1, rows: 17, iChar: '2', maxBin: 10, maxAlpha: 18, maxNum: 26 },
    { hi: '13', cols: 1, rows: 20, iChar: '3', maxBin: 13, maxAlpha: 22, maxNum: 32 },
    { hi: '14', cols: 1, rows: 24, iChar: '4', maxBin: 18, maxAlpha: 30, maxNum: 44 },
    { hi: '15', cols: 1, rows: 28, iChar: '5', maxBin: 22, maxAlpha: 38, maxNum: 55 },
    { hi: '20', cols: 2, rows: 8, iChar: '0', maxBin: 8, maxAlpha: 14, maxNum: 20 },
    { hi: '21', cols: 2, rows: 11, iChar: '1', maxBin: 14, maxAlpha: 24, maxNum: 35 },
    { hi: '22', cols: 2, rows: 14, iChar: '2', maxBin: 21, maxAlpha: 36, maxNum: 52 },
    { hi: '23', cols: 2, rows: 17, iChar: '3', maxBin: 27, maxAlpha: 46, maxNum: 67 },
    { hi: '24', cols: 2, rows: 20, iChar: '4', maxBin: 33, maxAlpha: 56, maxNum: 82 },
    { hi: '25', cols: 2, rows: 23, iChar: '5', maxBin: 38, maxAlpha: 67, maxNum: 93 },
    { hi: '26', cols: 2, rows: 26, iChar: '6', maxBin: 43, maxAlpha: 72, maxNum: 105 },
    { hi: '30', cols: 3, rows: 6, iChar: '0', maxBin: 6, maxAlpha: 10, maxNum: 14 },
    { hi: '31', cols: 3, rows: 8, iChar: '1', maxBin: 10, maxAlpha: 18, maxNum: 26 },
    { hi: '32', cols: 3, rows: 10, iChar: '2', maxBin: 15, maxAlpha: 26, maxNum: 38 },
    { hi: '33', cols: 3, rows: 12, iChar: '3', maxBin: 20, maxAlpha: 34, maxNum: 49 },
    { hi: '34', cols: 3, rows: 15, iChar: '4', maxBin: 27, maxAlpha: 46, maxNum: 67 },
    { hi: '35', cols: 3, rows: 20, iChar: '5', maxBin: 39, maxAlpha: 66, maxNum: 96 },
    { hi: '36', cols: 3, rows: 26, iChar: '6', maxBin: 54, maxAlpha: 90, maxNum: 132 },
    { hi: '37', cols: 3, rows: 32, iChar: '7', maxBin: 68, maxAlpha: 114, maxNum: 167 },
    { hi: '38', cols: 3, rows: 38, iChar: '8', maxBin: 82, maxAlpha: 138, maxNum: 202 },
    { hi: '39', cols: 3, rows: 44, iChar: '9', maxBin: 97, maxAlpha: 162, maxNum: 237 },
    { hi: '40', cols: 4, rows: 4, iChar: '0', maxBin: 8, maxAlpha: 14, maxNum: 20 },
    { hi: '41', cols: 4, rows: 6, iChar: '1', maxBin: 13, maxAlpha: 22, maxNum: 32 },
    { hi: '42', cols: 4, rows: 8, iChar: '2', maxBin: 20, maxAlpha: 34, maxNum: 49 },
    { hi: '43', cols: 4, rows: 10, iChar: '3', maxBin: 27, maxAlpha: 46, maxNum: 67 },
    { hi: '44', cols: 4, rows: 12, iChar: '4', maxBin: 34, maxAlpha: 58, maxNum: 85 },
    { hi: '45', cols: 4, rows: 15, iChar: '5', maxBin: 45, maxAlpha: 76, maxNum: 111 },
    { hi: '46', cols: 4, rows: 20, iChar: '6', maxBin: 63, maxAlpha: 106, maxNum: 155 },
    { hi: '47', cols: 4, rows: 26, iChar: '7', maxBin: 85, maxAlpha: 142, maxNum: 208 },
    { hi: '48', cols: 4, rows: 32, iChar: '8', maxBin: 106, maxAlpha: 178, maxNum: 261 },
    { hi: '49', cols: 4, rows: 38, iChar: '9', maxBin: 128, maxAlpha: 214, maxNum: 313 },
    { hi: '4A', cols: 4, rows: 44, iChar: 'A', maxBin: 150, maxAlpha: 250, maxNum: 366 },
];

export const dplMicroPdfParams = (
    field: { name?: string; microColumns?: number; microRows?: number },
    data: string,
): { h: string; i: string; warning?: string } => {
    const isNum = /^\d+$/.test(data);
    const isAlpha = /^[ -~]*$/.test(data);
    const cap = (e: DplMicroPdfEntry) => isNum ? e.maxNum : isAlpha ? e.maxAlpha : e.maxBin;
    const len = isNum || isAlpha ? data.length : new TextEncoder().encode(data).length;

    const cols = field.microColumns;
    const rows = field.microRows;

    let warning: string | undefined;

    // Both specified: validate combination against Table G-7
    if (cols !== undefined && cols > 0 && rows !== undefined && rows > 0) {
        const exact = DPL_MICRO_PDF_TABLE.find(e => e.cols === cols && e.rows === rows);
        if (exact) {
            if (len > cap(exact)) {
                warning = `"${field.name}": data length (${len}) exceeds maximum capacity (${cap(exact)}) for MicroPDF417 ${cols}x${rows}.`;
            }
            return { h: String(exact.cols), i: exact.iChar, ...(warning ? { warning } : {}) };
        }
        warning = `"${field.name}": MicroPDF417 size ${cols}x${rows} is not in Table G-7; defaulted to automatic sizing.`;
    }

    // MicroColumns specified (1-4)
    if (cols !== undefined && cols >= 1 && cols <= 4) {
        const candidates = DPL_MICRO_PDF_TABLE.filter(e => e.cols === cols && cap(e) >= len);
        if (candidates.length > 0) {
            const chosen = candidates[0];
            return { h: String(chosen.cols), i: chosen.iChar, ...(warning ? { warning } : {}) };
        }
        const maxForCol = DPL_MICRO_PDF_TABLE.filter(e => e.cols === cols).pop()!;
        return {
            h: String(maxForCol.cols),
            i: maxForCol.iChar,
            warning: warning ?? `"${field.name}": data length (${len}) exceeds maximum capacity for ${cols} column(s).`,
        };
    }

    if (cols !== undefined && (cols < 0 || cols > 4)) {
        warning = `"${field.name}" asks for ${cols} MicroPDF417 data columns, which is outside the printer's 1-4 range. Defaulted to automatic sizing.`;
    }

    // Auto-select smallest symbol in table that can fit the data
    const fit = DPL_MICRO_PDF_TABLE.find(e => cap(e) >= len);
    if (fit) {
        return { h: String(fit.cols), i: fit.iChar, ...(warning ? { warning } : {}) };
    }

    const largest = DPL_MICRO_PDF_TABLE[DPL_MICRO_PDF_TABLE.length - 1];
    return {
        h: String(largest.cols),
        i: largest.iChar,
        warning: warning ?? `"${field.name}": data length (${len}) exceeds maximum MicroPDF417 capacity (366 numeric / 250 alphanumeric).`,
    };
};
