# Implementation Plan — BarTender ↔ App Full Parity ("Segitiga Akurasi")

> **Status dokumen**: rencana kerja untuk dieksekusi di sesi baru.
> Ditulis 2026-09-23 setelah reverse engineering BarTender 2022 + driver Seagull IPL 2023.4.
> Baca juga: `docs/HANDOFF-IPL-RENDER.md` (geometri/rotasi — sudah RESOLVED, jangan di-revisit premisnya),
> `docs/IMPLEMENTATION-PHASE-1.md` & `docs/IMPLEMENTATION-PHASE-3.md` (warning banner + Copy Safe — DONE).

---

## 1. Konteks & Definisi Tujuan

Tujuan akhir user — **segitiga akurasi**:

1. **Designer → kode akurat**: design dibuat di aplikasi kita → hasilkan IPL yang benar (printer asli & BarTender-equivalent).
2. **Paste → preview akurat**: kode IPL apa pun yang dipaste → preview benar.
3. **BarTender → paste → preview = design BarTender**: kode IPL output BarTender yang dipaste ke viewer harus menampilkan preview yang sama dengan design asli di BarTender.

**Temuan root-cause goal #3 (sudah terbukti, bukan hipotesis):**

| Bukti | Detail |
|---|---|
| Driver Seagull punya 3 toggle (CHM `C:\Temp_bt_chm\ipl\PrinterOptions.html` + `Options.html`, sudah diekstrak) | ① *Readable Control Characters* → notasi literal `<STX>`; ② *Use Direct Graphics* → RLE biner `<ESC>g0`; ③ *Binary Downloading* → ON = byte mentah 8-bit, OFF = **nibblized ASCII hex `<ESC>g1`** |
| `testdata/golden/bartender-logo.ipl` | Setting ASCII-safe → semua mode `G;u<rows>` ASCII murni → **tembus paste & golden kita LULUS** ✅ |
| `samples/bartender-tes1.ipl` | Setting DG+Binary ON → 2176 byte ≥0x80 (53%) → paste UTF-8 **kehilangan 146 byte permanen** → extent meledak 801×784 → 808×5465 ❌ |
| Parser kita saat ini (`viewerParser.ts:639`) | **Hanya menangani `<ESC>g0`**. `g1` (nibblized) diabaikan → fitur resmi PRM belum didukung |
| PRM Appendix E | `m=1`: pasangan byte ASCII hex → 1 byte asli (`1,B` → `0x1B`). 100% printable ASCII → **aman clipboard selamanya** |

**Kesimpulan strategis**: paritas penuh tercapai lewat kombinasi
(A) dukungan decoder `<ESC>g1`, (B) golden workflow driver BarTender didokumentasikan & diotomasi,
(C) audit per-command gap BarTender vs parser, (D) harness diff otomatis end-to-end.

---

## 2. Inventaris State Saat Ini (verifikasi dulu sebelum eksekusi)

**Sudah DONE (jangan kerjakan ulang):**
- 556 tes hijau di HEAD `aab02f9`; c7 m2 EAN/UPC, wide:narrow r0/r2, DG placement PRM bottom-up (batch W di memory index).
- Warning banner deteksi mojibake (`detectMojibake` di `services/ipl/fileBytes.ts`, dipakai `IPLViewerModal.handleTextareaChange`).
- Tombol "Copy Safe" (`encodeRlePayloadsAsHex` + `decodeHexToBytes` — **catatan: implementasi sekarang memakai heuristik split `\x02|<STX>` yang rapuh dan format `\xHH` yang TIDAK dikenal printer/parser mana pun; lihat Workstream 4.3 untuk penggantian**).
- Kontrol rotasi viewer (auto/0/90↺/180/90↻) — BarTender me-rotate via page setup DI LUAR stream; user pilih 90° CW manual.
- Dokumen: `docs/manuals/PASTE-FROM-BARTENDER.md`, plan di `~/.claude/plans/bartender-*.md`.
- Working tree belum di-commit: `M components/IPLViewerModal.tsx`, `M services/ipl/fileBytes.ts`, untracked `docs/IMPLEMENTATION-PHASE-{1,3}.md`, `docs/manuals/PASTE-FROM-BARTENDER.md`, `tests/diag-*.test.ts`, `tools/bartender/`.

