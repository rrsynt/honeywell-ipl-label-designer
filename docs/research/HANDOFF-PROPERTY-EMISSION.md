# Handoff — Property Emission Audit

Tanggal: 2026-10-02

## 1. Unit Pekerjaan yang Selesai pada Iterasi Ini
Milestone A0:
- **Audit `rssSegments` (c20,m3 — segmen per baris, expanded-stacked) di kelima generator**.
- **Kunci DUA arah dan Validasi TSPL**:
  - `RSSEXP` (versi 6) memancarkan `segWidth` (hanya bilangan bulat genap 2-22 sesuai TSC manual p. 71).
  - Varian non-RSSEXP (`RSS14`, `RSS14T`, `RSS14S`, `RSS14SO`, `RSSLIM`) mengabaikan `rssSegments` dan memberikan peringatan eksplisit.
  - Nilai ganjil atau di luar rentang 2-22 pada RSSEXP tidak dipancarkan dan memunculkan peringatan.
  - Parser TSPL `parseTSPL` menolak nilai ganjil sehingga tidak mem-parse segWidth ganjil ke dalam `rssSegments`.

### File yang Dimodifikasi/Dibuat
1. `services/tspl/tsplGenerator.ts`:
   - Menambahkan peringatan jika `rssSegments` diset pada varian non-RSSEXP (`"${field.name}" is a GS1 DataBar (${name}); segments per row applies only to expanded stacked (RSSEXP), so the segments set on screen is ignored.`).
   - Memvalidasi bahwa `seg` adalah bilangan bulat genap antara 2 hingga 22 (`Number.isInteger(seg) && seg >= 2 && seg <= 22 && seg % 2 === 0`).
   - Menambahkan peringatan jika `rssSegments` pada RSSEXP bukan bilangan genap 2-22, dan tidak memancarkan parameter tersebut ke printer.
2. `services/tspl/tsplParser.ts`:
   - Memperbarui parsing `case 'RSS':` dengan menambah syarat `&& seg % 2 === 0` agar nilai ganjil dari stream TSPL tidak di-parse ke `rssSegments`.
3. `tests/rssSegmentsAudit.test.ts`:
   - Kontrol positif pada ke-5 generator (mengubah x).
   - Pengujian emisi `rssSegments` pada IPL untuk RSSEXP (v6) (`c20,6,1,4` vs `c20,6,1,6`) + round-trip parser IPL.
   - Pengujian emisi `segWidth` pada TSPL untuk RSSEXP (2 vs 4) + round-trip parser TSPL.
   - Pengujian dua arah pada seluruh varian non-RSSEXP (`RSS14`, `RSS14T`, `RSS14S`, `RSS14SO`, `RSSLIM`) memastikan slot `segWidth` tidak dipancarkan dan peringatan muncul.
   - Pengujian validasi nilai ganjil atau di luar rentang (1, 3, 5, 0, -2, 23, 24) pada RSSEXP memastikan tidak dipancarkan dan memunculkan peringatan.
   - Pengujian parser TSPL: `segWidth` bernilai ganjil (seperti 3 atau 5) tidak dimasukkan ke `rssSegments`.
   - Pengujian ZPL, EPL, DPL memperingatkan ketidakdukungan simbologi 20.
4. `docs/research/LOOP-PLAN-PROPERTY-EMISSION.md`:
   - Checkbox `[x] Audit rssSegments (c20,m3 — segmen per baris, expanded-stacked) di kelima generator` ditandai selesai.

### Bukti Injeksi (Rule 8)
- **Injeksi 1**: Mematikan peringatan varian non-RSSEXP di `tsplGenerator.ts` (`if (false && field.rssSegments !== undefined && name !== 'RSSEXP')`) → **1 test gagal** (`two-way test: non-RSSEXP variants (RSS14, RSS14T, RSS14S, RSS14SO, RSSLIM) ignore rssSegments and warn`).
- **Injeksi 2**: Mengizinkan nilai ganjil dan mematikan peringatan validasi di `tsplGenerator.ts` (`validSeg` tanpa `seg % 2 === 0` dan `if (false && ... !validSeg)`) → **1 test gagal** (`validation: odd rssSegments or out-of-range (< 2 or > 22) must NOT emit segWidth and must warn`).
- **Injeksi 3**: Menghapus pengecekan `seg % 2 === 0` di `tsplParser.ts` → **1 test gagal** (`TSPL parser: odd segWidth in TSPL stream (e.g. 3) must NOT be parsed into rssSegments (must remain undefined)`).
- **Pemulihan**: Semua injeksi dipulihkan ke file asli → seluruh 9 test audit hijau, total test suite: **1928 tes / 118 file hijau**, `tsc --noEmit` bersih.

---

## 2. Temuan Audit `rssSegments` (c20,m3) di Kelima Generator
1. **IPL**: Mendukung penuh via `c20,m1,m2,m3` (`services/iplGenerator.ts:624`). Emisi `rssSegments` dipancarkan di slot m3. Round-trip terbaca via `services/iplParser.ts:571-573` (hanya bilangan genap 2-22).
2. **TSPL**: Mendukung via perintah `RSS x,y,"RSSEXP",rotate,pixMult,sepHt,segWidth,"content"` (TSC manual p. 71). Hanya berlaku untuk RSSEXP dan harus genap 2-22. Non-RSSEXP atau nilai invalid kini diberi peringatan jelas dan tidak memancarkan `segWidth`.
3. **ZPL**: Tidak mendukung simbologi 20. Generator memberi peringatan `"BC1" is barcode type 20, which this ZPL subset cannot draw. It was left off the label.`
4. **EPL**: Tidak mendukung simbologi 20. Generator memberi peringatan `"BC1" is barcode type 20, which EPL cannot draw. It was left off the label.`
5. **DPL**: Tidak mendukung simbologi 20. Generator memberi peringatan `"BC1" is barcode type 20, which this DPL subset cannot draw. It was left off the label.`

---

## 3. Unit Pekerjaan Berikutnya
Sesuai `docs/research/LOOP-PLAN-PROPERTY-EMISSION.md`:
- `[ ] Audit microColumns dan microRows (c19,m1/m2 — MicroPDF417) di kelima generator`
