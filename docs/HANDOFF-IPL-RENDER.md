# Handoff — IPL render vs BarTender export (tes1 / tes2)

Status as of 2026-09-20. Written for a fresh session: read this before touching the
renderer, because the obvious next step ("make the render match the export") is built
on a false premise that wasted a previous session.

---

## 1. Which files are actually BarTender exports

This is the thing that misled the last session. Two files in `testdata/` are **our own
older render output**, not BarTender exports:

| File | What it really is |
|---|---|
| `testdata/bartender-tes1-render.png` (1598×1038) | our own old render |
| `testdata/tes1-portrait.png` (1038×1598) | our own old render |

Proof is by exact pixel color, not by eye:

- `169,171,247` appears in both, and equals our canvas hairline border
  `rgba(99,102,241,0.55)` composited on white. The canvas perimeter is
  2×(1598+1038) = 5272 px; the file has 5202 such pixels. The golden PNGs in
  `testdata/golden/` contain this color too (2420 px in `product.png`) — it is
  our border, nothing else.
- `226,153,68` appears **only** in these old renders and never in a golden. It is
  our placeholder orange `#d97706` — i.e. in those renders, **elements that failed
  to render** were drawn as orange dashed placeholder boxes, not as content.

So the previous session's "the export is clipped and near-empty, our geometry is
correct" conclusion was measuring our own failed output.

