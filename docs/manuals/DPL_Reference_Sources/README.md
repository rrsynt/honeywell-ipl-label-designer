# DPL Reference Sources

Materi pihak ketiga tentang **DPL (Datamax Programming Language)** — bahasa
printer yang **sengaja tidak dibangun** proyek ini. Alasannya di
`../../research/ROADMAP.md`; ringkasnya: struktur protokolnya ada, tabel
langkapnya tidak, dan proyek ini sudah dua kali membuktikan (EPL, TSPL) bahwa
tabel bahasa printer yang ditulis tanpa spec otoritatif itu salah.

Disimpan sebagai bahan mentah untuk kalau DPL dikerjakan nanti. **Tidak ada
satu pun file di sini yang dipakai kode aplikasi** — tidak ada impor, tidak ada
build step, tidak ada dependensi.

Provenance lengkap dan hasil penilaian tiap sumber:
`../../research/SOURCE-HUNT-2026-09-26.md`.

## Berkas

| Berkas | Asal | Lisensi |
|---|---|---|
| `gutenprint_print-dpl.c` | Gutenprint, `src/main/print-dpl.c` | **GPL v2 or later** — header hak cipta ada di dalam berkas |
| `nokka_dpl.py` | `kimasplund/nokka` | tidak dinyatakan di berkas |
| `nokka_datamax_skill.md` | `kimasplund/nokka` | **MIT** (frontmatter) |
| `portakal_dpl_protocol.md` | `hengmengsroin/portakal_flutter` | tidak dinyatakan di berkas |

## Catatan lisensi — penting untuk siapa pun yang mau memakai isi ini

Repo ini **tidak punya berkas LICENSE**. `gutenprint_print-dpl.c` berlisensi
**GPL v2+**, dan GPL itu copyleft: ia menyebar ke karya turunan. Selama berkas
ini hanya **disimpan sebagai rujukan** dan tidak satu baris pun darinya masuk ke
kode aplikasi, tidak ada yang tersebar. **Jangan salin kode dari berkas ini ke
`services/`** tanpa lebih dulu menyelesaikan pertanyaan lisensi repo ini —
menyalin tabel DPL darinya adalah persis cara yang akan memicunya.

Kalau DPL nanti benar-benar dikerjakan: tulis tabelnya dari manual resmi
Datamax (itu satu-satunya sumber yang membuat tabelnya benar sekaligus bersih),
bukan dari berkas di folder ini.
