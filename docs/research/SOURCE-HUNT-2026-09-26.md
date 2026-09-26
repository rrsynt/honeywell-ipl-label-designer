# Perburuan Sumber IPL — Laporan Riset 2026-09-26

> Riset internet mendalam atas permintaan prompt "Kampanye ground truth IPL" TAHAP 1.
> Semua klaim di bawah dikutip dengan URL dan kutipan persis. Yang tidak ditemukan
> dicatat beserta query yang dipakai, supaya "tidak ditemukan" bisa dibedakan dari
> "tidak dicari".

## Catatan metodologi (penting untuk membaca laporan ini)

Mesin pencari umum praktis tidak bisa dipakai dari mesin ini:

| Layanan | Status | Bukti |
|---|---|---|
| WebSearch (built-in) | **0 hasil untuk SEMUA query** | 6 query berbeda, semuanya balik kosong |
| Google | HTTP 200 tapi tanpa hasil organik | hanya shell JS |
| Bing | **hasil ter-hijack** | query "PDP43 firmware" mengembalikan hasil NSFW dari reddit — DNS ISP menyuntikkan halaman berbeda (`internetsehatku.com` di cert) |
| DuckDuckGo (lite/html) | sertifikat tidak cocok (intersepsi) | `Host: html.duckduckgo.com is not in the cert's altnames` |
| Mojeek / Startpage / SearXNG (beberapa instance) | halaman Captcha / Anubis | anubis_challenge, "Making sure you're not a bot" |
| Yandex | Captcha | — |
| Marginalia | 200 tapi nol hasil relevan | — |

Yang **bekerja** dan jadi tulang punggung riset ini: **Wayback Machine CDX API**,
**archive.org advancedsearch + metadata API**, **GitHub API via `gh` CLI** (terautentikasi),
dan **`raw.githubusercontent.com`**. Konsekuensinya: laporan ini kuat pada sumber
*terarsip* (manual/firmware/forum lama) dan lemah pada sumber *hidup*.

---

## Ringkasan

- **Sumber baru ditemukan: 18** (7 manual/dokumen resmi, 3 firmware/rilis, 4 stream
  IPL nyata, 4 sumber DPL). **Diunduh & disimpan: 15.**
- **Gagal ditemukan: 4** kelompok (tabel substitusi Appendix B resmi, metrik glyph
  bitmap resmi, release notes pasca-2015 untuk K10/P10, manual DPL resmi).

### Tabel temuan

| Temuan | URL | Jenis | Relevansi ke tujuan utama | Status unduh |
|---|---|---|---|---|
| **IPL Migration Considerations for PM43/PC43 TechBrief** (612241-A, 11/12) | `web.archive.org/web/20130123024707if_/intermec.com/public-files/technology-briefs/en/IPLMigration-TechBrief.pdf` | manual resmi | **SANGAT TINGGI** — daftar perintah didukung/tidak, perubahan font, Direct Graphics, barcode, posisi cetak antar firmware | ✅ `IPL_Migration_Considerations_PM43_PC43_TechBrief.pdf` |
| **K10/P10 Firmware Release Notes x10.09.010948** (3 Nov 2015) | `web.archive.org/web/20160710234741if_/apps.intermec.com/downloads/eps_download//Firmware%20Release%20Notes%20x10_09_010948.pdf` | firmware notes | **SANGAT TINGGI** — riwayat lengkap perubahan perilaku IPL per versi, termasuk bug `<ESC>g1`, `<SI>L` di 406dpi, font | ✅ `IPL_Firmware_Release_Notes_K10_v9_P10_v9.pdf` |
| **IPL Command Reference Manual 937-028-003** (firmware K10/P10, PC23d/PC43/PD43/PM43) | `web.archive.org/web/*/apps.intermec.com/downloads/eps_man/937-028-003/Content/**` | manual resmi | **SANGAT TINGGI** — manual generasi saat ini; tabel font resident dengan pemetaan Monotype asli; Direct Graphics dengan contoh byte | ✅ 17 halaman HTML di `IPL_Command_Reference_K10_937-028-003/` |
| **IPL Programming Reference Manual P/N 066396-003** | `web.archive.org/web/2000if_/corp.intermec.com:80/manuals/066396/iplprm.pdf` | manual resmi | **TINGGI** — PRM versi lebih lama dari yang dimiliki repo (repo punya -005, -008, -012); daftar bahasa n=0–33 lengkap | ✅ `IPL_Programmers_Reference_Manual_066396-003.pdf` |
| **PB series firmware IPL 11.4.0** (zip, berisi readme rilis) | `web.archive.org/web/20160806182603if_/apps.intermec.com/downloads/eps_download//IPL_PB_series11.x.x_v11.4.0.zip` | firmware | Sedang — model mobile, tapi membuktikan format release note firmware | ✅ `IPL_PB_series11_v11.4.0.zip` (di temp) |
| **Sample IPL Arab nyata** (`IPLArabic_sample.txt`) | `web.archive.org/web/20160629185029id_/community.intermec.com/intr/attachments/intr/DevPrinterBoard/192/1/IPLArabic%20sample.txt` | stream nyata | **TINGGI** — stream IPL asli dari forum developer Intermec, dengan kontrol `<SI>`/`<ESC>` dan teks Arab UTF-8 | ✅ `IPL_Samples_Real/IPLArabic_sample.txt` |
| **PD43/PD43c User Manual** (via archive.org) | `archive.org/download/manualzilla-id-7188886` | manual | Sedang — menyebut daftar font resident printer + bahasa | ✅ teks diekstrak (tidak disalin ke repo) |
| **PD41/PD42 Migration Considerations For PD43** | `archive.org/download/manualzilla-id-5991389` | manual | Sedang — perubahan antar-generasi | ✅ teks diperiksa |
| **PM43 FAQ** | `archive.org/download/manualzilla-id-5831687` | KB | Rendah (tidak ada tabel IPL) | diperiksa, tidak relevan |
| **GitHub: `pikidisini/Thermal-Label-Studio`** `ipl_encoder.py` | `raw.githubusercontent.com/pikidisini/Thermal-Label-Studio/main/engine/printer_encoders/ipl_encoder.py` | kode | Sedang — encoder IPL pihak ketiga; alur `G1;o…;w…;h…;d0002` | ✅ teks diperiksa |
| **GitHub: `Harshith38/bwpost_webapp_v01`** `intermec_print_v5.html` | `raw.githubusercontent.com/Harshith38/bwpost_webapp_v01/main/intermec_print_v5.html` | kode | **TINGGI** — **contoh stream IPL nyata untuk printer PF4i** dikirim lewat Web Serial | ✅ `Real_IPL_Streams/PF4i_WebSerial_test_stream.html` |
| **Forum Intermec: "Sending IPL commands to PC43t"** | `web.archive.org/web/*/community.intermec.com/t5/Printing-Applications/Sending-IPL-commands-to-PC43t/td-p/24923` | forum | **TINGGI** — stream produksi C# nyata, plus jawaban moderator resmi | ✅ diperiksa |
| **Forum Intermec: "PC43d printing issue via IPL"** | `web.archive.org/web/*/community.intermec.com/t5/Printing-Applications/PC43d-printing-issue-via-IPL/td-p/23532` | forum | **SANGAT TINGGI** — pernyataan moderator tentang orientasi default IPL | ✅ diperiksa |
| **Forum Intermec: "IPL sample from Dev Guide always gives printer error 'Data field missing'"** | `web.archive.org/web/*/community.intermec.com/t5/Printing-Applications/IPL-sample-from-Dev-Guide.../td-p/5622` | forum | **TINGGI** — jebakan sintaks `<STX>` literal vs byte 0x02 | ✅ diperiksa |
| **Gutenprint `print-dpl.c`** | `raw.githubusercontent.com/echiu64/gutenprint/master/src/main/print-dpl.c` | **kode referensi DPL** | **TINGGI untuk DPL** — implementasi DPL lengkap dalam C | ✅ `DPL_Reference_Sources/gutenprint_print-dpl.c` |
| **`kimasplund/nokka`** `dpl.py` + skill doc DPL | `raw.githubusercontent.com/kimasplund/nokka/main/...` | **kode + fakta hardware DPL terverifikasi** | **SANGAT TINGGI untuk DPL** — fakta terverifikasi pada M-4208, tabel font & symbology | ✅ `DPL_Reference_Sources/` |
| **`hengmengsroin/portakal_flutter`** `docs/protocols/dpl.md` | `raw.githubusercontent.com/hengmengsroin/portakal_flutter/main/docs/protocols/dpl.md` | dokumentasi | Sedang untuk DPL | ✅ `DPL_Reference_Sources/portakal_dpl_protocol.md` |
| **DPL Command Reference (Honeywell)** `dpl-en-cr.pdf` | `web.archive.org/web/20201024024138/https://www.honeywellaidc.com/en/-/media/.../dpl-en-cr.pdf` | manual resmi | **TINGGI untuk DPL** | ❌ **TERPOTONG** — lihat catatan di bawah |

