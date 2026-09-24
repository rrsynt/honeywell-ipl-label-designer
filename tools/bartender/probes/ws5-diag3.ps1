# Capture the actual exception behind the empty COM properties.
$ErrorActionPreference = 'Continue'
$bt = New-Object -ComObject BarTender.Application
$flags = [Reflection.BindingFlags]::GetProperty
foreach ($name in @('Edition','Version','BuildNumber','Visible','Formats','ActiveFormat')) {
    try {
        $r = $bt.GetType().InvokeMember($name, $flags, $null, $bt, $null)
        Write-Output ($name + " = [" + $r + "]")
    } catch {
        $e = $_.Exception
        while ($e.InnerException) { $e = $e.InnerException }
        Write-Output ($name + " ERR: " + $e.GetType().Name + " : " + $e.Message)
    }
}
try { $bt.GetType().InvokeMember('Quit', [Reflection.BindingFlags]::InvokeMethod, $null, $bt, @(0)) | Out-Null } catch {}
Write-Output "DONE"
