# Handoff — Property Emission Audit

Tanggal: 2026-10-02

## 1. Unit Pekerjaan yang Selesai pada Iterasi Ini
Milestone B:
- **Verifikasi `fontSize`, `h_mag`, `w_mag` benar-benar terkirim di kelima generator (bukan hanya IPL)**:
  - **Hasil Audit Lintas Generator**:
    1. **Font Bitmap pada `TextField` (`font: '0'`, `'1'`, `'2'`, `'7'`)**:
       - `h_mag`: Terkirim pada kelima generator:
         - **IPL**: Emisi parameter `;h${field.h_mag};` (`h1` -> `h3`).
         - **ZPL**: Emisi `^A0N,${baseHeight * h_mag},...` (`^A0N,9,...` -> `^A0N,27,...`).
         - **EPL**: Emisi pengali vertikal `p6` pada perintah `A` (`A...,1,1,N,...` -> `A...,1,3,N,...`).
         - **TSPL**: Emisi pengali vertikal `p6` (`y-multiplication`) pada perintah `TEXT` (`TEXT ...,1,1,"..."` -> `TEXT ...,1,3,"..."`).
         - **DPL**: Menghitung `cellH = baseHeight * h_mag` dan mencocokkan resident font serta pengali tinggi `dplMultiplier`.
       - `w_mag`: Terkirim pada kelima generator:
         - **IPL**: Emisi parameter `;w${field.w_mag};` (`w1` -> `w4`).
         - **ZPL**: Emisi `^A0N,...,${baseWidth * w_mag}` (`^A0N,...,7` -> `^A0N,...,28`).
         - **EPL**: Emisi pengali horizontal `p5` pada perintah `A` (`A...,1,1,N,...` -> `A...,4,1,N,...`).
         - **TSPL**: Emisi pengali horizontal `p5` (`x-multiplication`) pada perintah `TEXT` (`TEXT ...,1,1,"..."` -> `TEXT ...,4,1,"..."`).
         - **DPL**: Menghitung `cellW = baseWidth * w_mag` dan mencocokkan resident font serta pengali lebar `dplMultiplier`.
       - `fontSize`: Diabaikan secara seragam oleh kelima generator saat font bitmap aktif (aliran byte identik saat `fontSize` diubah), konsisten dengan UI desainer (`FieldEditor.tsx`) yang menyembunyikan input ukuran poin untuk font bitmap dan hanya menampilkan "Height Mag" & "Width Mag".
    2. **Font Outline pada `TextField` (`font: '20'`, `'21'`, `'25'`, dll.)**:
       - `fontSize`:
         - **IPL**: Emisi `;b0;k${field.fontSize};`.
         - **ZPL**: Emisi `^A0N,${dots(fontSize)},${dots(fontSize)}`.
         - **DPL**: Emisi record font 9 scalable dengan point size pada slot `Axx` dan `PxxxPxxx`.
         - **EPL**: Tidak memiliki font outline skalabel bawaan; generator memperingatkan fallback ke font resident 1: `"<name>" uses a font with no EPL equivalent. It prints with resident font 1, which is a different size and shape.`.
         - **TSPL**: `TSPL_FONT_FOR` hanya memetakan font bitmap 0, 1, 2; generator memperingatkan fallback ke font resident 2: `"<name>" uses a font with no TSPL equivalent. It prints with resident font 2, which is a different size and shape.`.
       - `h_mag` & `w_mag`: Diabaikan secara benar oleh IPL dan ZPL untuk font outline (IPL tidak menulis parameter `;h` / `;w`, ZPL menggunakan ukuran poin `dots(fontSize * 25.4 / 72)`).
    3. **`BarcodeField` (1D Barcodes)**:
       - `h_mag`: Terkirim pada kelima generator (IPL `h`, ZPL slot tinggi `^B3`/`^BC`, EPL parameter `p7`, TSPL parameter `p4`, DPL unit `(h_mag / dpi) * 100`).
       - `w_mag`: Terkirim pada kelima generator (IPL `w`, ZPL `^BY`, EPL parameter `p5`, TSPL parameter `p7`, DPL pengali `narrow`).
    4. **Geometri & Bounding Box**:
       - `getObjectBoundingBox` pada `services/geometry.ts` memperhitungkan `h_mag` dan `w_mag` untuk font bitmap, dan memperhitungkan `fontSize` untuk font outline.
    5. **Test Suite**:
       - Ditambahkan file pengujian komprehensif `tests/fontSizeMagAudit.test.ts` (27 tes) yang memverifikasi kontrol positif, emisi `h_mag`/`w_mag` bitmap, pengabaian `fontSize` bitmap, emisi `fontSize` outline, emisi `h_mag`/`w_mag` barcode, dan perhitungan bounding box.

### Bukti Injeksi (Rule 8)
- **Injeksi 1 (IPL bitmap magnification)**: Memaksa `params.push('h1', 'w1')` di `iplGenerator.ts` → **2 test gagal** (`IPL: emits h command with field.h_mag value` dan `IPL: emits w command with field.w_mag value`).
- **Injeksi 2 (ZPL outline font sizing)**: Memaksa `dots(12 * (25.4 / 72))` di `zplGenerator.ts` → **1 test gagal** (`ZPL: calculates ^A0 dot height and width from fontSize`).
- **Injeksi 3 (EPL vertical multiplier)**: Memaksa `p6 = 1` di `eplGenerator.ts` → **1 test gagal** (`EPL: sets vertical multiplier p6 in A command`).
- **Injeksi 4 (TSPL horizontal multiplier)**: Memaksa `p5 = 1` di `tsplGenerator.ts` → **1 test gagal** (`TSPL: sets x-multiplication parameter in TEXT command`).
- **Injeksi 5 (DPL outline point size)**: Memaksa `pts = '12'` di `dplGenerator.ts` → **1 test gagal** (`DPL: emits scalable font 9 record with point size in A and P slots`).
- **Pemulihan**: Semua injeksi dipulihkan ke file asli → seluruh 27 test audit hijau, total test suite: **1987 tes / 121 file hijau**, `tsc --noEmit` bersih.

---

## 2. Status Penutupan Milestone B
- [x] Audit `intercharGapDots` (celah antar-karakter `c n,m`) di kelima generator
- [x] Verifikasi `fontSize`, `h_mag`, `w_mag` benar-benar terkirim di kelima generator (bukan hanya IPL)

Semua item pada Milestone B telah selesai diverifikasi dan dikunci dengan pengujian otomatis.

---

## 3. Unit Pekerjaan Berikutnya
Sesuai `docs/research/LOOP-PLAN-PROPERTY-EMISSION.md`:
### C. Penutup
- `[ ] Perbarui memori method-property-emission-audit dengan hasil akhir`
- `[ ] Tulis ringkasan hasil di docs/research/ (properti apa yang bersih, apa yang diperbaiki)`
