# BarTender automation (Workstream 5)

Regenerates a real BarTender IPL stream and a real BarTender preview PNG with no
manual step, so `tests/bartenderAuto.test.ts` can check our renderer against
BarTender rather than against a hand-made sample.

## What works without a licence

BarTender 2022 R8 here is a trial. Two routes are closed:

- `PrintToFile` / the script's `<PrintToFile>` — refused with error 2610,
  "Print to file is not supported in a Free edition license or in a trial
  license".
- A spooler port whose name is a file path — rejected by Windows with
  ERROR_ACCESS_DENIED, even from an elevated process (`ws5-port.ps1` uses the
  low-level `XcvData`/`AddPort` call for this reason).

Print preview export is *not* gated, which is what makes the reference PNG
possible.

## Running

    # one-time, elevated: point the IPL printer at a file port
    powershell -ExecutionPolicy Bypass -File C:\Temp\bt-port.ps1

    # the .btw that is printed, and its BarTender preview
    PreviewExport.exe "<format.btw>" C:\Temp\bt-preview

    # the IPL BarTender sends to the printer
    PrintToFile.exe "<format.btw>"

`bt-port.ps1` lives in `C:\Temp` on purpose: BarTender's export path handling
rejects directory names containing a space or parentheses, which the project
root has.

## Why C# and not PowerShell

The PowerShell COM adapter reaches BarTender only through an RCW that implements
none of the interop interfaces, and `InvokeMember` drops any argument the interop
marks `[Optional]` — `PageSetup.LabelWidth`'s units argument among them, so every
PowerShell attempt ended in DISP_E_PARAMNOTOPTIONAL. A hand-rolled `IDispatch`
declaration is worse: `out object pVarResult` gives the server an 8-byte slot
where it writes a 24-byte VARIANT on x64, which crashes the process with an
AccessViolationException.

## Why the API cannot author a format

`Interop.BarTender.dll` exposes no barcode symbology anywhere — the symbol set
only exists inside a `.btw`. Every property write on a newly created
`DesignObject` is refused with "Object property is not supported". The script
language (`IBtApplication.XMLScript`) is the surface that can reach them; its
element names come from the schemas beside the executable
(`btxmlscript_2.0.xsd`, `btxmlscript_base_2.0.xsd`), which is where the root
`XMLScript`/`Command` shape and `PrintSetupFullType` come from.

Assign the printer on the `Format`, not through `<FormatSetup>`: the server
reports an empty `FormatSetup` for a printer named in the script and silently
falls back to Microsoft Print to PDF, which cannot show a dialog unattended.
