# IPL Rendering Specification

Mined from the extracted manuals in this directory:

- **Primary source**: `IPL_Programmers_Reference_Manual.txt` — rev 008 (06/2004), IPL firmware **2.30**. Cited as "PRM p.N" (printed page number) and "PDF PAGE N" (the `===== PAGE N =====` marker).
- **Cross-check**: `IPL_2.70_Programmers_Reference_Manual.txt` — rev 012 (12/2005), IPL firmware **2.70**. Cited as "PRM270 p.N".
- **Supplemental**: `IPL_Developers_Guide.txt` (cited as "DevGuide").

Where the two reference manuals differ, the difference is called out explicitly (see §12).

---

## Table of contents

1. [Coordinate system & canvas](#1-coordinate-system--canvas)
2. [Field Origin (`o`)](#2-field-origin-o)
3. [Field Direction (`f`) — rotation](#3-field-direction-f--rotation)
4. [Bar Code Select Type (`c` in `B` fields)](#4-bar-code-select-type-c-in-b-fields)
5. [Ratio (`r`) rules](#5-ratio-r-rules)
6. [Height (`h`) / width (`w`) magnification rules](#6-height-h--width-w-magnification-rules)
7. [Human-readable fields (`H`) and the font table](#7-human-readable-fields-h-and-the-font-table)
8. [Box fields (`W`) and Line fields (`L`)](#8-box-fields-w-and-line-fields-l)
9. [Interpretive fields (`i`, `I`) — HRI](#9-interpretive-fields-i-i--hri)
10. [UDC / graphics (`G`, `U`, `u`, `x`, `y`, `t`, `X`, `z`)](#10-udc--graphics-g-u-u-x-y-t-x-z)
11. [Data sources (`d`), print blocks, substitution, increments](#11-data-sources-d-print-blocks-substitution-increments)
12. [Label canvas config (`<SI>W`, `<SI>L`)](#12-label-canvas-config-siw-sil)
13. [Parameter defaults when omitted](#13-parameter-defaults-when-omitted)
14. [IPL 2.70 differences relevant to rendering](#14-ipl-270-differences-relevant-to-rendering)
15. [Open questions / calibration candidates](#15-open-questions--calibration-candidates)

---

## 1. Coordinate system & canvas

> PRM p.35 (PDF PAGE 51): "In Advanced Mode, a dot is 5 mil for a 200 dpi printer and
> 2.5 mil for a 400 dpi printer. For the 4X30 printers, a dot is 3.3 mil."
> PRM p.124 (PDF PAGE 140): "There are 203 dots per inch or 8 dots per millimeter"
> for standard printers; 3400e-400dpi / 3240 / 3440 = 406 dpi / 16 dots/mm;
> 4X30 = 300 dpi / 12 dots/mm.

| Printer class | DPI | Dot size | Notes |
|---|---|---|---|
| Standard (3400, 3600, 4100, 4400, PF/PF/PM/PX series) | 203 dpi ("200 dpi") | 5.0 mil | 8 dots/mm |
| High-res (3240, 3440, 3400e-400, 4440) | 406 dpi ("400 dpi") | 2.5 mil | 16 dots/mm |
| 4X30, PM4i/PX4i/PX6i (300dpi option, per PRM270 p.198) | 300 dpi | 3.3 mil | 12 dots/mm |

**Renderer implication**: a format must be rendered against a chosen dot density.
The natural choice for a browser viewer is **203 dpi / 5 mil**, with a scale factor
applied for 400-dpi formats. All coordinate values below are in *dots* unless noted.

Emulation mode doubles every dot (101 dpi / 4 dots per mm):
"If you are operating your printer in Emulation mode, the dot sizes are doubled
(101 dots per inch or 4 dots per mm)" — PRM p.35 (PDF PAGE 51).

---

## 2. Field Origin (`o`)

Exact wording (PRM p.178 / PDF PAGE 193, identical in PRM270 p.187):

> "**Field Origin, Define**
> Purpose: Defines the origin for a field. The field origin is the upper left corner
> of the field. Horizontal n and vertical m locations represent the number of dots
> from the label's origin. The origin (0,0) is the upper left square on the label.
> Syntax: `on,m`
> Default n = 0, m = 0. Range: n = 0 to 19999, m = 0 to 19999."

Key semantics:

- `(0,0)` is the **upper-left corner of the label**; +x → right, +y → down (screen-like).
- `o x,y` positions the **upper-left corner of the *unrotated* field bounding box**.
  DevGuide Ch.2: "For all types of fields, determine the print position by defining
  the coordinates of the upper left corner of the unrotated field."
- Example from PRM p.35: 0.25 in from left, 0.5 in from top at 203 dpi ⇒ `o51,102`.
- **Negative values**: never documented. Legal range is `0..19999` for both axes.
  A renderer should clamp negative values to 0. *(Flagged in §15 — some hosts do send
  negatives in the wild; behavior undocumented.)*
- Default when omitted: `o0,0`.

### Interaction of `o` with rotation `f`

This is the single most important rendering rule. PRM p.35–36 (PDF PAGE 51–52):

> "You can rotate any type of printable field in increments of 90 degrees
> counterclockwise around the field origin. To position a rotated field, you should
> keep in mind that the field origin remains on the corner where it was before you
> rotated the field. If you rotate a field 90 degrees counterclockwise, the origin
> that was at the upper left corner is now at the lower left corner."

> - "To rotate a field 90 degrees, you must position the lower left corner of the
>   rotated field.
> - To rotate a field 180 degrees, you must position the lower right corner of the
>   rotated field.
> - To rotate a field 270 degrees, you must position the upper right corner of the
>   rotated field."

Rendering algorithm: let the unrotated field bbox be size `W×H` anchored at its
top-left at `(ox, oy)`. After CCW rotation the anchor point stays fixed but changes
meaning:

| `f` | Anchor corner of final bbox | Final bbox top-left |
|---|---|---|
| 0 (0°) | top-left | `(ox, oy)` |
| 1 (90° CCW) | bottom-left | `(ox, oy − W)` |
| 2 (180°) | bottom-right | `(ox − W, oy − H)` |
| 3 (270° CCW) | top-right | `(ox − H, oy)` |

(where `W`,`H` are the *unrotated* field dimensions.)

The PRM270 illustration (PDF PAGE 53) shows text `ABCDE` drawn horizontally for `f0`
and rotated 90/180/270 CCW for `f1/f2/f3`, each growing away from the same anchor.

---

## 3. Field Direction (`f`) — rotation

Exact wording (PRM p.177 / PDF PAGE 193; PRM270 p.186):

> "**Field Direction, Define**
> Purpose: Defines the field rotation.
> Syntax: `fn`. Default n = 0.
> 0 = Horizontal
> 1 = Rotated 90° counterclockwise from horizontal
> 2 = Rotated 180° counterclockwise from horizontal
> 3 = Rotated 270° counterclockwise from horizontal"

- Rotation is **counterclockwise** (not clockwise quadrants).
- Applies to **every field type**: `H`, `B`, `L`, `W`, `U` graphics, interpretives.
- Text baseline: for `f1` text reads bottom-to-top; `f2` upside-down; `f3` top-to-bottom
  (standard CCW screen rotation; see DevGuide example "f3; Rotates field 6 by 270
  degrees counterclockwise around the field origin").
- Barcode growth direction: bars grow **perpendicular to the reading direction**,
  away from the anchor, exactly as the whole field bbox rotates per §2. There is no
  separate "bar direction" control — the entire symbology rotates as one block.
- Character-level rotation inside a human-readable field is a separate parameter
  `r` (see §7.4); combining `f` and `r` yields compound orientations
  (e.g. DevGuide: `f3` + `r1` = field 270° CCW with characters additionally 90° CCW).
- Range: `n` is a single digit 0–3. Out-of-range values follow the generic clamping
  rule (§13.3).
- Default when omitted: `f0` (horizontal).

---

## 4. Bar Code Select Type (`c` in `B` fields)

Syntax (PRM p.141 / PDF PAGE 157): `cn[,m1][,m2][,m3]` — "n is the symbology and
m1, m2, and m3 are modifiers for that symbology." Default `n = 0` (Code 39).

### 4.1 Symbology code table (both manuals agree except where noted)

| n | Symbology | Modifiers | Notes |
|---|---|---|---|
| 0 | Code 39 | `c0[,m]`, m=0–8 | see 4.2 |
| 1 | Code 93 | `c1` | no modifiers |
| 2 | Interleaved 2 of 5 | `c2[,m]`, m=0–2 | see 4.2 |
| 3 | Code 2 of 5 | `c3[,m]`, m=0/1 | 0=3-bar start/stop, 1=2-bar start/stop |
| 4 | Codabar | `c4[,m]` or `c4,1,x,y` | see 4.2 |
| 5 | Code 11 | `c5[,m]`, m=0–3 | see 4.2 |
| 6 | Code 128 | `c6[,m1][,m2][,m3]` | see 4.2 |
| 7 | UPC/EAN Codes | `c7[,m1][,m2]` | see 4.2 |
| 8 | HIBC Code 39 | `c8[,m1][,m2]` | supplier std: 0 primary, 1 alt primary, 2[,m2] secondary (m2 = linkage field id); provider std: 3 single, 4 first, 5[,m2] second, 6 multiple |
| 9 | Code 16K | `c9` | no modifiers; square symbol via h1 (Advanced) / h250 (Emulation) |
| 10 | Code 49 | `c10` | alphanumeric (0) and numeric (2) modes only; square like Code 16K |
| 11 | POSTNET | `c11` | uses `h`/`w` like a **font** magnification; base cell 13×22 dots, default mag 2×2 |
| 12 | PDF417 | `c12[,m1][,m2][,m3]` | see 4.3 |
| 14 | MaxiCode | `c14[,m1]` | fixed-size; **h/w ignored**; m1: 2 numeric postal SCM, 3 alnum postal SCM, 4 standard, 5 full EEC, 6 reader programming; hexagons 35 mil × 40 mil |
| 15 | JIS-ITF | `c15[,m]` | m=0/1/2 → narrow bar width mag 5/8/10 dots; boxed in solid black frame 4.75 mm; always includes centered interpretive (21×14 OCR-B); data length 6 (condensed)/14 (standard)/16 (extended), zero-padded up |
| 16 | HIBC Code 128 | `c16[,m1][,m2]` | same m1 pattern as HIBC Code 39 |
| 17 | Data Matrix ECC-100/ECC-200 | `c17[,m1][,m2][,m3,m4[,m5,m6]]` | defaults: m1=200 (version), m2=0 (square; 1=rectangular), m3/m4/m5/m6 structured append (pos 0–16, total 0–16, file id 1–254, 1–254) |
| 18 | QR Code | `c18[,m1][,m2][,m3]` | defaults: m1=2 (Model 2; 1=Model 1), m2=M (ECC L/M/Q/H = 7/15/25/30%), m3=8 (mask auto; else 0–7). Max 3550 chars |
| 19 | MicroPDF417 | `c19[,m1][,m2]` | m1 = data columns 0–4 (default 0 = printer chooses), m2 = data rows (default 0 = auto); only defined col×row combos legal (max 4 cols × 44 rows; e.g. 1x11 … 4x44) |
| 20 | RSS family | `c20[,m1][,m2][,m3]` | m1: 0 RSS-14, 1 RSS-14 Truncated, 2 RSS-14 Stacked, 3 RSS-14 Stacked Omni, 4 RSS Limited, 5 RSS Expanded, 6 RSS Expanded Stacked; m2 separator height (default 1); m3 segments per row 2–22 even (m1=6 only) |
| 21 | EAN.UCC Composite | `c21[,m1][,m2][,m3][,m4][,m5][,m6]` | linear+2D composite; data split linear⇢composite by `<HT>`; m1 selects version (0 UCC/EAN-128 w/ CC-C, 1 UCC/EAN-128 CC-A/B, 2 EAN-13, 3 EAN-8, 4 UPC-A, 5 UPC-E, 6–9 RSS variants, 10 RSS Limited, 11–12 RSS Expanded variants); m2 separator height 1–2×w; m3 columns/segments; m4 display space/"("/")"; m5 row height (0 = 3× magnification); m6 print linear interpretive 0/1 |
| 22 | Planet | `c22` | **2.70 / rev010+ only**, EasyCoder PF2i/PF4i/PM4i/PX4i/PX6i; fixed size, h/w ignored |

*(No code 13 exists — the table jumps 12 → 14.)*

Per-printer availability differs (PRM p.141): e.g. 3400A supports 0–11 only;
4100 standard memory 0–11; PF2i…PX6i support 0–21 (rev 008) / 0–22 incl. Planet
(rev 012). A renderer should accept all codes and degrade gracefully.

### 4.2 Check-digit / variant flags per symbology

**Code 39** (`c0[,m]`, default m=0; PRM p.142):

| m | Meaning |
|---|---|
| 0 | 8646-compatible Code 39, no check digit |
| 1 | 8646-compatible, printer enters check digit |
| 2 | 8646-compatible, host enters check digit, printer verifies |
| 3 | Full ASCII Code 39, no check digit |
| 4 | Full ASCII, printer enters check digit |
| 5 | Full ASCII, host enters check digit, verified |
| 6 | 43-character Code 39, no check digit |
| 7 | 43-character, printer enters check digit |
| 8 | 43-character, host enters check digit, verified |

"The 8646 compatible version only differs from the full ASCII version by four
characters. The '$', '%', '/', and '+' are encoded as single characters instead of
as '/D', '/E', '/O', and '/K.'" Entering `<ESC><SPACE>` as data prints the
start/stop characters visibly.

**Interleaved 2 of 5** (`c2[,m]`, default 0): 0 no check digit, 1 printer enters,
2 host enters. *"The printer adds a zero to character strings that are odd in length."*
(p.143 — renderer must reproduce this padding.)

**Codabar** (`c4[,m]`): 0 = host supplies start/stop, printer verifies;
`1,x,y` = printer inserts start code x and stop code y, each in `A–D` or `a–d`.
Start/stop sent in print data override those defined in the field. (p.143–144)

**Code 11** (`c5[,m]`): 0 printer enters 2 check digits; 1 printer enters 1;
2 host enters 2, verified; 3 host enters 1, verified. (p.144)

**Code 128** (`c6[,m1][,m2][,m3]`, all default 0):

| m1,m2 | Meaning |
|---|---|
| 0,0 | Code 128, keep parentheses and spaces |
| 0,1 | Ignore parentheses/spaces in bar code but keep them in the interpretive |
| 1,0 | UCC-128 Serial Shipping Container Code |
| 1,1 | UCC-128 SSCC, keep parentheses/spaces in interpretive |

m3 (subset control, only PF4i/PM4i fw≥2.10, requires m1=0): 0 = auto-select start
character (recommended), 1 = start subset A, 2 = subset B, 3 = subset C.

> "UCC-128 serial shipping container code automatically starts in subset C with a
> `<FNC1>`. It is a fixed length version of Code 128 requiring you to enter 19 numeric
> characters. The printer forces the first two characters to zero." (p.145)

Function characters: `<SUB><SUB>n` where n = 1–4 for FNC1–FNC4 (Advanced mode);
in-data subset switching with `<SUB><SUB>A|B|C|S`. Renderer must implement FNC1
insertion for UCC-128 and honor explicit start-subset selection.

**UPC/EAN** (`c7[,m1][,m2]`, defaults 0):

| m1 | Check digit | Flag 1 |
|---|---|---|
| 0 | printer enters | enabled |
| 1 | printer enters | disabled |
| 2 | host enters, verified | enabled |
| 3 | host enters, verified | disabled |

m2 version select: 0 variable-length (auto by char count), 1 EAN-8, 2 EAN-13,
3 UPC-A, 4 UPC-E, 5–9 UPC D1–D5.

Fixed lengths (data + check): EAN-8 7+1, EAN-13 12+1, UPC-A 11+1, UPC-E 6+1,
D1 13+1, D2 18+2, D3 22+2, D4 25+3, D5 29+3.

> "Use a '.' to delimit the bar code data from the supplemental data. Data to the
> right of the '.' is supplemental data; data to the left is bar code data." (p.146)

Flag-1 rendering rule (p.147): "For EAN 13, enabling the flag 1 option prints the
first character of the bar code interpretive. For EAN 8 and UPC version A, enabling
the flag 1 option moves the first and last character of the bar code interpretive
outside of the guard bars." UPC D1–D5 unsupported on several printers.

**PDF417** (`c12[[,m1][,m2][,m3]]`; p.148–149):

| Param | Default | Meaning |
|---|---|---|
| m1 | 0 | number of data columns 0–30; 0 = printer picks columns for near-square symbol; *"When you select zero, the printer selects a height magnification that is three times the width magnification"* |
| m2 | 9 | error correction level 0–8, or 9 = auto per data amount; levels 6–8 reserved "for special applications where the symbol is subject to damage"; levels 0/1 "not recommended" |
| m3 | 0 | truncate flag: 0 full symbol, 1 truncated (no right row indicators, one-module stop) — Intermec recommends leaving 0 |

Capacity guideline: Full ASCII 1108, Alphanumeric 1850, Numeric 2725 chars.

---

## 5. Ratio (`r`) rules

Command (PRM p.170 / PDF PAGE ~186): "**Character Rotation or Bar Code Ratio,
Define** — Purpose: Defines the character rotation for human-readable fields, or the
bar code ratio for a bar code field. Syntax: `rn`."

In bar code fields, n = ratio of wide element to narrow element. Defaults and
allowed values vary by printer family:

| n | Most printers (default n=1) | 3400C/D, 3400e, 4440-class |
|---|---|---|
| 0 | 2.5 : 1 | 2.5 : 1 |
| 1 | 3.0 : 1 (**default**) | 3.0 : 1 |
| 2 | 2.0 : 1 | 2.0 : 1 |
| 3 | — | 2.3 : 1 ("applies to Code 39 for a ratio of 7 dots to 3 dots") |

Quoted special cases:

> "If the bar code width is odd and you select r0, the printer substitutes r1."
> "The narrow elements of this code are always at least 3 dots, therefore select a
> width of w = 1 to have the shortest symbol." (3240 notes)

Symbologies with **fixed** geometry ignore `r`: MaxiCode, Planet (fixed size),
POSTNET (font-style magnification), JIS-ITF (fixed 5/8/10-dot narrow widths, true
ratio 2.4:1 at 5 dots because "the printer cannot achieve a true 2.5 to 1 ratio…
The printer uses a wide bar width of 12 dots for a true 2.4 to 1 ratio instead").

Default barcode-field ratio: **"Ratio r — 3 to 1"** (Bar Code Field Default
Parameters table, PRM270 p.171 / PDF PAGE 187).

In human-readable fields `r` means character rotation: 0 = horizontal, 1 = 90° CCW
(only values 0/1 documented for character rotation).

---

## 6. Height (`h`) / width (`w`) magnification rules

### 6.1 Semantics per field type

`h` (PRM p.187 / PDF PAGE 203): "**Height Magnification of Bar, Box, or UDC, Define**
— Purpose: Defines box, bar code, or UDC height magnification. For bar code and box
fields, define the height n in number of dots."

`w` (PRM p.201 / PDF PAGE 217): "**Width of Line, Box, Bar, or Character, Define**
— Purpose: Defines the width magnification of a line, box, bar code, or character.
You define the width of line, box, or bar code fields by the number of dots that you
specify for n. For human-readable fields, graphics and the POSTNET symbology, n is
the magnification of the character width."

So the meaning switches by field type — critical for a renderer:

| Field type | `h` means | `w` means |
|---|---|---|
| Bar code | **absolute bar height in dots** (default 50) | **narrow-element width in dots** (default 1) |
| POSTNET | vertical mag of character cell (default 2) | horizontal mag of cell (cell 13×22 dots) |
| Human-readable | vertical mag of bitmap (default 2) | horizontal mag of bitmap (default 2) |
| Box | box height in dots (default 100) | line thickness in dots (default 1) |
| Line | — | line thickness in dots (default 1) |
| Graphics/UDC | vertical mag (default 1) | horizontal mag (default 1) |

DevGuide corroboration (PRM270 Ch.3, PDF PAGE 54–55): "For bar code fields, the
height magnification is the actual dot height of the bar code. If you choose a
height magnification of h20, the height of the bar code field will be 20 dots."
…"The width magnification factor for bar code fields refers to the width of the
narrowest element of the bar code. When you specify a narrow element width of w3,
the width of the narrowest element in the symbology is 3 dots wide. The spaces and
large element widths grow according to preset ratios for each symbology."

> "Note: You can only print a bar width of 1 if you are printing in drag mode (bars
> perpendicular to the print head). If you select a width of 1 in picket mode (bars
> parallel to the print head), the printer defaults to 2." (PRM270 p.39)

A screen renderer cannot know printhead orientation; render w=1 literally (flagged §15).

### 6.2 Clamping rule (generic, applies to ALL parameters)

PRM p.45 (PDF PAGE 61), "Parameter Errors":

> "If you do not supply these parameters, the printer substitutes default values.
> If a parameter is above its maximum range limit, the printer uses the maximum value.
> If it falls below the minimum range, the printer uses the minimum value."

And specifically for `h`: "If you set n to a number that is too large, the printer
uses the highest value it can support." (PRM270 p.198)

### 6.3 Ranges (typical modern printers; PRM pp.187, 201)

| Context | Default | Range |
|---|---|---|
| h — bar code | 50 | 1–9999 |
| h — box | 100 | 1–9999 |
| h — graphics | 1 | 1–250 (some printers 999) |
| h — human-readable / POSTNET | 2 | 1–250 (some 400/999) |
| w — line/box | 1 | 1–9999 |
| w — bar code | 1 | 1–99 (newer printers; 9999 on oldest) |
| w — graphics | 1 | 1–250…999 |
| w — human-readable / POSTNET | 2 | 1–250…999 |
| l (line/box length) | 100 | 1–9999 |

RSS default heights when `h` omitted (PRM p.158, exact formulas):

> "If the bar height magnification command is not sent, the bar code will default to
> the proper height specified for the selected width:
> m1=0: h=33*w · m1=1: h=13*w · m1=2: h=7*w · m1=3: h=33*w · m1=4: h=10*w ·
> m1=5: h=33*w · m1=6: h=34*w"

---

## 7. Human-readable fields (`H`) and the font table

`Hn[,name]` creates/edits field n (0–199, default 0); name ≤ 8 ASCII chars, may not
start with a digit. (PRM p.189 / PDF PAGE 205.)

### 7.1 Default field parameters (exact table, PRM p.189 / PDF PAGE 205)

| Parameter | Syntax | Default |
|---|---|---|
| Field origin | o | 0,0 |
| Field direction | f | 0 degrees |
| Character rotation | r | 0 degrees |
| Font | c | 7 x 9 standard (= font 0) |
| Height magnification | h | 2 |
| Width magnification | w | 2 |
| Pitch | g | Disabled |
| Point | k | Disabled |
| Border | b | Disabled |
| Data origin | d | Print mode |
| Data length | | 30 |

### 7.2 Font table (`cn[,m]`, PRM p.180–181 / PDF PAGE 196–197; PRM270 adds `,o` language suffix)

`m` = intercharacter gap, range −199 to 199; "If you do not specify ,m, the printer
uses the default value of the selected font." Default font selection `n = 0`.

| n | Font | Kind |
|---|---|---|
| 0 | 7 × 9 Standard (86XX font) | bitmap |
| 1 | 7 × 11 OCR (86XX font) | bitmap (OCR-A sized) |
| 2 | 10 × 14 Standard (86XX font) | bitmap |
| 3–6 | User-defined fonts | bitmap/outline per download |
| 7 | 5 × 7 Standard (86XX font) | bitmap |
| 8–19 | User-defined fonts | |
| 20 | 8 point monospace | built-in scalable (point-named) |
| 21 | 12 point monospace | |
| 22 | 20 point monospace | |
| 23 | OCR A | |
| 24 | OCR B size 2 | |
| 25 | Swiss Mono 721 standard outline | TrueType/Speedo outline |
| 26 | Swiss Mono 721 bold outline | outline |
| 28 | Dutch Roman 801 proportional outline | outline |
| 30 | 6 point monospace bold | |
| 31 | 8 point monospace bold | |
| 32 | 10 point monospace standard | |
| 33 | 10 point monospace bold | |
| 34 | 12 point monospace bold | |
| 35 | 16 point monospace standard | |
| 36 | 16 point monospace bold | |
| 37 | 20 point monospace bold | |
| 38 | 24 point monospace standard | |
| 39 | 24 point monospace bold | |
| 40 | 30 point monospace bold | |
| 41 | 36 point monospace bold | |
| 50 | Kanji outline font | |
| 51 | Kanji monospace outline font | |
| 52 | Katakana 12 x 16 bitmap | |
| 53 | Katakana 16 x 24 bitmap | |
| 54 | Katakana 24 x 36 bitmap | |
| 55 | Kanji 16 x 16 bitmap | |
| 56 | Kanji 24 x 24 bitmap | |
| 61–70 (2.70, PF/PF/PM/PX) | Swiss 721, Swiss 721 bold, Swiss 721 bold condensed, Prestige bold, Zurich extra condensed, Dutch 801 bold, Century Schoolbook, Futura light, Letter Gothic, DingDings | outline |

Font availability varies per printer (e.g. 3400A only 0–24; 4400 only 0–25) — PRM p.180.

### 7.3 Bitmap font metrics (exact dot cells)

From the font names above plus PRM270 scaling section (PDF PAGE 54):

> "the letters in font c0 are 7 dots wide by 9 dots high, with a 1-dot gap between
> characters. If you design a field that prints 10 letters in font c0, the field will
> be 79 dots wide by 9 dots high."

| Font | Cell (W×H dots) | Default intercharacter gap |
|---|---|---|
| c0 | 7 × 9 | 1 dot |
| c1 | 7 × 11 | — |
| c2 | 10 × 14 | — |
| c7 | 5 × 7 | — |
| z default | — | 2 dots (intercharacter space baseline, DevGuide p.48: "the default spacing of 2") |

Magnification: `h`/`w` integer-multiply the cell. "Increasing the width of a text
field to 2 makes each letter in the field twice as wide." Jagged edges noted:
"When you magnify a bitmap font, the edges of the characters become jagged. If you
want to print large text characters (greater than 1 inch), use an outline font such
as c25." Renderers should draw nearest-neighbor (blocky) magnification for fidelity.

Character advance for bitmap fonts can be overridden per-font with `Zn` (font
character width, default = bitmap width − X-offset + interchar space; setting it
makes the printer ignore `z`).

### 7.4 Character rotation `r`

In `H` fields: 0 = horizontal, 1 = rotated 90° CCW relative to field direction.
(Default 0.) Only 0/1 are documented for character rotation.

### 7.5 Point size `k` (PRM p.198 / PDF PAGE 214; PRM270 p.207)

> "Purpose: Sets the point size that defines the size of the characters in
> human-readable fields. You can only use this command in Advanced mode.
> Syntax: kn. Default n = 12.
> Note: A point size equals 1/72 inch. A higher point size means larger characters."

Ranges: typically 4–288 (200 dpi printers) / 3–255 (400 dpi). "This command works
most effectively on fonts c25, c26, and c27" (older) / "on outline fonts"
(2.70) / "on fonts c20, c21, and c22" (4100/4400/4X30). Treat k as valid for
**outline/point-based fonts (20+, esp. 25/26/28)**, not for bitmap 0/1/2/7.

Conversion: pixels(dots) = k × dpi / 72 (e.g. 12 pt @203 dpi ≈ 33.8 dots em).

### 7.6 Pitch `g` (PRM p.197 / PDF PAGE 213; PRM270 p.206)

> "Purpose: Sets the pitch size that defines the size of the characters in
> human-readable fields. You can only use this command in Advanced mode. When you
> use the pitch size command, you disable the height and width magnification and
> point. Syntax: gn. Default n = 12. Values 1 to 50.
> You can use this command for both bitmap and outline fonts. Pitch is characters
> per line. The higher the pitch, the smaller the characters.
> Note: Use the pitch size command to scale outline fonts smoothly."

So `g`, when present, **overrides** h, w AND k (mutually exclusive sizing modes).
Characters-per-inch mapping: pitch 12 ≈ 12 cpl. Exact glyph height per pitch value
is not tabulated anywhere in the manuals — flagged §15.

### 7.7 Border `b` (PRM p.167–168 / PDF PAGE 183–184)

> "Purpose: Defines a border around a human-readable field. Syntax: bn.
> Default n = 0 (no borders, black letters). Range 0–199 (or 0–999 on some models).
> When n is greater than 0, field prints white letters with n dot size border around
> the field."

Important visual consequence: **b>0 produces reverse-video text** (white glyphs on a
black n-dot surround). The border box hugs the field extent; thickness = n dots.
Example in DevGuide: `b10` used on shipping-label headers.

---

## 8. Box fields (`W`) and Line fields (`L`)

### 8.1 Box field (PRM p.168–169 / PDF PAGE 184–185)

`Wn[,name]` — default n = 0, range 0–199. Parameter defaults:

| Parameter | Syntax | Default |
|---|---|---|
| Field origin | o | 0,0 |
| Field direction | f | 0 degrees |
| Box length | l | 100 |
| Box height | h | 100 |
| Box width | w | 1 |

Geometry: `l` runs along the field direction (horizontal for f0) from the origin,
`h` extends downward (f0). `w` = stroke thickness of all four sides, drawn **inside**
the l×h rectangle (thickness grows inward; the manual does not state inward/outward
explicitly — flagged §15, but examples such as `W3;o11,0;l1207;h802;w4` in the
DevGuide full-label listing behave consistently with inner strokes).

### 8.2 Line field (PRM p.192–193 / PDF PAGE 208–209)

`Ln[,name]` — defaults: o 0,0; f 0°; line length `l` 100; line width `w` 1.
Range of l: 1–9999 dots. A line extends along the field direction from the origin;
rotation `f` pivots it exactly as any other field.

Clamping: same global min/max clamp (§6.2). "The printer generates an error code
(52) for invalid lengths" applies to `l` on some commands.

---

## 9. Interpretive fields (`i`, `I`) — HRI

### 9.1 Enable/disable — `in` (PRM p.192 / PDF PAGE 208)

> "Purpose: Determines if the interpretive field of the current bar code field prints.
> Syntax: in. Default n = 0.
> 0 = Disable
> 1 = Enable with start and stop characters
> 2 = Enable without start or stop characters"

Placement rule (quoted):

> "When you enable the interpretive field, the human-readable information in the
> default font (font 0, 7 x 9 standard) prints **2 dots below the bar code field and
> is left justified**."

So default HRI placement: immediately under the barcode, left-aligned to the
barcode's left edge, 2-dot gap, font 0 at h2/w2.

Special interactions:

- JIS-ITF: "always include an interpretive field [21 x 14 OCR-B (JIS x 9001)]
  **centered beneath** the bar code field" regardless of `i` (PRM p.152).
- EAN.UCC Composite: ",m6 = 1: print the human readable interpretive field for the
  linear bar code… The human readable interpretive field for the 2D Composite
  Component is displayed if the i[n] is set to 1." (PRM p.162)
- Code 128 with m2=1 keeps parentheses/spaces only in the interpretive.
- Creating a B field "automatically create[s] an interpretive field if you have
  enabled the Interpretive parameter" (PRM270 p.171).

### 9.2 Editing — `In` (PRM p.191 / PDF PAGE 207)

> "Purpose: Edits an interpretive field. Syntax: In. Default n = 0.
> n is the field ID number of the bar code field to be interpreted."

An interpretive field has its own full parameter set (o, f, r, c, h, w, g, k, b, d)
with these defaults: origin "2 dots below bar code, left justified", f 0, r 0,
font 7×9 standard, h 2, w 2, g/k/b disabled, data from Print mode, length 30.
"You cannot create interpretive fields with this command; you can only create or
delete them when enabling the interpretive of the corresponding bar code field."
Each interpretive counts toward the 200-field limit (0–199).

Rendering: treat `I<n>` as a normal text field whose default anchor is derived from
the referenced B field's rendered bbox (left edge + 2 dots below), overridable by an
explicit `o`.

---

## 10. UDC / graphics (`G`, `U`, `u`, `x`, `y`, `t`, `X`, `z`)

Download pipeline for a graphic (Advanced mode):

1. `Gn[,name]` — "User-Defined Character, Clear or Create — Clears or creates a
   graphic bitmap" (ID 0–99). (PRM p.199 / PDF PAGE 215.)
2. `xn` — **Bitmap Cell Width**: "Defines the maximum width for a graphic or any
   character in a font… n is the number of columns for the UDC, bitmap, or
   user-defined font." Default 1 (bitmap/graphics), 10 (outline fonts);
   range 1–599…1999 depending on printer. (PRM p.166 / PDF PAGE 182.)
3. `yn` — **Bitmap Cell Height**: "Defines the height of a graphic or user-defined
   font… n is the number of rows for a graphic or font (bitmap)." Default 1 (fonts) /
   50 (graphics). (PRM270 p.172 / PDF PAGE 188; same content in rev008 Appendix refs.)
4. `un,m...m` — **Graphic or UDC, Define**: "Maps one column of bitmap for a graphic
   or a font character. n is the column to be mapped." Column numbers run within
   the cell width range (e.g. 1–799). (PRM p.186 / PDF PAGE 202.)
5. `Un[,name]` — places the graphic on the label: "User-Defined Character Field,
   Create or Edit — Edits or creates a graphic field." Defaults: o 0,0; f 0°;
   r 0°; h 1; w 1. (PRM p.199 / PDF PAGE 215.)

User-defined font characters use `Tn` (create font set, IDs 3–6/8–19), `tn`
(select next ASCII char 0–255), plus the same x/y/u commands.

### 10.1 Bit→pixel mapping

**One bit per byte** (Emulation mode; PRM App.C p.220 / PDF PAGE 236): each `m` is a
literal `'1'`/`'0'` string, one char per row of that column: "m = 1 prints, m = 0 does
not. Any unmapped columns or row elements default to m = 0."

**Six bits per byte** (Advanced mode): "each data byte m represents 6 bits of the
bitmap." Packing algorithm (DevGuide Ch.3, pp.49–52):

- Take each column top-to-bottom, group into 6-bit groups (pad last group with 0s).
- "The top digit of each group is bit 0, the bottom digit is bit 5."
- Set bit 6 to 1 (required for 7-bit transports), bit 7 to 0.
- Reverse bit order within the byte (bit 7 transmitted first) — the resulting byte is
  an ASCII character in range 0x40 ('@') to 0x7F.

Decoding rule for a renderer: for byte `c` (0x40..0x7F), bits = `((c - 0x40) reversed
7-bit)`; bit0 = topmost pixel of the 6-pixel group; groups stack top→bottom down the
column; column index from `un`. Rows beyond cell height y are ignored.

Example (DevGuide): 15×15 diamond downloaded as
`<STX>G1;x15;y15<ETX>` + `<STX>u0,@B@<ETX>` … `<STX>u14,@B@<ETX>`.

Field placement: `U` field renders the bitmap scaled by h/w magnification (defaults 1),
anchored and rotated like any field. `c n` in a U field selects the graphic ID
("Graphic, Select — cn, default 0, range 0–99", PRM p.186).

Related text-spacing commands: `Xn` (character bitmap origin offset, default 0) and
`zn` (intercharacter space, default 2, ignored when `Zn` set).

---

## 11. Data sources (`d`), print blocks, substitution, increments

### 11.1 Field Data, Define Source — `dn[,m1][,m2]` (PRM p.175–176 / PDF PAGE 191–192)

| Form | Meaning |
|---|---|
| `d0[,m1]` | "Enter optional data in Print mode" (variable). m1 = max chars. Default m1: **20 for bar code fields, 30 for human-readable fields** (64 for RFID, 2.70). |
| `d1[,m1];` | Same — "Data entered in Print mode". (d0/d1 behave identically per the printer table; both listed "0 = Data entered in Print mode, 1 = Data entered in Print mode".) |
| `d2,m1[,m2];` | "Copy data into this field from field m1" (slave field). Optional offset m2 0–9999 (default 0); offsets apply only across `<FS>`/`<GS>` delimiters. "A bar code field cannot copy data from a human-readable field, but a human-readable field can copy data from a bar code field." Up to 19 slave fields per format. |
| `d3,m1;` | "Fixed data m1 is stored as part of the format" — printed verbatim every time; not changeable via print commands. |

Defaults per printer table: bar code fields `0,20,0`; human-readable fields `0,30,0`.
Max data lengths: 3550 (most printers), 250 (4100/4400).

JIS-ITF overrides the meanings (see §4.1): lengths 6/14/16, d3,m1 where m1 picks type.

**Date/time sources d0..d4 / DATE-TIME FORMAT INDEX tables: DO NOT EXIST in either
reference manual.** Exhaustive search found no `d4`/`d5` data source, no clock/date
command, no format-index tables anywhere in PRM rev008, PRM 2.70, or the Developer's
Guide. IPL 2.x formats carry dates only as fixed data (d3) or host-supplied variable
data. (The local `IPL-CHEATSHEET.md` claim "date/time via index format" is
unsupported — flagged in §15. Date/time-indexed sources belong to other
languages/firmware generations, e.g. Fingerprint or later Honeywell firmwares.)

### 11.2 Print block structure (Print mode)

Typical sequence (examples throughout Ch.7, e.g. PRM p.114):

```
<STX><ESC>E1<CAN><ETX>            select format 1, clear old data
<STX><ESC>F0<NUL>data<ETX>        data into field 0 (<NUL> separates cmd from data)
<STX><US>1<ETX>                   batch count = 1
<STX><RS>1<ETX>                   quantity = 1 batch
<STX><ETB><ETX>                   PRINT
```

| Cmd | Name | Page | Behavior |
|---|---|---|---|
| `<ESC>E n[,m]` | Format, Select | p.101–102 | n = format id (or `*` temp-RAM on some printers); optional m=1 reimages only changed fields |
| `<CAN>` | Clear All Data | p.93 | clears host-entered data of current format/page; field pointer → first data entry field. Commonly combined: `<ESC>E1<CAN>` |
| `<DEL>` | Clear Data From Current Field | p.93 | deletes current field's data only (used inline before data: `<ESC>F0<DEL>text`) |
| `<ESC>F n` / `<ESC>F"name"` | Field, Select | p.97 | routes following data into field n (number or quoted name); **must be separated from data by `<NUL>`**: `<ESC>F4<NUL> data` |
| `<CR>` | Next Data Entry Field, Select | p.106 | advances field pointer (wraps to first) |
| `<ACK>` | First Data Entry Field, Select | p.99 | pointer to lowest-numbered data-entry field |
| `<FS>` | Numeric Field Separator | p.106 | `<FS>digits<FS>` marks region for numeric inc/dec (odometer, 9→0); non-numerics ignored; multiple non-overlapping regions allowed |
| `<GS>` | Alphanumeric Field Separator | p.92 | `<GS>data<GS>` region; alphabet = 0–9,A–Z odometer (Z→A); non-alphanumerics ignored |
| `<ESC>In` | Field Increment, Set | p.99 | n 1–9999, default 1; applied to `<FS>`/`<GS>` regions "after it prints each batch" |
| `<ESC>Dn` | Field Decrement, Set | p.98 | n 0–9999, default 1; same trigger |
| `<ESC>N` | Increment and Decrement, Disable | p.104 | resets inc/dec flags for current field |
| `<US>n` | Batch Count, Set | p.93 | copies per batch; 1–9999, default 1. Total labels = batches × copies |
| `<RS>n` | Quantity Count, Set | p.110 | number of **batches**; 1–9999, default none/1. "Data increments or decrements between batches of labels" |
| `<ETB>` | Print | p.109 | prints current page/format with entered data |
| `<FF>` | Form Feed | p.101 | feeds one blank label to next print point (no printing) |

Semantics for a renderer/simulator: `<RS>q<ETB>` prints q batches, each containing
`<US>c` copies; inc/dec values advance **once per batch** (after each batch), not per
copy. Error 21 = qty/batch out of range; error 22 = inc/dec out of range.

Mode switching: `<STX><ESC>P<ETX>` enter Program mode (loses entered data);
`<STX>R<ETX>` exit to Print mode saving the edited format. In Program mode each
message needs `<STX>…<ETX>`, semicolon terminators between commands, and
parentheses/`<LF>` are ignored.

---

## 12. Label canvas config (`<SI>W`, `<SI>L`)

These are immediate (configuration) commands, effective outside Program mode.

### `<SI>Wn` — Label Width, Set (PRM p.125 / PDF PAGE 141)

> "Sets the label width to n in dot increments… Calculations for all printers
> (except the 4440 printer) use a 5 mil dot."
> Defaults: 4400 n=896, 4440 n=672(6.5mil head), 44X0 4420=896 / 4440=1792,
> 7421 n=832. Ranges: 50–896 typical; 100–1792 for 4440 (2.5 mil dot).

Defines the printable width of the canvas; "effective upon execution".

### `<SI>L n` — Maximum Label Length, Set (PRM p.126 / PDF PAGE 142)

> "where n specifies the maximum label length in 5 mil increments."
> Default n = 1000 (1200 on F4/PF/PF/PM/PX). Range 100–4800 (200–4800 for 4400/4X30).
> "The printer uses this number for detecting media faults. **It does not use this
> number to limit the image size of a format on the label.**"

Renderer implication: `<SI>L` should **not** clip the drawing area — it is media
handling metadata only. Canvas height should be derived from the fields themselves
(or a UI-set label size), while `<SI>W` legitimately bounds width. Related stock
config: `<SI>T n` (0 continuous / 1 gap / 2 mark), `<SI>F n` margin/feed adjust
(default 20, range −10…4000 in 5-mil steps — note **negative values allowed here**:
"The negative values for n let you decrease the margin and print closer to the edge
of the label").

---

## 13. Parameter defaults when omitted

### 13.1 Per-field-type default parameter sets (exact manual tables)

**Human-readable field H** (PRM p.189): o 0,0 · f 0° · r 0° · c font 0 (7×9) ·
h 2 · w 2 · g disabled · k disabled · b disabled · d Print-mode · length 30.

**Bar code field B** (PRM270 p.171 / PDF PAGE 187; identical list implied rev008):
o 0,0 · f 0° · c Code 39 (check digits disabled, no prefix) · data length 20 ·
r 3:1 · i disabled · h 50 · w 1.

**Line field L** (PRM p.193): o 0,0 · f 0° · l 100 · w 1.

**Box field W** (PRM p.169): o 0,0 · f 0° · l 100 · h 100 · w 1.

**Graphic/UDC field U** (PRM p.199): o 0,0 · f 0° · r 0° · h 1 · w 1.

**Interpretive field I** (PRM p.191): o "2 dots below bar code, left justified" ·
f 0° · r 0° · c font 0 · h 2 · w 2 · g/k/b disabled · length 30.

### 13.2 Standalone command defaults

`f`=0 · `r`=0 (H) / 1 (B ratio 3:1) · `o`=0,0 · `h` per type (§6.1) · `w` per type ·
`l`=100 · `b`=0 · `g`=12 · `k`=12 · `i`=0 · `c`=0 everywhere · `x`=1 (bitmap)/10
(outline) · `y`=1 (fonts)/50 (graphics) · `z`=2 · `X`=0 · `Zn` = computed advance ·
`<US>`=1 · `<ESC>I`=1 · `<ESC>D`=1 · `d`=`0,20`(B)/`0,30`(H) · `<ESC>E`=format 0 ·
`<ESC>F`=field 0.

### 13.3 Clamping

All numeric params: below minimum → minimum; above maximum → maximum; missing →
default (PRM p.45 quote in §6.2). Syntax errors are *not* rejected — "the printer…
attempts to execute the commands… the printer produces output, even if it is wrong"
(PRM p.44). A faithful emulator should likewise best-effort render malformed input.

---

## 14. IPL 2.70 differences relevant to rendering

Comparing PRM rev012 (fw 2.70) against rev008 (fw 2.30):

1. **Planet symbology `c22` added** (rev 010, IPL 2.50) — supported only on
   EasyCoder PF2i/PF4i/PM4i/PX4i/PX6i; "linear bar code similar to the POSTNET bar
   code… prints at a fixed size so any height and width commands are ignored."
2. **PC41 printer** added to printer tables (rev 009); behaves like 7421 ranges.
3. **RFID commands** (`a` RFID Tag Field Setup, RFID Tag Write Field, Tag Protect —
   rev 011/012). No effect on visual layout except new default d length (64 for RFID
   fields) and `Q` tag-field syntax; irrelevant to on-screen rendering.
4. **Extended character sets for fonts c25, c26, c28** (fw 2.70 change list).
5. **Slash Zero `<SI>z`** existed already in rev007/008 (p.138) — unchanged.
6. **Font Type Select gains third parameter**: rev008 `cn[,m]`; rev012
   `cn[,m][,o]` where o = language for the field (defaults to `<SI>l` setting on
   PF/PF/PM/PX). Affects glyph repertoire, not layout math.
7. **New fonts 61–70** (Swiss 721 family etc.) available on PF2i/PF4i/PM4i/PX4i/PX6i.
8. Page-number shifts only otherwise; command semantics for o/f/h/w/c/r/d/i/b/l/W/L
   are identical between revisions — rendering logic need not branch on firmware
   version except for `c22` availability and fonts 61–70.

---

## 15. Open questions / calibration candidates

Items the manuals do **not** pin down; each needs empirical calibration against a
real printer output or reference renders:

1. ~~**Date/time field sources d0–d4 and DATE/TIME FORMAT INDEX tables**~~ —
   **RESOLVED 2026-09-25.** They do not exist (PRM p.184 defines only d0–d3), so
   the generator now bakes the value as `d3` at generate time, the viewer warns
   `unknown-data-source`, and the importer still migrates old streams.
   `tests/dateTimeBaking.test.ts`.
2. ~~**Box stroke direction (inward vs outward)**~~ — **RESOLVED 2026-09-25,
   inward, already correct.** Measured on `samples/bartender-tes1.ipl`'s
   `W3;o13,14;h770;l492;w3` against its export: outer ink 769×493 for a declared
   770×492, and the opening 763×486 = `l−2w` by `h−2w`. Centred would read
   495×773 and outward 498×776. Pinned by `tests/strokeAndPicket.test.ts`.
3. ~~**w=1 barcodes in picket vs drag mode**~~ — **RESOLVED 2026-09-25; it IS
   decidable, so no toggle.** Field direction decides it: measured, f0/f2 draw
   vertically barred symbols (bars along the feed = drag, keep w1) and f1/f3
   horizontally barred ones (bars across the web = picket, promote w1 to 2).
   Pinned by `tests/strokeAndPicket.test.ts`.
4. ~~**Pitch `g` glyph metric table**~~ — **RESOLVED 2026-09-25, by using the
   quantity the manual does define.** No height per pitch is tabulated, but `gn`
   IS defined as "n characters per line", so the advance is `labelWidth / n`
   and the cell keeps the font's own aspect. Pitch replaces h/w/k, exactly as
   the manual states. `tests/pitch.test.ts`.
5. ~~**Outline font advance widths**~~ — **RESOLVED (Batch U, 2026-09-24).** The
   0.6 em guess is gone: `services/ipl/fontMetrics.ts` carries per-glyph advance
   tables measured from the vendored Liberation faces, so the proportional
   families (c28 Dutch Roman → serif, c61 Swiss → sans) measure within ~0.3% of
   `measureText` and monospace stays byte-stable. `tests/fontMetrics.test.ts`.
6. ~~**Interpretive gap of "2 dots"**~~ — **RESOLVED 2026-09-25: it is the field
   box, not the last bar row.** The manual says "2 dots below bar code" (PRM
   p.191), and the bar code field's declared height is the box the printer knows.
   BarTender never emits `i1`/`i2` anyway — it places HRI as a separate `H` field
   with explicit coordinates — so there is no reference render to contradict the
   text. Anchored at `host.oy + host.heightDots + 2`; `tests/originAndHri.test.ts`.
7. ~~**Negative origins**~~ — **RESOLVED 2026-09-25: passed through, not clamped.**
   BarTender's own `edges` sweep places boxes at −0.4in and its preview keeps the
   ink running to pixel 0 on three sides — the fields stay where the host put them
   and the label edge cuts them. Sliding them inward would print ink the host never
   asked for, so the viewer now says "not clamped" instead of claiming a clamp.
   `tests/originAndHri.test.ts`.
8. ~~**`r` character rotation limited to 0/1**~~ — **RESOLVED 2026-09-25.** The
   manual documents only 0 and 1 for text fields and prints nothing for 2/3, so
   anything above 1 warns and falls back to horizontal rather than inventing a
   180/270 reading the printer may not share. `tests/charRotation.test.ts`.
9. **Composite `c21` separator-pattern rendering** (m2) — described only as "height
   of the separator pattern row"; exact module pattern must come from the GS1
   Composite spec, not this manual.
10. **PDF417 auto aspect (m1=0)** — "height magnification three times the width
    magnification" gives the row/module ratio but the printer's exact column choice
    algorithm is unpublished; near-square heuristic recommended.