### ⚠️ Satu kegagalan teknis yang harus diketahui

Snapshot Wayback untuk **semua PDF DPL-EN-CR** (dan DPL_88-2360-01_B) rusak:
wayback menyajikan **tepat 1.048.576 byte** (1 MiB) setiap kali, sementara
`x-archive-orig-x-crawler-content-length` melaporkan 2.026.421 byte. Enam snapshot
berbeda (2019→2021), dengan/tanpa `if_`, HTTP/1.1, `Accept-Encoding: identity`,
dan reassembly via Range — semuanya memberi byte terpotong yang **identik** (tail
`...72 5d bc 72 1f c5 62 54 d6 20 f3 4c 90 3d fb fd`), dan `pdftotext` menolaknya
("Couldn't read xref table"). **Bukan batas ukuran jaringan**: zip 8.16 MB dari
host yang sama terunduh utuh dalam 6 detik (`speed=1363313`), dan PDF 1.071.245
byte (K10 release notes) juga utuh. Jadi ini cacat penyimpanan/pelayanan pada
objek itu. PDF DPL resmi karena itu **belum berhasil diambil**.

---

## Bagian per item permintaan

### 1. Firmware notes / release notes printer IPL

**DITEMUKAN — hasil terbaik dari seluruh riset ini.**

Dokumen kunci: **"Printer Firmware Release Notes, Version 9, x10.09.010948"
(PC43t/PC43d/PC23d = K10.09.010948; PM43/PM43c/PM23c = P10.09.010948;
PD43/PD43c = K10.09.010948), 3 November 2015.**
Menariknya, dokumen ini menyatakan versi IPL-nya sendiri:

> "Family / Model Names / Firmware Code / **IPL** / ESim / DSim
> PM Series Mid-range Industrial | PM43, PM43c, PM23c | P10.09.010948 | **1.001155**
> PC Series Desktop | PC43t, PC43d, PC23d | K10.09.010948 | **1.001155** | 1.001155 | 6.001155
> PD Series Light Industrial | PD43, PD43c | K10.09.010948 | **1.001155** | 1.001155 | 6.001155"

Perubahan perilaku perintah yang disebut eksplisit — inilah yang diminta prompt:

**Direct Graphics:**
- `16349 IPL graphics problem (when using <ESC>g1 command)` — subsystem Images
- `15952 IPL direct graphics mode command <ESC>g1 doesn't work` — Language Conformance
- `16395 Direct graphics can't be printed if using binary controlcode` — Images
- `16350 IPL graphics problem (when using IPL UDC commands)` — Images
- `13891/17016 PM43 IPL not able to download UDC graphics` — Images

**Font resident:**
- `15449 The first dot row missing for IPLFONTx printing` — Fonts
- `15752 Different char size when using 406dpi TPH` — Fonts
- `15894 IPL font alias file limit is 16 entries only` — Fonts
- `15985 IPL user-defined character doesn't work anymore` — Fonts
- `16127 IPL UDF and UDC don't work anymore` — Fonts
- `16939 CPR 140421-000160 PM43 - IPL c57 to c60 are not scaled properly` — Fonts
- `130425-000107 IPL aliasing font base point size change without file entry`
- `Missing "Univers Condensed Bold" in webpage font lists`

**Penambahan/penghapusan fitur font — kutipan langsung:**
> "**Restored IPL Speedo fonts for Legacy Mode**
> For customers using IPL Legacy Mode, we have restored the Speedo fonts present in
> the PM4i and earlier model printers. This will result in label formats printed using
> Legacy Mode commands that look much closer to the legacy model printers than before.
> If you are not using Legacy Mode your labels will continue to look as they have."

> "**Restored IPL 86xx-15mil bar code capability**
> We have restored the ability to print 15mil bar codes."

**Posisi cetak / margin:**
- `15788 Continuous media, feed 1200dots before start to print`
- `130412-000023 PC43: start print position different from PM printer by 1mm`
- `130426-000005 PC43T print location differs from PF8T`

**Barcode:**
- `17019 ... IPL:EAN (c7) incorrect size printout on 406dpi`
- `17020 ... IPL:Incorrect size 2D barcodes for 15mil emulation`
- `17023 IPL:Datamatrix barcode printed incorrectly`
- `130510-000070 IPL Not adding check digit to Code 39 barcode`
- `130503-000027 PC43t PDF417 barcode missing`
- `130507-000178 PC43T cannot print PDF417 correctly when PF8T is OK`
- `16033 C# Drawing Render() and Export() behaving unexpectedly`

