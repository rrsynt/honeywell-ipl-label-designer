"""Datamax Programming Language (DPL) constants, fonts, barcodes, printers.

Every table here is transcribed from Datamax's official
*M-Class DPL Programmer's Manual* and the *Class Series Programmer's Manual*,
with the section noted alongside.  Nothing is guessed.

Coordinate system (manual, "Generating Label Formats"):

    Home position is the LOWER-LEFT corner of the label.  Row counts UPWARD
    from it, column counts RIGHT from it, both in hundredths of an inch
    (imperial mode, the default) or tenths of a millimetre (metric mode).
"""

from dataclasses import dataclass

# =========================================================================
# Control codes (manual, "Control Codes")
# =========================================================================
SOH = b"\x01"  # Immediate commands  ("attention getter" for status/control)
STX = b"\x02"  # System-level commands
CR = b"\x0d"  # Record terminator
ESC = b"\x1b"  # Font-loading commands
LF = b"\x0a"

#: Rotation values for header field `a`.  Clockwise, pivot at the object's
#: bottom-left corner.
ROTATION_0 = 1
ROTATION_90 = 2
ROTATION_180 = 3
ROTATION_270 = 4
ROTATIONS = {0: 1, 90: 2, 180: 3, 270: 4}

# =========================================================================
# Multipliers (header fields c and d)
# =========================================================================
#: Values 1-9 then A-O represent multiplication factors 1..24 ("base 25").
MULTIPLIER_CHARS = "123456789ABCDEFGHIJKLMNO"


def multiplier(value: int) -> str:
    """Map an integer 1..24 onto the DPL multiplier character."""
    if not 1 <= value <= 24:
        raise ValueError(f"multiplier must be 1..24, got {value}")
    return MULTIPLIER_CHARS[value - 1]


def multiplier_value(char: str) -> int:
    """Inverse of :func:`multiplier`."""
    idx = MULTIPLIER_CHARS.find(char.upper())
    if idx < 0:
        raise ValueError(f"not a DPL multiplier character: {char!r}")
    return idx + 1


# =========================================================================
# Internal bitmapped fonts (Appendix C, Table C-2 @ 203 DPI)
# =========================================================================
@dataclass(frozen=True)
class Font:
    id: str
    height_dots: int
    width_dots: int
    spacing_dots: int
    point_size: float
    description: str

    def height_in(self, dpi: int = 203) -> float:
        return self.height_dots / dpi


FONTS: dict[str, Font] = {
    "0": Font("0", 7, 5, 1, 2.5, "96-character alphanumeric, upper and lower"),
    "1": Font("1", 13, 7, 2, 4.6, "145-character alphanumeric with descenders"),
    "2": Font("2", 18, 10, 2, 6.4, "138-character alphanumeric"),
    "3": Font("3", 27, 14, 2, 9.6, "62-character alphanumeric, uppercase"),
    "4": Font("4", 36, 18, 3, 12.8, "62-character alphanumeric, uppercase"),
    "5": Font("5", 52, 18, 3, 18.4, "62-character alphanumeric, uppercase"),
    "6": Font("6", 64, 32, 4, 22.7, "62-character alphanumeric, uppercase"),
    "7": Font("7", 32, 15, 5, 11.3, "OCR-A, size I"),
    "8": Font("8", 28, 15, 5, 9.9, "OCR-B, size III"),
}

#: Font 9 is the internal smooth/scalable CG Triumvirate.  Sizes are chosen
#: through the `eee` height field (Appendix C, Table C-3).
SMOOTH_FONT = "9"
SMOOTH_SIZES: dict[int, str] = {
    6: "A06", 8: "A08", 10: "A10", 12: "A12", 14: "A14",
    18: "A18", 24: "A24", 30: "A30", 36: "A36", 48: "A48",
}


def smooth_size(points: int) -> str:
    """Nearest valid smooth-font size specifier for a point size."""
    if points in SMOOTH_SIZES:
        return SMOOTH_SIZES[points]
    nearest = min(SMOOTH_SIZES, key=lambda p: abs(p - points))
    return SMOOTH_SIZES[nearest]


# =========================================================================
# Barcodes (Appendix F Table F-2, Appendix G)
# =========================================================================
@dataclass(frozen=True)
class Barcode:
    id: str  # uppercase = human-readable text beneath
    name: str
    default_height_in: float
    ratio: str
    charset: str
    length: str = "variable"

    @property
    def human_readable_id(self) -> str:
        return self.id.upper()

    @property
    def plain_id(self) -> str:
        return self.id.lower()


