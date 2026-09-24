$ErrorActionPreference = 'Continue'
$asm = [System.Reflection.Assembly]::LoadFrom('C:\Program Files\Seagull\BarTender 2022\Interop.DriverAutomationLibrary.dll')
Write-Output '=== Types in DriverAutomationLibrary ==='
$asm.GetTypes() | ForEach-Object {
  Write-Output ('{0}  ({1})' -f $_.FullName, $_.BaseType)
  $_.GetMembers('Public,Instance,Static') | Where-Object { $_.DeclaringType -eq $_.ReflectedType } | ForEach-Object {
    if ($_.MemberType -eq 'Method') {
      $ps = ($_.GetParameters() | ForEach-Object { "$($_.Name): $($_.ParameterType.Name)" }) -join ', '
      "    M {0}({1}) -> {2}" -f $_.Name, $ps, $_.ReturnType.Name
    } elseif ($_.MemberType -eq 'Property') {
      "    P {0} : {1}" -f $_.Name, $_.PropertyType.Name
    }
  }
  Write-Output ''
}
