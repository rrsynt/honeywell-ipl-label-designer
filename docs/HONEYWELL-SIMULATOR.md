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

Yang **belum** bisa diputuskan tanpa printer: apakah metrik face outline printer
persis menyamai Liberation, dan apakah firmware memakai tabel substitusi
resident yang sama dengan Appendix B. Keduanya adalah pertanyaan akurasi, bukan
pertanyaan struktur — struktur sudah teruji.

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