**Pekerjaan agen otomasi BarTender (sesi ini, background `ab1c568ea97365fe7`):** probe COM sudah dibuat di
`tools/bartender/*.ps1` (export-driver-settings, probe-api, probe-driver-automation, probe-print-options, probe-setup).
Fact environment yang sudah dikonfirmasi: COM `BarTender.Application` registered; printer `Intermec PD43 (203 dpi) - IPL` dan `Honeywell PD45 (203 dpi)` ter-install, dua-duanya port `FILE:`; templates bawaan di `C:\Program Files\Seagull\BarTender 2022\Templates\...`.
→ **Sesi baru: cek dulu apakah agen selesai & ada output `samples/bartender-auto-test.ipl`; baca report-nya sebelum mulai Workstream 5.**

---

## 3. Workstream 1 — Decoder `<ESC>g1` (nibblized Direct Graphics) [PRIORITAS TINGGI]

Ini kunci goal #3 untuk stream BarTender yang memakai Direct Graphics: mode g1 = ASCII-safe, lolos paste, dan kita belum support.

### Task 1.1 — Parsing mode di VirtualPrinter
- `services/ipl/virtualPrinter.ts`: ganti flag boolean `directGraphicsActive` menjadi mode numerik, mis. `directGraphicsMode: 0 | 1 | null` (0 = g0 biner, 1 = g1 nibblized, null = off). `directGraphicsFrames` tetap.
- `services/ipl/viewerParser.ts:639-644` (`case 'g'`): parse `rest.startsWith('0')` → mode 0; **tambahkan** `rest.startsWith('1')` → mode 1. Mode lain (g2 dst) → issue warning `direct-graphics-unknown-mode`.
- Update call-site di `parseFrame` (sekarang cek `directGraphicsActive` dua kali: ~baris 444 dan 158) + `decodeDirectGraphics()`.

### Task 1.2 — Dekoder nibblize di `services/ipl/directGraphics.ts`
- Tambah parameter `mode: 0 | 1` ke `extractDirectGraphics(frames, mode)` (default 0 → backward compatible).
- Mode 1: sebelum decode RLE, konversi frame → bytes: ambil hanya karakter `[0-9A-Fa-f]`, pasangan 2 char → 1 byte (`parseInt(pair,16)`). Karakter non-hex (spasi/newline dari editor) diabaikan; jika jumlah char ganjil → issue warning sekali.
- **Hati-hati frame classifier** (baris 62): `/^<[A-Z]+>|^<ESC>[A-Za-z]/` — payload hex tulen seperti `2194A1...` lolos (ok), tapi payload yang kebetulan mulai `<ESC>` tidak mungkin (karakter `<` bukan hex). Tetap tambahkan guard: di mode 1, lewati classifier dan perlakukan SEMUA frame setelah g1 sebagai hex stream sampai terminator.
- Terminator akhir bitmap = byte `0x28` hasil nibblize → frame berakhir hex `28` (bukan char `0x28` mentah) — cek di `parseFrame` (~baris 456 `last === 0x28`) harus membaca byte hasil decode, bukan charCode mentah. **Ini bug laten jika hanya patch decoder tanpa patch deteksi frame.** Solusi: pindahkan keputusan "graphic selesai" sepenuhnya ke `extractDirectGraphics` (stateful per mode), `viewerParser` hanya meneruskan frame selamanya sampai frame `R`/`<ESC>E` datang.

### Task 1.3 — Toleransi whitespace
Paste dari editor sering merusak hex stream dengan newline/spasi → decoder mode-1 sudah toleran (poin 1.2). Tambahkan di parser frame juga: `content.trim()` sudah ada — pastikan tidak ada `.replace(/\s/g)` yang salah memangkas d3 payload (jangan sentuh `splitParams`).

### Task 1.4 — Ancillary: G-field & `u<rows>` sudah didukung (logo golden lulus) — tidak ada kerja.

### Acceptance criteria
- Tes unit baru `tests/directGraphicsHex.test.ts`:
  1. Ambil 3 payload DG dari `samples/bartender-tes1.ipl` secara programatik (byte-exact), **nibblize jadi g1 stream** (helper test-only), parse kedua varian → bitmap identik (deep-equal `pixels` + origin).
  2. g1 stream dengan newline/spasi terselip → hasil tetap identik.
  3. Ganjil/invalid char → warning, tidak crash.
