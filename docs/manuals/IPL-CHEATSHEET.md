# IPL Command Cheat-Sheet (untuk pengembangan viewer/renderer)

> Sumber: `IPL_Programmers_Reference_Manual.pdf` (rev 008, 06/2004 — IPL firmware 2.30,
> mencakup PF2i/PF4i/PM4i/PX4i/PX6i). Halaman merujuk ke PDF asli.
> Dokumen ini ringkasan kerja — untuk detail selalu cek PDF sumber.

## Struktur stream IPL

```
<STX><ESC>P<ETX>              ; masuk Program Mode
<STX>E1;F1<ETX>               ; pilih/buat format (A/F = create, E# = select saat print)
<STX>H0;o50,50;f0;c20;h2;w1;d0,30<ETX>   ; field contoh: teks
<STX>B2;o100,100;f0;c0;h100;w2;i1;d0,12345<ETX>  ; field barcode
<STX>R<ETX>                   ; keluar Program Mode
<STX><ESC>E1<CAN>DATA1;DATA2;<RS>2<ETB>   ; print block: pilih format, data, qty, cetak
```

- `<ETB>` / `<FF>` / `<RS>` menutup print block. Angka setelah `<RS>` = quantity.
- Data variable field dikirim di print block dengan `<ESC>F<n><NUL>` sebagai penanda field.

## Dua mode besar

| Mode | Pemicu | Fungsi |
|---|---|---|
| Program Mode | `<ESC>P` | Mendefinisikan format: field, origin, font, dsb. |
| Print Mode | `<ESC>E` + data + `<ETB>` | Mengirim data & mencetak |

## Parameter field (dipakai lintas jenis field)

| Param | Arti |
|---|---|
| `o` | origin x,y dalam dots (anchor kiri-atas field) |
| `f` | rotasi: 0=0°, 1=90°, 2=180°, 3=270° |
| `h` | magnifikasi tinggi (bar/box/UDC/barcode) atau tinggi karakter |
| `w` | lebar garis/modul/karakter (dots) |
| `c` | pilihan font (teks) atau symbology (barcode) |
| `r` | rotasi karakter (teks) atau rasio wide:narrow (barcode) |
| `d` | sumber data: `d0`/`d1` print-mode, `d2,m1` salin dari field lain, `d3,<data>` fixed. Hanya 0–3 (PRM p.184); tanggal/waktu di-bake sebagai `d3` |
| `g` | pitch = **karakter per baris** (1–50, default 12), bukan spasi dalam dots. Menonaktifkan `h`/`w`/`k` |
| `k` | point size untuk outline font |
| `i` | interpretive field on/off (HRI) |
| `b` | border sekeliling teks human-readable |
| `l` | panjang line/box |
| `u`,`x`,`y`,`t`,`X`,`z` | definisi bitmap UDC/user-defined font (cell width/height, data kolom) |

## Jenis field (create/edit)

| Huruf | Field |
|---|---|
| `H` | Human-readable (teks) |
| `B` | Barcode |
| `L` | Line |
| `W` | Box |
| `U` | UDC/graphic |
| `I` | Interpretive (HRI milik barcode) |
| `D` | Delete field |

## Tabel font `c` (human-readable) — penting untuk metrik renderer

| n | Font | n | Font |
|---|---|---|---|
| 0 | 7×9 Standard bitmap | 25 | Swiss Mono 721 outline |
| 1 | 7×11 OCR bitmap | 26 | Swiss Mono 721 bold outline |
| 2 | 10×14 Standard bitmap | 28 | Dutch Roman 801 proportional outline |
| 3–6, 8–19 | user-defined | 30–41 | monospace outline 6pt–36pt (beragam weight) |
| 7 | 5×7 Standard bitmap | 50/51 | Kanji outline |
| 20 | 8 pt monospace | 52–56 | Katakana/Kanji bitmap |
| 21 | 12 pt monospace | 61 | Swiss 721 |
| 22 | 20 pt monospace | 62–70 | Swiss bold, Dutch bold, Prestige, dll. |
| 23 | OCR-A | | |
| 24 | OCR-B size 2 | | |

Catatan metrik:
- Bitmap fonts (0,1,2,7): ukuran tetap dalam dots; magnifikasi `h`/`w` mengalikan.
- Outline fonts (20+): ukuran dari `k` (point size); konversi dot = pt × dpi/72.
- Viewer saat ini mengaproksimasi outline width ≈ 0.6 em — perlu kalibrasi.

## Symbology barcode `c` (Program Mode)

Nilai umum: Code 39 (`c0`), Code 93, Interleaved 2 of 5, Code 128 subset A/B/C,
Codabar, UPX/EAN keluarga, PDF417, dll. Detail nilai persisnya lihat hal. 141–166
pada PDF ("Bar Code, Select Type").

## Konfigurasi label (Print Mode, mempengaruhi canvas)

| Command | Arti |
|---|---|
| `<SI>W<n>` | lebar label (dots) |
| `<SI>L<n>` | panjang maksimum label (dots) |
| `<SI>S<n>` | kecepatan cetak |
| `<SI>d<n>` | dark adjust |
| `<SI>T<m>` | jenis media (gap/reflective/continuous) |

## DPI printer (untuk skala render)

Keluarga Intermec/Honeywell umum: 203 dpi (8 dots/mm) dan 300 dpi (12 dots/mm).
Semua koordinat `o`, `h`, `w`, `l` adalah **dots** → renderer harus tahu dpi target
atau ambil default 203.

## Sumber lengkap di folder ini

- `IPL_Programmers_Reference_Manual.pdf` — manual utama rev 008 (272 hal)
- `IPL_2.70_Programmers_Reference_Manual.pdf` — versi v2.70 lebih baru (292 hal)
- `IPL_4400_Reference_Manual.pdf` — varian printer 4400 (298 hal)
- `IPL_Developers_Guide.pdf` — developer's guide konsep (112 hal)
- `IPL_Command_Reference_Manual.chm` — help Windows interaktif (command reference)
- `*.txt` — hasil ekstraksi teks tiap PDF untuk pencarian cepat
