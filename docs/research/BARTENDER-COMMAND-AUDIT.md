# BarTender Command Audit — tes1 / tes2 / logo streams

> **Correction 2026-09-24:** everything below about **tes2** is withdrawn. The
> audit assumed `bartender-tes2.ipl` and `bartender-tes2-export.png` were the same
> format; they are not — the stream is 4 Direct Graphics (widest 112 dot) and the
> export needs a 625px rule. No conclusion drawn from the export for tes2 holds.
> The per-frame findings themselves (which commands the parser handles) are still
> accurate, since they were read off the stream, not measured against the image.
> See `docs/HANDOFF-IPL-RENDER.md` §1 and `tests/bartenderPairing.test.ts`.

Audited 2026-09-23 against `samples/bartender-tes1.ipl` (50 frames),
`samples/bartender-tes2.ipl` (36 frames) and `samples/bartender-logo.ipl`
(333 frames), compared with the real BarTender image export
`testdata/bartender-tes1-export.png` (798×518, ~1 px/dot). Every measurement
below was taken on the export PNG or on our own render, not estimated.

Read `docs/HANDOFF-IPL-RENDER.md` first: the export is the whole label rotated
90° clockwise by BarTender's page setup, which lives **outside** the IPL
stream. Nothing in this audit changes that conclusion.

## Verdict

No parser or renderer defect found. Every command these three streams emit is
handled, and the three things worth re-measuring all match the export:

| Check | Stream | Export (measured) | Ours |
|---|---|---|---|
| Frame border | `W3;…;h770;l492;w3` | top edge is exactly **3 consecutive ink rows** (y 13–15) | `thicknessDots` from `w`, drawn at `w` dots |
| EAN-13 HRI digits | `H9…H20` font `c26;h17;w17`, one digit each | glyphs **18 px** wide, **9 px** apart | identical pitch in a 90° CW render |
| Barcode HRI | every `B` field omits `i` | no doubled text under any barcode | `i` defaults to 0 (disabled, PRM p.192); the separate `H` fields are the only interpretive |

`parseViewerIPL` of tes1 reports 26 elements and zero warnings or errors.

## Per-command disposition

| Frame | Question | Result |
|---|---|---|
| `<ESC>C<SI>W801` (no `<SI>L`) | height missing from stream | By design. Extent falls back to content bounds (801×784 here) and the viewer's paper-size control overrides it. The 784 comes from the box `h770` at `o…,14`, which the export confirms. |
| `E2;F2`, `D0`, `d3,…` | print-block data flow | `d3` fixed data is the field content; `D0` clears data before the print block. No `d0` (print-block sourced) fields appear in these streams. |
| `H…;c26;b0;h17;w17` | outline font `h`/`w` semantics | Treated as base character size in dots, not magnification (`viewerParser.ts` outline branch): 17 dots → 6 pt. The export's 18 px glyph pitch confirms the size, and `b0` correctly draws no border. |
| `B…` without `i` | double HRI? | No. Default `i0` matches both the manual and the export; BarTender sends its own `H` fields for human-readable text. |
| `W3;…;w3` | `w` = border thickness | Confirmed against the export, see table above. |
| `B22;…;c18,2,L,8` | QR, 4-param form | Parsed (symbology 18, error correction L). Bar positions are an encoder concern, not geometry; the export places the symbol where the rotated origin predicts (HANDOFF §2). |
| `B8;…;c7,0,2` | EAN-13 version flag | `eanUpcVersion` 2 selects ean13. Digit pitch matches the export. |
| `B1;…;c6,0,0,3` / `B4;…;c0,6` / `B6;…;c1` | Code 128 / Code 39 / Code 93 | Parsed with their modifier params. Bar-pattern differences versus BarTender's encoder are a known, accepted gap (HANDOFF §2 revision); bounding boxes match. |
| `<SI>l13` | code page 1252 | Applied. These samples contain no glyph outside ASCII, so there is nothing further to pin. |
| `<ESC>E2,1<CAN>` | reimage changed fields only | Ignored visually, correctly — it is not a rotation command. |
| `<RS>1<US>1<ETB>` | one label, one copy | `quantity` 1, `batchCount` 1. |
| `<ESC>g0` payloads | Direct Graphics | Decoded and placed per PRM Appendix E. `<ESC>g1` (nibblized) now decodes identically — see `tests/directGraphicsHex.test.ts`. |
| `G0;x122;y384` + `u<n>,<data>` (logo) | stored-format graphics | Already a passing golden (`testdata/golden/bartender-logo`). |
| `E1`…`E99` preamble (logo) | erase stored formats | Ignored, correctly; the following `E1;F1` redefines what matters. |

## Pinned by tests

- Border thickness and the disabled-by-default interpretive:
  `tests/bartenderAudit.test.ts`.
- g0 ≡ g1 graphic identity: `tests/directGraphicsHex.test.ts`.
- Direct Graphics placement against these exact streams:
  `tests/directGraphics.test.ts`.
- Logo golden: `tests/golden/golden.test.ts`.

## Not pinned (and why)

Pixel-level barcode parity with the export is not attempted: bwip-js and
BarTender's encoder choose different module patterns for the same data. The
comparison that matters — bounding boxes — is recorded in
`docs/HANDOFF-IPL-RENDER.md` and held as long as the rotation model is unchanged.
