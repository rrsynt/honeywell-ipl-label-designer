# Breakdown implementasi — menuju preview ≡ cetak printer Intermec

> Disusun 2026-09-26 dari kampanye ground truth
> (`PROMPT-GROUND-TRUTH-CAMPAIGN.md`), temuan audit
> (`AUDIT-DG-VERTICAL-MIRROR-2026-09-26.md`), dan sumber baru di `docs/manuals/`.
> Urutan berdasarkan **dampak terhadap tujuan utama**, bukan kemudahan.
>
> Tujuan utama: kode IPL yang dihasilkan aplikasi ini, saat dicetak di printer
> Intermec sungguhan, identik dengan preview-nya; dan desain BarTender yang
> dikonversi ke IPL merepresentasikan cetakan printer itu secara akurat.

---

## Ringkasan status hari ini

| Aspek | Status |
|---|---|
| Toolchain BarTender (print→IPL + preview PNG) | ✅ tereproduksi byte-identik hari ini |
| Paritas vektor (teks `H`, box, line, barcode) | ✅ terkunci tes, cocok dengan export |
| Paritas raster Direct Graphics | ❌ **tercermin vertikal** — Tahap 1 di bawah |
| §15 IPL-RENDER-SPEC | ✅ tertutup (2026-09-25) |
| Sumber baru 2026-09-26 | 4 PDF + 10 halaman HTML (lihat Tahap 5) |

---

## Tahap 1 — Perbaiki posisi vertikal Direct Graphics (DUA cacat, bukan satu)

**Kenapa ini nomor satu.** Ini satu-satunya cacat yang membuat preview
*berbeda dari cetakan* pada label nyata, dan terjadi pada semua sampel
BarTender berbasis Direct Graphics yang kami uji. BarTender merasterkan
seluruh teks ke DG ketika font yang dipilih bukan font resident printer,
jadi dampaknya bukan sudut kecil — di `parity-base` **seluruh isi label**
salah tempat.

**Bukti.** `docs/research/AUDIT-DG-VERTICAL-MIRROR-2026-09-26.md`.

**Ada DUA cacat independen** (ditemukan lewat matriks 2×2 pada 2026-09-27,
lihat bagian KOREKSI di dokumen audit). Matriks korelasi terhadap preview
BarTender:

| cermin | tinggi label | r |
|---|---|---|
| as-is | as-is | 0.207 |
| as-is | diperbaiki | 0.327 |
| diperbaiki | as-is | 0.459 |
| **diperbaiki** | **diperbaiki** | **0.558** |

### Cacat A — bitmap DG tercermin vertikal

`directGraphics.ts` memodelkan bit tumbuh **ke bawah**; manual (PRM Appendix E
+ `IPL_Command_Reference_K10` yang baru diunduh) menyatakan bit tumbuh **ke
atas**: *"Each column of the graphic loads from the bottom to the top …
starts loading at X0,Y450 and loads up to X0,Y425."*

### Cacat B — `hBase` memakai tinggi label yang salah

Origin Y Direct Graphics bersifat bottom-up terhadap tinggi label. Di
`viewerParser.ts`, `hBase` dihitung dari `label.heightDots ?? 0` dan kalau nol
memakai fallback `max(el.oy + el.heightDots)`. Pada `parity-base` tidak ada
`<SI>L`, jadi `heightDots` **null** dan fallback memberi **352** — sementara
`<SI>W388` menyatakan label itu **388** dot. Setiap graphic tergeser 36 dot.

**Catatan penting:** cacat B bukan "fallback-nya kurang pintar". Fallback itu
ada karena DG bisa disebut sebelum tinggi label diketahui. Yang salah adalah
memakai **content extent** sebagai pengganti tinggi label ketika stream
**menyatakan** tingginya lewat `<SI>W`. Perbaikan harus membaca W.

**Yang harus diubah, ketiganya bersama:**