Dokumen **kedua**, sama pentingnya: **"IPL Migration Considerations for PM43 and PC
Series Printers" (Intermec, 612241-A 11/12)**:

> "New Intermec printers introduce a completely new firmware architecture… This change
> in architecture includes a new version IPL that does not inherit source code from
> earlier implementations."
> "73% of all IPL commands were carried over from legacy IPL implementations"
> "Over 7,000 known IPL use cases were tested before the release of IPL"

Kutipan krusial tentang font:
> "In 2010 Intermec moved to **Monotype font technology** with the PD41/42, PF2i/4i,
> PM4i and PX4i/6i upgrade printers. […] New printer resident fonts do not exactly
> match legacy fonts in terms of character look, but care was taken to ensure the new
> fonts are **metrically compatible** (fit in the same space) with legacy fonts"

> "**Outline Fonts**: Download of outline fonts using IPL commands is not supported."
> "**C0 to c7 Fonts**: When compared to PF2i/4i, PM4i and PX4i/6i upgrade printers
> fonts at 400 dpi may look different."

> "**Printing Position**: The fixed offset of 3mm for all print heads along system x
> axis (IPL y axis) printing position may not be same as PD41/42, PF2i/4i, PM4i and
> PX4/6i upgrade printers. You may need to adjust system X margin (IPL y axis) or
> start/stop (IPL x axis) adjust to achieve legacy printing positions."

> "IPL does not support printing control characters in rotated orientation for bitmap
> font c0, c1, c2 and c7."

> "**Date and Time (d4/d5 in field data)**: IPL prints the date format correctly
> according to the IPL manual, however the print outs are different than PF2/4i, PM4i
> and PX4/6i printers."

> "**UPC/EAN** — IPL barcode select command - c7: IPL application will print the 1st
> and last digit outside the guard bars for EAN/UPC barcodes as compared to PF2i/4i,
> PM4i and PX4i/6i upgrade printers."

> "**Configuration Transmits** — IPL utilizes the system start and stop adjust
> configuration for the following settings: `<SI>f` label rest point (Stop Adjust),
> `<SI>F` top of form (Start Adjust), `<SI>X` origin adjust (Start Adjust), `<SI>r`
> label retract distance (Start Adjust). If you have configured these settings via
> command, the resulting value may not be accurate."

Perintah yang **TIDAK didukung** di firmware baru (daftar eksplisit dari TechBrief):
`<ESC>d`, `<ESC>e`, `<ESC>J`, `<ESC>j`, `<ESC>k` (auto-transmit) — `<SI>P` (comm port
config) — `<ESC><SYN>` (message delay) — `<VT>` (status dump) — `<ESC>Z` (image
compression transmit), `<ESC>%` (user-defined tables transmit), `<SI>Z` (image
compression set), `<SI>xp` (ribbon save zones), `<SI>%` (intercharacter delay),
`<SI>ws,WPA2` / `<SI>wt,WPA` / `<SI>wt,WPA2` — dan mode `Emulation Mode (10 mil for
100 dpi printhead / Data Shift / One Bit per Byte)` dilaporkan pada tabel "Supported
Modes" namun `g` (UDC/Graphics Print) digantikan `U`.

Ditambah: **"DPL: Not printing first line"** dan `16024 DSim: DPL: Not print out the
prn file` muncul di daftar defect K10 — jadi DSim memang ada di firmware ini.

**Firmware lain yang dicari:** konfirmasi bahwa rilis P10 pasca-2015 tidak terarsip;
dan tidak ada release notes untuk PD43/PM43/PC43 di luar K10/P10 (keluarga K10/P10
memang satu firmware untuk semua model itu).

**Query yang dicoba (item 1):**
`Intermec PD43 firmware release notes IPL changes` · `Honeywell PD43 PM43 firmware release notes PDF support portal` ·
`"Intermec" printer "IPL" firmware version history PC43 PM43` · `Intermec 3400 printer IPL programmer reference manual` ·
`Honeywell PD43 firmware download` (semua via WebSearch — 0 hasil) ·
Wayback CDX `apps.intermec.com/downloads*` (1151 entri) · CDX `hsmftp.honeywell.com` (60 entri; hanya halaman login + 2 jalur firmware PM43 yang butuh auth) ·
`archive.org` query `intermec firmware release note`, `intermec usernote`, `pd43`, `pm43`, `pc43`, `px6i`, `intermec 3240/3440/4420` ·
CDX `support.honeywellaidc.com/s/article*` (400 artikel) dan `sps-support.honeywell.com/s/article*` (800 artikel).

### 2. Metrik glyph resmi font resident bitmap (c0–c7)

**TIDAK DITEMUKAN sebagai tabel metrik.** Tidak ada sumber yang memuat *cell width,
gap, baseline* resmi per font; yang ada hanya ukuran sel.

Yang **ditemukan** dan berguna:

(a) Manual K10/P10 (937-028-003) halaman `Font Type, Select` — **nama dan pemetaan
font asli** (lihat bagian "Yang membantah asumsi proyek"):

```
n   Font Name                              Mapped to Monotype TrueType Fonts
0   7 x 9 Standard (86XX font)             IPLFONT0
1   7 x 11 OCR (86XX font)                 IPLFONT1
2   10 x 14 Standard (86XX font)           IPLFONT2
3-6 User-defined fonts
7   5 x 7 Standard (86XX font)             IPLFONT7
8-19 User-defined fonts
20  8 point monospace                      Andale Mono
21  12 point monospace                     Andale Mono
22  20 point monospace                     Andale Mono
23  OCR A                                  OCR A
24  OCR B size 2                           OCR B
25  Swiss Mono 721 standard outline font   Andale Mono
26  Swiss Mono 721 bold outline font       Andale Mono Bold
28  Dutch Roman 801 proportional outline   CG Times
30  6 point monospace bold                 Andale Mono Bold
31  8 point monospace bold                 Andale Mono Bold
32  10 point monospace standard            Andale Mono
33  10 point monospace bold                Andale Mono Bold
34  12 point monospace bold                Andale Mono Bold
35  16 point monospace standard            Andale Mono
36  16 point monospace bold                Andale Mono Bold
37  20 point monospace bold                Andale Mono Bold
38  24 point monospace standard            Andale Mono
39  24 point monospace bold                Andale Mono Bold
40  30 point monospace bold                Andale Mono Bold
41  36 point monospace bold                Andale Mono Bold
61  Swiss 721                              Univers
62  Swiss 721 bold                         Univers Bold
63  Swiss 721 bold condensed               Univers Condensed Bold
64  Prestige bold                          Andale Mono Bold
65  Zurich extra condensed                 Univers Extra Condensed
66  Dutch 801 bold                         CG Times Bold
67  Century Schoolbook                     Century Schoolbook Roman
68  Futura light                           Univers
69  Letter Gothic                          Letter Gothic
```

