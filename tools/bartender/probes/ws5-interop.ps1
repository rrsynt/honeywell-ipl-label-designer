# Read the interop assembly directly: what can a Format actually do?
$ErrorActionPreference = 'Continue'
$asm = [System.Reflection.Assembly]::LoadFrom('C:\Program Files\Seagull\BarTender 2022\Interop.BarTender.dll')

function Show($name, $match) {
    $t = $asm.GetType($name)
    Write-Output ("=== " + $name + " (" + ($null -ne $t) + ") ===")
    if (-not $t) { return }
    $t.GetMembers() | Where-Object { $_.Name -match $match -and $_.Name -notmatch '^get_|^set_' } | ForEach-Object {
        Write-Output ("  " + $_.MemberType.ToString().Substring(0,4) + " " + $_.Name)
    }
}

Show 'BarTender.Format' 'Print|Page|Object|Save|Export|Design|Printer'
Show 'BarTender.PrintSetup' '.'
Show 'BarTender.Formats' 'Open|Add|Item'
Write-Output "DONE"
