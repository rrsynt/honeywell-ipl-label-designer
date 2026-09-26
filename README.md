# Honeywell IPL Label Designer & Viewer

Designer label WYSIWYG + **IPL Viewer** (Intermec Printer Language) berbasis web —
mirip ZPL Viewer / Labelary, tapi untuk printer Honeywell/Intermec.

## Fitur

### Designer
- Galeri **template siap pakai** (tombol Templates): blank, shipping 4×6", price tag, asset QR, lot sticker
- Canvas editor: drag/resize/rotate, snap + alignment guides, layer lock/hide, undo/redo
- Field: teks (font bitmap & outline IPL), barcode (20 symbology — encoder yang
  sama dengan Viewer, bukan lagi 6 format JsBarcode), garis, box (termasuk sudut
  bulat via raster graphic IPL); parameter symbology (QR EC/mask, MicroPDF rows,
  RSS version, MaxiCode mode, HIBC format) dapat diedit & bertahan round-trip
- Data source: fixed / variable / date / time / linked (variable & counter)
- Ekspor **job CSV**: tempel tabel CSV, load file `.csv`, atau drag & drop di
  tab Data → kolom terpetakan otomatis ke nama field/sumber data → unduh satu
  .ipl berisi satu print-block per baris (file Excel ANSI/windows-1252 terbaca benar);
  termasuk **pratinjau per-baris** yang merender lewat pipeline viewer sungguhan
  dan **Send Job** (kirim langsung ke printer via bridge lokal, dengan konfirmasi;
  target host:port disimpan bersama dengan Viewer — printer jaringan didukung)
- IPL generator + parser round-trip (dijamin test), simpan/muat localStorage, ekspor JSON
### IPL Viewer
- Live parse saat mengetik — terima byte kontrol asli (0x02/0x1b) maupun notasi literal (`<STX>`/`<ESC>`);
  bahasa dideteksi dari stream (IPL/ZPL/EPL/TSPL) dan bisa diganti manual kalau tebakannya salah;
  DPL (Datamax) sengaja belum didukung — lihat docs/research/ROADMAP.md
- Render: font bitmap/outline per DPI, barcode bwip-js dot-exact (20 symbology:
  Code 39/93/ITF/2of5/11/128+UCC, EAN/UPC+add-on, Codabar, HIBC 39/128, Code 16K,
  Code 49, POSTNET, Planet, PDF417, MicroPDF417, QR Code, Data Matrix, MaxiCode,
  RSS/GS1 DataBar), raster graphic G/U, rotasi 4 kuadran, HRI atas/bawah.
  JIS-ITF (c15) & EAN.UCC Composite (c21) tanpa encoder faithful → placeholder
  + info.
- Validator: urutan command, ID duplikat, rentang parameter, validitas data per symbology
- Zoom/fit, ukuran dots ≈ mm, ekspor PNG/PDF, ekspor **job multi-label**
  (satu PDF multi-halaman ATAU ZIP berisi PNG bernomor untuk semua label
  `<RS>×<US>` dengan odometer, kap 300 dengan konfirmasi awal),
  share via URL (`#ipl=...`)
- Send ke printer/simulator via bridge lokal, atau download .ipl

## Menjalankan

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # vitest
npm run build        # produksi (bwip-js & jspdf lazy-loaded)
```

## Verifikasi tanpa printer fisik

| Cara | Perintah | Keterangan |
|---|---|---|
| Honeywell Simulator (firmware asli) | `npm run bridge` lalu Send di viewer | Panduan: docs/HONEYWELL-SIMULATOR.md |
| Capture stream | `npm run bridge -- --listen=9100` | Bridge jadi fake printer; buka http://localhost:9181/capture |
| Crosscheck Labelary | `npm run crosscheck -- samples/product.ipl` | IPL ke ZPL ke PNG render Zebra untuk perbandingan visual |
| Konversi ZPL | `npm run zpl -- samples/product.ipl` | Tulis samples/product.zpl |
| Crosscheck TSPL | `npm run crosscheck:tspl -- samples/product.tspl` | **Tidak ada oracle independen untuk TSPL** — Labelary hanya menerima ZPL sebagai input, dan engine Labelize mem-parse ZPL/EPL saja. Perintah ini melaporkan pembacaan parser kita per elemen, untuk dicek manusia terhadap manual TSC dan printer sungguhan. Lebih lemah daripada crosscheck EPL, dan disebut apa adanya. |
| Crosscheck EPL | `npm run crosscheck:epl -- samples/product.epl` | Render EPL lewat engine **Labelize** (independen, MIT) dan tulis PNG di sebelahnya. Gunanya bukan identitas pixel, tapi **kesesuaian layout**: parser dan generator kita bisa sepakat satu sama lain tapi sama-sama salah membaca spec — hanya implementasi lain yang bisa menangkap itu. |
| Print server bersama | `npm run print-server` | Satu proses LAN memegang antrean, daftar printer dan log untuk semua stasiun. Alamatnya diisi di Print Center (mis. `http://192.168.1.10:9183`); kosong berarti antrean tetap di komputer ini. Karena server ini yang menulis ke soket printer, ia tahu pasti chunk mana yang sudah tercetak — peringatan "retry bisa cetak dua kali" hilang untuk antrean yang lewat sini. |
| Database langsung | `npm run db-server` | Ambil baris dari SQL Server sebagai sumber data tabel. Alamatnya diisi di tab Data (mis. `http://192.168.1.10:9184`), lalu tombol **From database…** menjalankan query tersimpan. Connection string tinggal di berkas query di server dan tidak pernah dikirim ke browser; klien hanya memilih nama query, tidak pernah mengirim SQL. Barisnya disimpan di dalam design, jadi membuka design lama tidak butuh database. |

## Struktur

- `services/iplGenerator.ts`, `services/iplParser.ts` - generator & parser sisi designer (round-trip)
- `services/canvasDrawer.ts`, `services/geometry.ts` - renderer editor canvas
- `services/ipl/` - pipeline viewer (independen dari model Design)
- `services/zpl/`, `services/epl/`, `services/tspl/` - bahasa printer lain: parser + generator,
  keduanya subset yang melaporkan apa yang tidak bisa digambar lewat peringatan
  bernama, bukan menghilangkannya diam-diam
  - `tokenizer.ts` - framing STX/ETX dual-notasi
  - `viewerParser.ts` - state machine + validator
  - `barcodes.ts` - bwip-js lazy-load, dot-exact
  - `graphics.ts` - codec raster graphic IPL (6-bit packing)
  - `renderer.ts` - painter canvas (rotasi anchor, font, HRI)
- `components/IPLViewerModal.tsx` - UI viewer (live parse, issues, export, send)
- `tools/` - ipl-bridge.mjs (HTTP ke TCP), library-server.mjs & print-server.mjs
  (berbagi perpustakaan desain dan antrean cetak antar PC), db-server.mjs
  (+ query-sqlserver.ps1 — baris dari SQL Server), ipl2zpl.mjs,
  labelary-crosscheck.mjs
- `samples/` - contoh stream IPL; `docs/` - panduan simulator
- `tests/` - vitest: round-trip, viewer, fidelity, validator, sampel

## Catatan desain

Viewer me-render langsung dari hasil parse (model elemen netral), bukan lewat model
`Design` internal - stream IPL pihak ketiga tetap tampil meski tidak sepenuhnya
ter-mapping, dan command asing dilaporkan di panel issues alih-alih dibuang diam-diam.
