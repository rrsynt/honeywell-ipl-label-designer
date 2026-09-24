$ErrorActionPreference = 'Stop'
[void][System.Reflection.Assembly]::LoadFrom('C:\Program Files\Seagull\BarTender 2022\Interop.DriverAutomationLibrary.dll')
$printer = New-Object -ComObject 'DriverAutomationLibrary.Printer'
$printer.Initialize('Intermec PD43 (203 dpi) - IPL')
Write-Output ('Name={0} Model={1} Port={2} Driver={3}' -f $printer.Name, $printer.ModelName, $printer.PortName, $printer.DriverVersion)
$cfgPath = 'D:\RR\PROJECT LAMA\WEB\honeywell-ipl-label-designer (5)\tools\bartender\pd43-settings-export.xml'
$printer.Configuration.Export($cfgPath, $null)
Write-Output "EXPORTED OK -> $cfgPath"
