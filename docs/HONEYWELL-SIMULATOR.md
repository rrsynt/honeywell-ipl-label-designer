# Verifikasi Output IPL Tanpa Printer Fisik

> **Status (terverifikasi 2026-08): Honeywell TIDAK menyediakan simulator.**
> Artikel resmi support mereka (000075988, "Does Honeywell provide a Simulator
> software for the printers?", sps-support.honeywell.com) menyatakan:
>
> *"There is no simulator software for Intermec by Honeywell printers.
> The testing can only be performed on a real-live printer."*
>
> Pencarian menyeluruh di portal hsmftp.honeywell.com (folder
> Software > Printers > Desktop > PC23 PC43 PD43 > Current, PC45, Printer
> Software and Drivers, isi zip firmware K10) menegaskan tidak ada file
> simulator. Dokumen ini dulunya menyarankan simulator "resmi" — itu keliru.

Dokumen ini kini menjelaskan jalur validasi yang benar-benar tersedia,
berurutan menurut rasio effort/confidence.

## Jalur A — Cross-check Labelary (tanpa hardware, sudah terpasang)

Konversi IPL → ZPL, render di Labelary, bandingkan dengan preview aplikasi.
Dua engine independen yang sepakat = confidence tinggi untuk **intent layout**
(posisi field, ukuran, data). Fidelity font IPL tidak teruji oleh jalur ini.

```bash
npm run crosscheck -- samples/product.ipl
```

`tools/labelary-crosscheck.mjs` membaca file, konversi via `portakal`,
POST ke API Labelary, simpan PNG hasil render Zebra untuk perbandingan visual.

## Jalur B — Golden files (regresi, sudah terpasang)

`npm run test:golden` membandingkan render piksel-demi-piksel dengan referensi
yang di-commit. Saat ini referensinya self-baseline (mengunci regresi, belum
membuktikan fidelity). Detail: [research/GOLDEN-TESTING.md](research/GOLDEN-TESTING.md).
Ground truth sejati membutuhkan salah satu jalur di bawah.

## Jalur C — Capture bridge (verifikasi byte-stream, sudah terpasang)

Bridge memverifikasi byte-stream yang dikirim (terminator, encoding kontrol,
ukuran payload) tanpa printer:

```bash
node tools/ipl-bridge.mjs --listen=9100
```

Kirim dari viewer (panel Bridge → Test → Send), lalu buka
`http://localhost:9181/capture` untuk melihat persis byte yang akan diterima
printer.

## Jalur D — Akses printer fisik (ground truth sejati)

Tidak ada pengganti printer untuk fidelity penuh (font, metrik barcode,
perilaku firmware). Opsi realistis:

1. **Vendor barcode lokal** — distributor Honeywell/Intermec umumnya punya
   demo unit PC43d/PD43. Satu jam akses cukup: kirim 10–20 file `.ipl`
   lewat panel Bridge (atau PrintSet), foto hasilnya, jadikan golden reference.
2. **Pinjam/komunitas** — penulis [portakal](https://github.com/productdevbook/portakal)
   mencari kolaborator untuk validasi printer nyata; komunitas labelary/labelize
   juga relevan.
3. **Beli unit entry-level** — PC23d adalah printer IPL termurah di line K10;
   satu unit memenuhi semua kebutuhan kalibrasi (line K10 berbagi firmware).

### Checklist kalibrasi visual saat dapat akses printer

> **Diaudit 2026-09-25.** Kedelapan item di bawah kini punya dasar yang bisa
> ditelusuri (manual, export BarTender, atau kontrak test) — bukan lagi
> aproksimasi tanpa rujukan. Yang tersisa untuk printer fisik adalah
> **konfirmasi**, bukan penemuan: setiap baris di bawah menyebut apa yang
> sudah memutuskan nilainya, sehingga satu sesi dengan printer cukup untuk
> memverifikasi kedelapannya sekaligus.

- [x] Tinggi huruf font bitmap (c0/c2/c7) — sel dari PRM270 §7.3 (c0 7×9,
  c2 10×14, c7 5×7), magnifikasi h/w mengalikan; `constants.ts` FONT_MAP.
- [x] Lebar karakter outline (c20–c28) — aproksimasi 0.6 em sudah DIGANTI tabel
  advance per-glyph hasil ukur font Liberation (Batch U,
  `services/ipl/fontMetrics.ts`); monospace eksak, proporsional ≤0.3%.
  **Perlu konfirmasi printer:** apakah face outline printer selebar Liberation.
- [x] Titik jangkar rotasi f1/f2/f3 — dikunci kontrak `tests/rotationWysiwyg.test.ts`
  (12 kasus) dan disepakati DevGuide p.27; sudah diverifikasi terhadap export
  BarTender (90° CCW).
- [x] Tinggi barcode linear vs `h`, lebar modul vs `w` — `h`/`w` dalam dot,
  default h50/w1 (PRM p.53/p.171); lebar narrow = `w` dot, dan aturan picket
  w1→2 kini diterapkan dari `f` (lihat `tests/strokeAndPicket.test.ts`).
- [x] PDF417 proporsi baris — manual menyatakannya: mode auto memakai tinggi
  3× lebar ("as close to a square as possible", PRM p.149), dan encoder memang
  default `rowmult` 3. Parameter eksplisit `c12,m1/m2/m3` kini dipatuhi.
- [x] HRI teks atas/bawah — `i1` di bawah / `i2` di atas, font 0 h2/w2 dengan
  gap 2 dot (PRM p.191); `services/ipl/renderer.ts`.
- [x] Sudut bulat box via `r` — `radiusDots` digambar dengan clamp
  `min(r, w/2, h/2)` seperti printer.
- [x] Interpretive gap 2 dot — diukur dari **kotak field** barcode, bukan baris
  bar terakhir (PRM p.191 "2 dots below bar code"); dipin
  `tests/originAndHri.test.ts`.

- [~] **Offset printhead 3 mm** — **premisnya sudah dikoreksi 2026-09-27 dan
  tidak lagi menunggu printer.** Tech brief migrasi PM43/PC43 menyebut offset
  3 mm pada sumbu x sistem (≈24 dot @203 dpi) sebagai perbedaan **hardware**
  antar generasi printhead, lalu menunjuk sendiri jalan keluarnya: *"You may
  need to adjust system X margin (IPL y axis) or start/stop (IPL x axis) adjust
  to achieve legacy printing positions."* Artinya offset itu **tidak pernah
  hidup di dalam stream** dan memang bukan milik preview — yang hidup di stream
  adalah perintah kompensasinya:

  | Perintah | Arti | Efek pada gambar |
  |---|---|---|
  | `<SI>X m1[,m2]` | Label Origin, X-Y Adjust | menggeser posisi terimajinasi |
  | `<SI>F n` | Top of Form, Set (default 20) | titik awal cetak |
  | `<SI>h n[,m]` | Printhead Loading Mode | `n=1` mirror, `,m=1` inverse |

  **Yang dikerjakan 2026-09-27:** ketiganya kini **dilaporkan** sebagai
  peringatan `setup-not-modelled` alih-alih diabaikan tanpa jejak, dan muncul di
  daftar bantuan perintah. Sengaja diperingatkan, **bukan** dimodelkan: besar
  dan tanda pergeserannya adalah perilaku hardware (interval 5 mil, rentang ±30
  dot, dan `<SI>X` sendiri berbunyi *"IPL uses the system configuration for this
  setting"*), sedangkan aturan proyek ini adalah tabel semacam itu **diukur**,
  tidak ditebak — EPL dan TSPL dua kali membuktikan ongkosnya. Penjaga:
  `tests/unmodelledSetup.test.ts` (8 tes, diverifikasi dengan memasukkan kembali
  bug-nya).

  **Sisa yang masih butuh printer:** besar pergeseran sesungguhnya per unit
  (karena itu tabel di atas belum boleh jadi model), dan apakah `<SI>X` di
  firmware PD43 memang berlaku seperti di K10. Sumber:
  `docs/manuals/IPL_Migration_Considerations_PM43_PC43_TechBrief.pdf`,
  `docs/manuals/IPL_Command_Reference_K10_937-028-003/Label_Origin_X_Y_Adjust_K10.htm`.

Yang **belum** bisa diputuskan tanpa printer: apakah metrik face outline printer
persis menyamai Liberation, dan apakah firmware memakai tabel substitusi
resident yang sama dengan Appendix B. Keduanya adalah pertanyaan akurasi, bukan
pertanyaan struktur — struktur sudah teruji.

### Kalau printer nyata berperilaku beda dari preview — periksa versi firmware dulu

`docs/manuals/IPL_Firmware_Release_Notes_K10_v9_P10_v9.pdf` (versi dokumen
x10.09.010948, 3 Nov 2015; IPL 1.001155) mendaftar defect bernomor **pada jalur
perintah yang justru kita pakai** — direct graphics, font resident, HRI/EAN.
Semuanya di bawah ini **sudah diperbaiki**, dan tabelnya menyebut versi
perbaikannya. Jadi yang perlu dibandingkan bukan daftar ini sendiri melainkan
**versi firmware printer target**: printer yang lebih tua dari kolom "fixed in"
masih bisa memamerkan perilaku ini.

| Issue ID | Deskripsi (verbatim) | Fixed in | Relevansi di sini |
|---|---|---|---|
| 16349 | IPL graphics problem (when using `<ESC>g1` command) | x10.06.008523 | jalur Direct Graphics yang dipakai `bartender-parity-base.ipl` |
| 16350 | IPL graphics problem (when using IPL UDC commands) | x10.06.008523 | jalur UDC `u`/`G` |
| 15952 | IPL direct graphics mode command `<ESC>g1` doesn't work | x10.06.008523 | idem, mode DG |
| 16395 | Direct graphics can't be printed if using binary controlcode | x10.06.008523 | DG dengan byte kontrol biner di payload |
| 15939 | IPL: Missing human readable and barcodes on printout | x10.06.008523 | HRI hilang tanpa sebab yang terlihat di stream |
| 15002.1 | EAN8, 13 and their add-on barcodes position wrong | x10.05.007902 | keluarga `c7` — posisi HRI |
| 15007.6 | EAN UCC barcode overlapping printout issues | x10.05.007902 | keluarga `c7`/`c8` — tumpang-tindih |
| 11136.2 | Printer hangs when printing Font page with variable data | x10.04.007069 | hanya halaman uji printer, bukan alur kerja kita |
| 130429-000121 | IPL: `<SI>L` command doubles its value in 406dpi | x10.06.008523 | label length salah di printer 406 dpi |

Catatan kejujuran: `15009.5` ("ESim: PDF417 barcode printout issues") pernah
ikut dikutip sebagai bug IPL — **itu ESim**, bahasa perintah yang berbeda, dan
tidak berlaku untuk stream IPL kita. Yang benar untuk keluarga itu di IPL
adalah `15002.1` dan `15007.6` di atas.

**Bukan bug preview kita:** stream yang sudah benar bisa tetap salah cetak di
printer yang firmwarenya lebih tua. Catat versi firmware bersama setiap temuan,
supaya perilaku ini tidak salah diatribusikan ke parser/renderer.

Setelah golden reference dari printer terkumpul:
`testdata/golden/<nama>.png` diganti dengan hasil scan/foto printer, lalu
`npm run test:golden` menjadi uji fidelity sejati.

## Catatan sejarah riset (agar tidak diulang)

- Artikel support "Does Honeywell provide a Simulator..." (000075988) sering
  gagal render (CSS Error Salesforce) sehingga isinya tidak terlihat —
  jawabannya ternyata tegas: tidak ada simulator.
- Artikel lain yang menyebut "simulator" (ZSim, DSim, ESim; instalasi via
  Compact Flash) merujuk firmware emulasi yang berjalan DI DALAM printer,
  bukan software PC.
- Portal hsmftp.honeywell.com butuh registrasi gratis + Honeywell Download
  Manager, tapi isinya memang tidak menyertakan simulator.
