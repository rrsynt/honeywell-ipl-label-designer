export const validateBarcode = (data: string, symbology: string): string | null => {
    if (!data) return 'Data cannot be empty.';
    switch (symbology) {
        case '0': if (!/^[A-Z0-9-.$/+% ]*$/.test(data)) return 'Code 39 data contains invalid characters.'; return null;
        case '1': return null; // Code 93 supports full ASCII, no strict validation needed
        case '2': if (!/^\d*$/.test(data)) return 'Interleaved 2 of 5 requires numeric data.'; return null;
        case '3': if (!/^\d*$/.test(data)) return 'Code 2 of 5 requires numeric data.'; return null;
        case '4': if (!/^[0-9-$:/.+A-D]*$/.test(data)) return 'Codabar data contains invalid characters.'; if (!/^[A-D]/.test(data) || !/[A-D]$/.test(data)) return 'Codabar must start and end with A, B, C, or D.'; return null;
        case '5': if (!/^[0-9-]*$/.test(data)) return 'Code 11 supports only digits (0-9) and hyphen (-).'; return null;
        case '7': if (!/^\d+$/.test(data)) return 'EAN/UPC requires numeric data.'; return null;
        case '6': case '9': case '10': case '12': case '14': case '16': case '17': case '18': case '19': case '20': case '21': return null; // 2D/GS1/HIBC symbologies, skipping regex validation.
        case '11': if (!/^\d*$/.test(data)) return 'POSTNET requires numeric data.'; return null;
        case '22': if (!/^\d*$/.test(data)) return 'Planet requires numeric data.'; return null;
        case '8': if (!/^[+A-Z0-9.\-/ $%]*$/.test(data)) return 'HIBC Code 39 data contains invalid characters.'; return null;
        default: return null; // Unknown symbology ids (e.g. BarTender variants) — don't hard-fail rendering.
    }
};