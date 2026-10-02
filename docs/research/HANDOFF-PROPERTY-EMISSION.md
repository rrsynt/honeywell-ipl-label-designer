# Handoff — Property Emission Audit

Tanggal: 2026-10-02

## 1. Unit Pekerjaan yang Selesai pada Iterasi Ini
Milestone B:
- **Audit `intercharGapDots` (c n,m — celah antar-karakter pada TextField) di kelima generator**:
  - **IPL**: Mendukung penuh via `c n[,m]` (PRM p. 195/203) baik untuk font bitmap (c0-c7) maupun outline (c20-c99), termasuk nilai negatif untuk overlap karakter. Emisi dan round-trip parser IPL diverifikasi.
  - **ZPL, EPL, TSPL, DPL**: Tidak memiliki parameter celah antar-karakter pada perintah teks masing-masing (`^A...^FD`, `A...`, `TEXT ...`, dan DPL standard text record). Terukur: aliran keluaran ke-4 bahasa ini **byte-identik** saat `intercharGapDots` diubah.
  - **Cacat yang Ditemukan**:
    1. Kanvas desainer (`canvasDrawer.ts`) menggambar teks dengan celah antar-karakter kustom tersebut, tetapi saat mengekspor ke ZPL/EPL/TSPL/DPL, `designerOnlyWarnings` **diam tanpa peringatan**.
    2. `getObjectBoundingBox` pada `services/geometry.ts` sebelumnya mengabaikan `intercharGapDots` baik untuk font bitmap maupun outline, sehingga perhitungan lebar bounding box salah dan fungsi pergeseran alignment (`shiftForTextAlign`) menggeser teks rata kanan/tengah (`align: 'right' | 'center'`) berdasarkan lebar yang tidak sesuai dengan yang digambar.
    3. `canvasDrawer.ts` sebelumnya memanggil `bitmapTextWidthDots` tanpa menyertakan `intercharGapDots`.
  - **Perbaikan yang Diterapkan**:
    1. `services/designerOnly.ts`: Menambahkan peringatan untuk bahasa non-IPL (`language !== 'ipl'`) jika field teks memiliki `intercharGapDots !== undefined`: `"<name>": intercharacter gap is only supported in IPL (c n,m), so the character spacing set on screen is not printed in this language. (IPL carries it.)`.
    2. `constants.ts`: Menambahkan parameter opsional `gapOverrideDots?: number` pada `bitmapTextWidthDots` agar advance font bitmap memperhitungkan celah kustom `c n,m`.
    3. `services/geometry.ts`: Memperbarui `getObjectBoundingBox` pada `case 'text'` agar memperhitungkan `field.intercharGapDots` untuk font bitmap dan outline.
    4. `services/canvasDrawer.ts`: Meneruskan `(field as TextField).intercharGapDots` ke `bitmapTextWidthDots`.
    5. `tests/intercharGapAudit.test.ts`: Menambahkan 17 pengujian yang memverifikasi kontrol positif, emisi IPL, round-trip IPL, byte-identical pada ZPL/EPL/TSPL/DPL, peringatan `designerOnlyWarnings`, dan perhitungan bounding box / alignment.

### Bukti Injeksi (Rule 8)
- **Injeksi 1**: Mematikan blok peringatan `intercharGapDots` di `designerOnly.ts` (`const gapped = shown.filter(f => false);`) → **1 test gagal** (`designerOnlyWarnings reports intercharGapDots on non-IPL languages > warns on ZPL, EPL, TSPL, and DPL when intercharGapDots is set`).
- **Injeksi 2**: Mematikan `intercharGapDots` pada font bitmap di `geometry.ts` (`bitmapTextWidthDots(field.font, maxChars, field.w_mag)`) → **2 test gagal** (`getObjectBoundingBox expands bitmap text width with positive intercharGapDots` dan `shiftForTextAlign with right alignment shifts further when intercharGapDots widens text`).
- **Injeksi 3**: Mematikan `intercharGapDots` pada font outline di `geometry.ts` (`const gapDots = 0;`) → **1 test gagal** (`getObjectBoundingBox expands outline text width with intercharGapDots`).
- **Pemulihan**: Semua injeksi dipulihkan ke file asli → seluruh 17 test audit hijau, total test suite: **1960 tes / 120 file hijau**, `tsc --noEmit` bersih.

---

## 2. Status Penutupan Milestone Sebelumnya
- Milestone A0 `microColumns` dan `microRows` (c19,m1/m2 — MicroPDF417) telah diselesaikan dan dikomit pada commit `8f730a2` (TSPL warning untuk microRows > 0) dan `127d5c8` (DPL Table G-6/G-7 emisi & parser round-trip, test suite 15 test di `tests/microPdfAudit.test.ts`). Checkbox di `LOOP-PLAN-PROPERTY-EMISSION.md` telah disinkronkan.

---

## 3. Unit Pekerjaan Berikutnya
Sesuai `docs/research/LOOP-PLAN-PROPERTY-EMISSION.md`:
- `[ ] Verifikasi fontSize, h_mag, w_mag benar-benar terkirim di kelima generator (bukan hanya IPL)`
