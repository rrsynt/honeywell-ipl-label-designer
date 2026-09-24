# Why does the BarTender COM object answer with empty properties?
$ErrorActionPreference = 'Continue'
Write-Output "--- processes ---"
Get-Process | Where-Object { $_.ProcessName -match 'bar|seagull' } | ForEach-Object {
    Write-Output ("PROC " + $_.ProcessName + " pid=" + $_.Id + " session=" + $_.SessionId + " main=" + $_.MainWindowTitle)
}
Write-Output ("our session=" + (Get-Process -Id $PID).SessionId)

Write-Output "--- windows titled bartender ---"
Get-Process | Where-Object { $_.MainWindowTitle -match 'BarTender|License|Activation|Seagull' } | ForEach-Object {
    Write-Output ("WIN " + $_.ProcessName + " : " + $_.MainWindowTitle)
}

Write-Output "--- com object ---"
$bt = New-Object -ComObject BarTender.Application
Write-Output ("type=" + $bt.GetType().FullName)
Write-Output ("SAPI.Support=" + $bt.SAPI.Support)
try { $bt.Visible = $true; Write-Output "Visible=true set ok" } catch { Write-Output ("Visible set ERR: " + $_.Exception.Message) }
Start-Sleep -Seconds 3
Get-Process | Where-Object { $_.MainWindowTitle -ne '' -and $_.ProcessName -match 'bar|seagull' } | ForEach-Object {
    Write-Output ("WIN2 " + $_.ProcessName + " : " + $_.MainWindowTitle)
}
Write-Output ("Edition after visible=" + $bt.Edition)
$bt.Quit(0) | Out-Null
Write-Output "DONE"