BARCODES: dict[str, Barcode] = {
    "A": Barcode("A", "Code 3 of 9", 0.40, "6:2", "0-9 A-Z -.*$/+% space"),
    "B": Barcode("B", "UPC-A", 0.80, "3", "0-9", "12 digits (11 + checksum)"),
    "C": Barcode("C", "UPC-E", 0.80, "3", "0-9", "7 digits (6 + checksum)"),
    "D": Barcode("D", "Interleaved 2 of 5", 0.40, "6:2", "0-9"),
    "E": Barcode("E", "Code 128", 0.40, "2", "all ASCII"),
    "F": Barcode("F", "EAN-13", 0.80, "3", "0-9", "13 digits (12 + checksum)"),
    "G": Barcode("G", "EAN-8", 0.80, "3", "0-9", "8 digits (7 + checksum)"),
    "H": Barcode("H", "Health Industry Bar Code (HIBC)", 0.40, "6:2",
                 "0-9 A-Z -.*$/+% space"),
    "I": Barcode("I", "Codabar", 0.40, "6:3", "0-9 A-D -.$:/+"),
    "J": Barcode("J", "Interleaved 2 of 5, mod-10 checksum", 0.40, "5:2", "0-9"),
    "K": Barcode("K", "Plessey", 0.40, "6:3", "0-9", "1-14 digits"),
    "L": Barcode("L", "Interleaved 2 of 5, mod-10 + bearer bars", 1.30, "5:2", "0-9"),
    "M": Barcode("M", "2-digit UPC addendum", 0.90, "3", "0-9", "2 digits"),
    "N": Barcode("N", "5-digit UPC addendum", 0.80, "3", "0-9", "5 digits"),
    "O": Barcode("O", "Code 93", 0.40, "3", "0-9 A-Z -.$/+% space"),
    "p": Barcode("p", "Postnet", 0.08, "n/a", "0-9", "5, 9 or 11 digits"),
    "Q": Barcode("Q", "UCC/EAN Code 128", 1.40, "2", "0-9", "19 digits"),
    "R": Barcode("R", "UCC/EAN Code 128 K-MART", 1.40, "2", "0-9", "18 digits"),
    "S": Barcode("S", "UCC/EAN Code 128 Random Weight", 1.40, "2", "0-9",
                 "34+ digits"),
    "T": Barcode("T", "Telepen", 0.80, "1", "all ASCII"),
    "u": Barcode("u", "UPS MaxiCode", 1.00, "n/a", "all ASCII"),
    "v": Barcode("v", "FIM", 0.50, "1", "A, B, C or D", "1 character"),
    "z": Barcode("z", "PDF-417", 0.00, "n/a", "all ASCII", "up to 3000 chars"),
}

#: Two-dimensional symbologies addressed through the Wxx expansion field.
BARCODES_W: dict[str, str] = {
    "W1C": "Data Matrix",
    "W1D": "QR Code",
    "W1F": "Aztec",
    "W1Z": "PDF-417",
}


def barcode(name_or_id: str) -> Barcode:
    """Look up a symbology by DPL id or by human name."""
    key = name_or_id.strip()
    if key in BARCODES:
        return BARCODES[key]
    if key.upper() in BARCODES:
        return BARCODES[key.upper()]
    want = key.lower().replace("-", " ").replace("_", " ")
    for bc in BARCODES.values():
        if bc.name.lower().replace("-", " ") == want:
            return bc
    raise KeyError(
        f"unknown barcode {name_or_id!r}. Known ids: {', '.join(sorted(BARCODES))}"
    )


# =========================================================================
# Print speeds (Appendix K, Table K-1)
# =========================================================================
SPEEDS: dict[str, float] = {
    "A": 1.0, "B": 1.5, "C": 2.0, "D": 2.5, "E": 3.0, "F": 3.5,
    "G": 4.0, "H": 4.5, "I": 5.0, "J": 5.5, "K": 6.0,
}
SPEED_RANGE = ("C", "K")  # M-Class print speed range
DEFAULT_SPEED = "G"  # 4.0 ips


def speed_for_ips(ips: float) -> str:
    """Closest speed command character for a given inches-per-second."""
    valid = {k: v for k, v in SPEEDS.items() if SPEED_RANGE[0] <= k <= SPEED_RANGE[1]}
    return min(valid, key=lambda k: abs(valid[k] - ips))


# =========================================================================
# Printer models (Appendix J / Class Series Appendix K)
# =========================================================================
@dataclass(frozen=True)
class PrinterModel:
    name: str
    dpi: int
    dpmm: float
    max_width_dots: int
    max_width_mm: float
    max_column_inch: int
    max_column_metric: int

    @property
    def max_width_in(self) -> float:
        return self.max_width_dots / self.dpi


MODELS: dict[str, PrinterModel] = {
    # The M-4208's "08" denotes 8 ips print speed, not resolution: every
    # 4-inch M-Class model is 203 DPI.  Confirmed against this unit's own
    # <STX>KC output (printer key 4208-MD10).
    "M-4206": PrinterModel("M-4206", 203, 8.0, 864, 108.0, 425, 1080),
    "M-4208": PrinterModel("M-4208", 203, 8.0, 864, 108.0, 425, 1080),
    "M-4210": PrinterModel("M-4210", 203, 8.0, 864, 108.0, 425, 1080),
    "M-4308": PrinterModel("M-4308", 300, 11.8, 1248, 105.7, 416, 1046),
    "I-4208": PrinterModel("I-4208", 203, 8.0, 832, 104.1, 410, 1041),
    "I-4308": PrinterModel("I-4308", 300, 11.8, 1248, 105.7, 416, 1046),
    "H-4212": PrinterModel("H-4212", 203, 8.0, 832, 104.1, 410, 1041),
    "H-4310": PrinterModel("H-4310", 300, 11.8, 1248, 105.7, 416, 1046),
}

DEFAULT_MODEL = "M-4208"

# =========================================================================
# Memory modules (Appendix J, Table J-1)
# =========================================================================
MODULES = {
    "A": "DRAM (512 KB default)",
    "B": "Flash (user area; ~100,000 write cycles)",
    "C": "Default module as assigned by <STX>X",
}

# =========================================================================
# Sensor / media types (<STX>K commands)
# =========================================================================
SENSOR_TYPES = {"gap": "e", "continuous": "c", "reflective": "r"}
MEDIA_DIRECT_THERMAL = "direct"
MEDIA_THERMAL_TRANSFER = "transfer"


def inches_to_units(inches: float, metric: bool = False) -> int:
    """Convert inches to DPL position units.

    Imperial mode counts hundredths of an inch; metric mode counts tenths
    of a millimetre.
    """
    return round(inches * 254.0) if metric else round(inches * 100.0)


def mm_to_units(mm: float, metric: bool = True) -> int:
    """Convert millimetres to DPL position units."""
    return round(mm * 10.0) if metric else round(mm / 25.4 * 100.0)
