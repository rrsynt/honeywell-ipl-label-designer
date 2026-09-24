$ErrorActionPreference = 'Continue'
Add-Type -Path 'C:\Program Files\Seagull\BarTender 2022\Interop.BarTender.dll'
try {
    $app = New-Object 'BarTender.ApplicationClass'
    Write-Output ("Early-bound OK. Edition={0} Version={1} Build={2}" -f $app.Edition, $app.Version, $app.BuildNumber)
    Write-Output ("Formats.Count={0}" -f $app.Formats.Count)
    try {
        $fmt = $app.Formats.Add()
        Write-Output ("Add() => {0}" -f $(if ($null -ne $fmt) { 'OBJECT' } else { 'NULL' }))
        if ($fmt) {
            Write-Output ("  Title={0} Units? ok" -f $fmt.Title)
            $fmt.Close(1)
        }
    } catch { Write-Output ("Add threw: " + $_.Exception.Message) }
    $app.Quit(1)
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app)
} catch {
    Write-Output ("FAIL: " + $_.Exception.Message)
}
