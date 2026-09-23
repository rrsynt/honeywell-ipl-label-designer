# Labelize (GOODBOY008/labelize) — Bedah Arsitektur

> Hasil riset mendalam terhadap https://github.com/GOODBOY008/labelize (branch `main`,
> v1.4.1, MIT AND BSD-3-Clause). Engine Rust yang parse ZPL & EPL → render PNG/PDF
> tanpa hardware. Ini cetak biru arsitektur utama untuk IPL viewer kita.

## 1. Struktur direktori

```
src/
├── lib.rs / main.rs / error.rs
├── tuning.rs                  # konstanta kalibrasi font-0 vs Labelary/Zebra
├── playground.rs              # HTML playground tertanam (feature)
├── assets/fonts/              # DejaVuSansMono(+Bold), HelveticaBoldCondensedCustom, ZplGSCustom (embedded)
├── parsers/
│   ├── zpl_parser.rs          # tokenizer ZPL + dispatch command
│   ├── epl_parser.rs          # parser EPL berbasis baris
│   ├── virtual_printer.rs     # STATE MACHINE printer virtual  ← kunci
│   ├── command_utils.rs       # helper parsing parameter bersama
│   └── fs.rs                  # filesystem virtual untuk graphics/format tersimpan
├── elements/                  # ~32 file: IR (label_element.rs), text_field, font,
│                              # label_position, barcode_* per symbology, dst.
├── drawers/renderer.rs        # Renderer stateless → rasterisasi RgbaImage
├── barcodes/                  # encoder murni → BitMatrix: code128/39, ean13,
│                              # 2of5, pdf417, aztec, datamatrix, qr, maxicode
├── encodings/                 # peta codepage (^CI)
├── hex/                       # decoding escape ^FH dan graphic hex
├── images/                    # monochrome (encode_png), pdf (lopdf), scaled, reverse_print
tests/
├── common/{image_compare,labelary_client,render_helpers,...}.rs
├── e2e_golden.rs              # ~109 tes golden-file
├── e2e_labelary.rs            # bootstrap referensi dari Labelary (--ignored)
testdata/
├── labels/ unit/              # input .zpl/.epl + golden .png
├── diffs/                     # side-by-side + overlay merah + laporan diff
└── labelary_cache/            # cache respons Labelary <sha256>.png
workers/labelize-wasm/         # WASM build (npm @goodboy008/labelize-wasm) — TIDAK parse IPL
```

## 2. Parser

### Tokenizer (ZPL) — hand-rolled character walker
1. UTF-8 lossy; buang `\n \r \t`.
2. Boundary command di `^` atau `~`, atau saat buffer berakhir `^CT`/`^CC` (prefix bisa didefinisikan ulang; dinormalisasi ke bentuk kanonik).
3. Dispatch via rantai `starts_with` pada prefix ~3 char, tiga kategori:
   - **State setter** (`^LH ^LR ^PO ^PW ^MU ^CI ^CF ^A ^FW ^FO ^FT ^FD ^FN ^FR ^FH`) → mutasi VirtualPrinter, tanpa elemen.
   - **Config barcode** (`^BC ^BE ^B2 ...` `^BY`) → elemen `*Config` yang update `default_barcode_dimensions`.
   - **Draw command** (`^GB ^GC ^GD ^GF ^GS ^FS`, `~DG ^IL ^XG ^DF ^XF`) → langsung menghasilkan elemen drawable (teks commit di `^FS`).

Quirk yang ditangani: digit nempel (`^A048,40`), aturan proporsional satu dimensi `^CFB0,30`, rasio `^BY` clamp 2.0–3.0, module width min 1 dot.

### IR (intermediate representation) — bahasa-netral
```rust
pub enum LabelElement {
    Text(TextField), GraphicBox(..), GraphicCircle(..), DiagonalLine(..), GraphicField(..),
    Barcode128(..|Ean13|2of5|39|Pdf417|Aztec|Datamatrix|Qr)(WithData), Maxicode(..),
    // Config (state printer, tidak digambar):
    Barcode128Config(..), /* satu Config per symbology */ FieldBlockConfig(..),
    // Template: StoredField(..), RecalledFieldData(..), RecalledFormat(..),
}
pub struct LabelInfo { pub print_width: i32, pub inverted: bool, pub elements: Vec<LabelElement> }
pub struct TextField {
    pub reverse_print: ReversePrint, pub font: FontInfo,
    pub position: LabelPosition, pub alignment: FieldAlignment,
    pub text: String, pub block: Option<FieldBlock>, // ^FB word-wrap
}
pub struct FontInfo { name: String, width: f64, height: f64, orientation: FieldOrientation }
pub struct LabelPosition { x: i32, y: i32, calculate_from_bottom: bool, automatic_position: bool }
```
**Poin terpenting:** parser EPL (berbasis baris) menghasilkan IR yang SAMA dengan parser ZPL → renderer bahasa-agnostic. Untuk IPL: buat parser IPL → IR sama.

## 3. VirtualPrinter (state machine)

