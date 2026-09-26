# Temuan Audit — Direct Graphics terbalik vertikal (2026-09-26)

> Ditemukan saat menjalankan kampanye ground truth (lihat
> `PROMPT-GROUND-TRUTH-CAMPAIGN.md`). **Ini bug nyata, bukan regresi suite** —
> 1185 tes hijau (85 file) dan `bartenderAuto.test.ts` lolos 10/10 meski
> render kita berbeda dari preview BarTender pada sampel yang sama.

## Ringkasan

`directGraphicToBitmap()` menulis bit Direct Graphic ke **baris** bitmap,
padahal model koordinat yang didokumentasikan di fungsi itu sendiri (dan di
`DirectGraphic.pixels`) menyatakan indeks bit adalah **kolom**. Akibatnya semua
Direct Graphic tercermin vertikal.

Sampel `samples/bartender-parity-base.ipl` yang mengekspos ini adalah kasus
terburuk: BarTender merasterkan **seluruh teks** label ke Direct Graphics, jadi
seluruh isi label tercermin — bukan hanya satu elemen kecil.

## Bukti terukur

Semua angka dari mesin ini, 2026-09-26, `samples/bartender-parity-base.ipl`
vs `testdata/bartender/parity-base.png` (preview BarTender sendiri).

### 1. Streamnya tidak punya frame teks sama sekali

`parseViewerIPL` menghasilkan 7 elemen: `box` 1, `barcode` 3, `line` 1,
`graphic` 2. **Nol elemen `text`.** Tidak ada frame `H` di stream. Tapi preview
BarTender memperlihatkan "PARITY BASE", "Placed by Format Builder", "INSIDE BOX"
(Direct Graphic kedua), "ABC123456789", "5901234123457" dan satu URL.

Kesimpulan: BarTender merasterkan setiap teks ke Direct Graphics. Jalur teks
`H` tidak dipakai sama sekali oleh format ini.

### 2. Graphic sendirian, dibaca langsung

Merender hanya elemen `graphic` lalu membalik canvas secara vertikal:

| | hasil |
|---|---|
| as-is | "PARITY BASE" terbalik di **bawah**, glyph masing-masing terbalik |
| flipV | terbaca benar, urutan baris benar |

Bitmap yang sama, satu transform. `flipV` = benar.

### 3. Baris tinta terpadat (diskriminator numerik)

"PARITY BASE" adalah teks terbesar, jadi baris terpadatnya menandai di mana
konten grafis berada. Posisi sebagai persen dari atas kotak tinta:

| sumber | baris terpadat | posisi |
|---|---|---|
| preview BarTender | 216 | **52.9%** dari atas |
| graphic kita as-is | 342 | **97.7%** dari atas |
| graphic kita flipV | 9 | **2.3%** dari atas |

Baris bitmap terpadat muncul di **baris terakhir** (indeks 342 dari 343) —
sidik jari pasti dari pembalikan baris, karena indeks bit tumbuh ke atas
sementara penulisan baris tumbuh ke bawah.

### 4. Dekomposisi vektor vs raster

Korelasi profil baris terhadap preview BarTender, pada lag 0, dinormalisasi ke
kotak tinta:

| subset | as-is | flipV |
|---|---|---|
| semua elemen | 0.198 | -0.027 |
| tanpa graphic (vektor saja) | 0.205 | **-0.293** |
| hanya graphic | 0.044 | **0.376** |

Elemen vektor (box, line, barcode) sudah benar apa adanya; hanya raster yang
terbalik. Tinta: export 57.602 px, kita 69.143 px — vektor 49.833, raster 27.050.

## Akar penyebab

Model koordinat di `services/ipl/directGraphics.ts` membalik sumbu bit. Ia
mengklaim (doc comment baris 24-27 dan 248-257):

> bit i of a column sits at bottom-up Y = originY - i, i.e. top-down
> y = labelHeightDots - originY + i (**bits grow DOWNWARD** on the label)

Manual menyatakan sebaliknya. Kedua edisi yang dimiliki proyek ini sepakat:

- PRM (Appendix E, "Using Direct Graphics Commands"): *"your printer loads the
  information in the reverse Y direction. Each column of the graphic loads from
  the **bottom to the top**. Y coordinates now start at 0 from the bottom left
  corner and increase in size as the data loads. So, the printer starts loading
  data for the complex graphic at X0,Y450 and loads up to X0,Y425."*
- `docs/manuals/IPL_Command_Reference_K10_937-028-003/Advanced_Printer_Programming_About_Direct_Graphics_Mode.htm`
  (sumber baru 2026-09-26): kalimat yang sama, kata per kata.

Origin Y450 → Y425 berarti bergerak **naik** dari tepi bawah label pada sistem
Y top-down normal IPL (450 adalah tepi bawah label 450-dot). Jadi bit 0 berada
di **bawah**, dan indeks bit bertambah **ke atas** — bukan ke bawah seperti yang
diasumsikan kode.

Dua tempat memakai model yang salah itu dan harus diperbaiki bersama:

1. `directGraphics.ts:269`
   ```ts
   bm[i - minBit][s - box.x] = 1;
   ```
   `bm` diindeks `bm[baris][kolom]`, jadi bit `i` dipetakan ke **baris** dengan
   bit 0 di atas. Pembalikan baris di dalam kotak (`bm[box.h-1-(i-minBit)]`)
   memetakan bit `maxBit` ke baris 0 dan bit `minBit` ke baris terakhir — bentuk
   yang benar untuk urutan bit.

2. `directGraphicVisualBox` (`directGraphics.ts:237-246`)
   ```ts
   y: labelHeightDots - dg.origin[1] + minBit,
   ```
   `minBit` adalah bit **terendah** (top-down y terbesar), bukan baris teratas.
   Dengan model yang benar, tepi atas kotak adalah
   `labelHeightDots - originY - maxBit`. Sumbu X tidak terpengaruh (kolom
   memang maju ke kanan dari origin X), jadi `x` dan `w` sudah benar.

**Perbaikan belum final.** Yang sudah terbukti secara terukur adalah arahnya:
membalik urutan baris bitmap DG membuat render cocok dengan BarTender (lihat
bagian berikut). Bentuk akhir kedua fungsi di atas harus diturunkan bersama dan
diuji, bukan ditempel sebagai satu baris — `offsetY` dan urutan baris wajib
sepakat, dan kalau tidak, gejalanya hanya bergeser, bukan hilang.

## Kenapa 1185 tes tidak menangkapnya

1. **`tests/directGraphics.test.ts:128`** — "manual worked example places bits
   downward from origin" hanya menguji bitmap 1-baris:
   `expect(bitmap.length).toBe(1)`. Bitmap satu baris kebal terhadap pembalikan
   baris — bug-nya tidak bisa diekspresikan. Assertion berikutnya
   (`bitmap[0].filter(v => v).length === 26`) menghitung tinta, bukan posisi.
   **Nama tesnya sendiri mengunci asumsi yang salah.**
2. **`tests/bartenderAuto.test.ts`** — tes "renders a comparable share of the
   export ink" membandingkan **rasio tinta** (0.6–1.6), dan rasio tidak berubah
   oleh pembalikan. Tes "reproduces the content BarTender drew" memakai
   **centroid** untuk menyelaraskan, dan centroid nyaris tidak bergeser oleh
   pencerminan — memori proyek ini sudah mencatat bahwa centroid menyesatkan
   (`verify-parity-needs-completeness`).
3. Golden case `bartender-logo` lolos karena logo adalah bentuk yang
   kebetulan simetris di sumbu itu, atau karena referensinya self-baseline.

**Tidak ada satu pun tes yang menanyakan "di mana" sebuah bit DG berada dalam
sumbu Y.** Semuanya menghitung tinta atau menyelaraskan lewat centroid.

## Dampak pada tujuan utama

Tinggi: setiap label yang teksnya dirasterkan BarTender ke Direct Graphics akan
di-preview terbalik terhadap hasil cetak printer. Ini persis kelas kegagalan
yang proyek ini ada untuk mencegah — preview yang percaya diri tapi salah.

