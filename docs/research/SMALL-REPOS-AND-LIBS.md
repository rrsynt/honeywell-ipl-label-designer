# Bedah Repos Kecil & Library Pendukung

> Riset source-level 2026-08-24. Semua terverifikasi via fetch GitHub kecuali
> diberi catatan.

## 1. yibudak/godex-ezpl-viewer — viewer EZPL offline single-file

- Satu `index.html`; header comment mendokumentasikan keputusan akurasi: konversi
  tetap 8/12/24 dots/mm, font bitmap berbasis point, anchor QR kiri-bawah,
  output 1-bit — diturunkan dari dekompilasi GoLabel + manual resmi.
- Render: HTML5 canvas murni + `image-rendering: pixelated` (estetika thermal)
  + checkbox output monokrom 1-bit.
- Isi single-file: font Noto Serif base64 + stub ROM bitmap; encoder QR ISO 18004
  self-contained dengan GF(256) Reed–Solomon (uji 8 mask by penalty); encoder 1D
  lookup-table (Code 39/128, EAN-13/8, UPC-A, ITF, Codabar) → run-length + teks HRI;
  layer UI/designer.
- Symbology langka dirender sebagai placeholder berukuran; QR & 1D umum diverifikasi
  **dengan decode hasil render**.
- **Pelajaran**: viewer offline single-file viable; canvas pixelated + selector DPI
  (203/300/600) pas untuk thermal. Parser internal tidak terverifikasi (fetch terpotong).

## 2. Cjmatthews/zpl-parser — IR netral + fidelity modes

- Dua tahap: `tokenizeZpl` (scan `^`/`~`, nama command ≤3 huruf) → `parseZpl`
  state machine satu-pass (homeX/Y, x/y, font/barcode state, pending accumulator
  antara graphic command dan penutup `^FS`). Field emit di `^FS`.
- IR: discriminated union `kind` — text, rect (rx rounding), circle, ellipse,
  line-diagonal (`orientation L|R`), graphic, barcode, qrcode. Shape punya tone/fill/stroke.
- **Fidelity modes**: `{fidelity: "exact"|"simplified"}` — simplified skip ellipse
  (dicatat sebagai skipped), degradasi diagonal→box dengan warning, command tak
  dikenal terakumulasi jadi satu warning. Pola bagus untuk viewer IPL: mode "aproksimasi"
  yang jujur.
- Bonus: `applyContrastHeuristic` — flip teks hitam→putih bila pusatnya di dalam
  shape gelap terisi (trik reverse-video).

## 3. SMenigat/react-zpl-renderer — wrapper React minimal

- API publik cuma `<ZplRenderer zpl width height />`; canvas client-side; SSR off
  via `next/dynamic({ssr:false})`. Sanity check bahwa core viewer bisa disembunyikan
  di belakang dua props.

## 4. le2ni/zplr — TS ZPL lib paling matang arsitekturalnya (2026)

- pnpm workspaces, tsdown, Vitest + Playwright screenshot tests, Lighthouse CI.
- Dual entry engine sama: `zplr/node` (skia-canvas → PNG Buffer[]) dan `zplr/web`
  (HTMLCanvasElement → PNG Blob[]).
- **Pipeline lewat raster 1-bit MSB-first dulu** (virtual printer dot buffer),
  baru ekspansi ke canvas. Model yang tepat untuk fidelity IPL juga.
- Virtual-printer state machine lengkap: syntax chars, print settings, encodings,
  downloaded graphics/fonts, stored formats, numbered fields; `createRenderSession()`
  mempertahankan state antar render FIFO; `fieldValues` mengisi ^FN tanpa rewrite template.
- **Diagnostik terstruktur, bukan exception**: kode stabil, severity, phase, identitas
  command, dan **source span**; safety limits (max 32.768 dots dimensi, 40M px/label,
  16 MiB graphics). Helper editor: `findCommandAtOffset` / `findHighlightRegionAtPoint`.