| File | Perubahan |
|---|---|
| `services/ipl/viewerParser.ts` (~366-374) | `hBase` mengambil tinggi dari `<SI>W`/`<SI>L` yang sudah diparse, bukan content extent |
| `services/ipl/directGraphics.ts:269` | urutan baris bitmap: bit `maxBit` → baris 0 |
| `services/ipl/directGraphics.ts:237-246` | `directGraphicVisualBox` — tepi atas = `labelHeightDots - originY - maxBit` |

Ketiganya harus diturunkan dari model yang sama dan diuji bersama: `offsetY`
dan urutan baris wajib sepakat, atau gejalanya cuma bergeser.

**⚠️ Jangan memperbaiki lalu menguji satu per satu.** Memperbaiki cermin saja
memberi 0.459 — lebih buruk daripada 0.558 milik keduanya — sehingga hasil
antaranya terlihat mengecewakan dan menggoda untuk dibatalkan. Kerjakan
ketiganya, baru ukur.

**Cara membuktikan (tes harus GAGAL dulu):**

1. Tes baru: bitmap DG asimetris vertikal — klaim posisi bit, bukan jumlah
   tinta. Yang ada sekarang (`directGraphics.test.ts:128`) memakai bitmap
   1-baris sehingga kebal; **nama tesnya sendiri mengunci asumsi yang salah**
   dan harus diganti namanya.
2. Tes baru untuk cacat B: label dengan `<SI>W` tapi tanpa `<SI>L` — `hBase`
   harus sama dengan W, bukan dengan content extent. Ini tes yang berdiri
   sendiri dan **tidak** butuh BarTender.
3. Guard paritas: bandingkan dengan `testdata/bartender/parity-base.png`
   memakai **profil baris**, bukan centroid atau rasio tinta. Ambang: naik ke
   ≥0.50 (terukur 0.558 setelah kedua perbaikan).
4. Jalankan ulang ketiga sampel; `tes1` tidak bisa memutuskan apa pun lewat
   korelasi (23 elemen vektor mendominasi) jadi ia butuh mata manusia atau
   fixture satu-objek.

**Konsekuensi pada memori proyek.** `ipl-direct-graphics-placement` mencatat
"ground truth brute-force ink-pattern matching" yang menyimpulkan bit tumbuh
ke bawah. Pencocokan itu berjalan di bawah tinggi 352 yang salah, sehingga dua
kesalahan saling menutupi. Memori itu perlu dikoreksi setelah perbaikan
mendarat — kalau tidak, sesi berikutnya akan mempercayai konklusi yang
terbalik.

**Yang sengaja TIDAK dikerjakan:** menyentuh jalur `stripsAsRows`
(`graphics.ts:143`). Diuji pada `bartender-logo.ipl`: render "Intermec" sudah
tegak. Perbaikan yang menyentuhnya akan merusak yang sudah benar.

**Risiko:** golden `bartender-logo` dan tes DG lama akan tetap hijau — keduanya
tidak bisa mengekspresikan bug ini. Jangan jadikan "suite hijau" sebagai bukti.

---

## Tahap 2 — Guard yang bisa menangkap kelas bug ini

**Kenapa.** Tiga kali sekarang suite hijau menyembunyikan cacat nyata
(772 tes vs urutan `I<n>`/`B<n>`; 605 tes vs resize canvas; 1185 tes vs cermin
ini). Pola yang sama: tes mengukur **tinta** atau menyelaraskan lewat
**centroid**, dan keduanya tahan terhadap transformasi yang merusak layout.

**Yang harus diubah:**

| File | Perubahan |
|---|---|
| `tests/bartenderAuto.test.ts` | ganti penyelarasan centroid dengan **profil baris/kolom** di dalam kotak tinta, lag 0 |
| (baru) | guard asimetri: setiap fixture paritas wajib punya setidaknya satu elemen yang **tidak simetris** di sumbu yang diuji |

Ambang dinyatakan sebagai angka dari pengukuran, bukan pilihan: r≥0.40 untuk
sampel berbasis DG (nilai terukur setelah perbaikan 0.463, sebelum 0.198).

