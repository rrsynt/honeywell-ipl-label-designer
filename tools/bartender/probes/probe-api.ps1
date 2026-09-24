$ErrorActionPreference = 'Continue'
$asm = [System.Reflection.Assembly]::LoadFrom('C:\Program Files\Seagull\BarTender 2022\Interop.BarTender.dll')

Write-Output '=== ALL EXPORTED TYPES ==='
$asm.GetExportedTypes() | ForEach-Object { $_.Name } | Sort-Object
Write-Output ''

foreach ($tn in @('DBtApplication','DBtFormats','DBtFormat','DBtDesignObjects','DBtDesignObject','DBtPageSetup','DBtPrintSetup','DBtPrinterSetup')) {
  $t = $asm.GetExportedTypes() | Where-Object { $_.Name -eq $tn }
  if (-not $t) { Write-Output "== $tn : NOT FOUND =="; continue }
  Write-Output "== $tn =="
  $t.GetMembers() | ForEach-Object {
    if ($_.MemberType -eq 'Method') {
      $ps = ($_.GetParameters() | ForEach-Object { "$($_.Name): $($_.ParameterType.Name)" }) -join ', '
      "  M {0}({1})" -f $_.Name, $ps
    } elseif ($_.MemberType -eq 'Property') {
      "  P {0} : {1}" -f $_.Name, $_.PropertyType.Name
    }
  }
  Write-Output ''
}

foreach ($en in @('BtObjectType','BtShape','BtUnits','BtPrintResult','BtSaveOptions','BtVersion','BtHorizontalAlignment','BtOrientation','BtResolution')) {
  $t = $asm.GetExportedTypes() | Where-Object { $_.Name -eq $en }
  if (-not $t) { Write-Output "== $en : NOT FOUND =="; continue }
  Write-Output "== enum $en =="
  [System.Enum]::GetValues($t) | ForEach-Object { "  {0} = {1}" -f $_, [int]$_ }
  Write-Output ''
}
