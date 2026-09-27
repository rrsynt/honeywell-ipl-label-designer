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

> **SELESAI 2026-09-27, dengan premis yang dikoreksi.** Kalimat yang dikutip di
> bawah ternyata **menunjuk jalan keluarnya sendiri**, dan jalan itu bukan
> "geser preview" melainkan perintah kompensasi di dalam stream. Offset 3 mm
> adalah perbedaan **hardware** antar generasi printhead; ia tidak pernah ada di
> dalam stream, jadi memang bukan milik preview.

**Yang benar-benar perlu dikerjakan, dan sudah dikerjakan.** Tiga perintah yang
dipakai untuk mengompensasi offset itu — `<SI>X` (Label Origin X-Y Adjust),
`<SI>F` (Top of Form), `<SI>h` (Printhead Loading Mode, `n=1` mirror / `,m=1`
inverse) — **sama sekali tidak ditangani** `parseSetupFrame` dan lenyap tanpa
satu pun peringatan. `parseSetupFrame` mencocokkan W/L/T/g/S/d/l lewat regex dan
mengabaikan sisanya, yang benar untuk setelan comms/jaringan tapi salah untuk
ketiganya: manual menyatakan `<SI>h` *"affects how the whole image prints"*.
Teknisi yang mengikuti anjuran tech brief akan mengirim `<SI>X` ke PD43 dan
preview kita diam saja sementara label tercetak bergeser ~24 dot.

Dibuktikan dengan probe lebih dulu (`parseViewerIPL` atas stream sintetis):
`<SI>X5,3`, `<SI>F20`, `<SI>f0`, `<SI>r0`, `<SI>Z` semuanya menghasilkan
`issues=[]` — sedangkan frame field betulan (`Q9`) memunculkan `unknown-frame`.
Jadi ini bukan kebijakan "diam untuk yang tak dikenal", melainkan celah di jalur
yang seharusnya bersuara.

**Perbaikan:** pelaporan `setup-not-modelled` (`viewerParser.reportUnmodelledSetup`)
untuk ketiganya, plus entri bantuan perintah. Default tidak diperingatkan
(`<SI>X0`, `<SI>F20`, `<SI>h0`), dan bentuk telanjang `<SI>h` tetap senyap —
`n` dan `m` wajib, jadi tanpa argumen tidak ada mode yang dipilih. Tiga sampel
yang di-ship (`box-date`, `external`, `product`) memakai bentuk telanjang itu;
contoh Intermec yang asli di `docs/research/SOURCE-HUNT-2026-09-26.md` berbunyi
`<SI>h0,0;`, jadi milik kita kemungkinan salah tulis — tetapi senyap adalah
respons yang benar untuk keduanya. Penjaga `tests/unmodelledSetup.test.ts`
(9 tes) menyapu seluruh sampel yang di-ship agar tidak ada alarm palsu;
diverifikasi dengan memasukkan kembali bug-nya (4 tes gagal). Satu kasus batas
ditemukan lewat sapuan manual, bukan oleh tes pertama: `<SI>X,3` (m1 kosong,
m2 diberi) sah menurut sintaks `[m1][,m2]` dan tadinya lolos senyap.

**Sengaja diperingatkan, bukan dimodelkan.** Besar dan tanda pergeseran adalah
perilaku hardware (5 mil per langkah, rentang ±30 dot, dan `<SI>X` berbunyi
*"IPL uses the system configuration for this setting"*). Aturan proyek ini:
tabel semacam itu diukur, tidak ditebak — EPL huruf barcode-nya dan TSPL nama
tipenya dua kali membuktikan ongkosnya. Yang **masih butuh printer**: besar
pergeseran nyata per unit, dan apakah `<SI>X` berlaku sama di firmware PD43.

**Cara mengukur sisanya (kalau ada printer).** Dua format identik dengan
`<SI>X` berbeda, cetak lewat file port, ukur pergeseran tinta terhadap `W`/`L`.
Bukan dibaca dari dokumen — diukur.

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

