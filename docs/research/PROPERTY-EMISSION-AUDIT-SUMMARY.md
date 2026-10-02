# Ringkasan Audit Property-Emission Lintas Lima Bahasa Printer (IPL, ZPL, EPL, TSPL, DPL)

Tanggal: 2026-10-02  
Status: Selesai & Terkunci oleh Pengujian Otomatis (121 file / 1987 tes lulus, `tsc --noEmit` bersih)

---

## 1. Latar Belakang dan Tujuan

Desainer label menyediakan berbagai properti inspektur (`TextField`, `BarcodeField`, `BaseField`) yang digambar secara akurat di kanvas pratinjau WYSIWYG. Namun, printer target menggunakan lima bahasa perintah berbeda:
1. **IPL** (Intermec Printer Language)
2. **ZPL** (Zebra Programming Language)
3. **EPL** (Eltron Programming Language)
4. **TSPL** (TSC Printer Language)
5. **DPL** (Datamax Programming Language)

Audit *property-emission* bertujuan untuk memastikan bahwa setiap properti yang disetel di UI dan ditampilkan di pratinjau:
- **Terkirim secara akurat** jika bahasa target mendukung perintah/parameter terkait secara native, atau
- **Di-emulasi secara geometris** (seperti perataan teks `align: 'center' | 'right'`), atau
- **Dilaporkan secara eksplisit** melalui saluran peringatan desainer (`services/designerOnly.ts` / `designerOnlyWarnings`) jika bahasa atau firmware target tidak memiliki instruksi perangkat keras untuk properti tersebut.
- **Tidak ada properti yang hilang tanpa suara (*silent drop*)**.

---

## 2. Metodologi & Guardrails Audit (Pelajaran dari 7 Jebakan)

Selama pelaksanaan audit, ditemukan sejumlah jebakan metodologis yang dirangkum menjadi protokol wajib di `method-property-emission-audit`:

1. **Kontrol Positif Wajib**: Setiap probe diff stream wajib menyertakan properti kontrol yang pasti memicu perubahan byte (`x`, `h_mag`, `symbology`, `dataSource`). Tanpa kontrol positif, probe yang rusak dapat melaporkan seluruh properti hilang (false positive 100%).
2. **Asinkronitas Generator**: `generateIPL` berjalan asinkron (`async`). Probe sinkron melewatkan generator IPL secara diam-diam.
3. **Enumerasi Tipe Lengkap**: Properti diekstrak dari antarmuka `types.ts`, bukan dari ingatan. Properti yang tampak seperti "fitur tampilan saja" (`align`, `intercharGapDots`, `visible`) justru yang paling sering terlewat.
4. **Symbology yang Tepat**: Pengujian properti khusus (seperti kontrol 2D QR atau DataBar) wajib diujikan pada symbology yang sesuai agar tidak menghasilkan NONE palsu.
5. **Semantik Perbedaan Byte**: "Byte berbeda" tidak selalu berarti properti terkirim (contoh: `hriFontSize` sempat dikira terkirim hanya karena membesarkan kotak pembatas). Perbedaan byte harus dianalisis secara semantik.
6. **Turunan Bukan Bug**: Dimensi gambar (`width`/`height` dalam mm) diturunkan dari grid dot bitmap. Pengujian bentuk vektor berbasis canvas kosong di Node sehingga wajib divalidasi di browser.
7. **Disiplin Injeksi Negatif (Aturan 8)**: Setiap tes audit yang dibuat WAJIB membuktikan kemampuannya mendeteksi regresi melalui uji injeksi negatif (tes harus gagal ketika perbaikan dinonaktifkan sementara).

---

## 3. Rincian Cacat yang Ditemukan dan Diperbaiki

Selama kampanye audit properti ini, serangkaian perbaikan berhasil diidentifikasi, diperbaiki, dan dikunci dengan pengujian otomatis:

### A. Teks dan Tipografi
| Properti | Masalah Sebelum Audit | Solusi / Perbaikan | Komit Terkait |
| :--- | :--- | :--- | :--- |
| `align` (`center`, `right`) | Hanya dipanggang di IPL; ZPL, EPL, TSPL, DPL mencetak teks rata kiri (*flush-left*). | Bounding box dihitung dan offset koordinat `x` diterapkan pada keempat generator non-IPL. | `2c7bbce` |
| `field.font` (DPL) | Generator DPL selalu mengeluarkan resident font 2 terlepas dari font yang dipilih di desainer. | Generator DPL memetakan font desainer ke resident font atau font scalable 9. | `b5b9f66` |
| `intercharGapDots` | Celah karakter (`c n,m`) hanya didukung IPL. Pada ZPL, EPL, TSPL, DPL diabaikan tanpa peringatan. `getObjectBoundingBox` juga mengabaikan gap sehingga menggeser align center/right. | Peringatan ditambahkan di `designerOnlyWarnings` untuk 4 bahasa non-IPL; `getObjectBoundingBox` diperbaiki memperhitungkan gap. | `23bcaa3` |
| `fontSize`, `h_mag`, `w_mag` | Belum ada tes komprehensif yang mengunci konsistensi emisi di kelima generator. | Diaudit dan dikunci dengan 27 tes serta 5 injeksi negatif (`tests/fontSizeMagAudit.test.ts`). | `dd9695f` |

