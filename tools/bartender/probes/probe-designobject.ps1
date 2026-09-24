$ErrorActionPreference = 'Continue'
$asm = [System.Reflection.Assembly]::LoadFrom('C:\Program Files\Seagull\BarTender 2022\Interop.BarTender.dll')

Write-Output '== enum BtObjectType =='
$t = $asm.GetExportedTypes() | Where-Object { $_.Name -eq 'BtObjectType' }
[System.Enum]::GetValues($t) | ForEach-Object { "  {0} = {1}" -f $_, [int]$_ }

Write-Output ''
Write-Output '== ALL DBtDesignObject properties =='
$t = $asm.GetExportedTypes() | Where-Object { $_.Name -eq 'DBtDesignObject' }
$t.GetMembers() | Where-Object { $_.MemberType -eq 'Property' } | ForEach-Object { "  {0} : {1}" -f $_.Name, $_.PropertyType.Name }

Write-Output ''
Write-Output '== ALL DBtDesignObject methods =='
$t.GetMembers() | Where-Object { $_.MemberType -eq 'Method' } | ForEach-Object {
  $ps = ($_.GetParameters() | ForEach-Object { "$($_.Name): $($_.ParameterType.Name)" }) -join ', '
  "  {0}({1})" -f $_.Name, $ps
}

Write-Output ''
Write-Output '== DBtDesignObjects Create/Add signatures =='
$t2 = $asm.GetExportedTypes() | Where-Object { $_.Name -eq 'DBtDesignObjects' }
$t2.GetMembers() | Where-Object { $_.MemberType -eq 'Method' } | ForEach-Object {
  $ps = ($_.GetParameters() | ForEach-Object { "$($_.Name): $($_.ParameterType.Name)" }) -join ', '
  "  {0}({1})" -f $_.Name, $ps
}

Write-Output ''
Write-Output '== Seagull PowerShell modules =='
Get-Module -ListAvailable -Name 'Seagull*' | ForEach-Object { "  {0} {1}" -f $_.Name, $_.Version }

Write-Output ''
Write-Output '== PrintManagement cmdlets available? =='
Get-Command Add-PrinterPort, Set-Printer -ErrorAction SilentlyContinue | ForEach-Object { "  {0}" -f $_.Name }
