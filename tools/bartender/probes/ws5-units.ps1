Add-Type -Path 'C:\Program Files\Seagull\BarTender 2022\Interop.BarTender.dll'
[enum]::GetNames([BarTender.BtUnits]) | ForEach-Object {
    Write-Output ($_ + '=' + [int]([BarTender.BtUnits]::$_))
}
