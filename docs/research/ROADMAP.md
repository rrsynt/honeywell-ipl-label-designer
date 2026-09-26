# Roadmap: Menjadi "IPL Viewer kelas Labelary"

> Disusun dari riset (docs/research/), manual resmi (docs/manuals/), dan kondisi
> kode saat ini. Kode yang sudah ada lebih baik dari perkiraan awal: sudah ada
> tokenizer frame STX/ETX (`services/ipl/tokenizer.ts`), parser viewer
> (`viewerParser.ts`, 549 baris), renderer (`renderer.ts`), encoder barcode
> (`barcodes.ts`), dan 5 suite tes.

## Posisi sekarang vs standar Labelize/Labelary

| Aspek | Labelize (patokan) | Proyek kita | Gap |
|---|---|---|---|
| Parser → IR bahasa-netral | `LabelElement` enum + `LabelInfo` | `ViewerElement` union + `ViewerLabel` | ✅ polanya sudah sama |
| State machine printer virtual | `VirtualPrinter` dua fase (pending→commit) | `services/ipl/virtualPrinter.ts` — semua state parse di satu objek, invariant commit di satu tempat | ✅ selesai 2026-09-20 (Fase 1) |
| Renderer stateless | ya, opsi per panggilan | `renderLabel(canvas,label,extent,opts)` murni (dipakai headless vitest); `canvasDrawer` khusus UI designer | ✅ terpisah |
| Semua koordinat dalam dots | ya, sejak parse time | ya (pt→dots hanya outline `k`, butuh dpi renderer — disengaja) | ✅ diaudit |
| Golden-file testing | ~109 tes, threshold per-pixel, diff overlay, toleransi didokumentasikan | harness golden 8 kasus + parity suite BarTender (geometry, sweep, auto, golden-pair) + codeword decode | ✅ Fase 3 |
| Kalibrasi font | tabel tuning per-karakter vs referensi | tabel advance per-glyph Liberation (fontMetrics.ts, ASCII 32–126, per-mille em) dipakai estimateElementSize + border b + import designer | ✅ Batch U 2026-09-24 (mono byte-stable, proporsional ≤0.3% vs measureText) |
| Semantik command yang tak terdokumentasi | — | seluruh 10 pertanyaan terbuka IPL-RENDER-SPEC §15 tertutup 2026-09-25 (jawaban dari manual, export BarTender, atau invarian terukur) | ✅ §15 kosong |
| Print data non-ASCII | — | code page `<SI>l` (cp850/1250-1258/874/UTF-8) + substitusi resident n=0-9, satu entry point `decodePrintData` | ✅ 2026-09-24 |

## Fase 0 — Fondasi pengetahuan (SELESAI)
- [x] Manual resmi terunduh: docs/manuals/ (4 PDF + CHM + ekstraksi .txt)
- [x] Cheat-sheet command IPL: docs/manuals/IPL-CHEATSHEET.md
- [x] Bedah arsitektur Labelize: docs/research/LABELIZE-ARCHITECTURE.md
- [x] Survei ekosistem: docs/research/ECOSYSTEM-SURVEY.md

## Fase 1 — Refactor arsitektur ke pola Labelize (SELESAI 2026-09-20)
- [x] 1. `VirtualPrinter` eksplisit: `services/ipl/virtualPrinter.ts` — SELURUH
      state parse pindah ke sana (format aktif + bucket, program-mode, seen-field
      keys, Direct Graphics mode/pending, downloaded-graphics store + split-graphic
      cursor `lastGraphicId`/`graphicColumnBase`, label). Parser
      (`viewerParser.ts`) tersisa sebagai penerjemah frame → operasi printer.
      Catatan: IPL tidak punya "origin berikutnya / default font" lintas-field
      (semua parameter field eksplisit per-frame, PRM p.171) sehingga slot pending
      ala ZPL tidak berlaku — state yang ada hanyalah yang di atas.