- Render golden baru: daftarkan `nibblized-tes1` di `testdata/golden/cases.json` → PNG harus 801×784 dan diff ≈ sama dengan tes1 byte-exact (toleransi 0.05%, pola harness yang ada).
- Semua 556 tes lama hijau; `npx tsc --noEmit` bersih.

---

## 4. Workstream 2 — Audit Gap Per-Command Stream BarTender

Goal: setiap konstruk yang BarTender emit punya perilaku identik di parser/renderer kita. Basis: `samples/bartender-tes1.ipl`, `bartender-tes2.ipl`, `bartender-logo.ipl` + sample baru dari Workstream 5.

### Task 2.1 — Tabel audit (kerjakan sistematis, satu kolom per aspek)
Untuk tiap frame-type yang ada di stream BarTender, bandingkan: stream → interpretasi PRM → kode kita (`viewerParser` / `virtualPrinter` / `renderer`) → perilaku printer nyata. Checklist wajib:

| Frame di tes1/tes2 | Pertanyaan audit | Titik kode |
|---|---|---|
| `<ESC>C<SI>W801` (tanpa `<SI>L`) | extent fallback? user harus isi paper mm/rotate manual — apakah pesan UI cukup jelas? | `parseSetupFrame`, `computeLabelExtent` |
| `E2;F2` + `d0`/`d3` | default field data `d0,<id>` = dari print block `<ESC>F` — sudah ditangani print-block sanitizer (batch R) ✔ verifikasi | `resolveSource` |
| `H…;c26;b0;h17;w17` | outline font: `h` = tinggi titik? `w` = width magnification utk outline valid? PRM: untuk outline font `h` adalah font height dalam dots, `w` diabaikan → cek kita | `parseTextField`, `renderer` |
| `H…` HRI di posisi sama dengan barcode `i1` | **double-draw**: barcode `B…;i1` (default i tanpa param = ?) apakah kita print interpretive bawaan SEDANG BarTender juga kirim field `H` terpisah → teks dobel di preview. Tentukan default `i` menurut PRM p.142 (i omitted = print). Kalau BarTender mengandalkan H terpisah + barcode non-HRI, mungkin stream mereka set `i0` implisit via konfigurasi — audit barcode tes1 (`B1;...;w9;h66;d3,12345678` TANPA param `i`) vs export PNG (apakah ada HRI tercetak?) → putuskan: samakan default PRM (print) atau deteksi duplikat | `parseBarcodeField`, `drawBarcode` |
| `W3;f0;o13,14;h770;l492;w3` | box thickness `w3` dst + rotasi field `f0` ✔ (batch W) | `parseBoxField` |
| `B22;...;c18,2,L,8` | QR: 4-param, `L` ecc + scale 8 ✔ (batch C) — verifikasi posisi `o165,82` vs export | `buildBwipSpec` |
| `B8;...;c7,0,2` | EAN-13 leading interpretive flag ✔ (batch A) | sama |
| `<SI>l13` | code page 1252 → glyph mapping utk bitmap & outline ✔ (pernah difix) — pin test | `viewerParser` |
| `<ESC>E2,1<CAN>` | reimage changed-only — ignore visual ✔ | `parseEscFrame` |
| `<RS>1<US>1<ETB>` | print block 1 label ✔ odometer | `odometer.ts` |
| `<ESC>g0` payloads | → Workstream 1 | — |

### Task 2.2 — Perbaiki tiap gap yang terkonfirmasi
Satu commit per fix, konventional `fix(ipl): …`, masing-masing dengan tes regresi sendiri (pola `tests/*.test.ts` yang ada; pixel-level lewat harness golden).

### Task 2.3 — Pin seluruh stream BarTender sebagai golden
- `bartender-tes1` (binary, byte-exact file path) dan `nibblized-tes1` (paste-safe) → golden pair dengan PNG yang harus SAMA sama persis (assert canvas-vs-canvas diff 0%, bukan cuma vs file).
- `bartender-tes2` (hanya DG, tanpa vektor field) → golden.
- Simpan export PNG asli BarTender (`testdata/bartender-tes1-export.png`) sebagai referensi visual, diff dengan toleransi besar (encoder bars beda pattern — diketahui & diterima; lihat HANDOFF §"Encoder parity pass"): tujuannya **geometry parity** (bbox/frame), bukan bit parity bars.

