# Members of the COM interfaces Workstream 5 actually calls.
$ErrorActionPreference = 'Continue'
$bytes = [System.IO.File]::ReadAllBytes('C:\Program Files\Seagull\BarTender 2022\Interop.BarTender.dll')
$asm = [System.Reflection.Assembly]::ReflectionOnlyLoad($bytes)

function Show([string]$name, [string]$match) {
    $t = $asm.GetTypes() | Where-Object { $_.FullName -eq $name } | Select-Object -First 1
    Write-Output ("=== " + $name + " ===")
    foreach ($m in $t.GetMembers()) {
        if ($m.Name -notmatch $match -or $m.Name -match '^get_|^set_') { continue }
        $sig = ''
        if ($m.MemberType -eq 'Method') {
            $sig = '(' + (($m.GetParameters() | ForEach-Object { $_.ParameterType.Name }) -join ',') + ')'
        } elseif ($m.MemberType -eq 'Property') {
            $sig = ' : ' + $m.PropertyType.Name
        }
        Write-Output ("  " + $m.MemberType.ToString().Substring(0,4) + " " + $m.Name + $sig)
    }
}

Show 'BarTender.DBtFormat' 'Print|Page|Object|Save|Export|Design|Printer|Database|Close'
Show 'BarTender.DBtPrintSetup' 'File|Printer|Cop|Job|Output|Name|Path|Performance|Cache|Log|Media'
Show 'BarTender.DBtPageSetup' 'Width|Height|Orient|Paper|Stock|Label|Size|Mirror'
Show 'BarTender.DBtFormats' 'Add|Open|Item|Count'
Write-Output "DONE"
