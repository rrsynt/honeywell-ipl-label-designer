$ErrorActionPreference = 'Continue'
$asm = [System.Reflection.Assembly]::LoadFrom('C:\Program Files\Seagull\BarTender 2022\Interop.BarTender.dll')
$bt = New-Object -ComObject BarTender.Application
Write-Output ("Edition    = {0}" -f $bt.Edition)
Write-Output ("Version    = {0}" -f $bt.Version)
Write-Output ("BuildNum   = {0}" -f $bt.BuildNumber)
Write-Output ("FullVersion= {0}" -f $bt.FullVersion)
Write-Output ("Visible    = {0}" -f $bt.Visible)
Write-Output ("Formats.Count = {0}" -f $bt.Formats.Count)
# Try Open on a nonexistent path to see the error mode
try {
  $fmt = $bt.Formats.Add()
  Write-Output ("Add() result = {0}" -f $(if ($fmt) { "OBJ " + $fmt.GetType().Name } else { "NULL" }))
} catch { Write-Output ("Add() threw: " + $_.Exception.Message) }
$bt.Quit(0) | Out-Null
