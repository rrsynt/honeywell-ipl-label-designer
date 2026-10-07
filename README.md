# Honeywell IPL Label Designer & Viewer

[![MIT License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-2250%2B%20passing-brightgreen)](#)
[![Languages](https://img.shields.io/badge/printer%20languages-IPL%20%C2%B7%20ZPL%20%C2%B7%20EPL%20%C2%B7%20TSPL%20%C2%B7%20DPL-blue)](#)

A free, web-based WYSIWYG label designer + **printer-language viewer** with a
focus nobody else covers: **IPL (Intermec Printer Language)** for
Honeywell/Intermec printers — think Labelary, but for IPL, plus four more
languages (ZPL, EPL, TSPL, DPL) in the same codebase.

**Why this exists:** every online label viewer speaks Zebra ZPL
([Labelary](https://labelary.com/viewer.html)) or ZPL/EPL
([Labelize](https://github.com/versatile-lab/labelize), MIT). Nothing free
renders **IPL** — Honeywell's own tooling is BarTender (commercial) or
firmware simulators. This project parses, renders, validates, edits and
prints IPL in the browser, with golden-file tests and BarTender-export
oracles proving pixel-level fidelity.

|  | This project | Labelary | Labelize | BarTender |
|---|---|---|---|---|
| IPL render | ✅ | ❌ | ❌ | ✅ (commercial) |
| ZPL / EPL / TSPL / DPL | ✅ / ✅ / ✅ / ✅ | ZPL only | ZPL + EPL | ✅ (commercial) |
| WYSIWYG designer | ✅ | ❌ | ❌ | ✅ (commercial) |
| IPL → ZPL conversion | ✅ | n/a | n/a | via driver |
| Open source | ✅ MIT | ❌ | ✅ MIT | ❌ |
| Honest warnings (no silent drops) | ✅ named issues | — | — | — |

## Features

### Designer
- Ready-made **template gallery** (Templates button): blank, shipping 4×6", price tag, asset QR, lot sticker
- **New-label dialog** with 13 roll/sheet/receipt stock presets (metric + imperial) or fully custom size, DPI, orientation and grid — the choice flows into all five generators
- Canvas editor: drag/resize/rotate, snap + alignment guides, layer lock/hide, undo/redo, menu bar + toolbar + status bar
- Fields: text (IPL bitmap & outline fonts), barcodes (same encoder as the Viewer), lines, boxes (rounded corners via IPL raster graphics), ellipses, polygons, images; symbology parameters (QR EC/mask, MicroPDF rows, RSS version, MaxiCode mode, HIBC format) editable & round-trip safe
- Data sources: fixed / variable / date / time / linked (variable & counter, incl. printer-side serial odometer)
- **CSV job export**: paste CSV, load `.csv`, or drag & drop on the Data tab → columns auto-map to fields → one `.ipl` with one print block per row (ANSI/windows-1252 Excel files read correctly); per-row preview rendered through the real viewer pipeline, plus **Send Job** straight to the printer via the local bridge (host:port stored, network printers supported)
- IPL generator + parser round-trip (pinned by tests), localStorage save/load, JSON export

### Viewer (IPL + ZPL + EPL + TSPL + DPL)
- Live parse as you type — accepts raw control bytes (0x02/0x1b) as well as literal notation (`<STX>`/`<ESC>`); language auto-detected from the stream, manually overridable
- Rendering: bitmap/outline fonts per DPI, dot-exact bwip-js barcodes; EPL and TSPL also draw 2D (Data Matrix/MaxiCode/PDF417 in EPL, QR/PDF417 in TSPL) as far as each language's commands go — EPL2 genuinely has no QR; DPL fully supported (parser + generator validated against the Datamax/Fiji manuals)
- 35 symbologies (Code 39/93/ITF/2of5/11/128+UCC, EAN/UPC + add-ons, Codabar, HIBC 39/128, Code 16K, Code 49, POSTNET, Planet, PDF417, MicroPDF417, QR Code, Data Matrix, MaxiCode, RSS/GS1 DataBar, MSI, Plessey, Telepen, ITF-14, Aztec, EAN-14…), G/U raster graphics + Direct Graphics g0/g1, 4-quadrant rotation, HRI above/below. JIS-ITF (c15) & EAN.UCC Composite (c21) have no faithful encoder → placeholder + info.
- Validator: command order, duplicate IDs, parameter ranges, per-symbology data validity
- Zoom/fit, dots ≈ mm sizing, PNG/PDF export, **multi-label job** export (one multi-page PDF OR a ZIP of numbered PNGs for every `<RS>×<US>` label with odometer, capped at 300 with upfront confirmation), share via URL (`#ipl=...`)
- Send to printer/simulator via the local bridge, or download the `.ipl`

## Running

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # vitest (2250+ tests)
npm run build        # production (heavy deps code-split: modals, bwip-js, jspdf, ExcelJS load on demand)
```

## Verifying without a physical printer

| Method | Command | Notes |
|---|---|---|
| Honeywell Simulator (real firmware) | `npm run bridge`, then Send in the viewer | Guide: docs/HONEYWELL-SIMULATOR.md |
| Stream capture | `npm run bridge -- --listen=9100` | Bridge becomes a fake printer; open http://localhost:9181/capture |
| Labelary crosscheck | `npm run crosscheck -- samples/product.ipl` | IPL → ZPL → Zebra-rendered PNG for visual comparison |
| ZPL conversion | `npm run zpl -- samples/product.ipl` | Writes samples/product.zpl |
| TSPL crosscheck | `npm run crosscheck:tspl -- samples/product.tspl` | **No independent oracle for TSPL** — Labelary only accepts ZPL input, and the Labelize engine only parses ZPL/EPL. This command reports our parser's reading per element, for a human to check against the TSC manual and a real printer. Weaker than the EPL crosscheck, and stated as such. |
| EPL crosscheck | `npm run crosscheck:epl -- samples/product.epl` | Renders EPL through the **Labelize** engine (independent, MIT) and writes a PNG next to it. The point is layout agreement, not pixel identity: our parser and generator could agree with each other yet both misread the spec — only another implementation catches that. |
| Shared print server | `npm run print-server` | One LAN process holds the queue, printer list and log for all stations. Enter its address in Print Center (e.g. `http://192.168.1.10:9183`); empty means the queue stays on this machine. Because this server writes to the printer socket, it knows exactly which chunks printed — the "retry may print twice" warning disappears for queues going through it. |
| Direct database | `npm run db-server` | Pull rows from SQL Server as a table source. Enter its address in the Data tab (e.g. `http://192.168.1.10:9184`), then **From database…** runs a stored query. The connection string stays in the query file on the server and never reaches the browser; the client only picks a query name, never sends SQL. Rows are stored inside the design, so reopening an old design needs no database. |

## Project structure

- `App.tsx` + `components/MenuBar.tsx` - shell, menu bar, keyboard shortcuts, guarded canvas-replace actions
- `components/TopBar.tsx` + `components/toolbar/` - toolbar groups (edit/view/document)
- `components/panels/` + `components/RightPanel.tsx` - right-panel tab shell and editors (label stock, printer, data, code)
- `services/iplGenerator.ts`, `services/iplParser.ts` - designer-side generator & parser (round-trip)
- `services/canvasDrawer.ts`, `services/geometry.ts` - editor canvas renderer
- `services/ipl/` - viewer pipeline (independent of the Design model)
  - `tokenizer.ts` - STX/ETX framing, dual notation
  - `viewerParser.ts` + `viewerFrames.ts` - state machine + validator + frame primitives
  - `barcodes.ts` - lazy-loaded bwip-js, dot-exact
  - `graphics.ts` - IPL raster graphic codec (6-bit packing)
  - `renderer.ts` - canvas painter (rotation anchor, font, HRI)
- `services/zpl/`, `services/epl/`, `services/tspl/`, `services/dpl/` - other printer languages:
  parser + generator, both subsets that report what they cannot draw as named
  warnings instead of dropping it silently
- `components/IPLViewerModal.tsx` - viewer UI (live parse, issues, export, send)
- `tools/` - `ipl-bridge.mjs` (HTTP-to-TCP, token + printer allow-list),
  `library-server.mjs` & `print-server.mjs` (shared design library and print
  queue across PCs), `db-server.mjs` (+ `query-sqlserver.ps1` — rows from SQL
  Server), `ipl2zpl.mjs`, `labelary-crosscheck.mjs`; every server binds
  localhost by default with optional `--token`, and answers `/health`
- `samples/` - sample IPL streams; `docs/` - simulator guide, shop deploy guide
- `tests/` - vitest: round-trip, viewer, fidelity, golden files, validator,
  critical-path E2E (no Playwright needed), samples

## Design notes

The viewer renders straight from the parse result (a neutral element model),
not through the internal `Design` model — third-party IPL streams still display
even when they don't fully map, and foreign commands are reported in the issues
panel instead of being silently discarded.

## Shop / LAN deployment

See [docs/SHOP-DEPLOY.md](docs/SHOP-DEPLOY.md) — zero-config single station,
LAN with tokens + printer allow-list, database query admin, backup, troubleshooting.

## License

MIT — see [LICENSE](LICENSE). Vendor printer manuals are NOT included;
download your own copies per [docs/manuals/README.md](docs/manuals/README.md).
