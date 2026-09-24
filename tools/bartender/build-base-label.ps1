# Create the blank parametric label in BarTender, ready to edit in the GUI.
#
# Everything a .btw can hold -- page size, orientation, margins, printer -- is
# reachable from the script language's CreateFormat command, and the result is a
# real .btw the Format Builder opens. Only the design objects have to be placed
# by hand: the automation API refuses those with "This property is allowed only
# when running document event scripts", and no COM entry point exists to run
# one from outside.
#
# Run once (no elevation needed):
#   powershell -ExecutionPolicy Bypass -File build-base-label.ps1
param(
    [string]$OutFile = 'C:\Temp\bt-author\parity-base.btw'
)
$ErrorActionPreference = 'Stop'

# BarTender's own path handling rejects directories with a space or parentheses,
# so the label is built somewhere it can write.
$dir = Split-Path -Parent $OutFile
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

Add-Type -Path 'C:\Program Files\Seagull\BarTender 2022\Interop.BarTender.dll'

$script = @"
<?xml version="1.0" encoding="utf-8"?>
<XMLScript Version="2.0">
  <Command Name="CreateFormat">
    <CreateFormat SaveAsFileName="$OutFile" Printer="Intermec PD43 (203 dpi) - IPL">
      <Page Width="4 in" Height="2 in" Orientation="btLandscape" />
      <Layout Rows="1" Columns="1" />
      <Margins Top="0.1" Left="0.1" Bottom="0.1" Right="0.1" />
    </CreateFormat>
  </Command>
</XMLScript>
"@

$app = New-Object BarTender.ApplicationClass
try {
    $app.Visible = $false
    $messages = $null
    $null = $app.XMLScript($script, [BarTender.BtXMLSourceType]::btXMLScriptString, [ref]$messages)
    if ($messages) {
        for ($i = 1; $i -le $messages.Count; $i++) {
            $m = $messages.Item($i)
            Write-Output ("  [" + $m.Number + "] " + $m.Message.Split("`n")[0])
        }
    }
    Write-Output ("wrote " + $OutFile + " exists=" + (Test-Path $OutFile) +
                  " bytes=" + (Get-Item $OutFile -ErrorAction SilentlyContinue).Length)
} finally {
    $app.Quit([BarTender.BtSaveOptions]::btDoNotSaveChanges)
}