Perlu diperiksa: apakah `directGraphicVisualBox` dan jalur `u`/`G`
(stored-format graphics) membawa kesalahan sumbu yang sama.

## Perbaikan terbukti benar (diuji tanpa mengubah kode sumber)

Probe membalik baris setiap bitmap DG **di dalam tes** (decode →
`bm.reverse()` → `encodeBitmapColumns`) lalu merender ulang. Tidak ada file
sumber yang disentuh.

| varian | korelasi profil baris vs preview BarTender |
|---|---|
| render kita apa adanya | r = **0.198** |
| dengan baris DG dibalik | r = **0.463** |

Kenaikan 2.3×, dan render hasilnya (`C:/Temp/flipfix-render.png`) menunjukkan
"PARITY BASE" / "Placed by Format Builder" terbaca benar dan berada di posisi
yang tepat terhadap box, QR, dan barcode di bawahnya — termasuk tumpang-tindih
QR dengan teks yang memang ada di format aslinya.

Ini menetapkan arah perbaikan: **membalik baris bitmap DG**, bukan membalik
sumbu lain dan bukan mengubah `directGraphicVisualBox` saja.

## Bukti lintas-sampel: ini sistematis, bukan satu format

Diuji pada tiga sampel BarTender yang punya preview benar-benar dari `.btw`
yang sama:

| sampel | graphic | elemen vektor | r(as-is) | r(DG-dibalik) | verdict |
|---|---|---|---|---|---|
| `bartender-parity-base` | 2 | 5 | 0.198 | **0.463** | mirror |
| `bartender-auto` (template Seagull) | 4 | 3 | 0.354 | **0.368** | mirror |
| `bartender-tes1` | 3 | 23 | 0.798 | 0.798 | sinyal tenggelam di 23 elemen vektor |

`bartender-auto` diverifikasi **secara visual**: render as-is memperlihatkan
seluruh teks tercermin ("COMMODITY/VARIETY", "Pack/Weight, Grade", "Pack Date",
"PLU 4087", string GS1 `(01) 1 0850510 00201 1 (13) 210901 …`) dengan glyph
terbalik; setelah baris DG dibalik semuanya terbaca benar dan tata letaknya
cocok dengan preview BarTender. Karena ini template bawaan Seagull yang tidak
kita susun sendiri, ia membuktikan cerminnya bukan artefak format kita.

`bartender-tes1` tidak bisa memutuskan apa pun lewat korelasi profil: 23 elemen
vektornya mendominasi sinyal. Ia **bukan** bukti ketiadaan cermin.

Round-trip `decode → reverse → encode` juga diverifikasi lossless
(`roundtripDiff=0` untuk seluruh 9 graphic di ketiga sampel), jadi perbaikan
baris tidak akan merusak jalur encode.

## KOREKSI 2026-09-27 — ada DUA cacat, bukan satu

Audit di atas menemukan cerminnya tetapi **mengaitkan seluruh selisihnya pada
satu penyebab**. Eksperimen 2×2 (cermin × sumber tinggi label) menunjukkan ada
**dua cacat independen** yang keduanya harus diperbaiki.

**Cacat kedua: label.heightDots null → hBase jatuh ke 352, padahal label 388.**

`viewerParser.ts` menghitung `hBase` dari `label.heightDots ?? 0`, dan kalau nol
memakai `max(el.oy + el.heightDots)` dari elemen. Pada `parity-base` tidak ada
`<SI>L`, jadi `heightDots` **null** dan fallback memberi **352** — sementara
`<SI>W388` menyatakan label itu **388** dot. Origin Y Direct Graphics bersifat
bottom-up terhadap tinggi label, jadi salah 36 dot menggeser **setiap** graphic
ke bawah. Ini juga menjelaskan kenapa `directGraphicVisualBox` di probe
menghasilkan `y=343..343` (kotak setinggi 0 di dasar label 352).

Matriks 2×2, korelasi profil baris terhadap preview BarTender:

| cermin | tinggi | r | baris terpadat |
|---|---|---|---|
| as-is | as-is | 0.207 | 60.5% |
| as-is | **diperbaiki** | 0.327 | 50.3% |
| **diperbaiki** | as-is | 0.459 | 60.5% |
| **diperbaiki** | **diperbaiki** | **0.558** | **50.3%** |
| | *BarTender* | | *52.7%* |

