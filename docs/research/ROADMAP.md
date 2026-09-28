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
| Kalibrasi font | tabel tuning per-karakter vs referensi | tabel advance per-glyph (fontMetrics.ts, ASCII 32–126, per-mille em) dipakai estimateElementSize + border b + import designer; 6 keluarga resident | ✅ Batch U 2026-09-24 (mono byte-stable, proporsional ≤0.3% vs measureText). **Face printer andal 2026-09-28:** Andale Mono = 600/1000 em eksak; c67 Century Schoolbook beda ~10–13% → **diperbaiki** dengan TeX Gyre Schola (identik 0,0), keluarga ke-4 `'schoolbook'`; c23/c24 **salah tipe** (outline→bitmap, memperbaiki magnifikasi `h`); **c69 Letter Gothic DIPERBAIKI** — advance face-nya 500/1000 em (12-pitch), bukan 600; keluarga metrik ke-6 `'letter-gothic'` dengan tabel 500, dan **face-nya di-vendor**: Inconsolata (SIL OFL) ternyata satu-satunya face bebas yang advance-nya MEMANG 500 DAN glyph-nya muat sel sel 500 (0/94 menumpuk, sedangkan Liberation Mono 25/94 bertumpuk — itulah yang memblokir perbaikannya sampai sekarang); issue `letter-gothic-advance` dihapus; terukur di browser 133 dot vs 135,3 yang diharapkan (rasio 1,203 terhadap c25 yang 600); **c63/c65 cut CONDENSED DIPERBAIKI** — AFM asli Adobe untuk Univers Condensed Bold ditemukan (`mal359/unixfonts`), jadi advance-nya terukur (74,4 per-mille lebih sempit dari Liberation Sans); keluarga metrik ke-5 `'univers-condensed'`, face tetap Liberation + Arial Narrow di depan stack, dan **0 dari 67 glyph bertumpuk** sehingga ini aman (berbeda dari c69); peringatan lama dihapus; **c61/62/68 DITUTUP 2026-09-28 (dengan bukti, bukan menyerah)** — PFM per-face di paket driver Seagull (`ss#ipl.ddz` adalah ZIP: `Univers[1252].pfm`, `Swiss[1252].pfm`, `LetterGothic[1252].pfm`, …) ternyata membawa metrik **DESAIN**, bukan metrik printer: `Univers[1252].pfm` **byte-identik** dengan `Swiss[1252].pfm` (dan `CG_Times` ≡ `Dutch`), konsisten dengan tabel Honeywell yang memang menyebut c61 "Swiss 721" = Univers. Decode tabel lebar di offset 0x34 tervalidasi (Century 9,15 per-mille vs tabel kita yang eksak) tapi **lantai deraunya ~9–16 per-mille** — cukup untuk membaca Century, TIDAK cukup untuk memisahkan Univers dari Helvetica (keduanya rata 16,70). Jadi tidak ada sumber baru untuk c61/62/68, dan **estimasi ~6,5% tetap tidak dipakai**; AFM regular tetap tidak ada di sumber mana pun yang terjangkau; **c50/c51 lebar CJK DIPERBAIKI** — karakter lebar (UAX #11) kini 1000/1000 em, bukan rata-rata keluarga 524, sehingga field Kanji tidak lagi diukur ~48% terlalu kecil (`fontMetrics.ts`) |
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
      STATUS 2026-09-28: **(a) TERJAWAB TANPA PRINTER.** Face printer
      sesungguhnya adalah **Andale Mono / CG Times** (tabel
      `Font_Type_Select_K10_937-028-003.htm`). Andale Mono diukur dari file
      fontnya: advance **1229/2048 = 600 per-mille, identik integer demi
      integer** dengan Liberation Mono kita — jadi `MONO_PER_MILLE = 600`
      **eksak**, tidak ada perubahan kode (bentuk glyph masih beda ~6,7%
      lebar tinta; angkanya tercatat). **Temuan sampingan yang nyata:** id
      **c67 Century Schoolbook** (face `CENSCBK.TTF`, Monotype) advance-nya
      **beda 59,8 per-mille rata-rata (maks 406)** → field c67 tergambar
      **~10–13% lebih sempit** dari cetakan. **SUDAH DIPERBAIKI 2026-09-28**:
      TeX Gyre Schola (GUST Font License) ternyata metrik-nya **identik persis**
      dengan Century Schoolbook (0,0 per-mille), jadi ia di-vendor sebagai
      keluarga advance keempat `'schoolbook'` — face-nya benar-benar dikirim,
      bukan cuma tabelnya diubah, karena renderer menggambar lewat `fillText`.
      Terukur di browser: c67 kini +9,3% lebih lebar. Dua id serif lain
      (c28/c66 → CG Times) tetap benar dan **tidak disentuh**. **Sisa (b)**
      masih menunggu printer.
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

### Koreksi 2026-09-27 — tiga perintah yang menggeser gambar kini bersuara
Perintah yang dipakai untuk mengompensasi offset printhead 3 mm antar generasi
(lihat tech brief migrasi PM43/PC43) ternyata **tidak pernah masuk jalur
keputusan mana pun**: `parseSetupFrame` mencocokkan W/L/T/g/S/d/l lewat regex
dan membuang sisanya tanpa jejak. Yang dibuang itu termasuk tiga perintah yang
manualnya tegas mengubah gambar tercetak:

| Perintah | Arti | Manual |
|---|---|---|
| `<SI>X m1[,m2]` | Label Origin, X-Y Adjust — menggeser posisi terimajinasi | K10 937-028-003 (tidak ada di ketiga edisi PRM) |
| `<SI>F n` | Top of Form, Set — titik awal cetak (default 20) | PRM p.139 |
| `<SI>h n[,m]` | Printhead Loading Mode — `n=1` mirror, `,m=1` inverse | PRM p.135 |

Kini ketiganya dilaporkan sebagai peringatan `setup-not-modelled` dan punya entri
bantuan perintah. **Diperingatkan, bukan dimodelkan:** besarnya pergeseran adalah
perilaku hardware (interval 5 mil, rentang ±30 dot, `<SI>X` berbunyi *"IPL uses
the system configuration for this setting"*), dan aturan proyek ini adalah tabel
semacam itu diukur, tidak ditebak. Penjaga: `tests/unmodelledSetup.test.ts`.

Bentuk telanjang `<SI>h` (tanpa argumen) tidak memilih mode apa pun — `n` dan `m`
wajib, jadi tidak ada yang berubah dan preview tetap senyap. Tiga sampel yang
di-ship memakai bentuk telanjang itu (kemungkinan salah tulis; contoh Intermec
yang asli berbunyi `<SI>h0,0;`), dan tes menguncinya tetap senyap.

### Tahap 5 selesai 2026-09-27 — tabel setting → efek, diukur bukan diasumsikan

Tujuan proyek ini ("preview ≡ cetak") bergantung pada setting BarTender yang
**tidak hidup di dalam stream IPL**. Tahap 5 memetakan tiap setting ke efek
terukurnya; tabelnya di
[IMPLEMENTATION-BREAKDOWN-2026-09-26.md](IMPLEMENTATION-BREAKDOWN-2026-09-26.md)
("Tabel yang diminta"). Angka diukur dari lima fixture yang halaman aslinya
diketahui dari `tools/bartender/BuildParityLabels.cs`:

```
kanvas preview BarTender = halaman − 16 dot per dimensi  (konten TIDAK bergeser)
<SI>W                    = (sumbu lebar printhead) − 16 − LabelWidthAdjustment
```

> **Koreksi 2026-09-28 (tiga kali, dan yang ketiga tentang cara saya mengukur).**
> Entri ini mula-mula menulis *"memotong 8 dot per tepi"* — **salah**: crop
> menyiratkan pergeseran, dan ground truth membuktikan tidak ada pergeseran
> (objek di halaman x=37 muncul di preview x=37, bukan 29). Lalu menulis
> *"sumbu pendek − 18"* — juga **salah**: `mixed` dan `one-box-landscape`
> sama-sama 4×2 in tapi W-nya 794 vs 388, dan yang membedakan hanyalah
> orientasi.
>
> Lalu menulis *"18 = 16 + 2"* dengan bukti `W + 2 == preview` — **bukti itu
> cacat, ia sirkular**. `W + 2` memang sama dengan `preview` karena keduanya
> diturunkan dari pengukuran yang sama; ia tidak menjelaskan apa pun tentang
> *mengapa* 2. Yang benar: **2 itu `LabelWidthAdjustment`, angka per-model di
> tabel driver Seagull** (`ss#ipl.ddz`, sebenarnya arsip ZIP, berisi `Model.d`;
> `[PD43_203]` → `=2`). PM43 memakai 4, PM4i −40, seri 3400 lama 0 dan bahkan
> tidak mengirim `<SI>W` sama sekali.

Rumus lengkapnya `W = round(sumbu_lebar_in × 203) − 16 − LabelWidthAdjustment`,
diverifikasi **19/19 tanpa mismatch** atas seluruh pengukuran di disk. Karena
adjustment itu **per model**, angkanya **tidak boleh di-hardcode**; ia harus
dibaca per model kalau nanti printer lain perlu didukung.

Yang **tidak** dikerjakan, dan itu keputusan: menyelesaikan "tinggi label yang
diperlukan" dari pergeseran yang terukur menghasilkan angka rapi (389 vs 390)
dan **menyesatkan** — pengukuran pita-per-pita menunjukkan vektor dan raster
bergeser **sama persis**, jadi pergeseran itu milik lapisan halaman, bukan cacat
penempatan DG. Sisa pekerjaan tercatat di breakdown; tidak satu pun memblokir
Fase 5.

**Tindak lanjut 2026-09-28 — guard posisi absolut.** `tests/bartenderAbsolute.test.ts`.
Alasannya konkret dan sudah dibuktikan, bukan teoretis — dengan pergeseran
seragam (4,6) disuntikkan ke renderer, **18 tes** paritas BarTender yang ada
(`bartenderSweep`, `bartenderGeometry`, `bartenderAuto`, `bartenderPageTurn`)
**tetap hijau**, karena semuanya menyelaraskan origin tinta lebih dulu. Guard
baru gagal 5 dari 6 pada injeksi yang sama. Isinya: ukuran konten vs preview
BarTender, geometri kisi (pitch + ukuran kotak) vs ground truth build-script
yang **independen dari renderer BarTender**, dan offset halaman terpaku.

**Selisih absolut TERPECAHKAN 2026-09-28.** Offset yang terpaku di guard itu
semula dicatat "belum dijelaskan". Ternyata ia bukan pergeseran sama sekali
melainkan **bentuk model yang salah**: driver menulis origin Y Direct Graphics
dalam **kerangka terpusat**, `originY = K − pageH/2` — terukur persis, rasio
ΔoriginY/ΔpageH = −0,5000 pada dua pasangan tinggi halaman. Pembaca harus
menambahkan `pageH/2` kembali:

```
y_top = (originY + pageH/2) − maxBit − 424        terverifikasi 10/10 dalam 1 dot
```

Jadi suku `pageH/2` itu **bukan aturan penempatan halaman** melainkan
**membatalkan penskalaan driver** — kalau disubstitusi, `pageH/2` saling
menghapus dan tersisa `y_top = K − maxBit − 424`.

Aturan kita (`hBase = max(extent, originY)`) selalu memberi `hBase = originY`,
sehingga `y` kolaps jadi `minBit` dan setiap graphic mendarat di baris `minBit`
kanvas KONTEN — kita tidak menghitung posisi halaman sama sekali. Itu sebabnya
graphic selalu di atas (89,5 → 1, dst).

Terverifikasi lewat fixture baru yang sengaja dibuat untuk memisahkan variabel
(`sep-land-4x3` 3 in, `sep2-4x25` 2,5 in, `sep-land-4x4` 4 in — `btLandscape`
supaya previewnya tidak terputar), plus tiga fixture dibaca dari frame terputar
sebagai orientasi pembanding. Prediksi `C = 18` di tinggi 812 dikonfirmasi
sebelum diukur.

**Sisa satu besaran: 424 — TERPECAHKAN PENUH 2026-09-28.** Konstanta itu
**setengah lebar area cetak driver**:

```
konstanta = ceil( Stock.Printable.X [dot] / 2 )
```

| driver | `Stock.Printable.X` | /2 | `ceil` | terukur |
|---|---|---|---|---|
| PD43_203 | 4,09 in = 830,27 dot | 415,14 | **416** | **416** ✓ |
| PC23d_203 | 2,13 in = 432,39 dot | 216,20 | **217** | **217** ✓ |

**Dua printer, satu rumus, keduanya cocok** — bukan kecocokan satu sampel.

**Kenapa yang terlihat 424, bukan 416: kerangka ukur.** `printH = pageH − 16`
(inset preview), sehingga `424 − 416 = 8` — persis setengah inset. Keduanya
besaran yang sama: 424 dalam koordinat halaman, 416 dalam koordinat printable.
Begitu tinggi diambil dari **area cetak** (bukan halaman), sebaran enam fixture
turun ke **0,5 dot** dan bentuk tertutupnya muncul.

Verifikasi akhir **7/7 dalam 1 dot** dengan
`y_top = (originY + pageH/2) − maxBit − 424`; rumus `W` ter-commit tetap valid
(diuji ulang 6/6 termasuk `edges`). **Jangan hardcode 416/424** — hitung dari
`Stock.Printable.X` model yang bersangkutan.

### BT PORTRAIT — TERPECAHKAN 2026-09-28: sumbu raster DITRANSPOSISI driver

Batasan yang tadinya "belum diuji" lalu "terukur salah ~42 dot" sekarang
**terpecahkan**. Akar masalahnya bukan konstanta, melainkan **driver menulis
sumbu raster ter-transposisi untuk format `btPortrait`**:

| fixture | orientasi | payload | seharusnya |
|---|---|---|---|
| `por-3x2`, `por-2x3` | btPortrait | 146×268 | 268×146 |
| **`one-box`** | btPortrait (persegi) | 328×430 | 430×328 |
| `landscape`, `grid`, `sep-*` | btLandscape | benar | — |

`one-box` **juga** ter-transposisi. Selama ini tak terlihat karena halamannya
persegi: memutar 90° dan mentransposisi memberi hasil identik. `por-*` yang
pertama non-persegi memisahkannya. **Jadi yang selama ini disebut "page turn"
sebenarnya transposisi sumbu**, yang kebetulan benar untuk halaman persegi.

**Rumus portrait, terverifikasi 7/7 dalam 1 dot** — termasuk fixture validasi
yang halaman, posisi objek, DAN ukuran objeknya semuanya berbeda dari set
derivasi:

```
ink_left = originY − maxBit + (W + 18)/2 − 424
ink_top  = pageHeightDots − originX − inkWidth − 8
```

Payload ditranspose: kolom data → baris visual, bit → kolom visual.

**Dua input dari pemanggil**, karena stream tidak membawa keduanya:
orientasi halaman (memilih rumus mana) dan **tinggi halaman** — sebuah stream
portrait hanya berbunyi `<ESC>C<SI>W591`, tanpa `<SI>L` dan tanpa tinggi.
Keduanya sekarang jadi kontrol viewer (`Page`, dan `Paper mm` yang sudah ada);
kalau kosong, graphics **ditandai di daftar issues**, tidak ditempatkan diam-diam.

**Yang tetap GUGUR** (jangan diulang): `pageY/2`, `pageX/2`, `pageW/2`,
`pageH/2`, min/max/rata-rata kedua sumbu, `W/2` dengan 416 maupun 424, dan
transpose sederhana dengan rumus landscape. Satu kandidat sempat tampak
sempurna — `pageX/2 − 49` cocok **tepat** di kedua fixture portrait — dan
**gagal 100–360 dot** di setiap fixture landscape. Dua titik selalu bisa memuat
dua parameter.

**Yang menyelamatkan dari kesalahan:** model pertama cocok **6/6** di set
derivasi dan **gagal 20,8 dot** di fixture validasi. Angka "154" di dalamnya
adalah fit, bukan konstanta. Model final lulus uji validasi yang sama — itu
yang membedakannya. Penjaga: `tests/dgPortrait.test.ts` (dibuktikan dengan
mematikan jalur portrait: gagal 113 dot).

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
