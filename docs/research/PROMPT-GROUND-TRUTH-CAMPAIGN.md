# Prompt: Kampanye ground truth IPL — riset, reverse engineering BarTender, audit, breakdown

> Tempel seluruh isi blok di bawah ke sesi Claude Code baru yang dibuka di repo ini.
> Jangan dipendekkan: setiap "jangan ulangi" di dalamnya adalah kesimpulan yang
> sebelumnya sudah terbukti salah dan pernah membuang satu sesi penuh.

---

## PROMPT (mulai dari sini)

Kamu bekerja di repo `D:\RR\PROJECT LAMA\WEB\honeywell-ipl-label-designer (5)`,
branch `main`. Ini aplikasi web (React + TypeScript + Vite) yang mendesain label
dan menghasilkan kode IPL (Intermec Printer Language) untuk printer Honeywell/
Intermec (PD43, 203 dpi sebagai referensi).

**Tujuan utama, dan satu-satunya ukuran keberhasilan:** kode IPL yang dihasilkan
aplikasi ini, saat dicetak di printer Intermec sungguhan, identik dengan preview
yang ditampilkan aplikasi. Dan preview/desain BarTender yang dikonversi menjadi
IPL oleh BarTender adalah representasi akurat dari hasil cetak printer Intermec
sungguhan — dengan syarat BarTender sudah disetel dengan benar sebelumnya
(kontrak setting itu ada di bagian "Kontrak BarTender" di bawah, dan kamu WAJIB
memverifikasi ulang, bukan menganggapnya).

Pekerjaan ini ada EMPAT tahap berurutan. Jangan loncat ke implementasi kode
sebelum tahap 1–3 selesai dan tertulis. Output akhir yang diminta adalah
**breakdown tahap demi tahap pengerjaan**, bukan kode.

---

### TAHAP 1 — Cari semua sumber daya IPL yang belum kita punya

Lakukan riset internet mendalam untuk menemukan sumber pengetahuan IPL yang BELUM
ada di repo ini. Sebelum mencari, baca dulu apa yang sudah dimiliki supaya kamu
tidak mengunduh ulang:

**Sudah dimiliki** (`docs/manuals/`):
- `IPL_Programmers_Reference_Manual.pdf` + `.txt` (PRM, rujukan utama)
- `IPL_2.70_Programmers_Reference_Manual.pdf` + `.txt` (PRM 2.70)
- `IPL_4400_Reference_Manual.pdf` + `.txt`
- `IPL_Developers_Guide.pdf` + `.txt`
- `IPL_Command_Reference_Manual.chm` (plus `chm_dir.json`)
- `IPL-CHEATSHEET.md`, `IPL-RENDER-SPEC.md` (spesifikasi render hasil turunan manual)

**Sudah dimiliki** (`docs/research/`): `LABELIZE-ARCHITECTURE.md`,
`ECOSYSTEM-SURVEY.md`, `ARCHITECTURE-PATTERNS.md`, `SMALL-REPOS-AND-LIBS.md`,
`PORTAKAL-STUDY.md`, `GOLDEN-TESTING.md`, `BARTENDER-COMMAND-AUDIT.md`,
`DG-REPEAT-2026.md`, `ROADMAP.md`.

Yang WAJIB dicari (dan laporkan "tidak ditemukan" secara eksplisit bila memang
tidak ada, lengkap dengan query yang dipakai):

1. **Firmware notes / release notes** printer IPL (PD43, PM43, PC43, PF8, PX4/6,
   4400, 3400) yang menyebut perubahan perilaku perintah — terutama font resident,
   Direct Graphics, dan interpretasi `h`/`w` pada outline font. Honeywell punya
   artikel knowledge base bernomor (contoh yang sudah diketahui: 000075988
   menyatakan TIDAK ADA simulator resmi).
2. **Font resident bitmap** printer: metrik glyph resmi (cell width, gap, baseline)
   untuk font `c0`–`c7` dan turunannya, serta apakah face outline printer (c20–c41)
   berbasis font tertentu yang bisa diidentifikasi (kita sekarang memakai Liberation
   sebagai aproksimasi — ini salah satu dari dua pertanyaan terbuka yang tersisa).
3. **Appendix B tabel substitusi resident** (`n=0`–`n=9`, language substitution)
   dari sumber resmi, untuk dibandingkan dengan tabel yang sudah kita rekonstruksi.
   Ini pertanyaan terbuka kedua.
4. **Contoh stream IPL nyata** dari sumber selain BarTender: output printer driver
   Windows Intermec/Honeywell, contoh dari Developer's Guide yang belum diekstrak,
   repositori publik (portakal, labelize, dan yang lebih baru dari survei terakhir).
5. **Dokumen semantik yang masih abu-abu**: perilaku `<ESC>g` Direct Graphics pada
   firmware berbeda, `<SI>l` code page di luar yang sudah kita petakan
   (cp850/1250–1258/874/UTF-8), dan perintah yang PRM sebut "printer dependent".