### Acceptance criteria
- Dokumen `docs/research/BARTENDER-COMMAND-AUDIT.md` berisi tabel terisi penuh + keputusan.
- Golden baru lulus; `npm run test:golden:update` TIDAK mengubah golden lama (regression guard).

---

## 5. Workstream 3 — Designer Generate → Paste → Preview (goal #1+#2) [DONE 2026-09-24]

### Task 3.1 — Audit generator terhadap bentuk yang BarTender hasilkan
`services/iplGenerator.ts` hari ini meng-emits stored-format `G…;u<rows>` (ASCII). Tambah opsi (persist di settings designer, default OFF):
- **Emit Direct Graphics mode**: gambar di design → `<ESC>g1` + nibblized hex (ASCII-safe, simetris dengan decoder Workstream 1). Implementasi nibblizer = kebalikan 1.2, taruh di `services/ipl/graphics.ts` (`encodeColumnsToNibblizedRle(bitmap): string`).
- Run-length-kan bitmap → RLE commands (0x21/22/24/25/26/27/28) dulu, baru nibblize — jangan kirim raw 0x27 penuh kalau bisa kompresi 0x25/0x26 (kualitas output ≈ BarTender).

### Task 3.2 — Round-trip test matrix (sudah sebagian ada — perluas)
Di `tests/` (file baru `tests/bartenderRoundtrip.test.ts`):
1. designer design → `generateIPL` → `parseViewerIPL` → render ≡ render design asli (parity WYSIWYG — sudah ada `rotationWysiwyg`, perluas kasus: gambar raster, QR, EAN, multiline).
2. `generateIPL` (mode g1) → paste-through-UTF-8 (encode/decode TextDecoder) → parse → render ≡ sebelum paste. **Ini bukti matematis goal #2 untuk semua keluaran kita.**
3. `bartender-logo.ipl` → render golden (sudah ada) + `nibblized-tes1` (baru).

---

## 6. Workstream 4 — Paste-Path & UI Hardening

### Task 4.1 — Perbaiki "Copy Safe" yang sudah di-merge parsial
`encodeRlePayloadsAsHex` sekarang: split `/\x02|<STX>/` (salah — literal `<STX>` multi-char dan raw byte tercampur; plus kehilangan struktur ETX/CRLF) dan output `\xHH` (format yang TIDAK dikenal printer maupun parser kita sendiri). Ganti:
- Gunakan tokenizer resmi: `tokenizeFramesWithLines(code)` → untuk tiap frame payload DG (setelah `<ESC>g0`), **konversi ke mode g1 nibblized yang SAH** (`<ESC>g1` + hex pairs). Output = IPL valid yang bisa dicetak printer & dipaste ke app ini tanpa apa-apa lagi.
- Rename tombol jadi **"Copy ASCII (g1)"**, tooltip: "Converts binary Direct Graphics to printer-supported hex mode; paste-safe and prints identically".
- Hapus `decodeHexToBytes` (tidak dipakai) atau implementasikan sebagai nibblize-decode yang benar (dipakai decoder 1.2 — reuse satu fungsi!).
- Update `tests/diag-safe.test.ts` → jadi tes permanen `tests/asciiCopy.test.ts` dengan acceptance: hasil copy = ASCII murni (`detectMojibake().highCharCount === 0`) DAN `parseViewerIPL(copy)` punya extent & jumlah graphic sama dengan sumber (assert posisi origin bitmap, deep-equal).

### Task 4.2 — Notifikasi cerdas alih-alih hanya warning
Ketika paste terdeteksi mojibake (>50 high chars): selain banner kuning, tambahkan tombol **"Try ASCII fix"** yang menjalankan konversi 4.1 di tempat dan mengganti isi textarea (bukan cuma menyarankan workflow lain). Banner menyebut akar: "file ini punya Direct Graphics biner; ASCII fix mengubahnya ke mode hex yang didukung printer".

### Task 4.3 — Bersihkan diag-*
Pindahkan assertion yang berguna ke tes permanen, hapus `tests/diag-bartender.test.ts`, `tests/diag-paste.test.ts`, `tests/diag-safe.test.ts` (atau rename ke `tests/parity/`).

---

## 7. Workstream 5 — Automasi BarTender End-to-End (goal #3 tanpa kerja manual user)