- [x] 2. Model dua fase: command mengisi state/collect pending (format buckets,
      pendingDirectGraphics, print-block attach), commit terjadi di titik-titik
      eksplisit printer (`commitElement`, `evictField`, `deleteField`,
      `closeFormat`, place/sync/compose di akhir parse). Invariant "last
      definition wins" kini dipaksakan di SATU tempat dan di-SCOPE ke format
      aktif: field ids adalah per-format (direktori field IPL), jadi duplikat
      dalam format 2 hanya membungkam definisi format 2 — elemen format lain
      selamat di live list maupun bucket-nya (review 2026-09-20 menemukan versi
      lintas-bucket pertama justru MENGHANCURKAN format lain; dikunci oleh dua
      tes iplValidator: eviction dalam-format + Dn-then-redefine tanpa false
      duplicate).
- [x] 3. Angka parameter dinormalisasi ke dots saat parse (o/h/w/l/r/i/c — semua
      dots; satu-satunya pt→dots adalah outline font `k` yang memang butuh dpi
      renderer, disengaja).
- [x] 4. Renderer murni: `renderLabel(canvas, label, extent, opts)` di
      services/ipl/renderer.ts tanpa React (dipakai vitest headless via setup.ts);
      `canvasDrawer` UI-designer tetap terpisah.
- BUG SEMANTIK Ikutan (2026-09-20): duplicate-field-id kini di-scope PER FORMAT
      (`formatId:K<id>`), sesuai direktori field IPL — H0 di format 1 dan H0 di
      format 2 adalah field berbeda; sebelumnya format 2 membungkam H0 format 1
      (terbukti lewat regresi tes page-composition saat refactor).

## Fase 2 — Fidelity rendering subset inti (SELESAI 2026-08)
Prioritas command (dari manual hal. 141–201), semua terverifikasi test di tests/iplViewer.test.ts:
- [x] H (teks): font bitmap c0/c2/c7 dengan metrik dot benar (7×9, 7×11, 10×14, 5×7);
      magnifikasi h/w independen; advance = lebar sel + gap antar karakter (c0 gap 1,
      lainnya 2; 10 karakter c0 = 79 dot sesuai PRM270 p.54). Default field: font 0, h2/w2.
- [x] Font outline 20–41: ukuran dari k (pt) → dots = pt × dpi/72 (aproksimasi lebar
      0.6 em; kalibrasi per-glyph ditunda ke fase golden-file).
- [x] B/C barcode via @bwip-js/browser: Code 39, Code 93, I2of5 (+padding nol otomatis
      untuk data ganjil, PRM p.143), Industrial 2of5, Codabar, Code 11, Code 128,
      keluarga EAN/UPC dari panjang data (c7), PDF417, DataMatrix. HRI bawah/atas
      (font 0 h2/w2, gap 2 dot, PRM p.191). Default B: h50, w1, rasio 3:1; r0/r1/r2
      + clamp ke default untuk nilai tak dikenal.
- [x] L/W line & box termasuk radius r (clamp seperti printer).
- [x] Rotasi f0–f3 dengan anchor yang benar.
- [x] UDC/graphic G/U (data kolom packed ASCII).
- [x] Interpretive field I<n> (anchor turunan barcode+2dot, override o/f/c/h/w/k/d,
      warisi data host, warning jika host tidak ada) dan border b>0 (huruf putih pada
      kotak hitam n dot, PRM p.167).
- [x] Dynamic data print block: substitusi data per nomor field, <US> batch count,
      <RS> quantity, <ESC>I increment / <ESC>D decrement (settings, belum simulasi
      odometer per label).

## Fase 3 — Golden-file test bed (SELESAI 2026-08)
Dokumentasi lengkap: [GOLDEN-TESTING.md](GOLDEN-TESTING.md).
- [x] Struktur `testdata/golden/<nama>.ipl` + `<nama>.png` + `cases.json`
      (dpi, ukuran label opsional, toleransi per-kasus).
- [x] Harness pembanding (resep Labelize): threshold per-kanal RGBA 32,
      diff_percent = piksel beda/area maksimum, overlay merah/hijau +
      side-by-side di `testdata/golden/diffs/`, env var `IPL_UPDATE_GOLDEN`.
      Default toleransi 0.05% (satu baris teks interpretive ≈ 0.28% → pasti gagal).