**Yang sengaja TIDAK dikerjakan:** menambah tes ke `directGraphics.test.ts`
yang ada — ia hijau dan akan terus hijau; menambahnya di sana menyamarkan
bahwa cakupannya kurang.

---

## Tahap 3 — Terapkan temuan sumber baru

Empat dokumen masuk hari ini (`docs/manuals/`). Dua menyentuh langsung tujuan
utama dan belum diolah:

### 3a. Offset cetak 3 mm — `IPL_Migration_Considerations_PM43_PC43_TechBrief.pdf`

> *"The fixed offset of 3mm for all print heads along system x axis (IPL y
> axis) printing position may not be same as PD41/42, PF2/4i, PM4i and
> PX4/6i upgrade printers. You may need to adjust system X margin (IPL y axis)
> or start/stop (IPL x axis) adjust to achieve legacy printing positions."*

**Kenapa penting.** 3 mm pada 203 dpi ≈ 24 dot. Itu pergeseran yang terlihat
mata dan persis jenisnya yang membuat "preview bagus, cetakan meleset".
Proyek ini belum memodelkannya. Perlu diputuskan: apakah ia milik
*post-processing BarTender* (seperti rotasi halaman) atau milik *firmware*
(yang berarti preview kita harus ikut menggeser).

**Cara memutuskan.** Dua format identik dengan margin sistem berbeda, cetak
lewat file port, ukur pergeseran tinta terhadap `W`/`L`. Bukan dibaca dari
dokumen — diukur.

### 3b. Font resident metrically compatible — tech brief yang sama

> *"New printer resident fonts do not exactly match legacy fonts in terms of
> character look, but care was taken to ensure the new fonts are metrically
> compatible (fit in the same space) with legacy fonts."*

