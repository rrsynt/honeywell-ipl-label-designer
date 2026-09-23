# Importing BarTender IPL Labels — Important Notes

## The Problem

BarTender generates `.ipl` files that contain **raw binary Direct Graphics RLE data** for bitmap shapes and vector art. This binary data uses bytes 0x80–0xFF which cannot be preserved through browser paste mechanisms.

When you copy/paste a BarTender-generated IPL file into this viewer's textarea, the browser attempts UTF-8 decoding, which fails silently on binary bytes. The result is **lost data** and **corrupted rendering**:

| Metric | Open File (correct) | Paste from clipboard (corrupted) |
|--------|---------------------|----------------------------------|
| Label size | 801 × 784 dots | 808 × 5465 dots (×7 height!) |
| Ink pixels | ~82,661 | ~203,220 (+2.5×) |
| Direct Graphics | Correctly placed | Garbage positions, fake commands |

## Why This Happens

```
BarTender file:   <STX><ESC>g0<ETX>\r\n<STX>!\x98F\x97&...<ETX>\r\n
                     ↑ raw binary byte here (0x98 = 152 decimal)

Browser paste:    <STX><ESC>g0<ETX>\r\n<STX>!F&...<ETX>\r\n
                     ↑ replaced with U+FFFD () character

RLE parser:       Reads  as random byte value → garbage command
```

Once `` appears in your JavaScript string, those original byte values are **GONE FOREVER**. No algorithm can recover them.

---

## Recommended Workflows (Best Results)

### ✅ Method 1: Drag-and-Drop (Fastest)

Simply drop your `.ipl` file directly onto the viewer canvas. The file opens with all bytes preserved.

### ✅ Method 2: Open File Button

Click the **"Open File"** button (next to "Sample" dropdown), then select your `.ipl` file from your computer.

Both methods use byte-exact reading (`bytesToByteString`) which preserves all 0x80–0xFF bytes correctly.

### ⚙️ Method 3: Save as UTF-8 in BarTender

If you MUST export from BarTender for later use:

1. In BarTender, go to **Print > Print to File**
2. Choose output format as **Text (.txt)** or enable **UTF-8 encoding** if available
3. Avoid ANSI/cp1252 saved files

---

## If You Must Paste

Paste is convenient but has limitations:

1. **Expect warnings**: A yellow warning banner will appear when non-ASCII characters are detected
2. **Graphics may fail**: Direct Graphics bitmap content (shapes, logos, vector paths) often won't render correctly
3. **Text/barcodes work**: Pure ASCII text and barcode commands usually render fine even after paste

### Quick Fix When Paste Fails

If you see corrupted output after pasting:
1. Use the **"Open File"** button instead
2. Or drag-drop the `.ipl` file onto the canvas

A paste that already replaced the high bytes cannot be repaired — the original
values are gone. The banner's **Convert to ASCII (g1)** only helps when the
bytes are still intact, which means the stream was opened from a file first.

---

## Recommended BarTender driver settings

Verified against the Seagull IPL driver help (`Options.html`, `PrinterOptions.html`,
driver 2023.4). Path: **Devices & Printers → Intermec PD43 (203 dpi) - IPL →
Printer Properties → Device Settings**.

| Setting | Page | Value | Why |
|---|---|---|---|
| Readable Control Characters | Printer Options | **ON** | Sends `<STX>` instead of byte 0x02, so the stream can be read, edited and pasted |
| Use Direct Graphics | Options | **OFF** | Graphics go out as stored-format `G`/`u` rows, pure ASCII. Most compatible; the `bartender-logo` golden proves this path |
| | | **ON** | Graphics go out as compressed Direct Graphics. Smaller and faster, but see the next row |
| Binary Downloading | Options | **OFF** whenever Direct Graphics is ON | Sends each byte as two ASCII hex digits (`<ESC>g1`) instead of raw 8-bit (`<ESC>g0`). The driver's own words: disable it "if you need to edit the IPL manually in a text editor". g1 pastes losslessly and renders identically |
| Use Temporary Format | Options | **OFF** | Prints to a numbered format instead of the temporary `*` format, which the printer deletes after the job |

The two combinations worth using:

- **Mode A** — Direct Graphics OFF. Plain ASCII throughout, works everywhere, including this viewer.
- **Mode B** — Direct Graphics ON, Binary Downloading OFF. Hex graphics (`<ESC>g1`), still plain ASCII, more compact. This viewer renders it identically to the binary form.

Direct Graphics ON with Binary Downloading left ON is the combination that breaks
paste: the file is fine, but copying it through a browser destroys it. If you
already have such a file, open it with **Open File** and use **Copy ASCII (g1)**
to get the paste-safe equivalent.

**Fix Direct Graphics Positioning** (Printer Options) compensates for the offset
early IPL3 firmware applied to direct graphics. Leave it at the driver default
unless graphics print shifted relative to the other fields on the target printer.

---

## Technical Details

For users who want to understand the engineering:

### File Encoding Flow

| Input Method | Encoding Path | Byte Preservation |
|-------------|---------------|-------------------|
| Drag-drop / Open File | `File.arrayBuffer()` → `bytesToByteString()` | ✅ 100% |
| Textarea paste | Browser clipboard → UTF-8 decode | ❌ Loses high bytes |
| Hash URL share | Base64 encode/decode | ✅ Preserved (ASCII-only safe subset) |

### Detection Algorithm

The viewer runs `detectMojibake()` on every textarea change:

```typescript
const { hasCorruption, highCharCount } = detectMojibake(code);
if (highCharCount > 50) showWarning();
```

High-byte counts >50 indicate significant corruption (typical BarTender samples have 2000+).

### RLE Payload Impact

Direct Graphics RLE payloads follow `<ESC>g0`:

```javascript
// Original barcode tes1 sample:
<STX><ESC>g0<ETX>\r\n
<STX>!\x98F\x97&\xed\x81"&\xeb\x83"...<ETX>\r\n

// After UTF-8 paste:
<STX><ESC>g0<ETX>\r\n
<STX>!F&"&...<ETX>\r\n
```

The RLE parser reads these replacement characters as fake command codes (0x98→command `!`, 0xED→extended run-count, etc.), causing massive coordinate explosions.

---

## Support Files

- [`tests/asciiCopy.test.ts`](../../tests/asciiCopy.test.ts) — proves the g0→g1 rewrite is pure ASCII and decodes identically
- [`services/ipl/fileBytes.ts`](../../services/ipl/fileBytes.ts) — `convertDirectGraphicsToHex` plus the byte-reading utilities
- [`samples/bartender-tes1.ipl`](../../samples/bartender-tes1.ipl) — real BarTender export sample (broken via paste, correct via file open)

---

## Sharing a label that contains graphics

Binary Direct Graphics (`<ESC>g0`) cannot survive a clipboard, but the printer
supports the same bitmap as nibblized ASCII hex (`<ESC>g1`, two hex digits per
byte — PRM Appendix E, mode m=1). The viewer's **Copy ASCII (g1)** button
performs exactly that rewrite: the result is pure ASCII, pastes anywhere
without loss, renders identically here, and prints identically. The paste
warning banner offers the same conversion in place via **Convert to ASCII (g1)**.

The conversion only helps while the bytes are still intact (opened via
drag-drop or Open File). Once a UTF-8 paste has already replaced them, nothing
can reconstruct them — open the file instead.
