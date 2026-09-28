---
name: datamax-dpl-labels
description: "Print labels on a Datamax printer via DPL."
version: 1.0.0
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Printing, Labels, Datamax, DPL, M-4208, Barcode, CSV]
---

# Datamax DPL labels (Nokka)

## When to Use

Use whenever the user wants something printed on a **Datamax label printer**
— shipping labels, asset tags, barcode labels, product labels. Triggers:
"print a shipping label", "make barcode labels", "label these boxes", or
handing over a CSV of items.

Also use it to diagnose a Datamax: nothing printing, garbled output,
scrambled fields, or status queries that hang.

**Not** for Brother QL, Zebra ZPL, or Dymo printers — different languages.

## Setup

```bash
pip install git+https://github.com/kimasplund/nokka
export NOKKA_DEVICE=/dev/usb/lp0      # or NOKKA_HOST for a networked unit
```

On Linux, join the `lp` group once so no sudo is needed:

```bash
sudo usermod -aG lp $USER             # then log out and back in
# or, without re-login:  sg lp -c "nokka ..."
```

## Quick reference

```bash
nokka status               # printer state
nokka config-label         # print its settings ON A LABEL (always works)
nokka test                 # self-test: fonts, box, 2 barcodes
nokka fonts                # 9 internal fonts
nokka barcodes             # 23 symbologies
nokka models               # resolutions and print widths

# quick one-off
nokka text "BOX 1" "Warehouse A" --barcode ASSET-0042

# batch from CSV
nokka template-init --out label.json
nokka print --template label.json --data rows.csv \
    --preview preview.png --dry-run          # ALWAYS preview first
nokka print --template label.json --data rows.csv --yes
```

`--dry-run` builds the job without sending. `--dump` shows the raw DPL bytes.

Running from a clone instead of an install: `python3 -m nokka.cli ...`.

## Coordinates (the thing people get wrong)

DPL's origin is the **LOWER-LEFT** corner and row counts **UPWARD**, in
hundredths of an inch. On 4x6" media:

- row 0 = bottom edge, row ~584 = top edge
- column 0 = left edge, column ~400 = right edge
- a sensible left margin is column 50-60

So a title near the top is `row=520`; a barcode lower down is `row=200`.

## Templates

```json
{
  "label": { "width_in": 4.0, "height_in": 6.0, "heat": 15, "speed": "G" },
  "fields": [
    { "type": "text",    "data": "{name}", "row": 520, "column": 60, "font": "4" },
    { "type": "barcode", "data": "{sku}",  "row": 200, "column": 60,
      "symbology": "E", "height": 50 }
  ]
}
```

Field types: `text`, `smooth` (scalable, in points), `barcode`, `line`,
`box`, `image`. `{column}` placeholders pull from the data; matching is case-
and underscore-insensitive. Data may be CSV, TSV, JSON or JSONL.

## Fonts and barcodes

| Font | Height | Use |
|------|--------|-----|
| 0-2 | 7-18 dots | small print, addresses |
| 3-4 | 27-36 dots | headings |
| 5-6 | 52-64 dots | large titles |
| 7-8 | OCR-A / OCR-B | machine reading |
| 9 | scalable | any point size via `smooth` |

Common symbologies: `E` Code 128, `A` Code 39, `F` EAN-13, `B` UPC-A,
`D` Interleaved 2 of 5, `I` Codabar, `O` Code 93, `z` PDF-417.

**Uppercase id prints human-readable text below the bars; lowercase prints
bars only.**

## Hardware facts (verified on an M-4208)

Each of these costs an afternoon if met cold.

1. **The `eee` height field is THREE characters, not four.** `040` = 0.40 in.
   A fourth digit silently shifts every following field and the label comes
   out scrambled. This is the single most likely cause of garbled output.

2. **The model number is not the resolution.** The "08" in M-4208 is print
   speed (8 ips). Every 4-inch M-Class model is **203 DPI**. Confirm with
   `<STX>KC`, which reports the printer key (e.g. `4208-MD10`).

3. **Never print through CUPS.** A queue bound to a Gutenprint driver
   rasterises the job and mangles raw DPL — and the driver is often for a
   different model entirely. Write to the device node directly.

4. **USB status reads work on a DIRECT cable, not over USB/IP.** Forwarded
   over USB/IP (`vhci_hcd`) the printer answers one `<STX>KC` and then stays
   silent forever, surviving USB resets and rebinds. Plugged straight in,
   `<SOH>A` and `<STX>KC` work every time. USB/IP passes bulk-OUT writes but
   mangles bulk-IN replies. **Keep the printer on a direct cable.**

5. **`<SOH>D` disables immediate commands.** Do not send it as a "reset".
   Recovery is three valid `<SOH>` commands one second apart
   (`Printer.restore_immediate_commands()`).

## Firmware updates need a REAL parallel port

On these older boards the boot loader accepts firmware only through a real
IEEE-1284 parallel interface. Every other path fails **silently** — all
bytes accepted, no error, old firmware keeps running:

- **Normal READY mode over USB**: the file lands in the print buffer, fails
  to parse as DPL, and is discarded. Indistinguishable from success.
- **Download mode** (power off, hold PAUSE + CANCEL, power on; display reads
  `SEND SOFTWARE`): the boot loader does not implement USB — the kernel
  logs `device not accepting address, error -71` and nothing enumerates.
- **USB-to-parallel bridges (e.g. CH340S) do NOT work.** They enumerate as
  a USB printer class device (`usblp`), not a `parport`, so data still
  arrives through the USB print pipeline the boot loader ignores. Verified
  on hardware in both READY and download mode.

What works: an on-board LPT or a PCI/PCIe parallel card (`parport_pc`,
giving `/dev/lp0`), then in READY mode `cat firmware.zg > /dev/lp0` — the
equivalent of Honeywell's `copy firmware.zg lpt1`. Serial is untested.

A failed download is harmless: the original firmware stays operational.
`tools/flash_firmware.py` refuses USB/IP and requires `--download-mode`.
Full write-up in `docs/firmware-update.md`.

## Preview before printing

```bash
nokka print --template label.json --data rows.csv --preview out.png --dry-run
```

Renders the same records at the same coordinates with real barcode patterns.
An approximation, not an emulation — but it catches overlaps, clipping and
bad coordinates for free. **Look at the PNG** before sending to the printer.

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| Garbled / shifted fields | a 4-digit value in the 3-char `eee` field |
| Nothing prints | printing through CUPS instead of the device node |
| Permission denied | not in `lp` group; wrap with `sg lp -c "..."` |
| `status` returns nothing | printer is on USB/IP; use a direct cable, or `config-label` |
| Printer ignores `<SOH>` | `<SOH>D` was sent; send `<SOH>A` 3x, 1s apart |
| Content off the label | remember row 0 is the BOTTOM edge |
| No device node at all | printer may be in download mode (`SEND SOFTWARE`) — power cycle it normally |

## Tests

```bash
python3 -m pytest tests/ -q
```

54 tests, green on Python 3.11-3.14. Four compare output byte-for-byte with
worked examples printed in Datamax's own manual.
