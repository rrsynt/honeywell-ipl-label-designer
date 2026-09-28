# DPL Protocol Guide

DPL (Datamax Programming Language) is a format-driven command language for Datamax-O'Neil industrial and desktop thermal label printers.

---

## 1. Overview & Scope
- **Builder Class**: `DplPrinter`
- **Compiler Facade**: `dpl.compile(labelBuilder)`
- **Parser**: `parseDPL(String code)`
- **Primary Targets**: Datamax I-Class, M-Class, E-Class, and compatible printers.

---

## 2. Minimal Working Example

```dart
import 'dart:typed_data';
import 'package:portakal_core/portakal_core.dart';

void main() {
  final printer = DplPrinter()
    ..startLabel()
    ..density(10)
    ..speed(4)
    ..text(row: 50, col: 50, font: '9', content: 'DATAMAX INDUSTRIAL LABEL')
    ..barcodeCode128(row: 120, col: 50, height: 70, content: 'DPL-9988')
    ..quantity(1)
    ..endLabel();

  final Uint8List bytes = printer.toBytes();
}
```

---

## 3. Command Lifecycle & CR Line Endings

> [!IMPORTANT]
> **Line Endings**: The native `DplPrinter` builder emits authentic Datamax Carriage Return (`CR` / `0x0D`) command terminators. The historical universal `compileToDPL` String compatibility serializer emitted `LF` (`0x0A`). Use the native builder for strict hardware compliance.

### Lifecycle Sequence:
1. **Start Label**: `startLabel()` emits `<STX>L<CR>`.
2. **Parameters**: `density(d)` (`D<d><CR>`), `speed(s)` (`S<s><CR>`), `width(w)` (`W<w><CR>`).
3. **Record Records**: Record descriptor records specifying rotation, font, scaling, coordinates, and data.
4. **Quantity**: `quantity(q)` emits `Q<q><CR>`.
5. **End Label**: `endLabel()` emits `E<CR>`.

---

## 4. Text & Barcode Records
- **Text Record**: Format `rotation font hMult vMult subFont row col content`.
- **1D Barcode**: Format `rotation barcodeType hMult wideNarrowRatio height row col content`.
- **2D QR Code**: Format `rotation QR ... row col content`.

---

## 5. Unsupported SDK Features (N/S-SDK)
- **Generic Raster Graphics**: Custom raster bitmaps are currently unsupported (`N/S-SDK`) on DPL.
- **Complex Geometric Primitives**: Ellipse, circular arcs, and reverse regions are `N/S-SDK`.

---

## 6. Hardware Validation Status
- **Automated Test Suite**: **PASS** (Level 1 Byte-Verified across all supported DPL cases).
