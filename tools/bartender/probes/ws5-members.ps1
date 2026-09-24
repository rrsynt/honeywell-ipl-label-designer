# Dump the real member names of the objects Workstream 5 needs.
$ErrorActionPreference = 'Continue'
Add-Type -Path 'C:\Program Files\Seagull\BarTender 2022\Interop.BarTender.dll'
$app = New-Object 'BarTender.ApplicationClass'
$fmt = $app.Formats.Add()

function Show($label, $obj, $match) {
    Write-Output ("=== " + $label + " ===")
    $obj.GetType().GetMembers() | Where-Object { $_.Name -match $match -and $_.Name -notmatch '^get_|^set_' } | ForEach-Object {
        Write-Output ("  " + $_.MemberType.ToString().Substring(0,4) + " " + $_.Name)
    }
}

Show 'Format(print/page/object)' $fmt 'Print|Page|Object|Save|Export|Unit'
Show 'PrintSetup' $fmt.PrintSetup 'File|Printer|Cop|Job|Output|Name|Path'
Show 'PageSetup' $fmt.PageSetup 'Width|Height|Orient|Paper|Stock|Label|Size'

$app.Quit(1)
Write-Output "DONE"