(b) `Font Character Width, Define` (937-028-003) — rumus pitch yang eksplisit:
> "**Purpose**: Defines the amount of space from the origin of one letter to the
> origin of the next. […] Syntax `Zn` […] **For all printers, the default value is
> the character's bitmap width, minus the font character offset (`Xn`) plus the
> intercharacter space (`zn`)**. Range: 1 to 799. […] This command is for bitmap
> characters only. The printer ignores the intercharacter space command (`zn`) if
> you use it with this command."

(c) `Height Magnification of Bar, Box, or UDC, Define` — himpunan default yang
berbeda dari yang dipegang repo:
> "**h n**. Values for n: Field Type / Range / **Default**
> Box 1 to 9999 dots / **100** · Bar code 1 to 9999 dots / **50** ·
> User-defined Character 1 to 999 dots / **1** · Graphics 1 to 250 / **1** ·
> Human-readable 1 to 250 / **2** · POSTNET 1 to 250 / **2**"

(d) `Point Size, Set` — default `k` adalah **12**, range 4–288 (dapat diubah via
`PointSizeMin` di `/home/user/config/ipl/IPL.CFG`):
> "**k n** … Range: 4 to 288 / **Default: 12** … A point size equals 1/72 inch."

(e) `c n [,m][,p]` — parameter ketiga yang belum tentu dimodelkan repo:
> "m = Intercharacter gap (space between characters). **Default is 0. Range is -199
> to 399.** p = Name of the font (if the font does not have an ID number)."

**Daftar font resident dari user manual printer** (PD43 dan PM43 — dua manual
berbeda, daftar sama):
> "Resident Fonts: **Andale Mono · Andale Mono Bold · CG Times · CG Times Bold ·
> Century Schoolbook Roman · IPLFONT0 · IPLFONT1 · IPLFONT2 · Letter Gothic · OCR A ·
> OCR 8 (varian: OCR 8/OCR B) · Univers · Univers Bold · Univers Condensed Bold ·
> Univers Extra Condensed**"

**Query (item 2):** CDX `937-028-003*` (104 halaman) · `Font_Type_Select`, `Font_Character_Width_Define`, `Height_Magnification...`, `Point_Size_Set`, `Download_Fonts_to_the_Printer`, `Create_User_Defined_Font_Characters_for_Advanced_Mode` ·
CDX `intermec.com` filter `.*ipl.*` · archive.org `IPLFONT`, `intermec ipl command` ·
manual PD43/PM43 di archive.org di-scan untuk "Substitution", "Character Set",
"Code Page", "Resident Font" → **0 hasil untuk tabel**. Hasil akhir: **tidak ada
tabel metrik glyph resmi**; yang otoritatif hanya *ukuran sel* (7×9, 7×11, 10×14,
5×7) dan *rumus pitch* di (b).

### 3. Tabel substitusi resident Appendix B (n=0–9)

**TIDAK DITEMUKAN dari sumber resmi terpisah.**

Yang **berhasil** ditemukan:

(a) **Daftar lengkap bahasa n=0–33** (identik di PRM 066396-003 p.7-58/7-59 dan di
manual K10 `Printer Language, Select`):
```
0 U.S.A.          1 United Kingdom  2 Germany         3 Denmark        4 France
5 Sweden          6 Italy           7 Spain           8 8-Bit ASCII     9 Switzerland
10 CP850          11 CP1250 Central Europe   12 CP1251 Cyrillic   13 CP1252 Latin 1
14 CP1253 Greek   15 CP1254 Turkish 16 CP1255 Hebrew  17 CP1256 Arabic 18 CP1257 Baltic
19 CP1258 Vietnamese  20 CP874 Thai   30 CP932 Shift JIS   31 CP936 GB2312   32 CP949 KSC5601
33 CP950 Big 5    **40 UTF-8**
```

(b) **Kalimat yang menutup pintu**: kedua manual, dua generasi berbeda, sama-sama
mengalihkan tanggung jawab tabel itu ke user manual printer:
> (937-028-003, halaman Appendix "ASCII Tables and International Character Sets")
> "Refer to these ASCII tables to create user-defined fonts: Full ASCII Table, Full
> ASCII Control Characters Table. **For international character sets, see your printer
> user manual.**"

> (066396-003) "You may want to look through the page tables in Appendix B to
> determine if one of the other languages (0 through 10) would be more suitable."

(c) **Yang proyek belum punya: tabel Appendix B dari PRM 066396-003 tercetak di
PDF yang sudah diunduh.** Ada 4 tabel di sana: *Advanced Character Table*,
*8636/46 Character Table*, *IBM Translation Character Table*, dan *Code Page 850
Character Table* (hal. B-3 s/d B-5). Catatan penting: **tabel ini diekstraksi buruk
oleh pdftotext** (glyph non-ASCII hilang; hanya posisi hex yang tersisa), jadi harus
dibaca dari PDF sebagai gambar, bukan teks. PRM yang sudah dimiliki repo (-008/-012)
"agree cell for cell" menurut catatan kode proyek — tabel 066396-003 memberi
**sumber ketiga independen** untuk verifikasi itu.