### B. Barcode 1D & 2D
| Properti | Masalah Sebelum Audit | Solusi / Perbaikan | Komit Terkait |
| :--- | :--- | :--- | :--- |
| `humanReadable: 'above'` | UI mengizinkan HRI di atas, tetapi ZPL dan DPL hanya mendukung HRI di bawah barcode dan mencetaknya di bawah dalam hening. | Generator ZPL dan DPL kini memberikan peringatan desainer eksplisit saat `above` dipilih. | `9861f34` |
| `Wxx` case & `W1Z` (DPL) | `W1Z` disalahartikan sebagai PDF417 biasa (seharusnya MicroPDF417). Huruf besar `Wxx` disalahartikan sebagai HRI padahal merupakan varian format data. | Tabel barcode dan generator DPL diperbaiki membedakan MicroPDF417 dan varian format data. | `4475475` |
| `qrModel`, `qrEcl`, `qrMask` (DPL) | Generator DPL menggunakan format otomatis `W1d` yang mematok model 2 / ECL M / auto mask, mengabaikan input kustom tanpa peringatan. | Peringatan desainer ditambahkan saat nilai non-default digunakan pada DPL. | `4651830` |
| `rssSepHeight` (TSPL) | Generator dan parser TSPL menjatuhkan tinggi pemisah untuk GS1 DataBar Expanded Stacked (`RSSEXP`, versi 6). | Generator dan parser diperbaiki untuk mendukung `RSSEXP`; varian linear diberi peringatan. | `10ad237` |
| `rssSegments` (TSPL) | Generator TSPL meloloskan nilai ganjil dan di luar rentang 2..22 yang melanggar spesifikasi manual TSC. | Clamping ke rentang genap 2..22 dan peringatan ditambahkan. | `de2c17f` |
| `microColumns` & `microRows` (MicroPDF417) | TSPL mengabaikan `microRows` dalam hening. DPL menjatuhkan kolom dan baris di generator dan parser. | TSPL memperingatkan baris manual; DPL mengimplementasikan pemilihan valid berdasarkan Tabel G-7 manual Datamax. | `8f730a2`, `127d5c8` |

### C. Visibilitas dan Kondisional
| Properti | Masalah Sebelum Audit | Solusi / Perbaikan | Komit Terkait |
| :--- | :--- | :--- | :--- |
| `visible: false` | Field yang disembunyikan di UI tetap dipancarkan oleh generator non-IPL. | Seluruh generator disatukan menggunakan filter `printableFields()`. | `343b8d9` |
| `suppressedFixed` | Field FIXED yang disupresi tetap tercetak di non-IPL. | Filter terintegrasi memastikan field tidak dicetak di semua generator. | `74374ee` |

---

## 4. Matriks Ringkasan Status Properti Lintas 5 Generator

| Properti Desain | IPL | ZPL | EPL | TSPL | DPL |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Koordinat (`x`, `y`)** | Native | Native | Native | Native | Native |
| **`dataSource` / data** | Native | Native | Native | Native | Native |
| **`h_mag` (Bitmap text)** | Native (`;h`) | Native (`^A0` height) | Native (`p6` mult) | Native (`p6` mult) | Native (font match) |
| **`w_mag` (Bitmap text)** | Native (`;w`) | Native (`^A0` width) | Native (`p5` mult) | Native (`p5` mult) | Native (font match) |
| **`fontSize` (Bitmap text)** | N/A (ignored) | N/A (ignored) | N/A (ignored) | N/A (ignored) | N/A (ignored) |
| **`fontSize` (Outline text)** | Native (`;k`) | Native (`^A0`) | Warn (resident fallback) | Warn (resident fallback) | Native (font 9 record) |
| **`align` (center/right)** | Native | Emulated (offset) | Emulated (offset) | Emulated (offset) | Emulated (offset) |
| **`intercharGapDots`** | Native (`;c`) | Warned | Warned | Warned | Warned |
| **`h_mag` (Barcode height)** | Native (`;h`) | Native (`^B_`) | Native (`p7`) | Native (`p4`) | Native (`h_mag/dpi*100`) |
| **`w_mag` (Barcode width)** | Native (`;w`) | Native (`^BY`) | Native (`p5`) | Native (`p7`) | Native (`narrow mult`) |
| **`humanReadable: 'above'`** | Native | Warned (below only) | Warned | Warned | Warned (below only) |
| **`rssSepHeight` (c20,m2)** | Native (`;c20,m2`) | Warned | Warned | Native (Stacked) / Warn (Linear) | Warned |
| **`rssSegments` (c20,m3)** | Native (`;c20,m3`) | Warned | Warned | Native (2..22 even) / Warn | Warned |
| **`microColumns` / `Rows`** | Native (`;c19,m1/m2`) | Native (`^BY`/`^BF`) | Warned | Native (Cols) / Warn (Rows) | Native (Tabel G-7) |
| **`qrEcl` / `qrModel` / `qrMask`** | Native | Native (`^BQ`) | Warned | Native (`QRCODE`) | Warned (W1d auto) |
| **`visible: false`** | Suppressed | Suppressed | Suppressed | Suppressed | Suppressed |

---

## 5. Kesimpulan & Penutupan

Dengan selesainya Milestone A0, B, dan C:
1. Seluruh properti utama desainer (`TextField`, `BarcodeField`, `BaseField`) telah diaudit lintas kelima bahasa printer.
2. Semua kasus di mana bahasa target tidak dapat mencerminkan properti desainer telah dialihkan dari *silent drop* ke peringatan eksplisit (`designerOnlyWarnings`), atau di-emulasi secara geometris.
3. Seluruh perbaikan telah memiliki tes unit regresif dengan bukti injeksi negatif yang terdokumentasi.
4. Baseline pengujian seluruh repositori berada dalam kondisi hijau: **1987 tes lulus di 121 file tes**, dan `tsc --noEmit` bebas kesalahan.
