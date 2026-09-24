$ErrorActionPreference = 'Stop'
$asm = [System.Reflection.Assembly]::LoadFrom('C:\Program Files\Seagull\BarTender 2022\Interop.BarTender.dll')

$bt = $null
try {
    # Late-bound dispatchid failed earlier; try early-bound RCW via ApplicationClass
    $bt = New-Object -ComObject BarTender.Application
    $bt.Visible = $true  # visible so any licensing dialog is interactable for this first probe
    Write-Output "Launched OK"

    $f = $bt.Formats
    Write-Output "Formats accessor OK"
    $fmt = $f.Add()
    Write-Output "Format created OK"

    Write-Output ("LabelW={0} LabelH={1} Orientation={2}" -f $fmt.PageSetup.LabelWidth(1), $fmt.PageSetup.LabelHeight(1), $fmt.PageSetup.Orientation)
    Write-Output ("Printer={0} PrintToFile={1}" -f $fmt.PrintSetup.Printer, $fmt.PrintSetup.PrintToFile)

    $fmt.Close(1) | Out-Null
    Write-Output "Closed OK"
} catch {
    Write-Output ("FAIL: " + $_.Exception.Message)
    Write-Output ("  at: " + $_.InvocationInfo.PositionMessage)
} finally {
    if ($bt) { try { $bt.Quit(1) | Out-Null } catch {} }
}