6. **Sumber DPL** (Datamax): manual pemrograman resmi atau contoh `.dpl`/`.prn`
   nyata. DPL sengaja TIDAK dibangun karena tidak ada sumber otoritatif — lihat
   `docs/research/ROADMAP.md` bagian "DPL". Kalau ketemu, catat saja; jangan bangun.

Unduh setiap dokumen yang ditemukan ke `docs/manuals/` (biner) dan ekstrak
teksnya. Jangan pernah mengklaim sebuah fakta dari ingatan: kutip file dan
halaman.

### TAHAP 2 — Reverse engineering BarTender di komputer ini, menyeluruh

BarTender 2022 R8 terpasang di mesin ini (trial, `C:\Program Files\Seagull\BarTender 2022\`).
Toolchain otomasi SUDAH ADA dan SUDAH TERBUKTI di `tools/bartender/` — baca
`tools/bartender/README.md` sebelum menulis satu baris pun. Jangan bangun ulang
dari nol dan jangan ulangi jalan buntu yang sudah terdokumentasi di
`tools/bartender/probes/README.md`.

**Kontrak yang sudah terbukti (verifikasi, jangan anggap — tapi jangan juga
buang waktu membuktikan ulang yang sudah dikunci tes):**

- Satuan COM selalu milimeter (`btUnitsMillimeters`), apa pun yang dideklarasikan
  format. Menulis dalam inci menggeser semuanya 25.4× keluar halaman.
- Angka di BTXML harus invariant-culture; di locale koma-desimal `0.1` jadi `0,1`
  dan script ditolak dengan error 3908.
- Objek HANYA bisa ditulis setelah `XMLScript CreateFormat` lalu `Formats.Open`.
  `Formats.Add()` melempar "allowed only when running document event scripts".
- Isi field (`SetXML`/`SetProperty`) diterima lalu diabaikan diam-diam di luar
  document-event script. Sweep yang ada adalah GEOMETRI saja.
- Symbology barcode tidak terekspos di mana pun di 196 tipe `Interop.BarTender.dll`.
- `PrintToFile` ditolak lisensi trial (error 2610). Jalur yang bekerja: file port
  spooler lewat `tools/bartender/bt-port.ps1` (butuh elevated, sekali), output ke
  `C:\Temp` karena path repo mengandung spasi dan tanda kurung yang ditolak
  BarTender.
- Printer harus di-assign pada `Format`, bukan `<FormatSetup>`, kalau tidak
  BarTender diam-diam jatuh ke Microsoft Print to PDF.
- Error 3704 = stok melebihi media PD43, bukan kegagalan tool.

**Setting BarTender yang membuat IPL-nya merepresentasikan cetakan nyata**
(ini yang dimaksud "settingan sedemikian rupa" — konfirmasi masing-masing terhadap
driver dan terhadap stream yang dihasilkan):

- Printer: `Intermec PD43 (203 dpi) - IPL`.
- Page setup: stok 4 in × 2 in, **landscape**, margin 0.1 in. Page setup BarTender
  memutar SELURUH label 90° CCW relatif terhadap koordinat IPL mentah. Rotasi ini
  hidup DI LUAR stream IPL — tidak ada perintah di stream yang menyatakannya.
  Konsekuensi: membandingkan render IPL mentah dengan export PNG BarTender tanpa
  menerapkan rotasi halaman ini adalah perbandingan yang salah. (Koreksi 2026-09-24:
  arahnya CCW, bukan CW — CW menghasilkan cermin.)
- Direct Graphics: BarTender mengirim `<ESC>g0`/`g1`; `g1` = nibble-encoded dan
  harus decode identik dengan `g0`.
- HRI barcode: BarTender mengirim field `H` terpisah, bukan modifier `i`. Default
  `i` adalah 0 (mati) sesuai PRM p.192.

**Yang harus dihasilkan tahap ini** (semua lewat toolchain yang ada, semua file
mentah disimpan di `C:\Temp` lalu yang lolos kurasi disalin ke `testdata/`):

1. **Inventaris driver**: dump semua devmode/setting driver IPL PD43
   (`probes/export-driver-settings.ps1` sudah ada sebagai titik mulai) dan petakan
   setting mana yang mengubah byte stream — terutama printhead width, label origin,
   rotation, direct graphics mode, code page, dan margin yang tidak bisa di-nol-kan.
2. **Matriks stream terkontrol**: untuk tiap jenis objek (teks bitmap, teks outline
   per font c20–c41, box, line, barcode per symbology yang bisa dipilih manual,
   graphic, tanggal), hasilkan minimal satu `.btw` → IPL (via file port) + PNG
   preview (via `PreviewExport.exe`) dengan geometri yang diketahui persis.
   Isi field yang tidak bisa diset via COM dibuat dengan menyunting `.btw`
   (itu ZIP berisi XML) secara langsung — verifikasi dulu bahwa hasil suntingan
   masih dibuka BarTender.
3. **Diff setting**: cetak format identik dengan page setup portrait vs landscape,
   margin 0 vs 0.1, 203 vs 300 dpi (bila driver punya), lalu catat PERSIS byte
   mana yang berubah. Tujuannya mengetahui setting mana yang "tidak terlihat" di
   stream tapi mengubah cetakan.

### TAHAP 3 — Audit mendalam semua data yang terkumpul

Audit = setiap klaim dihukum dengan bukti, dan setiap bukti diperiksa kelengkapan
pasangannya. Pelajaran yang sudah dibayar mahal di repo ini, yang WAJIB diterapkan:

- **Kelengkapan, bukan sekadar kecocokan.** Pernah ada tes yang lolos padahal
  stream dan gambarnya beda format (21% tinta). Pasangan stream↔gambar hanya sah
  bila tinta kedua sisi berada di pita yang sama (lihat
  `tests/bartenderPairing.test.ts`). `bartender-tes2.ipl` dan
  `bartender-tes2-export.png` BUKAN pasangan — jangan dipakai.
- **Asal file harus dibuktikan, bukan ditebak.** `testdata/bartender-tes1-render.png`
  dan `tes1-portrait.png` adalah render KITA SENDIRI yang gagal (warna
  `169,171,247` = border kanvas kita, `226,153,68` = placeholder oranye). Diff
  hanya terhadap `*-export.png` yang asli.
- **Pixel cocok bukan bukti layout cocok, dan sebaliknya.** Font beda mesin
  menghasilkan beda piksel yang sah. Sinyal yang bermakna: bounding box tinta
  (asal-usul tinta, bukan centroid) dan struktur perintah. Toleransi piksel tanpa
  argumen adalah angka kosong.
- **Satu objek per fixture** untuk menyimpulkan satu aturan. Fixture campur-aduk
  menghasilkan kesimpulan yang percaya diri tapi salah.
- **Jangan menyimpulkan dari tes yang lolos.** 772 tes hijau pernah menyembunyikan
  generator yang menulis `I<n>` sebelum `B<n>`-nya. Tiap temuan audit harus
  menyebut tes mana yang SEHARUSNYA gagal andai perilaku itu salah — dan bila
  tidak ada, itu sendiri adalah temuan.
- **Klaim "tidak ada" diperiksa dua kali** dengan cara berbeda. Grep case-sensitive
  pernah membuat fitur yang ada dilaporkan hilang.

Hasil audit ditulis sebagai tabel: temuan → bukti (file, perintah, angka terukur)
→ status (terbukti / terbantah / belum ada bukti) → dampak pada tujuan utama.

### TAHAP 4 — Breakdown implementasi

Petakan SEMUA pekerjaan tersisa menjadi tahapan yang bisa dikerjakan satu per satu,
diurutkan berdasarkan dampaknya terhadap tujuan utama. Untuk tiap tahap tuliskan:
apa yang diubah (file), bagaimana membuktikannya (tes atau pengukuran yang gagal
dulu, lalu lolos), dan apa yang sengaja TIDAK dikerjakan beserta alasannya.

Konteks yang tidak boleh diabaikan saat menyusun urutan:

- Seluruh §15 `IPL-RENDER-SPEC` sudah tertutup (2026-09-25). Jangan buka ulang
  sebagai "riset" — hanya buka bila bukti baru dari tahap 1–3 membantahnya.
- Dua pertanyaan yang benar-benar masih terbuka: (a) apakah face outline printer
  selebar Liberation, (b) apakah firmware memakai tabel substitusi resident yang
  sama dengan Appendix B. Keduanya terblokir hardware, bukan pengetahuan —
  kecuali tahap 1 menemukan dokumen yang menjawabnya.
- Tidak ada simulator firmware resmi. Ground truth akhir tetap printer fisik;
  BarTender + Labelary adalah proxy, dan Labelary TIDAK memodelkan rotasi halaman
  BarTender (sampel `bartender-tes1/tes2` terpotong di sana — jangan dipakai untuk
  crosscheck).
- Bahasa lain (ZPL, EPL, TSPL) sudah dibangun di `services/`; DPL sengaja ditunda.
  Jangan melebar ke bahasa lain kecuali bukti IPL bergantung padanya.

### Cara bekerja

- Baca `docs/research/ROADMAP.md` dan `docs/HANDOFF-IPL-RENDER.md` sebelum
  melakukan apa pun.
- Setiap angka yang kamu laporkan harus hasil pengukuran di mesin ini (sebutkan
  perintahnya), bukan perkiraan. Bila tidak bisa diukur, tulis "tidak terukur".
- Simpan semua artefak mentah dan tulis jejak setiap percobaan yang GAGAL beserta
  alasan pastinya — repo ini berkali-kali terselamatkan oleh catatan jalan buntu.
- Jangan mengubah kode aplikasi di pekerjaan ini. Output kamu adalah dokumen:
  sumber baru + hasil RE + tabel audit + breakdown, ditulis ke `docs/research/`.

## AKHIR PROMPT