(d) **Verifikasi independen keputusan proyek soal 0x7C**: tabel *Full ASCII Table*
dari manual K10 mendefinisikan 0x7B=`{`, **0x7C=`|`**, 0x7D=`}`, 0x7E=`~`. Ini
membenarkan keputusan `residentCharset.ts` yang menolak broken-bar U+00A6 di sel 0x7C
dan memperlakukan n=0 sebagai identitas (dua dokumen lagi: "Full ASCII table + ISO
646 agree on pipe").

(e) Dari manual PD43 (archive.org) — nama file font resident yang sebenarnya:
`IPLFONT0`, `IPLFONT1`, `IPLFONT2`, `IPLFONT7`. Ini jalur penelusuran baru: kalau
seseorang punya dump filesystem printer, **file-file itu yang memuat tabel
substitusi yang dicari**.

**Query (item 3):** WebSearch `"language substitution" Honeywell IPL` (0 hasil) ·
CDX `937-028-003*` filter `International|Character|Substitution` · halaman
`Data_Shift_International_Characters` (ditemukan — ternyata soal `<SUB>`/`<DLE>`,
bukan tabel substitusi) · `Appendix_ASCII_Tables...` ·
scan kata kunci "Substitution"/"International"/"Character Set"/"Code Page" pada
PD43 dan PM43 user manual di archive.org → **0 hasil**.

### 4. Contoh stream IPL nyata dari sumber SELAIN BarTender

**DITEMUKAN — 4 contoh nyata + 1 sumber encoder.**

**(i) Stream produksi C# (aplikasi nyata, printer PM4i/PC43).** Thread
"Sending IPL commands to PC43t" memuat kode pengiriman label yang dipakai produksi:
```
<STX><ESC>C<ETX>                                  // Advanced mode
<STX><ESC>P<ETX>                                  // Enter Program mode
<STX>E4;F4;<ETX>                                  // create format 4, field 4
<STX>H0;o94,99;f0;c25;h14;w8;d3,store:;<ETX>
<STX>H1;f0;o156,48;c26;b0;h51;w51;d3,<storenum><ETX>
...
<STX>B2;f0;o156,364;c0,6;w3;h132;r0;d3,<palletnum><ETX>
<STX>H6;f0;o267,488;c26;b0;h26;w26;d3,<palletnum><ETX>
...
<STX>R<ETX>                                       // end Program mode
<STX><ESC>E4<ETX>                                 // select format 4
<STX><CAN><ETX>                                   // clear data
<STX><ETB><ETX>                                   // print
```

**(ii) Stream Web Serial untuk printer PF4i** (`bwpost_webapp_v01`) — lengkap dengan
konversi kontrol char:
```
<STX><ESC>C<ETX> <STX><ESC>P<ETX> <STX>E1;F1;<ETX>
<STX>H0;o100,50;f3;c26;h50;w50;d3,TEST PRINT;<ETX>
<STX>H0;o100,120;f3;c26;h30;w30;d3,Intermec PF4i;<ETX>
<STX>B0;o100,220;f3;c6,0;i0;h50;w2;d3,*TEST123*;<ETX>
<STX>R<ETX> <STX><ESC>E1<ETX>
```
dan di JS-nya: `.replace(/<STX>/g,'\x02').replace(/<ESC>/g,'\x1B').replace(/<ETX>/g,'\x03')`.

**(iii) Sampel IPL Arab resmi forum developer Intermec** (`IPLArabic_sample.txt`,
byte nyata, BOM UTF-8 di depan):
```
efbbbf 02 1b 43 30 03 0a0d           <STX><ESC>C0<ETX>
02 1b 6b 03 0a0d                     <STX><ESC>k<ETX>
02 0f 4c32 3030 03 0a0d               <STX><SI>L200<ETX>   ← catat: 0x0F = <SI>
02 0f 53 3430 03 0a0d                 <STX><SI>S40<ETX>
02 0f 64 30 03 0a0d                   <STX><SI>d0<ETX>
02 0f 68 30 2c30 3b 03 0a0d           <STX><SI>h0,0;<ETX>
... 02 0f 46 3237 … 02 0f 57 3431 30 … 02 0f 67 30 2c31 3830
02 1b 50 03 0a0d                     <STX><ESC>P<ETX>
02 45 2a 3b 46 2a 3b 03              <STX>E*;F*;<ETX>
02 4c 31 3b 03 0a0d                  <STX>L1;<ETX>       ← L = line field
02 48 30 3b6f3133362c313133 3b 6633 3b 63 33 3b 6b 31 32 3b 64 33 2c<teks Arab>
02 44 31 3b 03 0a0d                  <STX>D1;<ETX>
02 52 03 0a0d                        <STX>R<ETX>
02 1b 45 2a 18 03 0a0d               <STX><ESC>E*<CAN><ETX>
02 1e 31 1f 31 17 03 0a0d            <STX><RS>1<GS>1<ETB><ETX>
```

**(iv) Program Fingerprint yang MENCETAK tabel karakter dari printer**
(`asciitbl_greek.prn` — `<ESC>EZ{LP}<ESC>wP` diikuti dump 0x20–0xFF; dan
`asciitbl_cyr.txt` — `<ESC>EZ{LP}<ESC>wP`). Ini resep untuk **mendapatkan tabel
substitusi langsung dari printer fisik** dengan satu perintah — sangat berguna
untuk jalur D di docs/HONEYWELL-SIMULATOR.md.

**(v) `pikidisini/Thermal-Label-Studio`** `ipl_encoder.py` — encoder pihak ketiga;
alur yang didokumentasikan di komentarnya:
> "1. `<STX>C<ETX>` (Clear/Reset format buffer) 2. `<STX>L<ETX>` 3. `<STX>D<ETX>`
> 4. `<STX>G1;o<x>,<y>;w<w>;h<h>;d<data_mode>;<ETX>` (mode 0002=uncompressed hex)
> 5. `<STX>u<HEX_STREAM_DATA><ETX>` 6. `<STX>R<ETX>` 7. `<STX>E1;F1;<ETX>`"

dan invariant yang ditegakkan: "IPL graphic width must be a multiple of 8 dots" —
konsisten dengan model grafis proyek.

**Query (item 4):** GitHub code search `extension:ipl` (3280 hasil — mayoritas file
peta GTA `.ipl`, bukan IPL printer!) · `"IPL" "Intermec"` (4888) · `Intermec IPL
"E1;F1"` (2 → **dua repo baru di atas**) · CDX `community.intermec.com/*` filter
`\.(ipl|prn|txt)$` · CDX `intermec.com` domain filter ekstensi ·
`archive.org` query `intermec label format`.

### 5. Semantik yang masih abu-abu

**(a) `<ESC>g` Direct Graphics — DITEMUKAN, dan lebih detail dari manual lama.**

Manual K10 (937-028-003) `About Direct Graphics Mode` memberi **contoh byte
lengkap** dengan penjelasan per-command, jauh lebih eksplisit daripada PRM lama:

> "The RLE file may contain five types of data, each of which is one byte long.
> **Immediate Commands** — recognized and executed as regular IPL commands. Byte
> format (7-0): 000xxxx Range: 0-31.
> **Compression Encoding Commands** — … Byte format (7-0): 000xxxx Range: 32-63.
> **Low Order Data** — up to 7 bits (0 to 127). Eighth bit is always set to 1.
> Byte format: 1xxxxxx Range: 128-255.
> **High Order Data** — combined with low order data, up to 13 bits (0-8191).
> **Printer ignores high order data followed by a command or more high order data.**
> 6 bits long… Byte format (7-0): 01xxxxx Range: 64-127 Data represented: 0-63.
> **Bitmap Data** — uncompressed bytes (7 data bits per byte)… 8th bit always 1."

**Arah muat kolom (bottom-up) dinyatakan tegas:**
> "after you enter Direct Graphics mode, your printer loads the information in the
> **reverse y direction**. Each column of the graphic loads from the bottom to the
> top. Y coordinates now start at 0 from the bottom left corner and increase in size
> as the data loads."

Contoh byte yang diberikan, dengan terjemahannya:
```
1B 67 30                <ESC>g0   Enter Direct Graphics mode
21 80 43 C2             0x21      Change origin → X0, Y450  (0x03*0x80)+0x42 = 0x1C2
27 90 A8 D5 90 22       0x27      Raw bitmap data follows … 0x22 End of line
26 84 96 22             0x26      Transition white (84-80=4 white, 96-80=22 black)
22                      0x22      End of line
26 8D 84 22             0x26      Transition white (13 white, 4 black)
24 82                   0x24      Repeat last line (82-80=2 times)
25 88 22                0x25      Transition black (9 black)
21 93 43 C2             0x21      Change origin → X19, Y450
25 43 C2                0x25      Transition black → Y450
28                      0x28      End of bitmap
```

> "When you download a direct graphic to the printer, the printer stores the graphic
> in the image bands until you: clear the label data · set up another format · enter
> Program mode or Test and Service mode."
> "when you download direct graphics, the printer retains no information regarding the
> existence of the graphic in its image bands. Therefore, the printer cannot reuse
> those image bands… With standard memory, you should be able to print almost any
> label up to 15.2 cm (6 in) long."

**Gap yang belum terjawab:** TechBrief menyatakan `g` (UDC/Graphics Print) dan
`<SI>o` (Direct Graphics Emulation Mode, Enable or Disable) tetap didukung di
firmware baru, sementara `<SI>Z` (Image Compression Set) **dihapus** — dan 5 defect
`<ESC>g1`/binary-controlcode di release notes menunjukkan wilayah ini paling rawan
beda perilaku antar-firmware. **Tidak ada dokumen yang menyatakan versi firmware
mana memperbaiki `<ESC>g1`**, karena release notes itu sendiri baru sampai v9.

**(b) `<SI>l` code page di luar yang sudah dipetakan — DITEMUKAN daftar lengkapnya,
dan proyek sudah menutup semuanya (n=0–20, 30–33, 40).**

Manual K10 `Printer Language, Select` memberi daftar yang **sama persis** dengan
yang proyek implementasikan, termasuk `40 UTF-8` — dan menambahkan aturan penting:
> "Resident fonts (those that were installed at the factory) use languages 0 through
> 10. […] **Code pages 11 through 33 do not work with resident fonts.**
> If you are using a TrueType font (not bitmap), **you must match the code page to
> your language needs. Do not use languages 0 through 10 with scalable TrueType
> fonts.**"
> "If you are using a downloaded outline (that is, not bitmap) Japanese, Chinese, or
> Korean TrueType font, you must first locate the correct code page and download it
> to your printer. (All others are already stored in your printer.)"

Manual K10 juga memberi tabel konversi UTF-8 1–4 byte → nomor karakter (belum
dibandingkan dengan implementasi `codePages.ts` proyek).

**(c) Command yang PRM sebut "printer dependent" — DITEMUKAN mekanismenya.**
PRM 066396-003 memuat kolom "Printers:" per perintah dengan default dan nilai per
model (`3240 / 3400A/B/C / 3440 / 3600 / 4100 / 4400 / 44X0 / 4X30 / 7421 /
EasyCoder F4`). Contoh nyata: `<SI>hn[,m]` printhead loading mode — 3400A/3600/4400
= N/A, sedangkan 3400C/3440/4100/44X0 = `n=0` normal / `1` Mirror, `,m=0` normal /
`1` Inverse. Ini artinya "printer dependent" bukan ketidakjelasan dokumen,
melainkan **tabel keputusan per model yang memang tercetak di manual** — untuk
PD43 (K10) perilakunya ditentukan manual 937-028-003 yang sama.

**Query (item 5):** CDX `937-028-003*About_Direct_Graphics*` · `Data_Shift...` ·
`Printer_Language_Select` · scan manual K10 untuk "Direct Graphic", "code page",
"`<SI>l`" · release notes K10 kata kunci `Direct Graphic` (2 posisi), `<SI>l` (1).

### 6. Sumber DPL (Datamax)

**DITEMUKAN — dan ini mengubah status item DPL dari "tanpa sumber" menjadi "ada
sumber, tapi belum lengkap".**

**(a) Implementasi referensi lengkap: Gutenprint `print-dpl.c` (41.4 KB, C).**
Memuat tabel perintah DPL: `A B C D E F G H I J K L M N`, `BW`, dan opsi driver
(Continuous/Gap/Notch/Hole/Mark, Landscape, Darkness, dll). Ini bukan manual, tapi
implementasi yang sudah melalui uji cetak nyata.

**(b) Fakta hardware terverifikasi pada printer fisik: `kimasplund/nokka`**
(`dpl.py` + skill doc). Kutipan yang berbobot:
> "DPL's origin is the **LOWER-LEFT** corner and row counts **UPWARD**, in
> hundredths of an inch. On 4x6" media: row 0 = bottom edge, row ~584 = top edge;
> column 0 = left edge, column ~400 = right edge"

> "**The `eee` height field is THREE characters, not four.** `040` = 0.40 in. A
> fourth digit silently shifts every following field and the label comes out
> scrambled."

> "**Never print through CUPS.** A queue bound to a Gutenprint driver rasterises the
> job and mangles raw DPL"

> "**Uppercase id prints human-readable text below the bars; lowercase prints bars
> only.**"

Tabel font internal: `0-2` = 7–18 dots; `3-4` = 27–36 dots; `5-6` = 52–64 dots;
`7-8` = OCR-A/OCR-B; `9` = scalable. Symbology: `E` Code 128, `A` Code 39,
`F` EAN-13, `B` UPC-A, `D` I2of5, `I` Codabar, `O` Code 93, `z` PDF-417 (23 total).

**(c) `hengmengsroin/portakal_flutter` `docs/protocols/dpl.md`** — API tingkat
tinggi, dengan contoh lengkap: `DplPrinter()..startLabel()..density(10)..speed(4)
..text(row:50,col:50,font:'9',content:'…')..barcodeCode128(row:120,col:50,height:70,
content:'…')..quantity(1)..endLabel()`.

**(d) Manual DPL resmi Honeywell ADA** (`dpl-en-cr.pdf` / `DPL_88-2360-01_B.pdf`) —
**ADA, tapi snapshot Wayback-nya terpotong** (lihat catatan metodologi). Ini yang
paling sayang, karena itu satu-satunya calon "spec otoritatif" DPL.

**Contoh `.prn` nyata**: `1D_Blank.prn` dari forum Intermec ternyata **bukan IPL/DPL
mentah** — isinya prolog `'Seagull:2.1:DP` + bahasa Fingerprint/Direct Protocol
(`SYSVAR(48) = 0`, `PRINT#1,"Printing,Media,…"`). Jadi statusnya: contoh DP, bukan
DPL. Tidak ada satu pun file `.dpl` nyata yang ditemukan di seluruh pencarian.

**Query (item 6):** `archive.org` `datamax` (232), `datamax+programming+manual`,
`datamax+class+series`, `"Class+Series+2"+programmer`, `datamax+i+class`,
`datamax+mclass` · CDX `datamaxcorp.com` domain · CDX `honeywellaidc.com` filter
`.*[Dd][Pp][Ll].*` → `dpl-en-cr.pdf`, `dpl_88-2360-01_b.pdf` ·
GitHub code `dpl datamax label printer` (934) · `datamax extension:prn` (0) ·
GitHub repos `datamax` (126).

---

## Yang membantah asumsi proyek

Ini bagian yang paling perlu dibaca. Sumber baru **mengoreksi dua hal** dan
**mengonfirmasi satu hal** yang selama ini dipegang.

### 🔴 TIDAK DIKONFIRMASI — face outline printer BUKAN sekadar "Liberation sebagai aproksimasi"; face aslinya KINI DIKETAHUI

`ROADMAP.md` Fase 0/2 dan `HONEYWELL-SIMULATOR.md` menyebut pertanyaan terbuka:
*"apakah face outline printer selebar Liberation"*. Sumber baru menjawab **face
apa yang sebenarnya**:

| id | Nama yang dipakai proyek (`constants.ts`) | **Face asli menurut manual 937-028-003** |
|---|---|---|
| 20, 21, 22 | "8/12/20 point monospace" | **Andale Mono** |
| 25 | "Swiss Mono 721" | **Andale Mono** |
| 26 | "Swiss Mono 721 bold" | **Andale Mono Bold** |
| 28 | "Dutch Roman 801" | **CG Times** |
| 30–41 | "N point monospace (bold)" | **Andale Mono / Andale Mono Bold** |
| 61 | "Swiss 721" (di luar cakupan) | **Univers** |
| 62, 63 | — | **Univers Bold / Univers Condensed Bold** |
| 66 | — | **CG Times Bold** |
| 67 | — | **Century Schoolbook Roman** |
| 69 | — | **Letter Gothic** |

Konsekuensinya konkret: **c28 (CG Times) adalah serif yang dimensinya bisa
diperiksa dari metrik CG Times**, bukan dari Liberation Serif; dan c20–c41
seluruhnya monospace **Andale Mono** — font yang metriknya dapat diperoleh
(Microsoft mendistribusikan Andale Mono). Ini mengubah pertanyaan terbuka dari
"apakah Liberation cukup dekat?" menjadi **"seberapa jauh Andale Mono/CG Times dari
Liberation?"** — pertanyaan yang bisa dijawab *sekarang*, tanpa printer.

Catatan tambahan yang memperkuat: TechBrief menyatakan Intermec pindah ke **Monotype
font technology pada 2010** dan font baru dibuat **"metrically compatible (fit in
the same space) with legacy fonts"** — jadi ada janji metrik-kompatibel yang
eksplisit dari pabrikan.

