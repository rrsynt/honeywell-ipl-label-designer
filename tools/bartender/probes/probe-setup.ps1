$ErrorActionPreference = 'Continue'
$asm = [System.Reflection.Assembly]::LoadFrom('C:\Program Files\Seagull\BarTender 2022\Interop.BarTender.dll')

Write-Output '=== DBtPageSetup members ==='
$t = $asm.GetExportedTypes() | Where-Object { $_.Name -eq 'DBtPageSetup' }
if ($t) {
  $t.GetMembers() | ForEach-Object {
    if ($_.MemberType -eq 'Method') {
      $ps = ($_.GetParameters() | ForEach-Object { "$($_.Name): $($_.ParameterType.Name)" }) -join ', '
      "  M {0}({1})" -f $_.Name, $ps
    } elseif ($_.MemberType -eq 'Property') {
      "  P {0} : {1}" -f $_.Name, $_.PropertyType.Name
    }
  }
}
Write-Output ''

Write-Output '=== DBtPrintSetup members ==='
$t = $asm.GetExportedTypes() | Where-Object { $_.Name -eq 'DBtPrintSetup' }
if ($t) {
  $t.GetMembers() | ForEach-Object {
    if ($_.MemberType -eq 'Method') {
      $ps = ($_.GetParameters() | ForEach-Object { "$($_.Name): $($_.ParameterType.Name)" }) -join ', '
      "  M {0}({1})" -f $_.Name, $ps
    } elseif ($_.MemberType -eq 'Property') {
      "  P {0} : {1}" -f $_.Name, $_.PropertyType.Name
    }
  }
}
Write-Output ''

Write-Output '=== BtUnits enum ==='
$t = $asm.GetExportedTypes() | Where-Object { $_.Name -eq 'BtUnits' }
if ($t) { [System.Enum]::GetValues($t) | ForEach-Object { "  {0} = {1}" -f $_, [int]$_ } }
Write-Output ''

Write-Output '=== BtResolution enum ==='
$t = $asm.GetExportedTypes() | Where-Object { $_.Name -eq 'BtResolution' }
if ($t) { [System.Enum]::GetValues($t) | ForEach-Object { "  {0} = {1}" -f $_, [int]$_ } }
Write-Output ''

Write-Output '=== BtShape enum ==='
$t = $asm.GetExportedTypes() | Where-Object { $_.Name -eq 'BtShape' }
if ($t) { [System.Enum]::GetValues($t) | ForEach-Object { "  {0} = {1}" -f $_, [int]$_ } }
Write-Output ''

Write-Output '=== BtSaveOptions enum ==='
$t = $asm.GetExportedTypes() | Where-Object { $_.Name -eq 'BtSaveOptions' }
if ($t) { [System.Enum]::GetValues($t) | ForEach-Object { "  {0} = {1}" -f $_, [int]$_ } }
Write-Output ''
