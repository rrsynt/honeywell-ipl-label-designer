# Direct Graphics `0x24` Repeat Last Line — bug found and fixed 2026-09-24

## The bug

`<ESC>g0` Direct Graphics mode encodes a bitmap as vertical columns.
`0x24 n` means *Repeat Last Line*: copy the previously defined column `n` times.
The decoder handled only the case where the column was **still buffered**, and
treated the common case — `0x24` right after an end-of-line `0x22`, which is how
BarTender actually emits it — as blank spacing:

```ts
} else {
    // Nothing buffered ... it advances the column index by n and copies no ink
    colIdx += n;
}
```

The manual is explicit (PRM2.70 Appendix E, p.262):

> **Repeat Last Line** — Purpose: Causes the printer to copy the previously
> defined column `n` number of times. … Notes: The printer automatically
> increments the X origin of each column. This command is only valid when
> preceded by a column of encoded, raw data or an end of line command.

So the column to copy is the one already committed to the output array. Dropping
it turns any repeated run of identical columns into empty space.

## Why it is invisible in ink totals

A solid box is emitted as *one* inked column plus N repeats. The repeats carry
identical ink, so discarding them removes most of the picture while the shape's
extent is unchanged. BarTender's own preview showed 16 solid 109×109 boxes; our
render produced 32 thin 109×1 rules at exactly the right lattice positions —
right where things are, wrong in what they are.

The existing `bartenderGeometry` test still passed, because each surviving rule
landed on *some* of the export's ink. The `bartender-tes1` golden moved by 39
pixels out of 628k, which reads as noise and is not.

## Evidence

The manual's own worked example (PRM2.70 p.264) decodes column-for-column after
the fix, and the automation-generated lattice goes from 3 inked columns to 110
per graphic:

| Check | Before | After |
|---|---|---|
| Manual col 0 bits | — | `4,10,12,14,16,18,20,25` (matches the manual's table) |
| Manual `24 82` repeat | cols 4,5 empty | both equal col 3 |
| Sweep `grid` ink overlap | 57% | 82% |
| Sweep `landscape` ink overlap | 54% | 90% |
| Sweep `rotations` ink | 64,327 / 71,803 | 71,872 / 71,803 |

Pinned by `tests/directGraphicsRepeat.test.ts` (manual example, synthetic filled
run, and the real BarTender stream) plus `tests/bartenderSweep.test.ts`.

## The three false leads worth remembering

1. **The 10-dot text offset was not a bug.** `elementVisualBox` returns the
   em/line box, not the ink box; a 6pt glyph inks 11 of 20 dots and the
   signature `dLeft=10, dRight=-1` is correct right-alignment.
2. **The blank previews after the first sweep were a unit bug, not a decode
   bug.** The BarTender interop reports `MeasurementUnits = btUnitsMillimeters`
   regardless of the format's declared units, so values authored in inches land
   25.4× off-page. The first sweep therefore rendered nothing at all.
3. **`0x24` data values must be ≥ 64.** The `0x25`/`0x26` loops read only
   `bytes[i] >= 64`; a smaller byte terminates the run. The compact 7-bit form
   is `value + 128`, so 40 dots is `0xA8` and 39 is `0xA7`.