### 🟡 PERLU DICEK — dua default dan satu rumus yang mungkin berbeda dari implementasi

1. **Default `k` (point size) = 12** (manual K10 `Point Size, Set`). Kalau
   `viewerParser`/`constants.ts` mengasumsikan default lain untuk field outline
   tanpa `k`, itu penyimpangan.
2. **Default `h` berbeda per tipe field**: box **100** (repo bilang "default h50"
   untuk barcode — barcode memang 50, benar; tapi **box 100** dan **UDC 1**,
   graphics 1, human-readable 2). Pastikan `constants.ts`/renderer memakai himpunan
   ini, bukan satu nilai.
3. **Pitch `Zn` didefinisikan sebagai** `bitmap width − Xn + zn`, dan `zn` (0x22
   intercharacter space) **diabaikan** kalau `Zn` dipakai. Proyek sudah menangani
   pitch (memory "Pitch + §15 closed"), tapi rumus eksplisit ini adalah rujukan
   baru yang bisa memverifikasinya.
4. **`c n[,m][,p]` punya parameter `m`** (intercharacter gap, default 0, range
   **−199 to 399**) dan `p` (nama font). Kalau parser mengabaikan `m`, label
   dengan `c25,3` akan salah lebar.

### 🟢 DIKONFIRMASI — keputusan `n=0` = identitas itu BENAR

