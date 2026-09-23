# Golden-File Test Bed (Fase 3)

Referensi piksel untuk renderer IPL, meniru resep [labelize](https://github.com/GOODBOY008/labelize):
render di Node dengan canvas asli, bandingkan per-piksel dengan PNG referensi
yang di-commit, dan tulis artefak diff saat gagal.

## Struktur

```
testdata/golden/
├── cases.json          # manifest kasus uji
├── <nama>.ipl          # stream IPL sumber
├── <nama>.png          # PNG referensi (golden)
└── diffs/              # artefak saat ada kegagalan (tidak di-commit)
    ├── <nama>_diff.png # overlay: merah = tinta hilang, hijau = tinta ekstra
    └── <nama>.png      # side-by-side expected | actual
```

Harness: [tests/golden/harness.ts](../../tests/golden/harness.ts), entry vitest
[tests/golden/golden.test.ts](../../tests/golden/golden.test.ts).

## Manifest `cases.json`

```json
[
  { "name": "product", "dpi": 203 },
  { "name": "wide", "dpi": 300, "widthDots": 1200, "heightDots": 600, "tolerance": 0.1 }
]
```

| Field | Wajib | Arti |
|---|---|---|
| `name` | ya | nama kasus; input `<name>.ipl`, referensi `<name>.png` |
| `dpi` | ya | resolusi printer; menentukan konversi point size ke dots |
| `widthDots` / `heightDots` | tidak | paksa ukuran kanvas; default dari `<SI>W`/`<SI>L` atau bounding box konten |
| `tolerance` | tidak | ambang diff persen; default **0.05%** |

## Menjalankan

```bash
npx vitest run tests/golden/golden.test.ts
```

Regenerasi semua referensi (setelah perubahan renderer yang memang diinginkan):

```bash
IPL_UPDATE_GOLDEN=1 npx vitest run tests/golden/golden.test.ts
```

Selalu **periksa PNG hasil regenerasi secara visual** sebelum commit — mode update
menerima apa pun yang dihasilkan renderer, termasuk regresi.

## Metrik perbandingan

Mengikuti labelize:

- Piksel dianggap beda bila **salah satu** kanal RGBA menyimpang lebih dari **32**.
- `diffPercent = (piksel_beda + selisih_area) / area_maksimum × 100`.
- Default toleransi 0.05%. Sebagai kalibrasi: satu baris teks interpretive pada
  kanvas 812×400 ≈ 900 piksel ≈ 0.28%, jadi kehilangan elemen utuh pasti gagal,
  sementara derau antialias satu-dua piksel masih lolos.

Toleransi per-kasus dinaikkan hanya bila penyebabnya sudah dipahami dan
didokumentasikan (mis. substitusi font outline yang belum dikalibrasi).

## Cara harness menjalankan renderer di Node

Renderer aplikasi menargetkan canvas DOM; di bawah vitest/happy-dom context 2D
hanyalah stub. Harness menukar dua hal:

1. `document.createElement('canvas')` dipatch agar mengembalikan canvas
   [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas) sungguhan — dipakai
   `barcodes.ts` dan `graphics.ts` untuk kerja offscreen. Properti `style` diberi
   objek kosong karena `renderLabel()` menulis lebar/tinggi CSS ke sana.
2. Modul `bwip-js/browser` diganti adapter atas `bwip-js/node`. Adapter memakai
   `render(options, drawing)` yang **sinkron**, dengan drawing interface yang
   mereplikasi semantik rasterisasi bawaan bwip (`DrawingBuiltin`):
   - `line()` membagi ketebalan jadi paruh besar/kecil persis seperti aslinya;
   - `polygon()` mengumpulkan titik tepi ke peta baris dengan aturan tepi
     atas/kiri yang sama;
   - `fill()` mengecat peta itu dengan aturan even-odd.

   Sinkronitas ini penting: `paintBarcode()` memanggil `toCanvas` lalu langsung
   `drawImage` dari canvas offscreen, jadi rasterisasi harus selesai sebelum
   fungsi kembali. Versi awal adapter memakai `async` dan menghasilkan barcode
   kosong — hanya teks HRI yang tampil.

## Sumber ground truth

Referensi saat ini adalah **output renderer sendiri** (self-baseline). Itu
mengunci regresi tapi belum membuktikan fidelity terhadap printer asli. Jalur
peningkatan, sesuai roadmap Fase 3/5:

1. **Honeywell Printer Simulator** (firmware asli) — lihat
   [docs/HONEYWELL-SIMULATOR.md](../HONEYWELL-SIMULATOR.md); kirim `.ipl` lewat
   bridge, tangkap hasilnya, jadikan golden.
2. **Cross-check Labelary** — `npm run crosscheck` mengonversi IPL→ZPL lalu
   merender di Labelary. Menguji intent layout, bukan fidelity font.
3. **Kurasi manual** — rekonstruksi contoh label dari Developer's Guide.

Saat golden dari sumber (1) masuk, naikkan toleransi per-kasus sesuai deviasi
yang terukur dan catat akar masalahnya di sini.
