# Label parametric: `parity-base.btw`

Halaman sudah diset: **4 in × 2 in, landscape, margin 0.1 in**, printer
`Intermec PD43 (203 dpi) - IPL`. Tinggal taruh objeknya.

## Kenapa halaman dibuat dari script, bukan GUI

`CreateFormat` di BTXML script bisa membuat halaman, orientasi, margin, printer,
dan menyimpan `.btw` yang valid — semuanya sudah otomatis di
`tools/bartender/build-base-label.ps1`. Yang **tidak** bisa diotomatisasi adalah
objek design: automation API menolaknya dengan

> This property is allowed only when running document event scripts.

dan tidak ada entry point COM untuk menjalankan document script dari luar. Jadi
objek harus ditarik di Format Builder, sekali saja.

## Yang perlu ditaruh

BarTender menampilkan ukuran dalam mm; pada 203 dpi 1 mm ≈ 8 dots.

- **Text** — `PARITY BASE`, Arial 28, di kiri atas
- **Text** — `Placed by Format Builder`, Arial 12, di bawahnya
- **Box** — di tengah kiri, tanpa fill
- **Text** — `INSIDE BOX`, Arial 14, di dalam box
- **Code 128** — data `ABC123456789`, memanjang horizontal di bawah
- **EAN-13** — data `5901234123457`, di kanan bawah
- **QR Code** — data `https://example.com/ipl`, di kanan tengah
- **Line** — separator tipis horizontal

Yang penting bukan koordinat persisnya, melainkan **ke delapan jenis objek ini
ada dan tidak saling tumpang tindih** — terutama QR, yang hanya beberapa
milimeter lebar dan menghilang ke tetangganya kalau ditempatkan asal.

## Setelah selesai

Simpan ke `C:\Temp\bt-author\parity-base.btw`, lalu:

    cd "D:\RR\PROJECT LAMA\WEB\honeywell-ipl-label-designer (5)\tools\bartender"
    PreviewExport.exe "C:\Temp\bt-author\parity-base.btw" C:\Temp\bt-preview
    PrintToFile.exe "C:\Temp\bt-author\parity-base.btw"

Yang pertama menghasilkan PNG referensi BarTender, yang kedua IPL-nya. Keduanya
dipakai `tests/bartenderAuto.test.ts` untuk membandingkan render kita, jadi
begitu `.btw` ini diganti, test itu langsung memverifikasi hasilnya.