`residentCharset.ts` menolak broken-bar U+00A6 di 0x7C untuk baris U.S. dan
memperlakukan n=0 sebagai identitas, dengan alasan "Full ASCII Table defines 0x7C
as |". **Sumber baru membenarkan secara literal**: tabel *Full ASCII Table* dari
manual K10 (937-028-003, 2012–2014) mendefinisikan `01111100 / 7C / 124 / %Q / |`.
Dua manual generasi (066396-003 dan 937-028-003) plus ISO 646 semuanya setuju.

### 🟡 PENGINGAT — perintah yang dilaporkan "didukung" tapi punya defect tercatat

Kedua dokumen baru menaruh keraguan pada asumsi bahwa stream yang kita hasilkan
akan berperilaku sama di semua firmware K10/P10. Yang paling relevan untuk
tujuan utama (preview ≡ cetakan):

- `<ESC>g1` (Direct Graphics nibble mode) — **5 defect terpisah** di release notes
- `<SI>L` "doubles its value in 406dpi" (`130429-000121`)
- `130425-000107 PM43 prints in 2.5 mil when ESC>C is used without parameter`
- `EWR 14934 PM43 IPL single byte status is incorrect`
- `EWR 13946 / 13977 PM43 does not print IPL the same as the PF/PM/PX` / `not the same as PM4i`
- `15883 PM43: <NUL> command is printed with Barcode and Text data`
- `16106 PM43 IPL not printing spaces`

Artinya: **stream yang kita anggap benar bisa mencetak beda di PD43 vs PM4i**, dan
itu bukan bug proyek. Ini memperkuat keputusan cross-check Labelary + printer fisik.

### ℹ️ CATATAN — orientasi default IPL (dari moderator resmi Intermec)

Thread "PC43d printing issue via IPL" memuat penjelasan moderator `karlperry`
(487 post, Moderator) yang layak dikutip karena menyentuh asumsi rotasi proyek:

> "IPL's default orientation is to print labels like you see an inkjet printer print
> a page in 'landscape' mode. The 'top' of an IPL label runs along the left edge of
> the label as it feeds out of the printer. **The 0,0 point is the lower-left corner
> of the label. 'X' runs along the left edge of the label, 'Y' runs across the label
> from left to right.**"

