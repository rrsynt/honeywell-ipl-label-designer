# What can a port actually be pointed at?
$ErrorActionPreference = 'Continue'
$dll = 'C:\Program Files\Seagull\BarTender 2022\Interop.DriverAutomationLibrary.dll'
$asm = [Reflection.Assembly]::LoadFrom($dll)
foreach ($name in @('IPrinterPort', 'IPrinterConfiguration')) {
    $t = $asm.GetTypes() | Where-Object { $_.Name -eq $name }
    Write-Output ("=== " + $name + " ===")
    foreach ($m in $t.GetMembers()) {
        if ($m.Name -match '^get_|^set_|^add_|^remove_') { continue }
        $sig = ''
        if ($m.MemberType -eq 'Method') { $sig = '(' + (($m.GetParameters() | ForEach-Object { $_.ParameterType.Name }) -join ',') + ')' }
        elseif ($m.MemberType -eq 'Property') { $sig = ':' + $m.PropertyType.Name }
        Write-Output ("  " + $m.Name + $sig)
    }
}
Write-Output "DONE"
