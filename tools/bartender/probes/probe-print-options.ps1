$ErrorActionPreference = 'Continue'
$asm = [System.Reflection.Assembly]::LoadFrom('C:\Program Files\Seagull\BarTender 2022\Interop.BarTender.dll')

Write-Output '=== DBtPrinterCodeTemplate members ==='
$t = $asm.GetExportedTypes() | Where-Object { $_.Name -eq 'DBtPrinterCodeTemplate' }
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

Write-Output '=== Looking for printer-specific methods on PrintSetup ==='
# Check if PrintSetup exposes a GetSetting/SetSetting pattern or indexer
$t = $asm.GetExportedTypes() | Where-Object { $_.Name -eq 'DBtPrintSetup' }
if ($t) {
  Write-Output 'Members containing Setting/Option/Config in name:'
  $t.GetMembers() | Where-Object { $_.Name -match 'Sett|Opt|Conf|Ipl|Emul' } | ForEach-Object {
    if ($_.MemberType -eq 'Method') {
      $ps = ($_.GetParameters() | ForEach-Object { "$($_.Name): $($_.ParameterType.Name)" }) -join ', '
      "  M {0}({1})" -f $_.Name, $ps
    } elseif ($_.MemberType -eq 'Property') {
      "  P {0} : {1}" -f $_.Name, $_.PropertyType.Name
    }
  }
}
Write-Output ''

Write-Output '=== Search for all Interface types with PRINTER or SETTING in name ==='
$asm.GetExportedTypes() | Where-Object { $_.Name -match 'IPrint|Setting|Printer' } | ForEach-Object {
  Write-Output '{0}' -f $_.Name
  $_.GetMembers() | Where-Object { $_.Name -notmatch '^(get_|set_|Equals|GetHashCode|GetType|ToString)$' } | Select-Object -First 30 | ForEach-Object { "    {0}`t{1}" -f $_.MemberType.ToString().Substring(0,4), $_.Name }
  Write-Output ''
}

Write-Output '=== Checking IBtPrinterCodeTemplate (interface) ==='
$t = $asm.GetExportedTypes() | Where-Object { $_.Name -eq 'IBtPrinterCodeTemplate' }
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