Ini sejalan dengan memory `tes1-reference-png-unreliable` (rotasi halaman
BarTender) dan dengan contoh Direct Graphics K10 ("bottom left corner"). Tidak ada
kontradiksi — tapi ini sumber otoritatif yang bisa menggantikan inferensi.

---

## Langkah lanjut yang disarankan

1. **Audit font pakai daftar face asli (paling berdampak).** Ubah pertanyaan "apakah
   Liberation cukup dekat?" menjadi pengukuran konkret: bandingkan tabel advance
   `fontMetrics.ts` (Liberation Mono) terhadap metrik **Andale Mono** untuk
   c20–c41, dan Liberation Serif terhadap **CG Times** untuk c28. Kedua face
   tersedia bebas (Andale Mono pernah dibundel Windows/Mac). Ini menutup satu dari
   dua pertanyaan terbuka ROADMAP **tanpa printer**. Kalau hasilnya menyimpang,
   ganti tabel advance — mesin render tidak berubah.

2. **Uji klaim `h`/`k`/`Z`/`m` terhadap implementasi.** Empat nilai default
   (h: box 100 / barcode 50 / UDC 1 / graphics 1 / human-readable 2; k: 12) dan
   rumus `Zn = width − Xn + zn` adalah pernyataan otoritatif baru. Tulis tes yang
   GAGAL dulu kalau implementasi menyimpang, baru perbaiki — sesuai disiplin repo.

3. **Pakai resep `asciitbl_*.prn` untuk menutup pertanyaan Appendix B di printer
   fisik.** File Fingerprint itu membuktikan printer bisa **mencetak tabel
   karakternya sendiri** (`<ESC>EZ{LP}<ESC>wP` → dump 0x20–0xFF). Saat ada akses
   printer (Jalur D), satu perintah ini menghasilkan tabel substitusi resident yang
   dicari — tanpa perlu dokumen Honeywell. Tambahkan ke checklist kalibrasi visual
   di `docs/HONEYWELL-SIMULATOR.md`.

4. **Uji silang tabel `n=0..9` terhadap PRM 066396-003 (sumber ketiga).** Repo
   sekarang punya tiga revisi PRM (-003, -008, -012) + 4400 (-005) + manual K10.
   Bandingkan sel per sel; catatan kode proyek mengklaim "-008 dan -005 agree cell
   for cell" — tambahkan -003. Ingat tabel di PDF itu harus dibaca **sebagai
   gambar**, bukan teks (pdftotext menghilangkan glyph non-ASCII).

5. **Batas ulang klaim DPL.** `ROADMAP.md` berkata "tidak ada manual resmi **dan**
   tidak ada oracle **dan** sumber sekunder terlalu tipis". Dua dari tiga masih
   benar; yang ketiga **tidak lagi**: ada `print-dpl.c` (implementasi referensi
   GutenPrint yang mencetak di printer sungguhan) dan `nokka` (fakta hardware
   terverifikasi pada M-4208, tabel font + 23 symbology + koordinat + jebakan
   `eee` 3-digit). Ini belum cukup untuk membangun DPL dengan standar repo — tapi
   kalimat "tidak ada sumber otoritatif" sekarang terlalu kuat dan sebaiknya
   diganti dengan daftar apa yang ada dan apa yang masih hilang (manual resmi,
   contoh `.dpl` nyata).

6. **Kejar manual DPL resmi lewat jalur lain.** PDF `dpl-en-cr.pdf` ADA di Wayback
   tapi terpotong; coba (a) snapshot locale lain (`de-de`, `ja-jp`, `zh-cn`) yang
   mungkin tersimpan utuh, (b) `archive.org` item untuk `DPL_88-2360-01_B`, (c)
   minta ulang ke portal Honeywell (registrasi gratis) — nomor part `88-2360-01`
   dan `dpl-en-cr` adalah kunci pencariannya.

7. **`<SI>l n=40 (UTF-8)` perlu verifikasi tabel.** Manual K10 memuat tabel konversi
   UTF-8 1–4 byte; belum dibandingkan dengan `codePages.ts`. Sekaligus cek apakah
   `decodePrintData` menerapkan aturan "code pages 11–33 tidak jalan dengan font
   resident" — kalau tidak, ada kombinasi yang seharusnya di-warning.

8. **Catat 14 halaman manual K10 tersisa yang belum diunduh.** CDX `937-028-003*`
   mengembalikan 104 halaman `.htm`; yang tersimpan 17. Yang layak dikejar:
   `Bar_Code_Select_Type/*` (25 halaman, per-symbology), `Interpret_Error_Codes`,
   `How_to_Design_Bar_Code_Labels`. Semuanya masih di Wayback.

---

## Berkas yang disimpan

**`docs/manuals/`**
- `IPL_Migration_Considerations_PM43_PC43_TechBrief.pdf` (390 KB) — baru
- `IPL_Firmware_Release_Notes_K10_v9_P10_v9.pdf` (1.0 MB) — baru
- `IPL_Programmers_Reference_Manual_066396-003.pdf` (1.3 MB) — baru
- `Full_ASCII_Table_K10_937-028-003.htm` (134 KB) — baru
- `Font_Type_Select_K10_937-028-003.htm`, `Font_Character_Width_Define_K10_937-028-003.htm`,
  `Height_Magnification_K10_937-028-003.htm` — baru
- `IPL_Command_Reference_K10_937-028-003/` — 17 halaman HTML manual resmi
  (termasuk Direct Graphics + contoh byte, Printer Language Select, Data Shift,
  Full ASCII Control Characters, Interpret Error Codes)
- `IPL_Samples_Real/` — `IPLArabic_sample.txt` (stream IPL asli),
  `asciitbl_greek.prn` + `asciitbl_cyr.txt` (reseptor tabel karakter),
  `1D_Blank.prn` (prolog DP/Seagull)
- `Real_IPL_Streams/PF4i_WebSerial_test_stream.html` — stream nyata PF4i
- `DPL_Reference_Sources/` — `gutenprint_print-dpl.c`, `nokka_dpl.py`,
  `nokka_datamax_skill.md`, `portakal_dpl_protocol.md`

**Tidak** ditemukan / tidak disimpan: tabel metrik glyph resmi, tabel substitusi
Appendix B resmi terpisah, release notes K10/P10 pasca-2015, manual DPL resmi
(snapshot rusak), file `.dpl` nyata.

*Semua temuan di atas berasal dari fetch langsung (URL tercantum) atau kutipan
dokumen yang diunduh. Tidak ada fakta yang diklaim dari ingatan. Yang belum
diperiksa silang ditandai eksplisit.*
