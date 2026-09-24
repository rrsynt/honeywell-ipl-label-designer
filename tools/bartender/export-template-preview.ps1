// Produce a BarTender reference preview for a .btw without a printer or a license.
//
// The 2022 R8 install on this machine is a trial, so PrintToFile and a
// print-to-a-file port both refuse (error 2610, and ERROR_ACCESS_DENIED from the
// spooler respectively). Print preview export is not gated either way, which
// makes it the one BarTender-side artifact that can be regenerated at will --
// enough to keep the parity suites honest against real BarTender rendering.
//
// Output goes to a plain path: BarTender's own path handling rejects directory
// names containing a space or parentheses, which is what the project folder has.

param(
    [Parameter(Mandatory = $true)][string]$Format,
    [string]$OutDir = 'C:\Temp\bt-preview'
)
$ErrorActionPreference = 'Stop'

Add-Type -Path 'C:\Program Files\Seagull\BarTender 2022\Interop.BarTender.dll'
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
Get-ChildItem -Path $OutDir -Filter '*.png' -ErrorAction SilentlyContinue | Remove-Item -Force

$app = New-Object BarTender.ApplicationClass
try {
    $app.Visible = $false
    $fmt = $app.Formats.Open($Format, $false, '')
    Write-Output ("opened=" + $Format)
    Write-Output ("objects=" + $fmt.Objects.Count)

    # 203 dpi is the IPL printer's density; the call is mono so the result is
    # the same black-on-white bitmap the golden harness compares against.
    $messages = $null
    $result = $fmt.ExportPrintPreviewToImage(
        $OutDir, 'preview.png', 'png',
        [BarTender.BtColors]::btColorsMono, 203, 0xFFFFFF,
        [BarTender.BtSaveOptions]::btDoNotSaveChanges, $false, $false, [ref]$messages)

    Write-Output ("result=" + $result)
    if ($messages) {
        for ($i = 1; $i -le $messages.Count; $i++) {
            $m = $messages.Item($i)
            Write-Output ("  [" + $m.Number + "] " + $m.Message)
        }
    }
    Get-ChildItem -Path $OutDir -Filter '*.png' | ForEach-Object {
        Write-Output ("wrote " + $_.FullName + " bytes=" + $_.Length)
    }
} finally {
    $app.Quit([BarTender.BtSaveOptions]::btDoNotSaveChanges)
}
