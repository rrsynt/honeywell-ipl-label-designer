// IPL command reference for the viewer's click-to-help panel.
// Sourced from docs/manuals/IPL-RENDER-SPEC.md (which cites the official
// Programmer's Reference Manual page numbers). Keyed so the UI can look up
// help for whatever token sits under the cursor.

export interface CommandHelp {
    /** Canonical token, e.g. "H", "o", "<ESC>P". */
    token: string;
    title: string;
    /** Field-level command (H/B/L/W/U/I) or parameter (o/f/c…) or control frame. */
    kind: 'field' | 'param' | 'control' | 'setup';
    syntax: string;
    /** Short human explanation. */
    summary: string;
    /** Optional manual page reference. */
    page?: string;
}

export const COMMAND_HELP: CommandHelp[] = [
    // --- Field creators ---
    { token: 'H', kind: 'field', title: 'Human-readable field', syntax: 'Hn[,name]',
      summary: 'Creates/edits text field n (0–199). Defaults: font 0 (7×9), h2, w2, origin 0,0.', page: 'PRM p.189' },
    { token: 'B', kind: 'field', title: 'Bar code field', syntax: 'Bn[,name]',
      summary: 'Creates/edits bar code field n. Defaults: Code 39, h50, w1, ratio 3:1, interpretive off.', page: 'PRM p.163' },
    { token: 'L', kind: 'field', title: 'Line field', syntax: 'Ln[,name]',
      summary: 'Creates/edits a line. Defaults: length 100, thickness (w) 1, origin 0,0.', page: 'PRM p.193' },
    { token: 'W', kind: 'field', title: 'Box field', syntax: 'Wn[,name]',
      summary: 'Creates/edits a box. Defaults: length 100, height 100, thickness (w) 1.', page: 'PRM p.168' },
    { token: 'U', kind: 'field', title: 'User-defined character / graphic field', syntax: 'Un[,name]',
      summary: 'Places a downloaded graphic (defined with G/u). Defaults: h1, w1.', page: 'PRM p.199' },
    { token: 'I', kind: 'field', title: 'Interpretive field', syntax: 'In',
      summary: 'Edits the human-readable interpretive of bar code n. Auto-anchored 2 dots below the barcode, left justified.', page: 'PRM p.191' },
    { token: 'G', kind: 'field', title: 'Define graphic', syntax: 'Gn[,name]',
      summary: 'Clears/creates graphic bitmap n (0–99), filled by u column data.', page: 'PRM p.199' },
    { token: 'D', kind: 'field', title: 'Delete field', syntax: 'Dn',
      summary: 'Deletes field n from the current format. The last field cannot be deleted.', page: 'PRM p.174' },

    // --- Field parameters ---
    { token: 'o', kind: 'param', title: 'Field origin', syntax: 'on,m',
      summary: 'Upper-left corner of the UNROTATED field, in dots from the label origin (0,0 = top-left).', page: 'PRM p.177' },
    { token: 'f', kind: 'param', title: 'Field direction', syntax: 'fn',
      summary: 'Rotation, counter-clockwise: 0=0°, 1=90°, 2=180°, 3=270°.', page: 'PRM p.177' },
    { token: 'c', kind: 'param', title: 'Font / bar code type', syntax: 'cn[,m…]',
      summary: 'In H fields: font id (0=7×9, 25=Swiss outline…). In B fields: symbology — 0 Code 39, 1 Code 93, 2 I2of5, 3 Code 2 of 5, 4 Codabar, 5 Code 11, 6 Code 128, 7 UPC/EAN, 8/16 HIBC, 9 Code 16K, 10 Code 49, 11 POSTNET, 12 PDF417, 14 MaxiCode, 17 Data Matrix, 18 QR, 19 MicroPDF417, 20 RSS/DataBar, 22 Planet.', page: 'PRM p.141 / p.180' },
    { token: 'h', kind: 'param', title: 'Height magnification', syntax: 'hn',
      summary: 'Bar code / box: absolute height in dots. Text / POSTNET / graphics: vertical magnification factor.', page: 'PRM p.187' },
    { token: 'w', kind: 'param', title: 'Width', syntax: 'wn',
      summary: 'Bar code: narrow-element width in dots. Line/box: border line thickness (the manual calls this "Line width"/"Box width", default 1 dot — the shape extent is l×h, not w). Text/graphics: horizontal magnification.', page: 'PRM p.193 / p.169' },
    { token: 'r', kind: 'param', title: 'Rotation / ratio', syntax: 'rn',
      summary: 'H fields: character rotation (0=horizontal, 1=90° CCW). B fields: wide:narrow ratio (0=2.5:1, 1=3:1, 2=2:1).', page: 'PRM p.170' },
    { token: 'd', kind: 'param', title: 'Field data source', syntax: 'dn[,m…]',
      summary: 'd0/d1 = variable (entered at print time), d2,m1[,m2] = copy from field m1 (m2 = FS/GS element offset), d3,text = fixed data.', page: 'PRM p.175' },
    { token: 'g', kind: 'param', title: 'Pitch size', syntax: 'gn',
      summary: 'Characters-per-line sizing (1–50). Overrides h/w and k. Advanced mode only.', page: 'PRM p.197' },
    { token: 'k', kind: 'param', title: 'Point size', syntax: 'kn',
      summary: 'Outline-font size in points (1 pt = 1/72"). Best on fonts 20+ (esp. 25/26/28).', page: 'PRM p.198' },
    { token: 'i', kind: 'param', title: 'Interpretive enable', syntax: 'in',
      summary: '0=off (default), 1=on with start/stop chars, 2=on without them. HRI in font 0, 2 dots below the bar code.', page: 'PRM p.192' },
    { token: 'b', kind: 'param', title: 'Border', syntax: 'bn',
      summary: '0=no border (black letters). n>0 = white letters on an n-dot black surround (reverse video).', page: 'PRM p.167' },
    { token: 'l', kind: 'param', title: 'Length', syntax: 'ln',
      summary: 'Length of a line or box field in dots (1–9999).', page: 'PRM p.192' },
    { token: 'u', kind: 'param', title: 'Graphic column data', syntax: 'un,m…m',
      summary: 'Maps one bitmap column n. In Emulation mode m is a string of 1/0; in Advanced mode each byte carries 6 bits.', page: 'PRM p.186' },

    // --- Control / print-block frames ---
    { token: '<ESC>P', kind: 'control', title: 'Enter Program mode', syntax: '<STX><ESC>P<ETX>',
      summary: 'Switches to Program mode where formats and fields are defined. Entered data is cleared.', page: 'PRM p.109' },
    { token: 'R', kind: 'control', title: 'Exit Program mode', syntax: '<STX>R<ETX>',
      summary: 'Saves the format being edited and returns to Print mode.', page: 'PRM p.199' },
    { token: '<ESC>C', kind: 'control', title: 'Select Advanced mode', syntax: '<STX><ESC>C<ETX>',
      summary: 'Selects Advanced (native) command mode. Often carries inline <SI> setup, e.g. <ESC>C<SI>W812.', page: 'PRM p.91' },
    { token: '<ESC>E', kind: 'control', title: 'Select format', syntax: '<STX><ESC>En[,m]<ETX>',
      summary: 'Selects format n for printing/data entry. Begins the print block.', page: 'PRM p.101' },
    { token: '<ESC>F', kind: 'control', title: 'Select field for data', syntax: '<STX><ESC>Fn<NUL>data<ETX>',
      summary: 'Routes the following data into field n (separate command from data with <NUL>).', page: 'PRM p.97' },
    { token: '<CAN>', kind: 'control', title: 'Clear all data', syntax: '<CAN>',
      summary: 'Clears host-entered data of the current format; usually right after <ESC>E (e.g. <ESC>E1<CAN>).', page: 'PRM p.93' },
    { token: '<ESC>I', kind: 'control', title: 'Field increment', syntax: '<ESC>In',
      summary: 'Increments <FS>/<GS>-delimited data by n after each printed batch (odometer).', page: 'PRM p.99' },
    { token: '<ESC>D', kind: 'control', title: 'Field decrement', syntax: '<ESC>Dn',
      summary: 'Decrements <FS>/<GS>-delimited data by n after each printed batch.', page: 'PRM p.98' },
    { token: '<US>', kind: 'control', title: 'Batch count', syntax: '<US>n',
      summary: 'Copies per batch (1–9999). Total labels = batches × copies.', page: 'PRM p.93' },
    { token: '<RS>', kind: 'control', title: 'Quantity count', syntax: '<RS>n',
      summary: 'Number of batches to print (1–9999). Inc/dec advances between batches.', page: 'PRM p.110' },
    { token: '<ETB>', kind: 'control', title: 'Print', syntax: '<ETB>',
      summary: 'Prints the current format with the entered data.', page: 'PRM p.109' },
    { token: '<FF>', kind: 'control', title: 'Form feed', syntax: '<FF>',
      summary: 'Feeds one blank label to the next print point (no printing).', page: 'PRM p.101' },

    // --- <SI> setup / label config ---
    { token: '<SI>W', kind: 'setup', title: 'Label width', syntax: '<SI>Wn',
      summary: 'Sets the label width across the printhead, in dots.', page: 'PRM p.125' },
    { token: '<SI>L', kind: 'setup', title: 'Maximum label length', syntax: '<SI>Ln',
      summary: 'Sets the maximum label length in dots (media-fault detection, not image clipping).', page: 'PRM p.126' },
    { token: '<SI>S', kind: 'setup', title: 'Print speed', syntax: '<SI>Sn',
      summary: 'Sets print speed. Does not affect on-screen rendering.', page: 'PRM p.132' },
    { token: '<SI>d', kind: 'setup', title: 'Dark adjust', syntax: '<SI>dn',
      summary: 'Sets darkness. Does not affect on-screen rendering.', page: 'PRM p.118' },
    { token: '<SI>T', kind: 'setup', title: 'Label stock type', syntax: '<SI>Tn',
      summary: 'Selects media sense mode (gap / reflective / continuous).', page: 'PRM p.125' },
    { token: '<SI>g', kind: 'setup', title: 'Media sensitivity', syntax: '<SI>gn[,m]',
      summary: 'Selects direct-thermal vs thermal-transfer stock and sensitivity.', page: 'PRM p.127' },
    // These three change the printed image and are NOT reproduced by this
    // preview; the parser warns when one is present (setup-not-modelled).
    { token: '<SI>X', kind: 'setup', title: 'Label origin X-Y adjust', syntax: '<SI>X[m1][,m2]',
      summary: 'Moves the imaged position on the media (m1 = x, m2 = y, in dots). Not reproduced by this preview.',
      page: 'K10 937-028-003 (absent from PRM rev 008)' },
    { token: '<SI>F', kind: 'setup', title: 'Top of form', syntax: '<SI>Fn',
      summary: 'Sets the start print point in 5-mil increments (default 20). Not reproduced by this preview.',
      page: 'PRM p.139' },
    { token: '<SI>h', kind: 'setup', title: 'Printhead loading mode', syntax: '<SI>hn[,m]',
      summary: 'n=1 mirror printing, m=1 inverse printing — "affects how the whole image prints". Not reproduced by this preview.',
      page: 'PRM p.135' },
];