Fondasi: probe COM sudah ada di `tools/bartender/*.ps1` + SDK Interop (`Interop.BarTender.dll`, version `11.x` = BarTender 2022). Cek hasil agen sesi ini dulu (file output + report).

### Task 5.1 — Script `tools/bartender/generate-reference.ps1` (lengkapi dari probe)
Alur:
1. `New-Object -ComObject BarTender.Application` → `Documents.Open` template kosong/`Format.Setup("BTWCompatRunner")`? (API: `bt.Documents.Add(templatePath)`, lalu `Format.PrintSetup` — verifikasi vs probe-api.ps1 yang sudah jalan).
2. **Template parametrik**: buat `samples/bartender-e2e/parity-base.btw` berisi kanvas 100×65 mm + set objek tetap: 3 text (outline c26, bitmap c3, multiline), barcode Code128/EAN-13/QR (data sama dengan golden internal kita), 1 garis, 1 box, 1 image bitmap kecil (logo PNG). Nilai field hardcoded agar diff deterministik.
3. Print ke printer **`Intermec PD43 (203 dpi) - IPL`** dengan port `FILE:` — arahkan output ke file: gunakan `Format.PrintSetup.IdenticalCopiesOfLabel` + driver "prompt to file" non-interaktif? Solusi robust: set printer default port FILE: via `Set-Printer -Name ... -PortName FILE:` lalu PrintOut akan menanyakan path → blokir UI. **Alternatif yang sudah dipelajari dari probe**: simpan profil driver via device settings (`Seagull_V3_PrintDispatcher`) ATU use BarTender's own "Print to file" via COM `Format.PrintOut(False, False)` dengan driver configured to a fixed file port. (Keputusan teknis ada di probe agen — baca report sebelum menulis ulang.)
4. Setelah IPL terkumpul → jalankan **dua kali** dengan profil driver berbeda:
   - Profil A (ASCII-safe): Readable CC ON, Direct Graphics OFF → `parity-base-a.ipl` (persis jalur golden logo)
   - Profil B (DG nibblized): Readable CC ON, DG ON, Binary Downloading OFF → `parity-base-b.ipl` (butuh Workstream 1 selesai!)
5. Export gambar referensi BarTender: `Format` → `PreviewExportAsImage` (Cek nama API sebenarnya: `Format.SaveAsPrintedPreviewFile` / `Application.Options` — dari SDK docs `HelpAPI/`) → `parity-base.png` pada 203 dpi.

### Task 5.2 — Harness diff `tools/bartender/compare.mjs` (Node)
- Input: `parity-base-{a,b}.ipl` + `parity-base.png`.
- Render dengan pipeline kita (pola `tests/golden/harness.ts` — import setup module-level, `parseViewerIPL` → `computeLabelExtent` → `renderLabel`, rotasi parameter dari CLI `--rot 3` untuk meniru page-setup landscape BarTender).
- Output: overlay diff per-region (teks/barcode/box/dg terpisah bila mungkin) + `docs/research/BARTENDER-E2E-DIFF.md` berisi tabel delta dot-per-elemen (pakai teknik brute-force matching yang terbukti di DG tes1, lihat HANDOFF).
- **Kebijakan toleransi**: posisi/ukuran ≤ 2 dot; teks advance ≤ 1%; barcode = bbox match saja (encoder pattern berbeda — diterima, documented); warna = biner.

### Task 5.3 — Golden e2e
Saat diff < toleransi → salin `parity-base-a.ipl` (+ PNG render kita) sebagai pasangan golden baru; commit. Dari sini setiap perubahan renderer terjaga terhadap stream BarTender nyata, selamanya, tanpa user menyentuh BarTender.

### Task 5.4 — Risk: licensing/UI
BarTender Starter/Standalone mungkin menolak COM automation penuh atau menampilkan aktivasi. Fallback: generator `parity-base.btw` dibuat sekali oleh user (10 menit), sisanya script; atau pakai one of bundled AIAG templates yang sudah ada sebagai basis tanpa membuat format baru.

---

## 8. Workstream 6 — Dokumentasi Driver Guide (user-facing) [DONE 2026-09-24]

