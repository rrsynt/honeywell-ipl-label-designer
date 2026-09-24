# BarTender automation (Workstream 5)

Regenerates a real BarTender IPL stream and a real BarTender preview PNG with no
manual step, so `tests/bartenderAuto.test.ts` can check our renderer against
BarTender rather than against a hand-made sample.

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

## Why the API cannot author a format's objects

`Interop.BarTender.dll` exposes no barcode symbology anywhere — the symbol set
only exists inside a `.btw`. Every property write on a newly created
`DesignObject` is refused, and the server is explicit about why: *"This property
is allowed only when running document event scripts"*. No COM entry point runs
one from outside, so design objects cannot be placed programmatically at all.

The script language (`IBtApplication.XMLScript`) is what builds the page:
`CreateFormat` takes Width/Height/Orientation, Layout, Margins, a `Printer`
attribute and `SaveAsFileName`, and writes a real `.btw` — which is all
`build-base-label.ps1` does. Its element names come from the schemas beside the
executable (`btxmlscript_2.0.xsd`, `btxmlscript_base_2.0.xsd`), which is where
the root `XMLScript`/`Command` shape and `PrintSetupFullType` come from.
Orientation values are `btPortrait` / `btLandscape` / `btPortrait180` /
`btLandscape180`, **not** `btOrientationRot0`; a wrong one fails the whole
script with only "Invalid BTXML script".

Assign the printer on the `Format`, not through `<FormatSetup>`: the server
reports an empty `FormatSetup` for a printer named in the script and silently
falls back to Microsoft Print to PDF, which cannot show a dialog unattended.

## probes/

Dead ends, kept for the reasoning rather than the code — see `probes/README.md`
for why each one cannot work. Nothing there is part of the working path.