const HELP_BY_TOKEN = new Map(COMMAND_HELP.map(h => [h.token, h]));

/**
 * Finds the STX/ETX (or literal) frame that contains a caret offset in the full
 * document, returning the frame body and the caret's offset within it. Accepts
 * both raw control bytes and <STX>/<ETX> placeholder notation.
 */
export const frameAtCaret = (code: string, caret: number): { frame: string; offsetInFrame: number } | null => {
    // Walk frames tracking original-text offsets. STX = \x02 or "<STX>".
    const isStx = (i: number) => code[i] === '\x02' || code.startsWith('<STX>', i);
    const isEtx = (i: number) => code[i] === '\x03' || code.startsWith('<ETX>', i);
    const stxLen = (i: number) => (code[i] === '\x02' ? 1 : 5);
    const etxLen = (i: number) => (code[i] === '\x03' ? 1 : 5);

    let i = 0;
    while (i < code.length) {
        if (!isStx(i)) { i++; continue; }
        const bodyStart = i + stxLen(i);
        let j = bodyStart;
        while (j < code.length && !isEtx(j)) j++;
        const bodyEnd = j; // exclusive
        if (caret >= bodyStart && caret <= bodyEnd) {
            return { frame: code.slice(bodyStart, bodyEnd), offsetInFrame: caret - bodyStart };
        }
        i = j < code.length ? j + etxLen(j) : code.length;
    }
    return null;
};

