# LOOP PLAN — menyelesaikan audit property-emission

> Rencana untuk driver otonom (`loop-engine/loop.mjs`). Berchecklist: driver berhenti
> saat tidak ada `[ ]` tersisa. Setiap iterasi adalah proses baru dengan context
> kosong — semua yang dibutuhkan harus tertulis di bawah, bukan di kepala.

## Tujuan

Menyelesaikan audit properti desainer yang **digambar preview tapi tidak pernah
ditulis generator**. Kelas bug ini sudah menghasilkan 8 perbaikan nyata (`align`,
`field.font` DPL, `hriFontSize`, `hriFont`, `humanReadable: 'above'` di ZPL/DPL,
field tersembunyi, field FIXED tersembunyi, teks center flush-left).

Bahasa yang harus diperiksa: **kelima generator** — `iplGenerator`, `zplGenerator`,
`eplGenerator`, `tsplGenerator`, `dplGenerator`.

---

## ATURAN WAJIB (dibaca sebelum iterasi pertama)

Melanggar aturan ini menghasilkan bug palsu. Resep lengkapnya di memori proyek
`method-property-emission-audit`. Ringkasannya:

1. **Kontrol positif wajib.** Sertakan properti yang PASTI berubah (`x`, `h_mag`,
   `symbology`, `dataSource`). Tanpa itu, probe yang rusak melaporkan SEMUA properti
   hilang — ini pernah terjadi dan hampir dilaporkan sebagai 16 bug.
   Kalau probe melaporkan kegagalan TOTAL, curigai probe-nya, bukan generatornya.

2. **`generateIPL` itu async.** Probe sinkron akan diam-diam melewatinya.

3. **Enumerasi dari `types.ts`, jangan dari ingatan.** Kunci yang terlihat "desain
   saja" (`align`) justru yang lolos.

4. **Pakai symbology yang benar.** QR diuji pada symbology Code 128 menghasilkan
   "NONE" palsu.

5. **"Byte berbeda" ≠ "properti terkirim".** Baca APA yang berbeda. `hriFontSize`
   pernah disimpulkan terkirim hanya karena menambah tinggi box.

6. **Turunan bukan bug.** `image.width/height` diturunkan dari bitmap — mengubahnya
   tanpa bitmap adalah keadaan mustahil. Bentuk (polygon/ellipse) raster-nya memakai
   canvas yang KOSONG di Node — bentuk **wajib diverifikasi di browser**.

7. **Jalur yang benar bisa jadi bukan generator.** Kalau properti memang tidak bisa
   dibawa bahasa printer mana pun, tempatnya di `services/designerOnly.ts` supaya
   ada peringatan, bukan hilang diam-diam.

8. **SETIAP perbaikan WAJIB disertai test yang GAGAL tanpa perbaikan itu.**
   Test yang tetap hijau saat perbaikannya dimatikan hanya *mendokumentasikan*
   perilaku, bukan *menguncinya* — dan regresinya tidak akan tertangkap. Buktikan
   dengan injeksi, dan **verifikasi dulu bahwa polanya cocok**:
   a. Salin file dulu: `cp services/.../x.ts /tmp/x.bak`
   b. Pasang injeksi lewat skrip yang MENG-ASSERT polanya ada (`assert old in s`).
      Jangan pakai `sed` yang bisa gagal diam-diam — injeksi yang tidak terpasang
      membuat test hijau, dan itu terbaca sebagai "test tidak mengunci" padahal
      perbaikannya masih utuh.
   c. Jalankan test → **harus GAGAL**. Kalau hijau, test-mu belum mengunci apa pun:
      perbaiki test-nya, bukan perbaikannya.
   d. Pulihkan dari `.bak`, jalankan lagi → hijau.
   e. Catat hasil injeksi di ringkasan/commit (mis. "injeksi mematikan blok X →
      test Y gagal").

   Pelajaran ini datang dari memori proyek `ipl-audit-findings-pending`
   ("injection must change BEHAVIOUR; prefer `throw`; verify the marker matched").

## Perintah verifikasi (setiap iterasi, sebelum menyatakan selesai)

```bash
./node_modules/.bin/vitest run --pool=forks     # WAJIB --pool=forks di mesin ini
./node_modules/.bin/tsc --noEmit                # harus bersih
```

Catatan: `--pool=forks` **wajib**. Pool thread gagal start di lingkungan ini dengan
`ECONNREFUSED 127.0.0.1:1`. Baseline saat plan ini ditulis: **1908 tes / 116 file hijau**.

## Jebakan yang sudah diketahui

- `npx.cmd` EINVAL di Node ≥20.12 — spawn `process.execPath`, jangan `npx`.
- Golden harness: import `tests/golden/setup` (BUKAN `harness.ts`).
- Jangan mengubah `services/ipl/fileBytes.ts` (lossy kalau diganti `File.text()`).
- DG origin bottom-up; `d3,` payload bisa berisi `;` — jangan disentuh.

---

## Checklist

### A0. Kunci hasil iterasi sebelumnya (perbaikan sudah ada, test belum mengunci)

Iterasi 2026-10-02 menemukan dan memperbaiki: **TSPL menjatuhkan `rssSepHeight`
untuk RSSEXP (versi 6, expanded-stacked)** — hanya RSS14S/RSS14SO yang ditangani.
Perbaikan ada di `services/tspl/tsplGenerator.ts` + `services/tspl/tsplParser.ts`
plus peringatan untuk versi linear. **Tapi `tests/rssSepHeightAudit.test.ts` tetap
hijau saat perbaikannya dimatikan** — jadi test itu belum mengunci apa pun.

- [x] Tulis ulang test RSSEXP TSPL agar GAGAL tanpa perbaikan (buktikan lewat injeksi)
- [x] Pastikan test mengunci DUA arah: RSSEXP memakai sepHt, versi linear TIDAK (dan memperingatkan)
- [x] Audit `rssSepHeight` (c20,m2 — tinggi baris pemisah versi bertumpuk) di kelima generator
- [x] Audit `rssSegments` (c20,m3 — segmen per baris, expanded-stacked) di kelima generator
- [x] Audit `microColumns` dan `microRows` (c19,m1/m2 — MicroPDF417) di kelima generator
- [x] Perbaiki tiap properti yang terkonfirmasi hilang, satu commit per perbaikan
- [x] Untuk yang memang tidak bisa dibawa bahasa tertentu: pastikan `designerOnlyWarnings` melaporkannya (jangan senyap)

### B. Properti teks yang belum diverifikasi lintas generator

- [x] Audit `intercharGapDots` (celah antar-karakter `c n,m`) di kelima generator
- [x] Verifikasi `fontSize`, `h_mag`, `w_mag` benar-benar terkirim di kelima generator (bukan hanya IPL)

### C. Penutup

- [ ] Perbarui memori `method-property-emission-audit` dengan hasil akhir
- [ ] Tulis ringkasan hasil di `docs/research/` (properti apa yang bersih, apa yang diperbaiki)