Keduanya menyumbang, dan bersama-sama keduanya cocok: baris terpadat 50.3% vs
52.7% milik BarTender. Empat kombinasi lain jelas lebih buruk.

**Kenapa ini penting untuk sesi berikutnya.** Memori
`ipl-direct-graphics-placement` (sesi 2026-09-19) mencatat "ground truth dari
brute-force ink-pattern matching" yang menyimpulkan bit tumbuh **ke bawah**.
Pencocokan itu dilakukan di bawah render bertinggi **352** — tinggi yang salah —
sehingga dua kesalahan itu sebagian saling menutupi dan konklusinya terbalik.
Ini bukan berarti sesi itu ceroboh: ia cocok dengan export, dan export adalah
satu-satunya oracle saat itu. Yang berubah sekarang adalah ada oracle kedua
(preview BarTender + manual K10) yang memisahkan keduanya.

**Konsekuensi untuk resep perbaikan:** memperbaiki cermin saja (0.459) lebih
buruk daripada memperbaiki keduanya (0.558). Urutan kerja tidak boleh
memperbaiki satu lalu menguji, karena hasil antaranya akan terlihat mengecewakan
dan menggoda untuk dibatalkan.

## Cakupan: hanya jalur Direct Graphics, bukan semua graphic

Proyek ini punya DUA konvensi penyimpanan graphic, dipilih di
`decodeGraphicColumns` (`graphics.ts:143`) oleh `stripsAsRows`:

| jalur | konvensi | pembalikan | status |
|---|---|---|---|
| Direct Graphics (`<ESC>g0`/`g1`) | bit menyusun kolom | **tidak ada** | ❌ terbalik |
| Stored graphic (`G`/UDC, logo) | strip = baris, bit melintang, LSB-first | `bitmap.reverse()` (`graphics.ts:167`) | ✅ benar |

Diuji pada `samples/bartender-logo.ipl` (384×122, `dataLen=122` → jalur
stripsAsRows): render menampilkan "Intermec" **tegak dan terbaca**. Jadi jalur
stored graphic tidak terpengaruh, dan perbaikan tidak boleh menyentuhnya.

Ini juga menjelaskan kenapa cerminnya sistematis pada semua sampel BarTender
berbasis Direct Graphics: seluruhnya jatuh ke cabang column-major yang tidak
punya pembalikan, sementara cabang satunya sudah punya.

Inventaris konvensi per sampel (semua column-major kecuali logo):

    parity-base g1 319x342 dataLen=319 stripLen=57  column-major
    parity-base g2 463x349 dataLen=463 stripLen=59  column-major
    auto g1        199x784 dataLen=199 stripLen=235 column-major
    auto g2         51x736 dataLen=51  stripLen=131 column-major
    auto g3         12x225 dataLen=12  stripLen=38  column-major
    auto g4         22x610 dataLen=22  stripLen=102 column-major
    tes1 g1         70x117 dataLen=70  stripLen=20  column-major
    tes1 g2         32x207 dataLen=32  stripLen=35  column-major
    tes1 g3         59x742 dataLen=59  stripLen=124 column-major
    logo           384x122 dataLen=122 stripLen=64  stripsAsRows

## Yang belum dikerjakan

- Perbaikan kode: **belum**, sesuai instruksi kampanye (audit dulu, kode
  belakangan). Perbaikan satu baris ada di bagian "Akar penyebab".
- `directGraphicVisualBox` memakai model koordinat yang sama; kesalahan sumbu
  yang sama harus diperiksa di sana sebelum menulis perbaikan final, karena
  `offsetY` dan urutan baris harus sepakat.
- Sampel lain (`bartender-tes1.ipl`: 3 graphic, `bartender-auto.ipl`: 4 graphic)
  belum diuji ulang terhadap preview masing-masing setelah perbaikan.
  Keduanya punya elemen vektor lebih banyak sehingga sinyalnya lebih lemah
  daripada parity-base, yang seluruh teksnya dirasterkan.
