# Bedah portakal (productdevbook/portakal) — Sisi IPL

> Riset source-level 2026-08-24. Repo: github.com/productdevbook/portakal (MIT).
> Satu paket npm `portakal` v0.5.0 + workspace `web/` (Nitro playground).
> Toolchain: obuild, oxlint/oxfmt, vitest, tsgo. Zero-dependency TERVERIFIKASI
> (tanpa field `dependencies`; peerDep opsional `etiket` untuk barcode render).

## Arsitektur

Flow (`src/convert.ts`): `Source → Parser → LabelElement[] → Target Compiler → Output`.
Parser menghasilkan `{commands, widthDots, heightDots, elements, warnings}`;
compiler mengonsumsi resolved element list; `preview.ts` merender `ResolvedLabel`
→ string SVG. Ada juga facade `src/lang/ipl.ts`: `{compile, parse, preview}`.

Catatan inkonsistensi: README di `main` import `portakal/core` dan
`portakal/lang/tsc`, tapi exports map package.json tidak punya entri tersebut —
docs atau manifest stale.

## Parser IPL (`src/parsers/ipl.ts`, ~170 baris)

- Tokenizer framing STX/ETX bersih: indexOf loop → frames[].
- Frame ESC (`\x1bC/E/P/F/M`) → command CREATE_FORMAT/END_FORMAT/PROGRAM_MODE/
  FILL_FIELD/COPIES.
- Frame `<SI>` config: L→heightDots, W→widthDots, S/d/g/t dicatat saja.
- Field frame H/B/L/W/G: split `;` pertama untuk nomor field, sisanya params —
  tapi hanya H, W, L yang diekstrak jadi elemen (regex ad-hoc `/o(\d+),(\d+)/`,
  `d\d+,(.+)$`, dll). Default 832×400 dots tanpa kesadaran DPI.

## Compiler IPL (`src/languages/ipl.ts`, ~100 baris)

Template `<STX><ESC>C1<ETX>` … fields … `<STX>R<ETX>` … `<STX><ESC>E1<ETX>`,
join CRLF. Text hardcode `c26`, size = `(o.size ?? 1) * 12`. Line hanya axis-aligned.
Circle/ellipse/reverse/erase **didrop diam-diam**.

## Model elemen bersama (`src/types.ts`)

```ts
type LabelElement =
  | { type: "text"; content: string; options: TextOptions }
  | { type: "image"; bitmap: MonochromeBitmap; options: ImageOptions }
  | { type: "box"; options: BoxOptions } | { type: "line"; ... }
  | { type: "circle"|"ellipse"|"reverse"|"erase"; ... }
  | { type: "raw"; content: string | Uint8Array };

interface MonochromeBitmap {   // format gambar 1-bit universal
  data: Uint8Array;            // packed, row-major, MSB-first
  width; height; bytesPerRow;  // ceil(width/8)
}
interface ResolvedLabel { widthDots; heightDots; dpi; gapDots; speed; density;
  direction: 0|1; copies; elements }
```

## Preview SVG (`src/preview.ts`)

Language-agnostic: canvas rect putih + translate; teks via heuristik
(`calcFontSize`: yScale jika >10 else max(8, size*12); baseline ratio 0.78/0.82;
font "0"→Helvetica stack else monospace); image → rects per-bit dengan downsampling
lossy step=max(1,floor(maxDim/100)); box filled bila thickness >= min(w,h), else
stroke inset t/2; reverse/erase → rect hitam/putih. **Tidak ada barcode rendering
sama sekali di core** (diharapkan datang sebagai MonochromeBitmap dari `etiket`).

## Validate IPL: TIDAK ADA

Default branch hanya info "Validation for IPL is basic". Tidak ada cek keseimbangan
frame, ordering CREATE→PROGRAM→fields→END, atau range parameter.

## Tes

Compiler-only 12 tes + parser 6 tes (frame splitting, dims, satu H/W/L). **Tidak ada
tes B/G sama sekali.**

## Penilaian vs command set resmi IPL

Solid: tokenizer STX/ETX, IR universal + pipeline SVG, hygiene paket (subpath
exports, sideEffects:false, zero-dep, per-language facade).

Rusak/hilang:
- **B (barcode) tidak diimplementasi dua arah** — padahal label IPL nyata didominasi barcode.
- U field tidak ditangani; G tidak jadi elemen.
- Parameter H dibuang: f rotasi, c font, h/w magnifikasi, r reverse, b/i flags.
- Regex rapuh: menolak nilai negatif/spasi; `d\d+,(.+)$` menelan trailing params;
  tidak ada handling `;` dalam data quoted.
- Compile: hanya format 1; tanpa round-trip `\x1bF` variable-data; images emit G
  tanpa data grafis (tak akan tercetak); diagonal line didrop senyap.
- Tanpa warning untuk konstruksi tak didukung (silent drop).

## Rekomendasi untuk viewer kita

Pertahankan bentuk arsitektur mereka (frames → typed commands → shared IR → SVG),
tapi tulis parser sendiri: tokenizer per-parameter sungguhan untuk H/B/L/W/U;
elemen barcode first-class membawa k/h/w/r + flag params; pertahankan f/c/h/w/r/b/i
teks ke IR; plumbing warnings untuk konstruksi tak didukung; tambahkan branch IPL
di validate (balance frame, urutan field-before-print). Reuse ide MonochromeBitmap
dan strategi renderer SVG umum (termasuk heuristik thickness-fill), tapi implement
rendering barcode 1D sungguhan via bwip-js karena pendekatan mereka struktural tidak bisa.
