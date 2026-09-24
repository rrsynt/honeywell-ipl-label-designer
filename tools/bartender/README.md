# BarTender automation (Workstream 5, extended 2026-09-24)

Regenerates a real BarTender IPL stream and a real BarTender preview PNG with no
manual step, so `tests/bartenderAuto.test.ts` can check our renderer against
BarTender rather than against a hand-made sample.

## Generating formats with objects (BuildParityLabels)

`BuildParityLabels.cs` creates formats with objects at **arbitrary geometry** —
a position lattice, a size sweep, eight rotation angles, four page stocks, edge
and overhanging placements, and a mixed-type label. Nothing is placed by hand.

This is possible because the gate on design-object writes is the **document**,
not the object:

| Route | `Objects.Create()` | `obj.X = ...` |
|---|---|---|
| `Formats.Add()` | succeeds | throws — *"allowed only when running document event scripts"* |
| `Formats.Add()` + `SaveAs` first | succeeds | **still throws** |
| `Formats.Open(existing.btw)` | succeeds | **works** |
| `XMLScript` `CreateFormat` → then `Open` | succeeds | **works** |

So the page is created with the script language, reopened, and only then filled.
That is what `CreatePage()` does, and skipping it is why the first attempt placed
nothing.

Two things bite every time, so they are noted here rather than rediscovered:

- **Units are millimetres.** `fmt.MeasurementUnits` reports
  `btUnitsMillimeters` on this install whatever the format declares, and every
  `DesignObject` X/Y/Width/Height uses that unit. Authoring in inches puts
  everything 25.4x off-page and every preview comes out blank. The specs below
  are written in inches for readability and converted once.
- **Script numbers must be invariant-culture.** Under a comma-decimal locale
  `0.1` serialises as `0,1` and BarTender rejects the whole script with error
  3908. A hand-typed script works and a generated one does not, which reads as
  a schema problem rather than a locale one.

**Field content cannot be set.** `Create(text)` produces BarTender's default
`"Sample Text"`, and `SetXML`/`SetProperty` are accepted and then silently
ignored outside a document-event script — read the value back to see it. The
sweep is therefore GEOMETRY-only; data content stays the job of the hand-placed
samples.

    # one-time build
    "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" -nologo ^
      -r:"C:\Program Files\Seagull\BarTender 2022\Interop.BarTender.dll" ^
      -out:BuildParityLabels.exe BuildParityLabels.cs

    BuildParityLabels.exe C:\Temp\bt-sweep
    powershell -ExecutionPolicy Bypass -File sweep-to-ipl.ps1   # elevated
    PreviewExport.exe C:/Temp/bt-sweep/grid.btw C:/Temp/bt-sweep-png

`sizes` (6x4in) and `page-8x4` exceed the PD43's media, so BarTender refuses to
preview them (error 3704) — that is a media limit, not a tool failure. The
remaining cases are pinned by `tests/bartenderSweep.test.ts`.

## What works without a licence

BarTender 2022 R8 here is a trial. One route is closed:

- `PrintToFile` / the script's `<PrintToFile>` — refused with error 2610,
  "Print to file is not supported in a Free edition license or in a trial
  license".

Print preview export is *not* gated, which is what makes the reference PNG
possible. The IPL itself is reached by pointing the printer at a spooler port
whose name is a file path — that needs an elevated process once, and no
licence at all.

## Running

    # one-time, elevated: point the IPL printer at a file port
    powershell -ExecutionPolicy Bypass -File tools\bartender\bt-port.ps1

    # the .btw that is printed, and its BarTender preview
    PreviewExport.exe "<format.btw>" C:\Temp\bt-preview

    # the IPL BarTender sends to the printer
    PrintToFile.exe "<format.btw>"

The port script defaults to `C:\Temp` rather than the repo because BarTender's
own export path handling rejects directory names containing a space or
parentheses, and this project root has both. Pass `-Port` to use another path.

## Why C# and not PowerShell

The PowerShell COM adapter reaches BarTender only through an RCW that implements
none of the interop interfaces, and `InvokeMember` drops any argument the interop
marks `[Optional]` — `PageSetup.LabelWidth`'s units argument among them, so every
PowerShell attempt ended in DISP_E_PARAMNOTOPTIONAL. A hand-rolled `IDispatch`
declaration is worse: `out object pVarResult` gives the server an 8-byte slot
where it writes a 24-byte VARIANT on x64, which crashes the process with an
AccessViolationException.

## What the API still cannot do

Two limits survive from the original audit, and both are narrower than "objects
cannot be authored" — placement is fine, see `BuildParityLabels` above.

**No barcode symbology is exposed anywhere.** All 196 types in
`Interop.BarTender.dll` were searched; the symbol set only exists inside a
`.btw`. A created barcode accepts geometry but its symbology surface is out of
reach, so the parity sweep cannot choose one.

**Field content cannot be set.** `SetXML` and `SetProperty` are accepted and
then silently ignored on a design object outside a document-event script — no
error, the value simply does not change. Read it back rather than trusting the
absence of an exception. What `GetXML` returns for a text object, for reference:

    <Text Name="Text 1" Width="1.850 in" ConditionalPrintType="Always"
          Position.X="0.157 in" Position.Y="0.077 in">
      <Font PointSize="28.000" FontName="Arial" Height="-560" Weight="700" .../>
      <DataSources>
        <EmbeddedDataSource ID="{GUID}" CultureID="-3" InputCultureID="1057">
          <Transforms>...</Transforms>
          <Value>PARITY BASE</Value>
        </EmbeddedDataSource>
      </DataSources>
    </Text>

Feeding that shape back through `SetXML` is accepted and changes nothing, so the
content route is genuinely closed rather than merely awkward.

The script language (`IBtApplication.XMLScript`) is still what builds the page:
`CreateFormat` takes Width/Height/Orientation, Layout, Margins, a `Printer`
attribute and `SaveAsFileName`, and writes a real `.btw`. Its element names come
from the schemas beside the executable (`btxmlscript_2.0.xsd`,
`btxmlscript_base_2.0.xsd`), which is where the root `XMLScript`/`Command` shape
and `PrintSetupFullType` come from. Orientation values are `btPortrait` /
`btLandscape` / `btPortrait180` / `btLandscape180`, **not** `btOrientationRot0`;
a wrong one fails the whole script with only "Invalid BTXML script".

Assign the printer on the `Format`, not through `<FormatSetup>`: the server
reports an empty `FormatSetup` for a printer named in the script and silently
falls back to Microsoft Print to PDF, which cannot show a dialog unattended.

## probes/

Dead ends, kept for the reasoning rather than the code — see `probes/README.md`
for why each one cannot work. Nothing there is part of the working path.