- [x] Renderer berjalan di Node dengan canvas asli (@napi-rs/canvas): patch
      `document.createElement('canvas')` + adapter `bwip-js/browser` →
      `bwip-js/node` yang mereplikasi semantik rasterisasi `DrawingBuiltin`
      (pembagian ketebalan garis, peta tepi even-odd) secara **sinkron**.
- [x] Script: `npm run test:golden`, `npm run test:golden:update`.
- [x] 6 kasus (product, box-date, external, chained, codabar, bartender-logo —
      ekspor asli BarTender dengan graphic print-head orientation; mengunci semua
      perbaikan parser BarTender: framing split E/G/u, basis u 0/1-based, transposisi).
- [ ] Ground truth dari printer asli — **satu-satunya item roadmap yang masih
      terbuka, dan terblokir hardware, bukan pengetahuan.** Referensi golden
      sekarang masih self-baseline untuk sebagian besar kasus (mengunci
      regresi); yang SUDAH punya rujukan eksternal adalah kasus BarTender
      (export PNG asli + stream asli, `tests/bartenderAuto/Geometry/Sweep`)
      dan metrik font (tabel advance hasil ukur).
      STATUS 2026-09-25: seluruh §15 IPL-RENDER-SPEC sudah tertutup, dan
      checklist kalibrasi di docs/HONEYWELL-SIMULATOR.md sudah diaudit — tiap
      itemnya kini menyebut apa yang memutuskan nilainya, jadi satu sesi dengan
      printer cukup untuk MENGKONFIRMASI kedelapannya, bukan menyelidiki dari
      nol. Dua pertanyaan yang benar-benar tersisa: (a) apakah face outline
      printer selebar Liberation, (b) apakah firmware memakai tabel substitusi
      resident yang sama dengan Appendix B.
      CATATAN: Honeywell resmi menyatakan TIDAK ADA simulator (artikel
      000075988) — jalur: cross-check Labelary (`npm run crosscheck`), akses
      printer fisik (vendor demo/pinjam), kurasi contoh Developer's Guide.
      STATUS 2026-09-20: jalur Labelary TERBUKTI BEKERJA — product/box-date/
      chained/external lolos konversi+render; render product.ipl cocok layout
      dengan viewer kita (teks, Code128+HRI, garis, posisi). BATASAN: sampel
      bartender-tes1/tes2 TERPOTONG di Labelary karena rotasi halaman BarTender
      hidup di luar stream IPL (lihat memory tes1-reference-png-unreliable) —
      konverter IPL→ZPL tidak memodelkannya; jangan pakai sampel itu untuk
      crosscheck.
      STATUS 2026-09-24 (Batch T): crosscheck dijalankan sistematis untuk 5
      golden cases dan MENEMUKAN 2 bug nyata di KONVERTER (bukan renderer):
      ^PW/^LL hilang dari frame gabungan <ESC>C<SI>W… (Labelary render di
      kertas default 812-dot) dan placeholder [DATE]/[TIME] tidak match
      tabel renderer ([DD/MM/YYYY] dst). Keduanya diperbaiki + dikunci tes
      offline tests/ipl2zpl.test.ts (8 tes). Hasil pasca-fix: bounding-box
      tinta cocok 1–4 px pada product/box-date/external — sisa beda pixel
      adalah inheren antar-engine (font ZPL vs Liberation, lebar modul
      bwip vs default ZPL), jadi sinyal crosscheck yang bermakna adalah
      AGREEMENT LAYOUT, bukan identitas pixel. Item tetap TERBUKA parsial:
      ground truth printer fisik belum tersentuh (Labelary tetap proxy).

### Bug fidelity yang ditemukan lewat harness ini
- `bcid` Codabar salah: bwip-js memakai `rationalizedCodabar`, bukan `codabar`
  → semua barcode c4 gagal render (jatuh ke placeholder).
- Default `c` barcode salah (`6`/Code 128); manual PRM270 p.171 menetapkan
  Code 39 (`0`).
- Default `i` (interpretive) salah (`1`/di bawah); manual PRM p.192 menetapkan
  disabled (`0`).

## Fase 4 — UX setara Labelary (SELESAI 2026-08)
- [x] Preview real-time sambil edit (debounce 300ms) — sudah ada di modal sejak awal.
- [x] Klik command → panel bantuan: modul services/ipl/commandHelp.ts (40+ entri
      dari manual, dengan nomor halaman PRM); panel mengikuti posisi kursor di
      editor (frameAtCaret + lookupHelpForFrame), teruji di browser.