Ini **sebagian menjawab pertanyaan terbuka (a)** ("apakah face outline printer
selebar Liberation"). Yang dinyatakan adalah kompatibilitas **metrik antar
generasi font printer** — bukan bahwa face-nya selebar Liberation. Jadi
pertanyaannya menyempit tapi tidak tertutup: yang perlu diukur tetap lebar
advance printer nyata.

Juga: *"Outline Fonts — Download of outline fonts using IPL commands is not
supported."* Itu menutup satu jalur (menanam font sendiri via `j`/`J`) dan
mengonfirmasi c20–c41 harus dirender dari font resident printer.

### 3c. Bug firmware terdokumentasi — `IPL_Firmware_Release_Notes_K10_v9_P10_v9.pdf`

Daftar issue ID + deskripsi, sangat berguna sebagai penjelas kalau printer
nyata berperilaku beda dari spesifikasi. Yang menyentuh area kita, kutipan
verbatim:

- `15952 IPL direct graphics mode command <ESC>g1 doesn't work`
- `16349 IPL graphics problem (when using <ESC>g1 command)`
- `16350 IPL graphics problem (when using IPL UDC commands)`
- `16395 Direct graphics can't be printed if using binary controlcode`
- `15002/15007/15009 EAN/UPC positioning & overlap issues`
- `15939 IPL: Missing human readable and barcodes on printout`
- `11136.2 Printer hangs when printing Font page with variable data`

**Implikasi praktis:** tiga issue pertama persis di jalur yang baru kita
perbaiki. Kalau printer target memakai firmware sebelum perbaikan, `g1` bisa
saja **memang tidak bekerja** di lapangan — dan itu bukan bug preview kita.
Ini harus dicatat di panduan kalibrasi, bukan dipatok sebagai tes.

### 3d. PRM edisi `066396-003`

Edisi keempat PRM yang proyek ini miliki. Belum dibandingkan dengan yang sudah
dipakai. **Tugasnya:** diff terhadap `IPL_Programmers_Reference_Manual.txt`
untuk mencari perbedaan nomor halaman/semantik yang membuat kutipan di kode
menunjuk halaman yang salah. Kutipan halaman yang salah adalah kelas bug
dokumentasi yang sudah pernah menggigit proyek ini.

---

## Tahap 3b-bis — Parameter `m` pada `c` diabaikan (celah, bukan bug yang tampak)

**Terverifikasi langsung ke manual**, bukan dari laporan riset:
`docs/manuals/IPL_Command_Reference_K10_937-028-003/Font_Type_Select_K10.htm`

> Syntax `c n [, m ][, p ]`
> `m` — **Intercharacter gap** (space between characters). **Default is 0.
> Range is −199 to 399.**
> `p` — Name of the font.

Halaman itu menyatakan tujuannya *"Selects a font type for human-readable and
interpretive fields"* — perintah field yang sama dengan yang dipakai stream kita,
bukan perintah upload font yang berbeda.

**Kondisi kode sekarang:** `viewerParser.ts:980` dan `:1130` keduanya melakukan
`.split(',')[0]` — hanya `n` yang dibaca. `m` dan `p` dibuang tanpa peringatan.

**Kejujuran cakupan — ini penting:** tidak ada satu pun sampel di repo
(`samples/`, `testdata/golden/`) yang memakai `m`. Yang ada hanya bentuk
`c6,0,0` dan itu parameter **barcode** pada frame `B`, bukan font. Jadi ini
**celah implementasi yang belum pernah muncul di data**, bukan bug yang
menghasilkan preview salah hari ini.

**Kenapa tetap dikerjakan:** kalau ada yang menulis `c25,3` (atau generator
BarTender mengirimnya untuk objek dengan character spacing), label akan
ter-render tanpa gap dan lebarnya salah — tanpa peringatan apa pun. Itu persis
kelas kegagalan diam-diam yang proyek ini ada untuk mencegah.

**Cara membuktikan.** Tes: field `H` dengan `c25,3` vs `c25` harus menghasilkan
lebar berbeda sebesar `3 × (jumlah karakter − 1)` dot. Tes itu **gagal** pada
kode sekarang, dan itulah buktinya.

**Risiko kalau salah:** `m` bernilai negatif (−199..399) berarti karakter bisa
saling tumpang-tindih. Perlu keputusan eksplisit apakah preview menirukan
tumpang-tindih itu (menurut saya ya — printer melakukannya).

### Konfirmasi: default `h` per tipe field SUDAH benar

Klaim riset bahwa `h` punya default berbeda per tipe field — **diverifikasi ke
`Height_Magnification_K10_937-028-003.htm`** dan ternyata kode kita sudah
sesuai. Tabel manual: box **100**, bar code **50**, UDC **1**, graphics **1**,
human-readable **2**, POSTNET **2**. Parser memakai tepat himpunan itu
(`viewerParser.ts:998` teks→2, `:1189` barcode→50, `:1520` box→100, `:1562`
UDC→1). **Tidak ada pekerjaan di sini** — dicatat supaya tidak ada yang
"memperbaikinya" nanti.

---

## Tahap 4 — Tutup dua pertanyaan yang benar-benar tersisa

**Pertanyaan (a) BERUBAH SIFAT: tidak lagi terblokir printer.**

`ROADMAP.md` dan `HONEYWELL-SIMULATOR.md` mencatatnya sebagai *"apakah face
outline printer selebar Liberation"* — pertanyaan yang butuh printer karena
face-nya tidak diketahui. Face-nya **sekarang diketahui**:

Sumber: `docs/manuals/IPL_Command_Reference_K10_937-028-003/Font_Type_Select_K10.htm`,
tabel yang saya baca sendiri (bukan dari laporan riset):

| id | Nama di `constants.ts` | **Face asli printer** |
|---|---|---|
| 20, 21, 22 | "8/12/20 point monospace" | **Andale Mono** |
| 25 | "Swiss Mono 721" | **Andale Mono** |
| 26 | "Swiss Mono 721 bold" | **Andale Mono Bold** |
| 28 | "Dutch Roman 801" | **CG Times** |
| 30–41 | "N point monospace (bold)" | **Andale Mono / Bold** |
| 64 | "Prestige bold" | **Andale Mono Bold** |
| 61, 62, 63, 65, 68 | "Swiss 721 …" | Univers (varian) |
| 66 | — | CG Times Bold |
| 67 | — | Century Schoolbook Roman |
| 69 | — | Letter Gothic |
| 23, 24 | OCR A / OCR B | (tetap OCR) |

Pertanyaannya menyempit dari *"apakah Liberation cukup dekat?"* menjadi
**"seberapa jauh Andale Mono dari Liberation Mono?"** — dan itu bisa diukur
sekarang.

**Jalan mengerjakannya, tanpa printer:**

1. Dapatkan face **Andale Mono** (Microsoft mendistribusikannya; juga tersedia
   di paket `fonts-crosextra-*` / corefonts). **Catatan: tidak terpasang di
   mesin ini** — sudah dicek, registry font tidak punya entri Andale.
2. Ukur tabel advance-nya per-glyph dengan metode yang sudah ada di
   `tests/fontMetrics.test.ts` (metode yang sama yang menghasilkan tabel
   sekarang).
3. Bandingkan dengan `MONO_PER_MILLE = 600` di `fontMetrics.ts`.

**Prediksi yang harus diuji, bukan diasumsikan:** Andale Mono adalah face
monospace, jadi advance-nya **seragam** untuk setiap glyph — yang berarti
perbedaan face **tidak mengubah lebar field**, hanya bentuk glyph. Kalau
terbukti advance-nya memang 600/1000 em, maka kalibrasi Batch U tetap benar
untuk semua id monospace dan pekerjaan ini selesai tanpa satu baris kode
berubah. Kalau bukan 600, seluruh metrik monospace harus diskalakan — dan itu
perubahan besar yang selama ini tidak terdeteksi karena tidak ada yang pernah
mengukurnya.

**Jangan mengerjakan ini dari ingatan.** Angka advance Andale harus diukur dari
file fontnya, bukan dikutip.

**Pertanyaan (b) tetap terbuka**, tapi target pencariannya berubah: halaman
charset K10 menunjuk ke **printer user manual** ("For international character
sets, see your printer user manual"), bukan mendaftar sendiri. Itu target yang
belum dicoba. Ada juga jalur yang lebih kuat yang ditemukan riset: program
Fingerprint `asciitbl_*.prn` bisa **mencetak tabel substitusi langsung dari
printer fisik** — resep untuk menutupnya definitif kalau ada akses printer.

**Kapan dikerjakan:** (a) sekarang, tanpa printer. (b) setelah ada akses printer
atau setelah pencarian user manual gagal. Checklist di
`docs/HONEYWELL-SIMULATOR.md` sudah siap — satu sesi printer cukup untuk
mengonfirmasi kedelapannya.

---

## Tahap 5 — Rumuskan ulang definisi "akurat"

**Kenapa ini tahap, bukan catatan.** Tujuan yang diberikan menyatakan preview
harus akurat terhadap cetakan printer nyata *dengan catatan BarTender sudah
disetel betul*. Kata "disetel betul" sekarang punya isi terukur yang sebagian
**tidak hidup di dalam stream IPL**:

| Setting | Efek | Terlihat di stream? |
|---|---|---|
| Page setup landscape | memutar seluruh label 90° CCW | ❌ tidak |
| Stok & margin | menentukan origin konten | ❌ tidak |
| `Fix Direct Graphics` = 0 | mode pengiriman raster | sebagian |
| Offset printhead 3 mm | pergeseran posisi | ❌ tidak |
| Driver IPL PD43 203 dpi | dpi → dot | implisit |

**Konsekuensinya untuk aplikasi ini:** preview yang benar harus memodelkan
lapisan di luar stream itu sebagai **opsi eksplisit**, bukan diasumsikan. Kalau
tidak, "akurat" bergantung pada setting yang tidak terlihat siapa pun yang
membaca `.ipl`-nya.

**Yang harus dihasilkan:** satu tabel di dokumen ini yang memetakan setiap
setting BarTender → efek terukur → apakah aplikasi kita memodelkannya.
Baris yang belum ada modelnya menjadi pekerjaan tersendiri.

---

## Yang sengaja TIDAK dikerjakan

| Item | Alasan |
|---|---|
| DPL (Datamax) — **status berubah, lihat di bawah** | alasan lama ("tidak ada sumber otoritatif") sudah tidak akurat lagi |
| Membuka ulang §15 IPL-RENDER-SPEC | tertutup 2026-09-25 dengan bukti; hanya dibuka kalau Tahap 1–3 membantahnya |
| Menyentuh jalur `stripsAsRows` / stored graphic | terverifikasi benar pada `bartender-logo.ipl` |
| Menjadikan `tes1` sampel penentu | 23 elemen vektor mendominasi sinyal; butuh fixture satu-objek |
| Memakai `bartender-tes2` sebagai pasangan | stream dan export-nya beda format (4 DG vs 625px rule); sudah dibatalkan 2026-09-24 |
| Memakai Labelary untuk memutuskan rotasi halaman | Labelary tidak memodelkan rotasi halaman BarTender |

### DPL: alasan lama sudah tidak akurat — tapi jangan langsung dibangun

`ROADMAP.md` menyatakan DPL tidak dibangun karena *"tidak ada manual resmi"* dan
*"tidak ada oracle independen"*. Riset hari ini mengoreksi itu. Tiga sumber baru
tersimpan di `docs/manuals/DPL_Reference_Sources/`:

| Berkas | Apa sebenarnya | Nilainya untuk parser DPL |
|---|---|---|
| `portakal_dpl_protocol.md` | panduan protokol: lifecycle, format record teks & barcode, terminator `CR` | **tinggi** — struktur perintah + urutan |
| `nokka_dpl.py` | 253 baris Python, tabel `A06`–`A48` (font skala) | sedang — hanya skala font |
| `gutenprint_print-dpl.c` | **driver Gutenprint**: mengubah raster → perintah cetak | **rendah** — ini generator, bukan parser; 0 referensi font/barcode |

**Yang masih TIDAK ada** (dan inilah yang dulu menghalangi): tabel font lengkap,
daftar tipe barcode → nomor, perintah ukuran/gap, dan tanggal. Sumber baru
memberi **struktur**, bukan **tabel**. Proyek sudah dua kali membuktikan (EPL,
TSPL) bahwa tabel yang ditulis tanpa spec otoritatif itu **salah**.

**Rekomendasi: tetap tunda**, tapi ubah alasannya di `ROADMAP.md` dari "tidak ada
sumber" menjadi **"ada struktur, belum ada tabel lengkap"** — itu alasan yang
benar dan bisa diaudit ulang.

**Yang akan membukanya sepenuhnya:** manual resmi DPL. Riset menemukan manual itu
**ada di Wayback Machine tapi snapshot-nya rusak** (terpotong persis 1 MiB di enam
snapshot — sudah dipastikan bukan batas jaringan). Jadi jalurnya: cari snapshot
Wayback lain, atau salinan dari sumber komunitas, atau contoh `.dpl`/`.prn` nyata
dari printer Datamax. Ini target pencarian yang jauh lebih spesifik daripada
sebelumnya.

---

## Urutan kerja yang disarankan

1. **Tahap 1** — perbaiki cermin DG. Tulis tes yang gagal dulu.
2. **Tahap 2** — ganti guard centroid → profil, tambah syarat asimetri.
3. **Tahap 3c** — catat bug firmware di panduan kalibrasi (murah, mencegah salah diagnosis).
4. **Tahap 3a** — ukur offset 3 mm lewat file port.
5. **Tahap 3d** — diff PRM edisi baru, perbaiki kutipan halaman.
6. **Tahap 5** — tabel setting → efek.
7. **Tahap 4** — hanya setelah ada printer.

Tahap 1 dan 2 adalah satu unit kerja: memperbaiki tanpa memperkuat guard
berarti mengundang bug yang sama terulang ketiga kalinya.
