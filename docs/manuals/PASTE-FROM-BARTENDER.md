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
