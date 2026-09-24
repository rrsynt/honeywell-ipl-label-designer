# Print each generated sweep format to an IPL file, one file-port per case.
#
# The IPL printer can only be pointed at ONE file port at a time, so this walks
# the cases: create the port, repoint the printer, run PrintToFile.exe, collect.
# Port names are paths, and a path with a space or parentheses is rejected by
# BarTender's own export handling, so everything lives under C:\Temp.
#
# Run elevated (Add-PrinterPort / Set-Printer need it):
#   powershell -ExecutionPolicy Bypass -File sweep-to-ipl.ps1
param(
    [string]$SweepDir = 'C:\Temp\bt-sweep',
    [string]$OutDir   = 'C:\Temp\bt-sweep-ipl',
    [string]$Printer  = 'Intermec PD43 (203 dpi) - IPL',
    [string]$ToolDir  = 'D:\RR\PROJECT LAMA\WEB\honeywell-ipl-label-designer (5)\tools\bartender'
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$cases = Get-ChildItem -Path $SweepDir -Filter *.btw | Sort-Object Name
foreach ($c in $cases) {
    $name = $c.BaseName
    $portPath = Join-Path $OutDir "$name.ipl"

    # Recreate the port each time: Windows will not repoint an existing one.
    if (Get-PrinterPort -Name $portPath -ErrorAction SilentlyContinue) {
        Remove-PrinterPort -Name $portPath -ErrorAction SilentlyContinue
    }
    Add-PrinterPort -Name $portPath
    Set-Printer -Name $Printer -PortName $portPath

    & (Join-Path $ToolDir 'PrintToFile.exe') $c.FullName | Out-Null
    Start-Sleep -Milliseconds 400

    if (Test-Path $portPath) {
        $len = (Get-Item $portPath).Length
        Write-Output ("{0,-12} IPL OK {1} bytes" -f $name, $len)
        # Spooler keeps the file locked briefly; make it readable for the next step.
        Start-Sleep -Milliseconds 200
    } else {
        Write-Output ("{0,-12} IPL MISSING" -f $name)
    }
}