- Parser dispatch: tokenizer boundary-scan (`findBoundary` ke `^`/`~`/STX/ETX/SI),
  positional slice tervalidasi regex, perilaku via **tabel capability deklaratif**
  (`getCommandCapabilityStatus(canonical)`), sedangkan special case hardcoded minim.
- Layout src/core: 24 file masing-masing berpasangan `.test.ts` (22 file tes termasuk
  fuzz + conformance vs hash raster printer fisik + barcode decoding). Conformance map:
  200+ command dikenali, 94 didukung / 11 parsial / 2 tidak.
- **Template terbaik keseluruhan untuk kita**: capability-table dispatch, diagnostics
  ber-span, raster 1-bit intermediate, tes per-modul berpasangan.

## 5. porrey/Virtual-ZPL-Printer — virtual printer jaringan (.NET)

- TCP server raw stream; deteksi akhir dokumen `^XZ` andal lintas multi-chunk;
  receive-buffer dinamis (buffer tetap >8192 byte terpotong). Port 9100 TIDAK
  terverifikasi eksplisit (TCP configurable sejak v2.3).
- Rendering delegasi penuh ke Labelary; gambar dicache lokal; linting optional
  ditampilkan di viewer khusus.
- UX: multi-konfig printer tersimpan, filter find/replace regex per config, test-label
  window dengan editor + template sampel, Serilog. Folder-watch TIDAK ada (workflow
  network-driven).

## 6. metafloor/bwip-js — verifikasi paket & API browser

- Paket: `bwip-js` utama; platform `@bwip-js/browser`, `/node`, `/react-native`,
  `/generic`. Platform packages ES-modules-only. Untuk kita: `import bwipjs from '@bwip-js/browser'`.
- `bwipjs.toCanvas(canvasOrId, options)` — auto-resize canvas, return canvas:
  `{bcid:'code128', text:'...', scale:3, height:10, includetext:true, textxalign:'center'}`.
- `toSVG(options)` sinkron, return string SVG. Caveat: `toSVG()` menaut SEMUA encoder;
  untuk tree-shaking gunakan import bernama + drawing object.
- Ukuran: module width via `scale` (scale=1 → 1px/module; integer scaleX/scaleY,
  scaleX default 2!). `height`/`width` dalam mm pada ~72 dpi (≈2,835 px/mm).
  `rotate: N|R|L|I`.
- HRI: `includetext`, `textxalign`, `textcolor`/`barcolor`/`bordercolor`; custom font
  via `bwipjs.loadFont(name, size, data)`.

## 7. BinaryKits.Zpl.Labelary — klien Labelary (detail kecil)

- Endpoint `{base}/{dpi}/labels/{w}x{h}/0/`; dpi dari `"8dpmm".Substring(2)`;
  POST UTF-8 bytes body; respons = PNG bytes. Tanpa cache; failure log + return
  array kosong (antipattern silent-failure — jangan ditiru).
- Gotcha locale: format ukuran dengan specifier "G" + culture en-US eksplisit agar
  koma desimal tidak merusak URL.

## Rekomendasi lintas proyek untuk IPL viewer

1. Parser: tokenizer + **capability-table dispatch** (zplr); diagnostics terstruktur
   ber-span sejak hari pertama (zplr, zpl-parser).
2. Element model: discriminated union netral-renderer; opsi fidelity-mode + warning
   skipped-command sejak awal.
3. Renderer: render ke **bitmap monokrom 1 dot = 1 pixel dulu**, baru scale-blit ke
   canvas dengan `image-rendering: pixelated` (zplr + godex) — otentik thermal dan
   golden-image test jadi trivial.
4. Tes: per-module paired files + fuzz + conformance-vs-device-capture (zplr);
   verifikasi barcode dengan decode hasil render (godex).
5. Barcode: jangan hand-roll — `@bwip-js/browser` `toCanvas`/`toSVG`.