The **real** exports were recovered from base64 image blocks the user had pasted into
an earlier transcript (the message read *"pastikan hasil tes1 dan tes2 seperti ini,
ini dari ekspor image bartender"*). They are now saved:

- `testdata/bartender-tes1-export.png` — 798×518
- `testdata/bartender-tes2-export.png`

**Diff against the `*-export.png` files. Never against `*-render.png` / `tes1-portrait.png`.**

## 2. The real problem: the whole label is rotated 90° (RESOLVED 2026-09-19, then REVISED same day)

`testdata/bartender-tes1-export.png` is 798×518 px for an 801-dot label
(`<SI>W801`) ⇒ **0.996 px/dot, essentially 1:1**.

The format's box is `<STX>W3;f0;o13,14;h770;l492;w3<ETX>`. Measured in the export:

- frame outer box is **769 px wide × 493 px tall**, top-left at (15, 13)

An earlier session read this as "`h` and `l` are transposed in BarTender". That was
wrong. A full re-measurement (2026-09-19) proved the **manual semantics are intact**
and the entire label is simply rotated 90° clockwise in the export:

| Element (stream) | Manual-correct render (f3 = CCW field rot, l=horiz/h=vert) | Export position |
|---|---|---|
| `W3` box `o13,14;h770;l492` | 492 wide × 770 tall at (13,14) | **769×493 at (15,13)** = that same box rotated 90° CW (w/h swap is the rotation) |
| `B6` Code93 `h102;w3` (length ≈321) | vertical, x 287–320, y 232–553 | **horizontal, x 140–460, y 230–331** ✓ exact CW image |
| `B8` EAN-13 `h76;w3` (length ≈201) | vertical, x 143–176, y 252–453 | **horizontal, x 241–441, y 374–455** ✓ exact CW image |
| `B1` Code128 `h66;w9` (length ≈576) | vertical, x 488–581, y 40–616 | **horizontal, x 108–683, y 418–491** ✓ exact CW image |
| `B22` QR `o165,82` | upper-left area | **lower-left** ✓ CW image |

So: **do NOT transpose box/line `l`/`h`.** Our renderer already follows the manual
(DevGuide `W27;l1150;h775` on a 1150-wide label is the dispositive reference).

### The Direct Graphics catch

The three `<ESC>g0` RLE payloads (arrow, "Sample Text" arcs, dashed line) decode and
place **exactly** on the export WITHOUT any page rotation (arrow covers 88% of the
export's arrow at its non-rotated position). PRM Appendix E: RLE columns are
print-head columns, origin (0,0) = **lower-left**, data loads in reverse Y — our
`directGraphics.ts` transform is manual-correct. Conclusion: **BarTender pre-rotates
its vector art inside the RLE payload**, so the raster content lands upright in the
export while the IPL vector fields land rotated. A global page rotation applied to
everything would break the RLE match.

### Where the rotation comes from — NOT in the stream

Both tes1 and tes2 exports are rotated, yet the streams contain **no** rotation
source: no `q` (Format Direction in a Page), no `S` (Page Create), no `M`/`m`/`O`
(page placement), no `Tn` (field template). The only commands are
`<ESC>C <SI>W801`, `<ESC>P`, `E2;F2`, fields, `D0`, `R`, `<SI>l13` (code page 1252),
`<ESC>E2,1<CAN>` (`,1` = reimage-changed-fields only, PRM p.106).

⇒ The 90° is **BarTender's page-setup rotation for the stock** (label defined
801 dots wide × ~784 long; printed on 100×65 mm landscape), applied outside the IPL
stream. A real printer fed this exact stream would produce our portrait render.

### Options (decision pending with user)

1. **Do nothing to the renderer** (it is manual-faithful); optionally add a *manual
   page-rotation feature* (`q`/page `S` support) so users can preview a rotated page
   — note it must be applied to vector fields only if we also want RLE payloads to
   stay as-is, which is exactly what BarTender's own path does (pre-rotated art).
2. Add a testdata-only comparison tool: rotate our render 90° CW and diff vs
   `bartender-tes1-export.png` (excluding DG regions) to lock in the geometry proof.
3. Do NOT auto-rotate when `<ESC>E n,1` / `<SI>l13` is seen — those are not rotation
   commands (verified in PRM), and auto-rotating would break manual-correct streams.

### Revision after the rotation-preview feature (2026-09-19, later session)

Option 1 was built: the viewer has a **Rotate** control (auto / 0° / 90↺ / 180 / 90↻;
`RenderOptions.rotation` in `renderer.ts`, persisted in localStorage; a standalone
`qn` frame feeds `label.settings.formatDirection` and 'auto' follows it). Rendering
tes1 at 90° CW and overlaying against the export showed the rotation model is only
partly right:

- ✅ the **frame** aligns within ~1–2 px (box rows/cols match export exactly after a
  (0,+14) offset), and every barcode's **bounding box** matches the CW prediction
  (B1 575≈576, B6 320≈321, B8 200≈201 px) — layout-level, the rigid-CW model holds;
- ❌ the **bars inside the barcodes do not align** (red/green checkerboard in the
  overlay): BarTender's encoders and bwip-js pick different module patterns for the
  same data (Code128 subset/compaction choice for "12345678", Code39 `c0,6` check-
  digit mode, EAN-13 quiet-zone/narrow-width handling). Pixel-exact export parity
  needs symbology work too, not just rotation;
- ✅ Direct Graphics placement — fixed later the same day (see below); they no
  longer stack at x=0, but they are placed by the PRM model, so they still do not
  align with the page-rotated export (expected: a real printer would not rotate).

So the honest state: **rotation explains the gross layout divergence ("jauh dari
mirip"); remaining pixel differences are encoder-parity issues.** The Rotate control
is still the right feature (a real printer fed this stream would NOT rotate — only
BarTender's page setup does).

### Encoder parity pass (2026-09-19, later session) — DONE

The silently-dropped `c`-parameter modifiers are now threaded from
`viewerParser.parseBarcodeField` through a new shared `buildBwipSpec()` in
`services/ipl/barcodes.ts` (single source of truth for validation, measuring and
painting, so the three can never disagree):

- **Code 39 `c0,m` (PRM p.150)** → modes 3–5 select bwip `code39ext` (full ASCII);
  modes 1/4/7 `includecheck` (printer enters the mod-43 digit); modes 2/5/8
  `validatecheck` (host entered, verified — wrong check digit now errors like the
  printer). Modes 6–8 are the plain 43-char set = bwip `code39`.
  Caveat found by probe: `code39ext` computes the check over the full-ASCII
  expansion, so a host check digit must match the expansion, not the raw string.
- **Code 128 `c6,m3`** (start subset A/B/C) — REWRITTEN 2026-09-20 after a
  codeword-decode review: the old `{A`/`{B`/`{C` text prefix is NOT bwip-js
  syntax (braces encode as literal data — the forced subset never happened).
  m3 now builds explicit codewords (Start A/B/C + per-subset character→cw
  maps; subset C = digit pairs only) and hands them to bwip's `raw:true`
  mode, which still appends the mod-103 check and stop. Characters outside
  the chosen subset return null → `barcode-data-invalid`, matching the
  printer's error 11. m3 requires m1=0; `c6,1,m2,m3≠0` warns
  `code128-mode-conflict` and ignores m3 (PRM p.144).
- **Code 128 `c6,m1`/`c6,m2` (UCC-128 SSCC + interpretive)** — DONE 2026-09-20.
  m1=1: data (after stripping `()` and spaces) must be exactly 19 numeric
  chars; the printer forces the first two to `00` and starts the symbol in
  subset C after an FNC1 → bwip text `^FNC1` + `00` + digits[2..] with
  `parsefnc:true`. CRITICAL syntax fact (verified by decoding codewords):
  bwip-js's ONLY FNC1 entry is the caret token `^FNC1` (fncvals map keys are
  FNC1/FNC2/FNC3/LNKA/LNKC); a backslash `\f1` encodes as literal data — the
  first pass shipped exactly that bug and its string-only tests green-lit it.
  m2: with m1=0 strips `()`/spaces from the BAR CODE but the interpretive
  keeps them (renderer `interpretiveText()`); with m1=1, m2=1 keeps the host
  SSCC verbatim in the interpretive, m2=0 prints the normalized forced-00
  form (only for exactly 19 valid digits — invalid data falls back to
  verbatim so the HRI never garbles). Validation goes through the same
  `buildBwipSpec`, so bad UCC data errors with a data-specific message.
  Tests: `tests/ucc128.test.ts` + harness parity tests now assert DECODED
  CODEWORDS (`tests/golden/code128Decode.ts` reads the pattern table from
  the installed bwip-js), never just the encoder input string.
  **I<n> interpretive fields** (review finding #4, decided 2026-09-20): an
  `I<n>` field with no data source of its own is now a *live view* of its
  host barcode's interpretive — `syncInterpretiveFields()` at end of parse
  (after print-block attachment, before page composition) copies the host's
  data through the SAME `interpretiveText()` the built-in HRI row uses, so
  UCC-128 forced-00 normalization applies to both paths and they cannot
  disagree; invalid host data stays verbatim. `I<n>` with explicit d3/d4/d5
  keeps its own source untouched. Pinned by two ucc128 tests (normalization
  mirror + print-block flow-through).
  Consequence: goldens `product.png`/`external.png` (c6,0,0,1 = forced
  Start-A) regenerated 2026-09-20 — they now show a true subset-A symbol
  instead of the old literal-`{A` junk.
- **EAN/UPC `c7,m1`** — no code needed: bwip-js already distinguishes "data with
  check digit appended" (13/8-digit EAN, 12/7-digit UPC → verifies) from "data
  without" (adds), which is exactly PRM m1=0/2 behavior; the m1 flag1 (EAN-13
  leading interpretive digit) only affects HRI, which we draw ourselves.
  **Supplemental data** (`d3,<main>.<NN|NNNNN>`, PRM p.154) is now split and the
  add-on rendered as a second `ean2`/`ean5` symbol 11 modules after the main
  symbol; invalid add-on lengths (1/3/4 digits, double delimiter) now fail
  `barcode-data-invalid` instead of encoding main-only.
- **`r0/r2` ratio (2.5:1 / 2:1)** — RESOLVED 2026-09-20 via a run-length path:
  every wide:narrow family (0,2,3,4,5) now encodes through bwip `raw()`
  (the DEFAULT export's raw, sync — the ESM *named* `raw` export is a
  different _ToAny API needing a drawing), classifying each sbs run as
  narrow/wide (min-run heuristic; bwip's internal grids differ per symbology)
  and re-rasterizing on a half-module unit grid: narrow = 2 units,
  wide = round(2×ratio) units, painted 1 px/dot with cumulative-round
  boundaries. PRM rules honored: r0 at odd w substitutes 3:1 ("if the bar code
  width is odd…", p.170); r1 reproduces the old raster exactly (bwip's
  wide:narrow defaults ARE 3:1, so no golden shifted). Unknown r codes clamp
  to 1. The `ratio-not-applied` parser warning was removed. Pinned by
  tests/ratioParity.test.ts and probed live in the viewer (ITF w4 bar-width
  pixel scan: 3.0 / 2.0 / 2.5 for default / r2 / r0).
  Two review-pass catches: Industrial 2of5 `sbs` is ALWAYS odd-length (starts
  and stops with a bar) — an earlier even-length bail silently excluded every
  c3 field from the ratio path, so parity must not be enforced; and
  `ensureBarcodesReady` console.warns once if raw() is unavailable (the only
  condition under which a declared r is silently ignored). Goldens confirmed
  unchanged: bwip stores ITF wide runs as 2 modules but RENDERS them 3-wide,
  so the run path at r1 is numerically identical to the old raster (46
  modules for '1234' on both paths).

Consequence: `testdata/golden/product.png` and `external.png` changed (their
`c6,0,0,1` = force Start-A — previously silently auto-encoded; the manual says
subset A cannot encode lowercase/`{`… but `(10)…`-style data now begins in A,
which is what a printer does). Goldens regenerated 2026-09-19.

**Sub-issue RESOLVED (2026-09-19, same day): DG placement.** The old formula
(`ox = labelW - originY - stripLen`) used origin **Y** in the **X** computation —
with all tes1 origins at Y=791 it always clamped to 0. The earlier "no `<SI>W` in
tes1" diagnosis was wrong: W801 *is* parsed (`widthDots=801`); the null came from a
test reading the sample as utf8. Ground truth was re-established by brute-force
matching each decoded graphic's ink pattern against the export (the arrow matched
100% of sampled points under one axis assignment). The placement now follows PRM
Appendix E literally: origin (X,Y) is bottom-up, columns advance rightward from X,
bit *i* sits at top-down `y = labelHeight - originY + i` (bits grow **down** from
the origin). Placement is deferred to end-of-parse because origin Y needs the label
height, which may be declared after the graphics or not at all (fallback:
max(content extent, max originY)). Tests pin all of this in
`tests/directGraphics.test.ts`.

## 4. Second, independent bug: EAN/UPC `m2` ignored

Field `B8;f3;o143,252;c7,0,2;w3;h76;d3,211234567891`.

Per `IPL-RENDER-SPEC.md` §4.2 (PRM p.146), `c7[,m1][,m2]` where **m2 selects the
version**: 0 variable-length, 1 EAN-8, 2 EAN-13, 3 UPC-A, 4 UPC-E. Here `m2 = 2`
⇒ **EAN-13**, which takes exactly **12 data digits** — `211234567891` is therefore
**valid** and a real printer prints it.

`services/ipl/barcodes.ts` → `eanUpcBcid()` ignores `m2` and picks by digit count
(`case 12: return 'upca'`), so it resolves to UPC-A instead, bwip-js rejects it
(`upcAbadCheckDigit`), and `viewerParser.ts` (~line 787) emits
`barcode-data-invalid` and the field renders empty.

Fix: thread the `m2` version parameter into symbology resolution for `c7`; keep the
length-based guess only for `m2 = 0`.

(An earlier note in this repo claimed this error was "bad test data, viewer is
right". That was wrong — see the color/parameter reasoning above.)

## 5. How to run and measure

```
npx vitest run                       # 161 tests / 11 files, all green (~14 s)
npx vitest run tests/golden/golden.test.ts
npx tsc --noEmit
npm run dev
```

To measure rendered output headlessly, add a **temporary** test under `tests/` with
`import './golden/setup'` at **module level** (inside a test body it throws
*"Calling the suite function inside test function is not allowed"*). The setup
installs the @napi-rs/canvas `document.createElement` shim and the bwip-js adapter, so
`parseViewerIPL` → `renderLabel` run in Node. Import `setup`, NOT `harness` — the
latter declares the executable suites and would re-run every golden comparison for
each importer (split done 2026-09-20). Delete the probe afterwards.

Two traps: a Node script in `/tmp` cannot resolve project modules (ESM resolves
relative to the script — put scratch scripts inside the project), and an ink metric
that thresholds only *darkness* misses colored content — count
`max(r,g,b) < 200 || max−min > 12`.

## 6. Unrelated, already working

- **Open File** in the IPL Viewer (button + drag-and-drop) is done. It must decode
  files byte-exactly: `File.text()` (UTF-8) and `TextDecoder('latin1')`
  (aliased to windows-1252 → `0x85` becomes `U+2026`) both corrupt Direct Graphics
  RLE payloads. Only `bytesToByteString()` in `services/ipl/fileBytes.ts` works;
  `directGraphics.ts` reads bytes via `charCodeAt(0) & 0xff`. Do not "simplify" it.
  Covered by `tests/fileBytes.test.ts`.