```rust
pub struct VirtualPrinter {
    stored_graphics, stored_formats: HashMap<..>,
    label_home_position, next_element_position: LabelPosition,
    default_font, last_field_font: FontInfo,
    default_orientation, default_alignment,
    next_element_alignment: Option<FieldAlignment>,
    next_element_field_element: Option<Box<LabelElement>>,
    next_element_field_data, next_element_field_number, next_font,
    next_download_format_name, next_hex_escape_char,
    next_element_field_reverse, label_reverse: bool,
    default_barcode_dimensions, current_charset, print_width, label_inverted,
    dpmm, measurement_unit, dpi_conversion,
}
```
Model dua fase: command format mengisi slot "pending"; saat commit, `get_field_info()` snapshot semuanya jadi `FieldInfo`, lalu `reset_field_state()` (menjaga state lintas-field). `reset_label_state()` hanya membersihkan flag level label.

## 4. Renderer — stateless

- `struct Renderer;` tanpa field; font embedded sebagai byte statis.
- Canvas `RgbaImage` putih dari crate `image`; primitif gambar dari `imageproc`; glyph dari `ab_glyph`.
- Ukuran pixel = `(mm * dpmm).ceil()`; width di-clamp ke print_width; rotasi 180° bila inverted.
- Teks: map font `"0"`→Helvetica Bold Condensed custom, lainnya DejaVu Mono/Bold; `PxScale{x,y}`; ascent ≈76% tinggi sel untuk baseline `^FT`; koreksi cap-height font bitmap; tabel delta advance per-karakter di `tuning.rs` (metodologi kalibrasi n-vs-2n).
- Orientasi non-normal: render ke buffer temp lalu rotate 90/180/270.
- Barcode: encoder murni → BitMatrix → raster → komposit dengan konversi posisi baseline.

## 5. DPI/skala

1. Output: `DrawerOptions.dpmm` (default 8 = 203dpi... catatan: 8 dots/mm ≈ 203 dpi; IPL umumnya juga 203/300 dpi).
2. Scaling waktu-parse (`^MU`): semua parameter numerik lewat `parse_int_scaled(s, unit_scale())` → **IR selalu dalam dots**, renderer tak perlu re-scale.

## 6. Tes golden-file (~109 tes)

Per tes:
1. Cari `.zpl/.epl` di testdata; jika golden `.png` belum ada → **bootstrap**: POST ke Labelary API, respons di-cache `<sha256(zpl‖dpmm‖w‖h)>.png`, rate-limit ≥334 ms (mutex global), normalisasi ukuran via pad/crop.
2. Render lokal, bandingkan: per-pixel 4 kanal RGBA, threshold |diff| > 32 = beda; `diff_percent` = piksel beda / area max ×100.
3. Artifact diff: overlay merah `{name}_diff.png` + side-by-side `{name}.png`.
4. Assert ≤ toleransi; ceiling per-label didokumentasikan di `docs/DIFF_THRESHOLDS.md` (LABEL 15%, UNIT 8%); env var `LABELIZE_UPDATE_GOLDEN` menimpa golden; CI offline fallback baseline renderer-sendiri.
Tingkat diff: PERFECT 0% / GOOD <1% / MINOR <5% / MODERATE <15% / HIGH ≥15%. Sumber diff sisa: substitusi font, arrangement codeword PDF417, pilihan encoder Aztec/DataMatrix.

## 7. Dependensi ↔ padanan JS/browser

| Crate | Peran | Padanan JS |
|---|---|---|
| image 0.25 | canvas RgbaImage, encode PNG | Canvas2D / OffscreenCanvas |
| imageproc 0.26 | garis/polygon/rotasi | Canvas path & transform |
| ab_glyph 0.2 | rasterisasi TTF embedded | OpenType.js atau Canvas fillText |
| lopdf | rakit PDF | pdf-lib |
| datamatrix/qrcode/rxing | payload barcode | **bwip-js** (cover semua incl. MaxiCode) |
| own code | encoder → BitMatrix | port dari src/barcodes/*.rs |

WASM mereka (`lz_render(src, w_mm, h_mm, dpmm, antialias, want_pdf, is_epl) -> Vec<u8>`) ada di npm tapi TIDAK mem-parse IPL.

## 8. Takeaway arsitektur untuk IPL viewer

1. **IR bahasa-netral adalah inti desain** — parser IPL harus menghasilkan IR yang sama dengan parser lain; varian IPL-specific hanya bila perlu.
2. **Pola parser stateful** (VirtualPrinter): pending slots → commit snapshot. Struktur IPL (`{command,params}`, framing `<STX>/<ETX>`, dynamic fields + counter) cocok dengan model dua fase ini.
3. **Semua dalam dots sejak parse time** → rendering murni matematika pixel.
4. **Renderer stateless**, opsi per-panggilan (`DrawerOptions`).
5. **Golden testing vs ground truth** — resep pembanding gambar mereka langsung bisa dipakai; untuk IPL, referensi datang dari simulator Honeywell / dump printer nyata / kurasi manual (Labelary hanya untuk ZPL; trik cross-check: konversi IPL→ZPL→render Labelary).
6. **Budaya kalibrasi**: terima diff ≠ 0, dokumentasikan akar masalah; metodologi tuning.rs (probing n-vs-2n) untuk fit metrik font pengganti font bitmap IPL.
7. **Encoder barcode murni terpisah dari render** → mudah dites independen.
