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
}

/**
 * The single-letter IDs. The manual's own note: "Other bar codes without a
 * human-readable counterpart include u (MaxiCode) and z (PDF417)", and Postnet
 * (`p`) likewise — for those the lowercase letter is the only valid form.
 */
export const DPL_BARCODES: Record<string, DplBarcodeType> = {
    A: { symbology: '0', name: 'Code 39' },
    B: { symbology: '7', name: 'UPC-A' },
    C: { symbology: '7', name: 'UPC-E' },
    D: { symbology: '2', name: 'Interleaved 2 of 5' },
    E: { symbology: '6', name: 'Code 128' },
    F: { symbology: '7', name: 'EAN-13' },
    G: { symbology: '7', name: 'EAN-8' },
    H: { symbology: '8', name: 'HIBC' },
    I: { symbology: '4', name: 'Codabar' },
    J: { symbology: '2', name: 'Interleaved 2 of 5, mod-10' },
    K: { symbology: '1', name: 'Plessey' },
    L: { symbology: '2', name: 'Interleaved 2 of 5, mod-10 + bearer bars' },
    M: { symbology: '7', name: '2-digit UPC addendum' },
    N: { symbology: '7', name: '5-digit UPC addendum' },
    O: { symbology: '1', name: 'Code 93' },
    P: { symbology: '11', name: 'Postnet', noHumanReadable: true },
    Q: { symbology: '6', name: 'UCC/EAN Code 128' },
    R: { symbology: '6', name: 'UCC/EAN Code 128 K-Mart' },
    S: { symbology: '6', name: 'UCC/EAN Code 128 Random Weight' },
    T: { symbology: '21', name: 'Telepen' },
    U: { symbology: '14', name: 'UPS MaxiCode', noHumanReadable: true },
    V: { symbology: '21', name: 'FIM', noHumanReadable: true },
    Z: { symbology: '12', name: 'PDF417', noHumanReadable: true },
};

/**
 * The two-character `Wxx` expansion IDs (manual p. 133: "Value W requires two
 * additional characters to specify the Bar Code/Font ID").
 */
export const DPL_W_BARCODES: Record<string, DplBarcodeType> = {
    W1C: { symbology: '17', name: 'DataMatrix' },
    W1D: { symbology: '18', name: 'QR Code' },
    W1F: { symbology: '23', name: 'Aztec' },
    W1Z: { symbology: '12', name: 'PDF417' },
};

/**
 * Resolves a DPL `b` field into its symbology, its human-readable flag, and
 * the letters consumed — two for the `Wxx` form, one otherwise.
 */
export const dplBarcodeFor = (
    b: string,
): { type: DplBarcodeType; hri: 0 | 1; consumed: number } | null => {
    if (b.length === 0) return null;
    if (b[0].toUpperCase() === 'W') {
        const key = b.slice(0, 3).toUpperCase();
        const type = DPL_W_BARCODES[key];
        if (!type) return null;
        // W1C is the upper-case (human-readable) form, W1c the lower.
        const upper = b[2] === b[2].toUpperCase() && b[2] !== b[2].toLowerCase();
        return { type, hri: upper && !type.noHumanReadable ? 1 : 0, consumed: 3 };
    }
    const letter = b[0];
    const type = DPL_BARCODES[letter.toUpperCase()];
    if (!type) return null;
    const isUpper = letter === letter.toUpperCase() && letter !== letter.toLowerCase();
    return { type, hri: isUpper && !type.noHumanReadable ? 1 : 0, consumed: 1 };
};
