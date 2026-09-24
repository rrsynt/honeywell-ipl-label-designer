# Point the IPL printer at a port whose name is a file path.
#
# A FILE: port pops a save dialog for every job, which an unattended script
# cannot answer. A local port named after a file writes the job's bytes straight
# there, so a normal print produces raw IPL with no interaction. BarTender's own
# PrintToFile cannot do this: it emits an encrypted blob that only BarTender can
# read back.
#
# Adding a port and retargeting a printer both need an elevated process. Run:
#   powershell -ExecutionPolicy Bypass -File ws5-port.ps1
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Spool {
    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool ClosePrinter(IntPtr handle);
    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool XcvData(IntPtr handle, string dataName, IntPtr input, int inputSize,
        IntPtr output, int outputSize, out int needed, out int status);
}
'@

$port = if ($args.Count -gt 0) { $args[0] } else { 'C:\Temp\ipl-out.ipl' }
$printer = 'Intermec PD43 (203 dpi) - IPL'

$handle = [IntPtr]::Zero
if (-not [Spool]::OpenPrinter(',XcvMonitor Local Port', [ref]$handle, [IntPtr]::Zero)) {
    throw "OpenPrinter failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}
$bytes = [Text.Encoding]::Unicode.GetBytes($port + "`0")
$ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)
$needed = 0; $status = 0
[Spool]::XcvData($handle, 'AddPort', $ptr, $bytes.Length, [IntPtr]::Zero, 0, [ref]$needed, [ref]$status) | Out-Null
[Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
[Spool]::ClosePrinter($handle) | Out-Null
# 0 = added, 183 = ERROR_ALREADY_EXISTS. Anything else is a real failure.
if ($status -ne 0 -and $status -ne 183) { throw "AddPort status=$status" }
Write-Output "port ready (status=$status)"

Set-Printer -Name $printer -PortName $port
Write-Output ("printer port now=[" + (Get-Printer -Name $printer).PortName + "]")
