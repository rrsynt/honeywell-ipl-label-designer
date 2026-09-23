# Pola Arsitektur dari BinaryKits.Zpl & zpl-renderer-js

> Riset source-level 2026-08-24. Sumber: github.com/BinaryKits/BinaryKits.Zpl
> (branch `develop`), github.com/Fabrizz/zpl-renderer-js (branch `main`),
> workers/ labelize.

## A. BinaryKits/BinaryKits.Zpl — C#, ~400⭐, aktif

### Pemisahan tiga proyek
| Proyek | Peran |
|---|---|
| `Zpl.Protocol` | EMIT ZPL (writer) + konverter gambar→format Zebra |
| `Zpl.Label` | Model elemen: `Elements/` 47 class elemen, `ZplEngine`, `ZplRenderOptions` |
| `Zpl.Viewer` | PARSE + raster: `ZplAnalyzer.cs`, `CommandAnalyzers/` (45 file), `ElementDrawers/` (~24), `VirtualPrinter.cs`, `FontManager`, `PrinterStorage`, `FormatMerger` |
| `Zpl.Viewer.WebApi` | ASP.NET API + demo web |
| `Zpl.Labelary` | Klien HTTP Labelary |

Elemen diproduksi analyzers, dikonsumsi drawers — parsing tidak pernah tahu soal pixel.

### Parser: registry analyzer + VirtualPrinter dua tingkat
- Entry `ZplAnalyzer.Analyze(zplData)`; splitter mendukung custom control chars (`^CT`/`^CC`); command tak dikenal → `AnalyzeInfo.UnknownCommands`; exception per-command ditangkap → `Errors`. **Parsing tidak pernah hard-fail.**
- Registry: static array ~40 `IZplCommandAnalyzer`; dispatch via predikat `CanAnalyze(currentCommand)`.
- Base:
```csharp
public abstract class ZplCommandAnalyzerBase : IZplCommandAnalyzer
public bool CanAnalyze(string zplLine) // => StartsWith(PrinterCommandPrefix)
public abstract ZplElementBase Analyze(string cmd, VirtualPrinter vp, IPrinterStorage storage);
```
- **State dua tingkat di VirtualPrinter** (peta 1:1 ke semantik field IPL):
  - Persistent defaults: `LabelHomePosition`, `FieldOrientation`, `FieldJustification`, `FontWidth/Height/Name`, `LabelReverse`.
  - One-shot "next-element", dikonsumsi sekali lalu clear: `NextElementPosition`, `NextElementFieldData`, `NextElementFieldBlock`, `NextElementFieldReverse`, `NextFont`, `NextFieldNumber`. Pasangan Set/Clear method menjaga enkapsulasi.
- Commit `^FD`/`^FS`: `^FD` mengonsumsi semua pending state → emit elemen final (barcode bila ada pending barcode config, block bila ada block, else text); fallback ke default persistent bila param hilang. `^FS` commit sisa dangling state lalu clear untuk field berikutnya.
- Drawer registry mirror: `CanDraw(element)` → `Draw(element, options, currentDefaultPosition, ...)`. **Return value = default position berikutnya** (feed-forward ala kursor printer asli).
- Reverse print: render ke bitmap temp → komposit `SKBlendMode.Xor`.

### Testing
Golden end-to-end: file `.zpl2` sampel di `Data/Zpl/` → `Common.DefaultPrint(...)` full pipeline analyze→draw→PNG ke disk. Bukan unit-mock parser.

## B. Fabrizz/zpl-renderer-js — TS wrapper WASM Go Zebrash

### Dua varian build (pola transferable)
- Default: wasm **inline base64** via esbuild loader `.wasm: base64` → zero-config tapi ~8 MB JS.
- Subpath `/external`: raw `dist/zebrash.wasm`; konsumen panggil `init({ wasmUrl | wasmBytes | wasmModule })` sekali (memoized promise). Pre-init misuse melempar error dengan contoh copy-paste (termasuk URL CDN jsDelivr ter-pin).
- Loading: union `WasmSource {bytes}|{module}|{url}`; URL → `instantiateStreaming` + fallback fetch-bytes.
- API: `zplToBase64Async(zpl, wMm=101.6, hMm=203.2, dpmm=8, opts?)` → base64 PNG; opsi `{ grayscaleOutput, enableInvertedLabels }`.
- Go side: register di `globalThis.zpl`; async via `js.FuncOf` goroutine + `defer recover()` → panic jadi rejection.

### Wiring preview UI (web/, "xaviewer")
- `ZplWorkbench.tsx`: Monaco self-hosted + language definition ZPL custom; scan mundur dari kursor untuk identifikasi command aktif; validasi balance `^XA/^XZ` sebagai editor markers.
- `ZplPreviewWW.tsx`: Worker per mount (`new Worker(new URL("./rww.ts"), {type:"module"})`), protokol pesan berkorelasi-ID `{id, zpl, wmm, hmm, dpmm, ...}` → `{id, ok, b64?, error?}`; respons stale dibuang by ID; debounce 300 ms; **graceful degradation**: simpan `lastUsableB64`, error menampilkan overlay merah di atas frame terakhir yang baik (bukan blanking).
- `rww.ts`: worker entry self-contained; init wasm via Vite `?url`; satu handler onmessage.

## C. GOODBOY008/labelize workers/ — packaging Rust/wasm-bindgen

- `build.sh`: target wasm32 → cargo build → `wasm-bindgen --target bundler` → optional `wasm-opt -Oz` → stage glue+bg.wasm+d.ts ke npm/. **Hard-fail jika wasm >10 MB** (limit Cloudflare).
- npm `@goodboy008/labelize-wasm` ESM-only: glue bundler + `_bg.wasm` + subpath `./init` hand-written untuk Node polos (`readFileSync(new URL('./..._bg.wasm'))` + manual instantiate).
- API typed: `lz_render(src: Uint8Array, width_mm, height_mm, dpmm, antialias, want_pdf, is_epl): Uint8Array` — **bytes-in/bytes-out, bukan base64** (hemat ~33% ukuran & decode step).
- Error Rust `Result<_, String>` dengan prefix numerik tahap (`1:` parse→400, `2:` render→500) dimap ke HTTP status di worker.js.

## Rekomendasi konkret untuk IPL viewer kita

1. **Adopsi split tiga arah BinaryKits**: model elemen murni ↔ analyzer per-command IPL (satu file/class per command) ↔ drawer registry `CanDraw(element)`.
2. **State VirtualPrinter dua tingkat** (persistent defaults vs one-shot next-element, commit di terminator field IPL `<ETX>`): struktur field IPL malu lebih bersih daripada pasangan ^FD/^FS ZPL.
3. Channel `UnknownCommands` + tangkap exception per-command → tampilkan daftar command tak didukung di UI (WebApi mereka mengembalikan `NonSupportedCommands` di setiap respons).
4. Feed-forward posisi antar drawer (kursor printer virtual).
5. WASM (masa depan, bila fidelity TS mentok): varian external + `init({wasmUrl})` memoized ala Fabrizz; bytes API ala labelize; worker dedikasi + correlation ID + last-good-frame fallback.
6. UI blueprint: Monaco + marker validasi struktur (balance format start/end IPL `<ESC>P`…`R`) + debounce → worker → img data URL.
7. Test golden end-to-end ala BinaryKits (corpus .ipl → pipeline penuh → PNG), bukan mock parser.
