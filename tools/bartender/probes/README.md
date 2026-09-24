# Probe scripts (archived)

Every script here is a dead end. They are kept because the conclusions they
reached are the reason the working tooling looks the way it does — several of
these are the only record of an approach that looked reasonable and wasn't.

**Do not run these to make something work.** The live tooling is one directory
up: `PreviewExport.exe`, `PrintToFile.exe`, `bt-port.ps1`, `build-base-label.ps1`.

## What each group proved wrong

**`ws5-port.ps1`** — creates the printer port with the low-level spooler API
(`OpenPrinter` + `XcvData`/`AddPort`) instead of the `Add-PrinterPort` cmdlet.
Windows returns ERROR_ACCESS_DENIED (status 5) **even from an elevated
process**, so this route cannot work at all. `bt-port.ps1` one directory up uses
the cmdlet and is accepted. If you are here to fix the port, use that one.

**`ws5-print.ps1`, `ws5-diag*.ps1`, `ws5-typelib.ps1`, `ws5-interop.ps1`**, and
the other `ws5-*` — attempts to drive BarTender from PowerShell. All fail, for
two independent reasons:

- The PowerShell COM adapter reaches BarTender through an RCW that implements
  none of the interop interfaces, and `InvokeMember` silently drops any argument
  the interop marks `[Optional]` — so `PageSetup.LabelWidth`'s units argument
  never arrives and the server reports DISP_E_PARAMNOTOPTIONAL.
- A hand-rolled `IDispatch` is worse than the adapter. Declaring the return
  value as `out object` hands the server an 8-byte slot where it writes a
  24-byte VARIANT on x64, which overruns the stack and kills the process with an
  AccessViolationException. This is what the crash in `ws5-print.out` is.

The fix is C# against the interop, which is what `PrintToFile.cs` and
`PreviewExport.cs` do.

**`probe-designobject.ps1`, `probe-api.ps1`, `probe-members.ps1`** — trying to
set properties on a `DesignObject` BarTender created. Every write is refused.
The message states the actual rule: *"This property is allowed only when running
document event scripts"* — and no COM entry point runs one from outside, so
design objects cannot be authored programmatically at all. This is why
`parity-base.btw` is placed by hand in the Format Builder.

**`probe-print-options.ps1`, `probe-setup.ps1`, `probe-driver-automation.ps1`**,
**`check-edition.ps1`** — enumeration of print/page/driver options. Useful once,
superseded: the schemas BarTender ships beside the executable
(`btxmlscript_2.0.xsd`, `btxmlscript_base_2.0.xsd`) document the script language
properly, and reading those beats reflection.

**`ws5-typelib.ps1`, `early-bound.ps1`, `ws5-build.ps1`** — compile helpers and
type-library dumps, written before the working C# tools. `ws5-build.ps1` in
particular does not produce the current binaries.

**`ws5-print.out`** — the AccessViolationException stack trace, kept because it
documents the VARIANT-marshalling failure described above.

## Naming

`ws5-*` came from "Workstream 5", the plan item these were written for.
`probe-*` are narrower one-off questions. None of the numbering after
`ws5-diag2` means anything; they were successive attempts at the same problem.