Perbarui `docs/manuals/PASTE-FROM-BARTENDER.md` dengan seksi **Setting Driver Rekomendasi** (dari CHM yang sudah diekstrak, terverifikasi):
```
Devices & Printers → Intermec PD43 - IPL → Printer Properties → Device Settings:
  Readable Control Characters : ON            (notasi <STX>, bisa diedit/dipaste)
  Use Direct Graphics         : OFF  → mode A (paling kompatibel, format G/u ASCII)
                             atau ON + Binary Downloading OFF → mode B (g1 hex, lebih ringkas)
  Use Temporary Format        : OFF  (format tetap, tidak tercetak sebagai *)
  (Opsional) Fix Direct Graphics Positioning: sesuai firmware printer target
```
Plus catatan: hasil mode B baru render sempurna setelah Workstream 1 masuk; mode A sudah bekerja sekarang (golden logo membuktikan).

**Selesai 2026-09-24.** Seksi "Recommended BarTender driver settings" ada di `docs/manuals/PASTE-FROM-BARTENDER.md`. Keempat nama setting diverifikasi kata-per-kata terhadap CHM driver Seagull 2023.4 (`C:\Temp_bt_chm\ipl\Options.html` + `PrinterOptions.html`), termasuk kalimat driver sendiri bahwa Binary Downloading dimatikan "if you need to edit the IPL manually in a text editor". Catatan plan bahwa mode B "baru render sempurna setelah Workstream 1" sudah terlewati — W1 masuk 2026-09-23, jadi mode B sekarang juga didukung.

---

## 9. Urutan Eksekusi & Estimasi

| # | Workstream | Dependensi | Estimasi | Risiko |
|---|---|---|---|---|
| 1 | g1 decoder + tes | — | 0.5–1 sesi | Rendah (PRM jelas; hati-hati frame-terminator bug laten) |
| 4 | Copy Safe → g1 asli + UI fix + cleanup | W1 (pakai nibblizer) | 0.5 sesi | Rendah |
| 2 | Audit per-command + fixes + golden pair | W1 (bisa pin g1 golden sekalian) | 1 sesi | Sedang (temuan HRI double-draw kemungkinan muncul) |
| 3 | Generator g1 + round-trip matrix | W1 | 0.5–1 sesi | Rendah |
| 5 | Automasi BarTender e2e | probe agen; W1 untuk profil B | 1–2 sesi | **Tinggi** (COM/activation/file-port friction) — kerjakan paling akhir, jangan blokir yang lain |
| 6 | Docs driver guide | W2 hasil | 0.2 sesi | — |

**Commit strategy** (aturan user `~/.claude/rules/git-workflow.md`): per workstream 1–2 commit konventional (`feat(ipl): support ESC g1 nibblized direct graphics`, `fix(ipl): ...`, `test: ...`), masing-masing hijau penuh (`npx vitest run` + `npx tsc --noEmit`). COMIT DULU working tree yang ada (Phase 1/3 features) sebelum mulai, karena belum di-commit:
`feat(ui): mojibake warning banner + ASCII-safe copy for BarTender paste`.

---

## 10. Perintah Verifikasi Standar (setiap sesi)

```bash
npx tsc --noEmit                                   # bersih
npx vitest run                                     # semua tes, hijau
npx vitest run tests/golden/golden.test.ts         # golden 24+ tes
node tools/update-goldens.mjs                      # HANYA saat menambah golden baru; verifikasi exit code + file berubah (pelajaran EINVAL)
# Manual browser (goal #3):
npm run dev → buka viewer → paste bartender-logo.ipl → render benar
→ paste hasil "Copy ASCII (g1)" dari tes1 → render ≡ buka file tes1 langsung
```

## 11. Definisi Selesai (goal checklist)