/**
 * Given a raw frame body (STX/ETX stripped) and a caret offset within the full
 * document, returns the most relevant command help. Resolution order:
 *   1. Control/setup frames matched by prefix (<ESC>x, <SI>x, <CAN>, R…).
 *   2. Field creator letter at frame start (H/B/L/W/U/I/G/D).
 *   3. Single parameter key under the caret (o/f/c/h/w/r/d/g/k/i/b/l/u).
 */
export const lookupHelpForFrame = (frame: string, caretInFrame: number): CommandHelp | null => {
    // Control/setup frames.
    if (frame.startsWith('<ESC>')) {
        const cmd = `<ESC>${frame.charAt(5)}`;
        if (HELP_BY_TOKEN.has(cmd)) return HELP_BY_TOKEN.get(cmd)!;
    }
    const siMatch = frame.match(/^<SI>([A-Za-z])/);
    if (siMatch && HELP_BY_TOKEN.has(`<SI>${siMatch[1]}`)) return HELP_BY_TOKEN.get(`<SI>${siMatch[1]}`)!;
    for (const t of ['<CAN>', '<US>', '<RS>', '<ETB>', '<FF>']) {
        if (frame.includes(t)) return HELP_BY_TOKEN.get(t)!;
    }
    if (frame === 'R') return HELP_BY_TOKEN.get('R')!;

    // Field creator letter.
    const fieldMatch = frame.match(/^([HBLWUIGD])\d*/);
    // Parameter under the caret: parameters are ';'-separated, key = first char.
    if (caretInFrame >= 0 && caretInFrame <= frame.length) {
        let segStart = frame.lastIndexOf(';', Math.max(0, caretInFrame - 1)) + 1;
        // Skip the field header (e.g. "H0") when the caret is inside the first segment.
        if (segStart === 0 && fieldMatch) segStart = fieldMatch[0].length;
        const key = frame.charAt(segStart);
        if (HELP_BY_TOKEN.has(key) && HELP_BY_TOKEN.get(key)!.kind === 'param') {
            return HELP_BY_TOKEN.get(key)!;
        }
    }
    if (fieldMatch && HELP_BY_TOKEN.has(fieldMatch[1])) return HELP_BY_TOKEN.get(fieldMatch[1])!;
    return null;
};