> **SELESAI 2026-09-27.** Tabel lengkapnya kini di
> `docs/HONEYWELL-SIMULATOR.md` ("Kalau printer nyata berperilaku beda dari
> preview"), dengan satu koreksi penting yang hanya muncul saat memverifikasi
> balik ke PDF-nya: **semua issue ini SUDAH DIPERBAIKI**, bukan defect terbuka.
> Tabelnya menyebut versi perbaikannya (x10.06.008523 untuk keempat issue
> graphics, x10.05.007902 untuk EAN, x10.04.007069 untuk 11136.2), jadi yang
> perlu dibandingkan adalah **versi firmware printer target**, bukan daftar
> issue-nya. Dua koreksi lain: `15009.5` yang ikut dikutip sebagai bug IPL
> sebenarnya **ESim**, dan `15939` duduk di tabel "Improved Functionality" —
> artinya "sudah dibetulkan", bukan "masih rusak".


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

### 3d. PRM edisi `066396-003` — **BUKAN edisi keempat; ini edisi KETIGA yang lebih tua**

> **SELESAI 2026-09-27, dan hasilnya membatalkan premisnya.** Berkas itu memang
> ber-P/N 066396-**003**, tapi namanya menyesatkan: yang **sedang dipakai**
> proyek ini adalah 066396-**008** (Document Change Record: revisi 008, 06/04,
> "IPL firmware versions 1.4 and 2.0 functionality", PF2i/PF4i/PM4i), sedangkan
> 066396-**003** berhenti di revisi 003 (10/00) — **lima revisi lebih tua**, dari
> era EasyCoder F4, sebelum 3400e/44X0/PF2i ada.

**Kenapa ini penting dan bukan sekadar catatan.** Rencana semula adalah
memakainya untuk **mengoreksi kutipan halaman** di kode (213 kutipan `PRM p.N`).
Kalau dikerjakan, hasilnya akan **merusak** semuanya: penomoran halamannya beda
sistem — edisi 003 memakai `7-50` (bab-halaman), edisi 008 memakai nomor urut
`191`. Kutipan seperti `PRM p.191` tidak punya padanan langsung di 003, jadi
"mengoreksinya" berarti memetakan dua skema penomoran dan menebak.

**Terverifikasi:** spot-check kutipan yang paling sering dipakai —
`PRM p.191` ("2 dots below bar code", interpretive gap) — **benar** di edisi
008: halaman tercetak di footer sekitar hit itu memang 191. Tidak ada yang perlu
diperbaiki.

**Yang tetap berguna dari berkas ini:** sebagai pembanding *isi antar era*,
bukan penomoran. Ekstraksi teksnya sudah dibuat lewat `pdftotext` dan
menunjukkan struktur bab yang sama; kalau nanti ada klaim "perintah X berubah
perilaku", dua edisi ini adalah pasangan sebelum/sesudah yang sah. **Jangan**
pakai 003 sebagai sumber nomor halaman.

---

## Tahap 3b-bis — Parameter `m` pada `c` diabaikan (celah, bukan bug yang tampak)

> **SELESAI 2026-09-27** — dan celah ini ternyata menyembunyikan bug yang
> JAUH lebih besar dari dirinya sendiri. Lihat "Temuan susulan" di bawah.

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

### Temuan susulan 2026-09-27 — mengerjakan `m` membongkar bug advance yang nyata

Menulis tes `m` ("c25,3 harus 3×(n−1) dot lebih lebar") menuntut pengukuran
lebar yang benar-benar terpampang. Di situlah ketahuan bahwa **lebar yang
terpampang tidak pernah sama dengan lebar yang dihitung** untuk font bitmap:

| | model (dipakai SEMUA kalkulasi layout) | cat yang terpampang |
|---|---|---|
| `c0`, 21 karakter | 8,0 dot/karakter | **5,4 dot/karakter** |
| `c0` dengan `w2` | 16,0 dot/karakter | 5,4 (w tidak berpengaruh sama sekali) |
| `c0` dengan `w3` | 24,0 dot/karakter | 5,4 |

Sebabnya: jalur gambar menyerahkan advance ke `ctx.fillText`, yang memakai
metrik face host (Liberation Mono 0,6 em = 5,4 dot) alih-alih sel printer
(7 dot + 1 gap). Akibatnya tinta ~33% lebih sempit daripada kotak field,
seleksi, anchor, dan border `b` — dan **`w` tidak mengubah apa pun di layar**
meski manualnya tegas: *"Increasing the width of a text field to 2 makes each
letter in the field twice as wide"* (PRM 2.70 p.55).

Di sisi **designer** masalahnya kembar tapi terbalik: `ctx.scale(w_mag, 1)`
melebarkan seluruh run memakai metrik face, jadi 10 karakter `c0` tergambar
104 px padahal kotaknya 79 dot — dan kedua mesin **berbeda satu sama lain**,
padahal paritas layar↔cetak adalah kontrak inti proyek ini.

**Perbaikan:** `services/fixedCellText.ts` — satu helper gambar bersama untuk
face bitmap, dipakai renderer viewer DAN canvasDrawer designer, sehingga
keduanya tidak bisa lagi berbeda. Advance = (lebar sel + gap) × w; glif
diskalakan agar satu advance host sama dengan sel printer.

**Kenapa tidak ada tes/golden yang menangkapnya:** tidak ada satu pun sample,
golden, atau stream BarTender di repo yang memuat **field teks berfont bitmap**
— semuanya memakai outline c20–c41 (`c25`/`c26` dominan). Jalur bitmap hanya
tersentuh lewat UDC/graphic dan HRI. Jadi ini kelas cacat yang sama dengan
cermin Direct Graphics: suite hijau, label tetap salah.

**Guard permanen:** `tests/bitmapTextAdvance.test.ts` (advance yang terpampang
vs model untuk c0/c2/c7 × w1/w2/w3, contoh 79-dot manual, rentang & tanda `m`,
serta pemisahan parameter barcode) + 9 kasus paritas designer↔cetak di
`tests/rotationWysiwyg.test.ts`. Keduanya **diverifikasi dengan memasukkan
kembali bug-nya** (21 tes gagal pada bug viewer, 9 pada bug designer).

**Catatan default `m`:** edisi manual berbeda — PRM ("the printer uses the
default value of the selected font") vs K10 ("Default is 0"). Yang dipakai di
sini adalah default font, karena itulah yang dikunci contoh 79-dot; perbedaan
itu dicatat, bukan disembunyikan.

**`p` sengaja TIDAK diimplementasikan** dan itu keputusan, bukan kelalaian:
`p` menamai font yang bisa diunduh, yang byte-nya tidak ada di renderer ini.
Peringatan untuk `p` juga tidak dipasang, karena bentuk `c18,2,L,8` pada frame
**`B`** adalah perintah lain ("Bar Code, Select Type") yang slot ketiganya
sebuah label — peringatan di sana akan menyala pada frame barcode yang benar
(sudah diperiksa: nol peringatan palsu pada 9 sampel nyata).

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

### Tabel yang diminta — diukur 2026-09-27, bukan diasumsikan

Setiap baris di bawah diukur dari pasangan yang sudah ada di repo (stream
BarTender-asli + PNG preview BarTender-asli), bukan dari deskripsi setting.
Lima fixture BarTender-authored dipakai: `grid`, `parity-base`, `one-box`,
`one-box-landscape`, `landscape` — semuanya dibuat
`tools/bartender/BuildParityLabels.cs`, jadi ukuran halamannya diketahui persis.

| Setting BarTender | Efek terukur | Dimodelkan? |
|---|---|---|
| **Page setup landscape** | memutar seluruh label 90° CCW (dan 90° CW memberi citra cermin) | ✅ opsi **Rotate** — `RenderOptions.rotation`, `auto` mengikuti frame `q`; dikunci `bartenderPageTurn.test.ts` |
| **Stok & margin** | kanvas preview **16 dot lebih kecil di kedua dimensi** (8+8), tapi konten **TIDAK bergeser** — preview berjangkar di origin halaman | ❌ **tidak** — viewer menggambar sampai tepi kanvas |
| **`<SI>W`** (lebar label) | = extent halaman pada **sumbu lebar printhead** **− 16 dot − `LabelWidthAdjustment`** (16 = inset tercetak; adjustment = **2** untuk PD43, dibaca dari tabel driver — lihat mekanisme di bawah) | ⚠️ sebagian — dipakai sebagai `widthDots`, tapi tidak ada kaitannya dengan pembingkaian di atas |
| **`Fix Direct Graphics`** | mengubah mode pengiriman (`g0` biner vs `g1` hex), bukan posisi | ✅ keduanya didekode identik (`extractDirectGraphics` mode 0/1) |
| **Offset printhead 3 mm** | perilaku hardware; yang hidup di stream hanya perintah kompensasinya | ✅ diperingatkan via `setup-not-modelled` (Tahap 3a), sengaja tidak dimodelkan |
| **Driver IPL PD43 203 dpi** | dpi → dot | ✅ opsi DPI 203/300/406 |

### Koreksi 2026-09-28 — "crop 8 dot per tepi" itu SALAH; yang benar kanvas mengecil tanpa pergeseran

Versi pertama tabel di atas menyebut preview BarTender *"memotong tepat 8 dot
(1,00 mm) dari tiap tepi"*. **Itu keliru, dan kesalahannya berbahaya** karena
crop menyiratkan **pergeseran** — padahal tidak ada.

Yang benar-benar terukur, diverifikasi terhadap ground truth
`tools/bartender/BuildParityLabels.cs` (koordinat yang **dimasukkan** untuk
membangun format, jadi bukan rasterisasi kedua):

| Fixture | GT halaman | Preview BarTender | Cocok? |
|---|---|---|---|
| `grid` | box 0,2 in → path x=41; tebal 1 mm → ink mulai **37** | kolom pertama bertinta di **37** | ✅ persis |
| `one-box-landscape` | box 0,6 in → path x=122; tebal 3 mm → ink mulai **110**; path y=102 → ink **90** | ink bbox **(110, 90)** | ✅ persis |

Kalau model "crop 8 dot per tepi" benar, objek di halaman x=37 akan muncul di
preview x=**29**. Yang terukur: **37**. Jadi:

```
BENAR : kanvas preview = halaman − 16 dot per dimensi, origin tetap di (0,0)
        -> konten tidak bergeser sama sekali
SALAH : "halaman dipotong 8 dot per tepi"  (menyiratkan pergeseran −8)
```

Angka 16 dot itu sendiri nyata dan konsisten di kelima fixture (812→796,
406→390, 609→593, 1218→1202), dan 16 = 2 mm = dua kali
`UNPRINTABLE_MARGIN_MM['PD43'] = 1` mm. Yang salah hanyalah **membaginya dua
lalu menyebutnya pergeseran**. Delapan dot itu ukuran beberapa efek nyata di
sini, jadi model yang keliru sempat menutupi selisih asli — pelajaran yang sama
dengan matriks 2×2 di audit DG.

**Konsekuensi yang penting untuk jumlah yang belum dijelaskan:** selisih posisi
absolut kita vs BarTender tetap **tidak seragam** — berbeda per fixture, bahkan
antara dua fixture berstok sama (dy 31 vs 89). Ia **bukan** satu crop, bukan
satu pergeseran, dan belum dijelaskan. Guard
`tests/bartenderAbsolute.test.ts` memakukannya sebagai baseline regresi.

### Mekanisme 18 dot TERPECAHKAN 2026-09-28 — ia bukan "sumbu pendek − 18"

Klaim lama di dokumen ini menyebut `<SI>W` = *sumbu pendek* stok − 18. **Itu
korelasi, bukan mekanisme, dan salah pada halaman non-persegi.** Buktinya sudah
ada di dataset sejak awal dan terlewat: `mixed` dan `one-box-landscape` sama-sama
halaman **4×2 in**, tapi W-nya **794 vs 388** — dua nilai berbeda untuk satu
"sumbu pendek". Yang membedakan hanya orientasinya.

**Rumus yang benar, diverifikasi 15/15 di dataset sweep dan 5/5 di `samples/`:**

```
W = (extent halaman pada SUMBU LEBAR PRINTHEAD) − 18 dot
```

Sumbu lebar printhead adalah **X halaman untuk `btPortrait`** dan **Y halaman
untuk `btLandscape`** — rotasi halaman menukar sumbu mana yang menghadap
printhead. Itu sebabnya `mixed` (portrait, 4 in) memberi 794 sementara
`one-box-landscape` (landscape, 4×2 → sumbu 2 in) memberi 388.

### Sisa 2 dot TERPECAHKAN 2026-09-28 — ia angka PER-MODEL di tabel driver

> **Koreksi atas koreksi.** Paragraf yang semula ada di sini mengklaim
> "18 = 16 + 2", dengan bukti `W + 2 == extent preview`. **Bukti itu cacat:
> ia sirkular.** `W + 2 = (halaman − 18) + 2 = halaman − 16 = preview` adalah
> identitas aljabar dari dua pengukuran yang sudah diketahui, bukan konfirmasi
> independen. Ia mengukur ulang hal yang sama dan tidak membuktikan apa pun
> tentang *mengapa* selisihnya 2. Klaim "keduanya satu mekanisme" dicabut.

**Sumber angka 2 itu ada di mesin ini, di tabel driver Seagull.**
`C:\Program Files\Seagull\Printer Drivers\Packages\2023.4\ss#ipl.ddz` adalah
arsip **ZIP** (ekstensi menyesatkan) berisi `Model.d` — tabel per model printer.
Di dalamnya, untuk printer yang justru dipakai proyek ini:

```
[PD43_203]
    ~ConfigurationOptions.LabelWidthAdjustment=2
    ~ConfigurationOptions.SetLabelWidth=true
```

`SetLabelWidth=true` berarti driver **memang** menghitung dan mengirim `<SI>W`
(driver lain memakai `false` dan tidak mengirimnya sama sekali).
`LabelWidthAdjustment` adalah koreksi per model yang diterapkan ke nilai itu.

**Rumus lengkap, diverifikasi 19/19 (nol mismatch) atas seluruh pengukuran yang
ada di disk — 15 format sweep + 4 sampel repo:**

```
W = round(sumbu_lebar_in × 203 dpi) − 16 − LabelWidthAdjustment
```

dengan **16** = inset area tercetak (diukur independen dari PNG preview) dan
**2** = `LabelWidthAdjustment` milik PD43_203.

**Nilainya berbeda per model**, yang menjelaskan kenapa ia tampak seperti
konstanta ajaib ketika hanya satu printer yang diamati:

| Model | UnprintableWidth | LabelWidthAdjustment | SetLabelWidth |
|---|---|---|---|
| PD43, PC23d, PC43, PC45d | 0.00 in | **2** | true |
| PM43 (semua dpi) | 0.00 in | **4** | true |
| PF2i, PF4i, PM4i | 0.07 in | **−40** | true |
| PD41 | 3.00 mm | **−40** | true |
| seri 3400/4100 lama | 0.05–0.12 in | 0 | **false** |

Jadi 18 bukan "16 + hiasan 2 dot": ia `16 + LabelWidthAdjustment(PD43)`. Pada
PM43 angkanya akan **20**, dan pada PM4i **−24** — besaran itu **tidak boleh**
dihardcode. Kalau nanti model printer lain perlu didukung, angka itu harus
dibaca per model, bukan disalin dari PD43.

**Satu fixture sengaja dikecualikan: `edges`.** Ia satu-satunya yang mengubah
dua variabel sekaligus (margin 0,05 in **dan** objek yang sengaja menggantung di
luar halaman), sehingga TemplateSize-nya 66,2 mm padahal halamannya 76,2 mm —
selisih 10,0 mm ≈ overhang 0,4 in. Ia **tidak bisa** dipakai sebagai uji
"apakah 18 bergantung margin": dua variabel berubah bersamaan. Korelasi yang
tidak bisa dipisahkan bukan bukti.

**Pelajaran (dua lapis).** Pertama: "konstan di lima halaman" bukan bukti
mekanisme — kelima halaman itu kebetulan punya lebar = sumbu pendek; dataset
yang lebih besar memisahkannya dalam satu langkah. Kedua, dan lebih penting:
**bukti yang diturunkan dari dua pengukuran yang sudah diketahui bukan bukti.**
`W + 2 == preview` terlihat seperti konfirmasi silang, padahal ia hanya aljabar.
Angka 2 itu nyata sebagai fakta dan **kosong sebagai penjelasan** sampai tabel
driver ditemukan.**

Pola yang sama dengan matriks 2×2 dan "crop 8 dot": **korelasi yang
rapi berhenti terlihat rapi begitu ada variabel yang memisahkannya.**

### Pergeseran vertikal adalah seragam — ia lapisan halaman, bukan bug DG

Hipotesis pertama yang muncul saat mengukur adalah "Direct Graphics salah
tempat karena `hBase` ditebak". **Itu dibantah oleh pengukuran.** Dengan
mengorelasikan pita-pita terpisah dari `parity-base` secara independen — tiap
pita hanya berisi satu jenis konten — semuanya memberi pergeseran yang **sama**:

| Pita (jenis) | dx | dy | tumpang-tindih |
|---|---|---|---|
| barcode x13–367 (vektor) | −8 | 24 | 91,4% |
| line x48–777 (vektor) | −8 | 29 | 74,2% |
| box x547–710 (vektor) | −9 | 29 | 75,6% |
| graphic x9–328 (Direct Graphics) | −8 | 24 | 93,6% |
| graphic x338–800 (Direct Graphics) | −8 | 29 | 83,7% |

Konten **vektor dan raster bergeser dengan jumlah yang sama**. Jadi
ketidakcocokan posisi itu milik **lapisan halaman** (baris "Stok & margin" di
tabel — memang di luar stream), bukan cacat penempatan Direct Graphics. Ini
justru menguatkan baris tabel itu: yang salah bukan elemen kita, melainkan
origin halaman yang tidak dibawa stream.

`dx = −8` itu **bukan** arti "crop 8 dot per tepi" (lihat koreksi di atas) —
ia kebetulan mendekati 8 dan sempat memperkuat model yang keliru.

### Selisih absolut TERPECAHKAN 2026-09-28 — origin vertikal DG berbasis TENGAH halaman

Bagian ini semula mencatat "belum dijelaskan, nilainya berbeda per fixture
(dy 29 vs 89, pada stok sama)". **Sekarang terpecahkan, dan hasilnya bukan
pergeseran sama sekali** — melainkan **model penempatan yang salah bentuk**.

Rumus yang benar, diverifikasi **9/9 dalam 1 dot** — termasuk tiga fixture
dibaca dari frame **terputar** (orientasi berbeda), jadi ia bukan curve-fit
pada satu orientasi saja:

```
y_top(graphic) = (originY − maxBit) + pageH/2 − 424
```

dengan `pageH` = tinggi halaman pada sumbu feed, `maxBit` = bit tertinggi yang
bertinta (baris TERATAS graphic, karena indeks bit menjauh dari origin).

| Fixture | pageH | originY | maxBit | terukur | prediksi |
|---|---|---|---|---|---|
| `one-box-landscape` | 406 | 518 | 207 | 90 | 90,0 |
| `landscape` | 406 | 553 | 279 | 53 | 53,0 |
| `sep2-4x25` (fixture baru) | 507 | 370 | 151 | 49 | 48,5 |
| `sep-land-4x3` (fixture baru) | 609 | 319 | 151 | 49 | 48,5 |
| `parity-base` dg0 | 406 | 604 | 350 | 33 | 33,0 |
| `parity-base` dg1 | 406 | 604 | 351 | 32 | 32,0 |
| `one-box` (frame terputar) | 609 | 640 | 431 | 90 | 89,5 |
| `one-rot90` (frame terputar) | 609 | 461 | 151 | 191 | 190,5 |
| `one-text` (frame terputar) | 609 | 417 | 215 | 83 | 82,5 |

**Temuan strukturalnya: suku `+ pageH/2`.** Origin vertikal Direct Graphics
BarTender **diukur dari TENGAH halaman**, bukan dari tepi bawah seperti yang
diasumsikan model bottom-up kita (PRM Appendix E). Itu menjelaskan kenapa
selisihnya tampak "berbeda per fixture": ia memang bergantung tinggi halaman,
lewat suku setengah — bukan konstanta.

**Konsekuensinya untuk kode kita.** Aturan sekarang
(`hBase = max(contentExtent, maxOriginY)`, lalu `y = hBase − originY + minBit`)
menghasilkan `hBase = originY` **selalu**, karena `originY` selalu melebihi
extent konten — sehingga `y` kolaps jadi `minBit`, dan setiap graphic mendarat
di baris `minBit` dari kanvas **konten**. Kita tidak menghitung posisi halaman
sama sekali. Itu sebabnya graphic kita selalu di atas (terukur: 89,5 → 1;
52,9 → 1; 48,9 → 6, dst).

**Asal suku `pageH/2` TERPECAHKAN — dan ia mengubah arti rumusnya.** Suku itu
**bukan aturan penempatan halaman**, melainkan **membatalkan penskalaan yang
sudah dilakukan driver**. Terukur pada satu objek yang sama di tiga tinggi
halaman berbeda:

| Fixture (objek sama, Y=0,3 in) | pageH | originY | `originY + pageH/2` |
|---|---|---|---|
| `sep-land-4x4` | 812 | 218 | **624,0** |
| `sep-land-4x3` | 609 | 319 | **623,5** |
| `sep2-4x25` | 507 | 370 | **623,5** |

Konstan dalam 0,5 dot. Dan antar pasangan, `ΔoriginY / ΔpageH` = **−0,4975** dan
**−0,5000** — jadi hubunya **persis**:

```
originY = K − pageH/2        (K = properti OBJEK, bukan halaman)
```

Substitusikan ke rumus sebelumnya dan `pageH/2` **saling menghapus**:

```
y_top = (originY − maxBit) + pageH/2 − 424
      = (K − pageH/2 − maxBit) + pageH/2 − 424
      = K − maxBit − 424
```

Jadi driver **sudah menulis `originY` dalam kerangka terpusat**, dan aplikasi
yang membaca harus menambahkan `pageH/2` kembali untuk memulihkan koordinat
halaman. Itu bukan pilihan desain kita — itu bagian dari cara nilai itu
dikodekan.

**Asal 424: TERJAWAB SEBAGIAN 2026-09-28 — ia milik DRIVER, bukan halaman;
tetapi rumusnya belum diturunkan.**

Diuji dengan memasang printer kedua dari driver store yang sama
(`Intermec PC23d (203 dpi) - IPL`) dan mencetak **berkas `.btw` yang sama**
lewat kedua driver — halaman dan objek identik, hanya `fmt.Printer` yang
diubah:

| driver | `W` | `originY` |
|---|---|---|
| PD43 (Default.X 4,00 in) | **408** | **413** |
| PC23d (Default.X 2,00 in) | **388** | **254** |

Satu dokumen, dua driver, dua nilai berbeda. Karena halaman dan objeknya
identik, **konstanta penempatan (dan `W`) ditentukan driver** — itu yang
terjawab. Angka 424 milik **driver PD43** secara spesifik.

**Yang GUGUR lewat pengukuran ini** (semua hipotesis numerik yang masuk akal):

| Hipotesis | Kenapa gugur |
|---|---|
| `424 = DefaultX / 2 + 18` | cocok sempurna di PD43 (812/2+18 = 424), tapi PC23d tidak memberi 221 |
| `424` dari `Stock.Printable.X` | selisih Printable 199 dot vs terukur 159 |
| margin ikut masuk rumus `W` | `edges` (margin 0,05 in) tetap `609 − 18 = 591`, persis rumus lama |
| `424` konstanta dot universal | `originY` beda 159 dot untuk dokumen yang sama |

**Yang BELUM terjawab: rumus yang menurunkan konstanta itu dari parameter
model.** Saya tidak menemukannya, dan sengaja tidak memilih kandidat yang
tersisa — tiga kali di proyek ini kandidat yang "rapi" ternyata salah.

**Yang tetap berdiri dan penting:**

- Rumus `W` ter-commit **tetap valid** untuk semua fixture repo: diuji ulang
  **6/6** (`grid`, `one-box`, `one-box-landscape`, `landscape`, `parity-base`,
  `edges`) — termasuk `edges` yang bermargin 0,05 in, yang membatalkan dugaan
  bahwa margin masuk rumus.
- Model penempatan DG PD43 tetap terverifikasi **10/10 dalam 1 dot**; yang
  ditambahkan di sini hanya keterangan bahwa 424 adalah **milik driver**.

**Konsekuensi praktis.** Karena konstanta itu per-driver, **jangan**
mengeraskannya ke kode. Untuk PD43 nilainya 424 dan modelnya tervalidasi;
untuk driver lain angkanya lain dan belum diukur.

**Catatan metode — eksperimen ini butuh tiga perbaikan sebelum satu
perbandingan pun sah, dan dua di antaranya kesalahan saya:**

1. Halaman 2,5 in yang saya minta **ditolak** PC23d (`Stock.Maximum.X = 2,36 in`),
   dan BarTender diam-diam memakai stok lain (53,5 × 40,8 mm) — terlihat hanya
   dari `TemplateSize`, bukan dari error. Percobaan pertama mengukur halaman
   yang salah.
2. Stream PC23d memakai **byte kontrol mentah** (0x02/0x03/0x1b), bukan notasi
   teks `<STX>` seperti PD43; parser pertama saya melihat nol frame.
3. Perbandingan pertama saya **mencampur tiga variabel** (halaman, objek, dan
   driver sekaligus berubah), lalu saya menuliskan tabelnya dengan angka
   "sumbu feed" yang salah. Perbandingan itu dibuang; yang dipakai di atas
   adalah yang benar-benar terkendali.

**Pelajaran.** "Cocok sempurna di satu printer" adalah sampel berukuran satu —
dan printer pembandingnya **sudah ada di driver store sepanjang waktu**,
lengkap dengan `Stock.Default.X = 2,00 in` di `Model.d` yang saya baca
berkali-kali tanpa menyadari bahwa itu uji yang menunggu.

**Catatan metode — dua kali salah sebelum benar, dan keduanya ketangkap oleh
pengukuran sendiri:**

1. Model pertama, `C = konstan`, cocok di semua fixture yang ada — **karena
   semuanya halaman 2 inci**. Tanpa fixture tinggi lain, konstanta dan fungsi
   tinggi tak terpisahkan. Fixture `sep-land-4x3` (3 in) memisahkannya: C
   ternyata 119, bukan 221.
2. Percobaan kedua menghasilkan "C tidak monoton (221 → 322 → 119), jadi C
   bukan fungsi tinggi" — dan itu **salah, karena dua dari capture-nya file
   basi**: `sep2-4x25` terbaca `W=185` padahal seharusnya 490. Spooler
   Windows menulis ke port dengan jeda, dan `cp` yang dijalankan terlalu cepat
   menyalin output job **sebelumnya**. Dengan sentinel + tunggu, capture yang
   benar memberi C=170, dan modelnya langsung monoton.

Pelajaran yang bisa dipakai ulang: **capture lewat port printer harus
diverifikasi isinya, bukan sekadar keberadaan filenya** — periksa `W` terhadap
nilai yang diharapkan. Dua kesalahan berturut-turut di atas keduanya berasal
dari memakai angka yang belum diverifikasi sebagai data.

**Pelajaran metodologis, sama seperti matriks 2×2 di audit DG sebelumnya:**
sebelum mengaitkan pergeseran seragam ke fitur yang kebetulan menonjol,
periksa apakah ia seragam. Menyelesaikan "hBase yang diperlukan" dari
pergeseran itu menghasilkan angka yang rapi (389 vs printable 390) dan
**menyesatkan** — kerapian itu artefak dari sebab yang salah.

### Temuan arsitektur terpisah — posisi DG dibakar saat PARSE (fakta benar), tapi "perbaikannya" DIBANTAH

Ini berdiri sendiri dari koreksi di atas, dan **terverifikasi langsung**:
`viewerParser.decodeDirectGraphics()` memanggil
`directGraphicToBitmap(dg, hBase)` **saat parse**, dengan `hBase` dari `<SI>L`
atau — karena stream BarTender tidak pernah membawa `L` — tebakan
`max(origin Y, content extent)`.

Karena origin Y Direct Graphics bersifat **bottom-up** (PRM Appendix E),
tinggi label seharusnya menentukan posisinya. Tapi keputusan itu sudah final
sebelum renderer berjalan, sehingga kontrol **Paper mm** di viewer membesarkan
kanvas **tanpa menggeser satu dot pun** (extent 352 → 952 dot, ink top tetap
`y=3`). Konten vektor juga diam, dan itu benar — koordinatnya top-down dan
tidak bergantung tinggi label.

**Rekomendasi "pindahkan penempatan DG dari parse ke render" ditulis di sini
sebelum diuji, dan sekarang DIBANTAH oleh dua pengukuran.** Jangan
mengerjakannya.

**Bantahan 1 — model yang mendasarinya tidak konsisten.** Kalau
`y = L − originY + minBit` benar (`L` = panjang label), menyelesaikan balik
dari preview BarTender harus memberi `L` yang **sama** untuk dua fixture
berstok identik. `parity-base` dan `one-box-landscape` keduanya halaman
4×2 in landscape (812×406 dot) dengan framing preview identik (796×390),
jadi crop 8 dot saling menghapus dan sisa selisihnya nyata:

| Fixture (keduanya 4×2 in) | originY | minBit | preview ink-top | `L` tersirat |
|---|---|---|---|---|
| `one-box-landscape` | 518 | 1 | 90 | **607** |
| `parity-base` (dg1) | 604 | 3 | 32 | **633** |

Selisih **26 dot**: tidak ada satu `L` pun yang mereproduksi keduanya. Dan
`L` yang manual-faithful (406, sumbu feed) akan menaruh `one-box-landscape`
di `y = 406 − 518 + 1 = −111` — **di luar label**. Jadi model tinggi-label
itu bukan deskripsi yang benar untuk apa yang BarTender lakukan.

**Bantahan 2 — perbaikannya no-op, atau merusak.** Floor `max(L, originY)`
harus dipertahankan (tanpanya graphic jatuh off-label). Dengan floor itu,
setiap `L` yang masuk akal dari stok nyata — 406, 609, 812 — **di bawah**
`originY` (518, 640, 718, 604), sehingga floor menelannya dan `y` tetap
`= minBit`. Satu-satunya fixture yang berubah adalah `grid`, dan di sana
`L = 812` menggeser error dari 39 → **55 dot** (memburuk).

**Kesimpulan.** Paper mm memang tidak memindahkan Direct Graphics, dan
berdasarkan bukti yang ada itu **bukan bug**: tidak ada model tinggi-label
yang tervalidasi untuk menggantikannya. Yang benar-benar salah posisi adalah
**lapisan halaman** (pergeseran seragam yang terdokumentasi di atas), dan itu
memang di luar stream. Kalau nanti mau membuat Paper mm berpengaruh pada DG,
yang dibutuhkan lebih dulu adalah **model yang lulus uji stok-sama → `L`-sama**
— bukan memindahkan kode penempatan.

**Pelajaran:** mengukur itu bukan sekadar memverifikasi kesimpulan, tapi juga
menguji *rekomendasi*. Dua rekomendasi berturut-turut di sesi ini
("hBase yang diperlukan = 389" dan "pindahkan ke render") terlihat masuk akal
dan keduanya gugur saat diuji.

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

1. **Tahap 1** — perbaiki cermin DG. Tulis tes yang gagal dulu. ✅ 2026-09-27
2. **Tahap 2** — ganti guard centroid → profil, tambah syarat asimetri. ✅
3. **Tahap 3c** — catat bug firmware di panduan kalibrasi. ✅
4. **Tahap 3a** — offset 3 mm: **bukan** pekerjaan preview, tapi tiga perintah
   kompensasinya yang dulu hilang tanpa jejak. ✅ 2026-09-27 (`setup-not-modelled`)
5. **Tahap 3d** — PRM 066396-003: **lebih tua**, bukan lebih baru; premis tesnya
   dibatalkan. ✅ 2026-09-27
6. **Tahap 5** — tabel setting → efek. ✅ 2026-09-27 (diukur, 5 fixture;
   `<SI>W` = sumbu pendek − 18 dot; pergeseran halaman memukul vektor **dan**
   raster sama rata. Koreksi 2026-09-28: model "crop 8 dot per tepi" salah —
   kanvas preview mengecil 16 dot TANPA menggeser konten)
7. **Guard paritas posisi absolut** — tindak lanjut Tahap 5. ✅ 2026-09-28
   (`tests/bartenderAbsolute.test.ts`: 6 tes, ukuran konten + offset terpaku +
   geometri kisi vs ground truth build-script)
8. **Tahap 4** — hanya setelah ada printer.

Tahap 1 dan 2 adalah satu unit kerja: memperbaiki tanpa memperkuat guard
berarti mengundang bug yang sama terulang ketiga kalinya.

**Sisa pekerjaan yang tercatat dari Tahap 5** (bukan bagian Tahap 4, bisa
dikerjakan tanpa printer):

| Item | Sifat |
|---|---|
| ~~Penempatan DG dipindah dari parse ke render~~ | **DIBANTAH 2026-09-27** — tidak ada model tinggi-label yang lulus uji stok-sama → `L`-sama, dan dengan floor yang ada perbaikannya no-op atau merusak. Jangan dikerjakan |
| ~~Mekanisme `<SI>W`~~ | ✅ **SELESAI PENUH 2026-09-28** — `W = round(sumbu lebar printhead) − 16 − LabelWidthAdjustment`, diverifikasi 19/19. Klaim "sumbu pendek" dibatalkan (salah pada halaman non-persegi). Sisa 2 dot ternyata **angka per-model** di tabel driver Seagull (`Model.d` → `[PD43_203]` → `=2`), bukan konstanta. **Jangan hardcode** — PM43 memakai 4, PM4i −40 |
| ~~Selisih posisi absolut kita vs BarTender (dy 29 / 89)~~ | ✅ **TERPECAHKAN 2026-09-28** — bukan pergeseran, melainkan **bentuk model yang salah**. Driver menulis `originY = K − pageH/2` (kerangka terpusat), jadi pembaca harus menambahkan `pageH/2` kembali: `y_top = (originY + pageH/2) − maxBit − 424`, terverifikasi 10/10 dalam 1 dot termasuk frame terputar. Aturan kita kolaps jadi `y = minBit`. **Sisa satu besaran:** angka 424 — terbukti **milik DRIVER** (dokumen sama lewat dua driver memberi nilai berbeda), tapi rumusnya belum diturunkan |
| Kanvas preview 16 dot lebih kecil, konten tidak bergeser | viewer menggambar sampai tepi; perlu keputusan apakah ingin menawarkan tampilan area-tercetak |
| ~~Guard paritas berbasis posisi absolut~~ | ✅ **SELESAI 2026-09-28** — `tests/bartenderAbsolute.test.ts` (6 tes). Bukti ia menutup celah nyata: dengan pergeseran seragam (4,6) disuntikkan, 18 tes paritas BarTender yang ada **tetap hijau**; guard ini gagal 5 dari 6 |

**Pola yang muncul tiga kali sekarang** (772 tes vs urutan `I<n>`/`B<n>`; 605 vs
resize canvas; dan Tahap 3a ini): yang tidak pernah tertangkap suite adalah
**perintah/perilaku yang tidak punya jalur keputusan sama sekali** — bukan yang
salah dihitung, melainkan yang tidak pernah dilihat. Cara menemukannya bukan
menambah tes ke jalur yang sudah ada, melainkan menyapu permukaan command
(`<SI>` letter sweep di atas stream nyata vs himpunan yang ditangani) dan
menanyakan "apa lagi yang bisa mengubah gambar di sini?".