- [ ] Stream BarTender mode A (G/u ASCII): paste → preview identik — **sudah terbukti (logo golden)**, pin sebagai test eksplisit `bartender ASCII paste roundtrip`.
- [x] Stream mode B (g1 hex): parser + renderer support (2026-09-23, `tests/directGraphicsHex.test.ts`: rewrite g0→g1 dari tes1 & tes2 menghasilkan elemen grafis identik, termasuk setelah paste UTF-8 + line wrap). Golden PNG pair belum dibuat — menyusul di Workstream 2.
- [x] Workstream 4 (2026-09-23): "Copy ASCII (g1)" menggantikan "Copy Safe" — `convertDirectGraphicsToHex` memakai tokenizer resmi dan meng-emit `<ESC>g1` sah (bukan escape `\xHH`); banner paste punya tombol "Convert to ASCII (g1)"; tes diag-* diganti `tests/asciiCopy.test.ts`. Sisa: golden pair PNG (W2) + opsi emit g1 di generator (W3).
- [ ] Stream mode C (g0 biner + mojibake paste): tidak bisa diselamatkan (fakta matematis) → ditangani W4 (deteksi + ASCII fix button + doc) TANPA preview salah yang senyap.
- [x] Designer generate → paste kembali → preview identik (2026-09-24): `tests/bartenderRoundtrip.test.ts` membandingkan ink box designer vs `generateIPL → parseViewerIPL → renderLabel` untuk raster, QR, EAN-13 dan multiline (≤3px), plus render g1 identik sebelum/sesudah round-trip UTF-8. Generator meng-emit `<ESC>g1` di balik `PrinterSettings.directGraphics` (default OFF, toggle di panel printer).
- [x] Audit table W2 terisi (2026-09-23, `docs/research/BARTENDER-COMMAND-AUDIT.md`); tidak ada gap yang terkonfirmasi. Golden pair (2026-09-24): `tests/bartenderGoldenPair.test.ts` merender tes1 & tes2 biner dan rewrite g1-nya, lalu menuntut diff 0% antar keduanya DAN terhadap PNG yang di-pin (`testdata/golden/bartender-tes{1,2}.png`). Stream biner tidak bisa jadi case golden biasa — harness membaca `.ipl` sebagai UTF-8.
- [x] Geometry parity vs export PNG BarTender (2026-09-24, `tests/bartenderGeometry.test.ts`): rotasi page-setup yang cocok adalah **90° CCW** (`rotation: 1`; 90° CW mencerminkan label). Setiap bounding box elemen, setelah digeser agar origin tinta bertemu, harus menutupi tinta export minimal 1 dot per 20 dot luas. Pixel-diff tidak dipakai — encoder barcode BarTender dan bwip-js beda pola modul. **Workstream 2 selesai.**
- [x] (Stretch) e2e BarTender→file→render→diff otomatis jalan tanpa intervensi manual (2026-09-24): `tools/bartender/PrintToFile.exe` mencetak `.btw` ke file lewat port berpath, dan `PreviewExport.exe` menghasilkan PNG preview BarTender — keduanya tanpa lisensi. `tests/bartenderAuto.test.ts` membandingkan render kita vs PNG itu per-element (box, 2 barcode, text, 4 graphic semuanya cover tinta BarTender). Detail di `tools/bartender/README.md`.
- [x] Memory index diperbarui: entri `ipl-bartender-g1-parity.md`.

## 12. Jebakan yang Sudah Diketahui (WAJIB dibaca sesi baru)

1. **JANGAN transpose l/h** box/line — rotasi 90° CW ada di page-setup BarTender, renderer kita manual-faithful (HANDOFF §2, sudah dibuktikan brute-force).
2. **Jangan** auto-rotate saat melihat `<ESC>E n,1` / `<SI>l13` — bukan perintah rotasi.
3. DG origin = **bottom-up**, bits tumbuh ke BAWAH, kolom ke KANAN dari origin X (PRM App E; sudah benar di `directGraphics.ts`).
4. Decoder byte-wise memakai `charCodeAt(0) & 0xff` → string input HARUS byte-string (0–0xFF). Codec file (`fileBytes.bytesToByteString`) jangan diganti `File.text()`/latin1 TextDecoder (lossy — komentar di file itu menjelaskan).
5. `d3,` greedy-split: payload bisa berisi `;` — jangan disentuh saat refactor tokenizer/W4.
6. Golden harness: import `tests/golden/setup` (BUKAN `harness.ts`) untuk render di Node; `vitest include` hanya `tests/**` — file tes di root tidak terkumpul.
7. jsPDF `save()` evade click-hook; verifikasi export via `createObjectURL` capture (memory `ipl-design-export`).
8. Pixel "ink" metric: threshold `max(r,g,b)<200` **atau** channel spread >12 — kalau hanya gelap, konten warna terlewat.
9. `npx.cmd` EINVAL di Node ≥20.12 — spawn `process.execPath` + `vitest.mjs` (sudah difixed di update-goldens, jangan regresi).
10. BarTender COM mungkin butuh interaksi lisensi; jangan habiskan sesi di situ — Workstream 5 boleh pakai template bawaan manual sekali.