- [x] Linter warnings dengan lompat-ke-baris: tokenizer melacak baris sumber
      (tokenizeFramesWithLines), issue membawa `line`, tombol L<n> di panel
      memindahkan kursor + scroll editor.
- [x] Ekspor PNG/PDF + pilih DPI 203/300/406 — sudah ada (jspdf).
- [x] Disclaimer akurasi yang jujur — diperjelas: font/metri barcode/spasi adalah
      estimasi; verifikasi akhir di printer/simulator.
- [x] Multi-label: komposisi halaman (S/M/O/q, PRM p.196) — parser menyimpan
      elemen per format, placements di-offset+dirotasi ke koordinat halaman;
      odometer inc/dec per batch (services/ipl/odometer.ts, alfabet 0-9,A-Z,
      wrap ZZZZ→0000) dengan stepper "Label n/N" di preview; status bar
      menampilkan "batch×qty labels" dan ringkasan page.

## Fase 5 — Validasi hardware (bila suatu saat ada akses)
- Simulator firmware asli via bridge (jalur A docs/HONEYWELL-SIMULATOR.md),
  checklist kalibrasi visual di dokumen itu.
- Tawarkan hasil ke penulis portakal & komunitas Labelize untuk uji silang.

## DPL (Datamax) — DITUNDA, menunggu sumber (2026-09-26)
DPL adalah satu-satunya bahasa dari daftar rencana induk yang **tidak dibangun**,
dan alasannya bukan tingkat kesulitan melainkan tidak adanya bahan:

- **Tidak ada manual resmi yang ditemukan.** Pencarian manual pemrograman DPL
  (Datamax/Honeywell) tidak mengembalikan salinan publik. Ini yang membedakannya
  dari TSPL, yang terselamatkan oleh manual TSC yang bisa diunduh.
- **Tidak ada oracle independen.** API Labelary memang mengeluarkan DPL
  (`Accept: application/dpl`), tapi keluarannya sebuah RASTER, bukan perintah:
  percobaan mengembalikan satu blob biner ditambah `D11`, `1Y…`, `Q1`, `E` —
  tanpa satu pun `1A` (teks) atau `1B` (barcode). Engine Labelize hanya punya
  `zpl_parser.rs` + `epl_parser.rs` (dikonfirmasi dari daftar berkasnya).
- **Sumber sekunder terlalu tipis.** Satu repositori VB.NET
  (`BauerPh/LabelDesigner`, 2 bintang) memberi sintaks untuk 6 tipe barcode dari
  puluhan, ditambah TEXT, BOX, LINE dan DataMatrix — tapi tidak ada tabel font,
  perintah ukuran/gap, maupun tanggal.

Kenapa tidak dikerjakan saja dengan sumber itu: EPL dan TSPL dua kali membuktikan
bahwa tabel bahasa printer yang ditulis tanpa spec otoritatif **salah**. Pada EPL
tabel huruf barcode-nya keliru total; pada TSPL tipenya ternyata nama, bukan
angka. Menebak DPL akan menghasilkan label salah cetak tanpa ada yang tahu —
persis kegagalan diam-diam yang proyek ini ada untuk mencegah.

**Yang membuka DPL:** manual DPL resmi, atau contoh label `.dpl`/`.prn` nyata dari
printer Datamax. Dengan itu, parser dan generator DPL mengikuti cetak biru yang
sudah ada (`services/epl/`, `services/tspl/`) dan `PrinterLanguage` tinggal
menerima nilai kelima.

## Keputusan teknologi
| Peran | Pilihan | Alasan |
|---|---|---|
| Barcode | `@bwip-js/browser` | semua symbology IPL, satu dep, aktif, browser-native |
| PDF export | pdf-lib | padanan lopdf di Rust |
| Font outline | webfont + Canvas fillText + kalibrasi | metodologi tuning.rs Labelize |
| WASM engine (opsional masa depan) | fork labelize-wasm + tambah parser IPL | jika fidelity sulit dicapai di TS murni |
