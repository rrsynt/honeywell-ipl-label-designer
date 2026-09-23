# Survei Ekosistem: Proyek Terkait IPL/Fingerprint & Label Rendering

> Hasil riset 2026-08-24. Semua item diverifikasi ada (fetch langsung), kecuali
> diberi catatan lain.

## Temuan utama

**Tidak ada renderer/viewer/emulator IPL open source yang serius.** GitHub search
"intermec IPL parser" dan `"fingerprint printer language"` = 0 hasil. Viewer IPL
komersial terdekat (zplpreview.com) hanya regex ~30 baris. Gap kompetitif nyata.

## Proyek per proyek

### zplpreview.com/ipl-viewer — VERIFIED (bedah bundle webpack)
- Next.js, keluarga viewer bahasa legacy (`/ipl-viewer`, `/dpl-viewer`, `/pplb-viewer`, `/ipl-to-zpl`).
- Implementasi IPL-nya SANGAT dangkal: dua regex — `H\d+;o(-?\d+),(-?\d+);...d\d+,(\d+)` untuk field teks, dan frame non-command untuk data. Digambar sebagai kotak teks di canvas hardcoded **812×1218 px (asumsi 203 dpi 4×6)**. Tidak ada barcode, tidak ada font `c25`/`h`/`w`, tanpa semantik ESC P/E.
- Yang layak ditiru: UX-nya (paste → parse → daftar field terdeteksi → preview aproksimasi → disclaimer akurasi menonjol).
- Kita bisa melampaui ini jauh.

### productdevbook/portakal — VERIFIED
- TypeScript, 58 ⭐, push 2026-04, npm `portakal`, v0.5.0, zero-dep.
- SDK thermal printer universal: 9 bahasa termasuk **IPL** (compile/parse/preview SVG/validate).
- `src/parsers/ipl.ts`: parser framing STX/ETX → `LabelElement[]`; default 832×400 dots. `src/languages/ipl.ts`: compile H/G/W/L/B.
- Fingerprint masih "planned". Penulis aktif mencari validasi printer nyata.
- **Kode IPL open source paling lengkap yang ada** — tetap early; jadi referensi parsing, bukan jadi-jadian.

### php-aidc/label-printer — VERIFIED
- PHP, 59 ⭐, dorman sejak 2021. Punya `src/Language/Fingerprint.php` + layer Emulation (`Canvas.php`, `EmulateText.php`, `PbmCodec.php`, `RllCodec.php`) — konsep rendering Fingerprint server-side. Referensi arsitektur saja.

### Lainnya
- BrunoCaimar/IntermecPB51_IPL_PrintBitmap1bit_Sample (VB, 2015) — sampel cetak bitmap 1-bit via IPL; trivial.
- ari90real/markpoint-renderer (JS, 2026-03) — "Labelary untuk Datamax"; bukan IPL; belum terbukti.

## Labelary — VERIFIED
- Input **ZPL only**, tapi output bisa IPL/EPL/DPL/SBPL/PCL via header Accept (`application/ipl`). Juga `POST /v1/graphics` (gambar→ZPL/IPL/...).
- API render: `GET/POST http://api.labelary.com/v1/printers/{dpmm}/labels/{w}x{h}/{index}/` (dpmm 6/8/12/24; ukuran inci ≤15"; free tier 3 req/s, 5k/hari, tanpa key). Header opsional: X-Rotation, X-Quality (Grayscale/Bitonal), X-Linter (warning di header X-Warnings), dsb.
- Peran bagi kita: (1) cetak biru UX/API, (2) mesin golden-file untuk jalur cross-check IPL→ZPL→render.

## Library barcode browser — VERIFIED
- **bwip-js** (metafloor/bwip-js, 2.4k ⭐, aktif): 100+ symbologies, termasuk SEMUA yang relevan IPL — code39, code128, interleaved2of5, datamatrix, maxicode, pdf417, qrcode, ITF-14, GS1-128, Codablock, MicroPDF417. npm `bwip-js`; build browser: `@bwip-js/browser`. **Rekomendasi tunggal** — tak perlu JsBarcode/zint.
- JsBarcode: 1D saja, tanpa 2D — fallback kurang.
- zint: C/GPL, jalur WASM (`wasmzint`) stale & adopsi rendah — hindari.

## ZPL viewer/designer untuk pinjam pola — VERIFIED
- **Fabrizz/zpl-renderer-js** (54⭐, TS, aktif): ZPL→PNG sepenuhnya client-side dengan engine Go Zebrash dikompilasi WASM (~8 MB). Pola "engine berat di WASM worker, API TS tipis" — model deliverable all-local.
- **BinaryKits/BinaryKits.Zpl** (406⭐, C#, aktif): pemisahan lapisan paling bersih — Protocol (parser) / Label (model elemen) / Viewer / WebApi / klien Labelary. Blueprint arsitektur lapisan.
- porrey/Virtual-ZPL-Printer (342⭐, C#): virtual printer jaringan yang merender job — model UX emulator.
- teynon/ZPL-Label-Designer (200⭐): WYSIWYG web vanilla; preseden UI.
- Kecil tapi relevan: SMenigat/react-zpl-renderer, le2ni/zplr, Cjmatthews/zpl-parser (ide fidelity exact/simplified), yibudak/godex-ezpl-viewer (viewer single-file offline untuk EZPL).

## Resource resmi Honeywell/Intermec — VERIFIED
- **PrintSet 5**: tool konfigurasi printer pintar current (PD43, PC43d/t, PD42, PM23c/PM43c); gratis dari support.honeywellaidc.com (perlu akun). **Tidak ada preview label.**
- Bahasa yang didukung hardware current: IPL, Fingerprint, Direct Protocol, ZSim II, DSim, ESC/P.
- SmartSystems Foundation: konsol manajemen perangkat (di belakang login support).
- Intermec Developer Library lama sudah defunct → sps.honeywell.com; manual selamat sebagai PDF. **Tidak ada emulator/preview resmi publik.**
- Catatan: honeywellaidc.com & sps.honeywell.com sering 301-redirect; deep link cepat busuk.

## Kesimpulan untuk IPL designer/viewer browser kita
1. Tidak ada peserta serius — proyek kita mengisi gap nyata.
2. Titik mulai kode: portakal `src/parsers/ipl.ts` (framing STX/ETX sudah beres); blueprint lapisan: BinaryKits; pola delivery WASM all-local: Fabrizz/zpl-renderer-js; bentuk REST bila perlu backend: Labelary.
3. Barcode: `@bwip-js/browser` satu dependensi untuk semua symbology IPL.
4. Tooling resmi Honeywell tidak memberi apa pun soal render; Programmer's Reference Manual adalah spec otoritatif (sudah diunduh di docs/manuals/).
5. Ground truth tanpa printer: Honeywell Printer Simulator (resmi, firmware asli, port 9100) + capture bridge + cross-check Labelary via konversi IPL→ZPL.
