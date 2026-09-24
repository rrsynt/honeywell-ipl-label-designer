# Point the BarTender IPL printer at a local port named after a file.
#
# Run this ELEVATED. A port monitor cannot be created by an unprivileged
# process, and unlike the low-level XcvData/AddPort route in probes/ws5-port.ps1
# this one is accepted by the spooler -- the raw API call fails with
# ERROR_ACCESS_DENIED even elevated, so do not go back to it.
#
# The default target is C:\Temp rather than the repo: BarTender's own export
# path handling rejects directory names containing a space or parentheses, and
# this project's root has both. An earlier elevated launch of the same script
# failed before it ran at all because the path it was handed had a space in it.
#
#   powershell -ExecutionPolicy Bypass -File tools\bartender\bt-port.ps1
param(
    [string]$Port = 'C:\Temp\ipl-out.ipl',
    [string]$Printer = 'Intermec PD43 (203 dpi) - IPL',
    [string]$Log = 'C:\Temp\bt-port.log'
)
$ErrorActionPreference = 'Continue'
"[$(Get-Date -Format s)] start" | Out-File $Log -Encoding utf8

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
"isAdmin=$isAdmin" | Out-File $Log -Append -Encoding utf8
if (-not $isAdmin) {
    "not elevated -- Add-PrinterPort will fail" | Out-File $Log -Append -Encoding utf8
}

# The spooler will not write to a directory that does not exist, and the port
# name has to equal the resulting path exactly.
$dir = Split-Path -Parent $Port
if ($dir -and -not (Test-Path $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    "created $dir" | Out-File $Log -Append -Encoding utf8
}

try {
    # 183/ERROR_ALREADY_EXISTS is success on a re-run: the port survives until
    # something removes it, and re-adding is not required.
    Add-PrinterPort -Name $Port -ErrorAction Stop
    "Add-PrinterPort ok" | Out-File $Log -Append -Encoding utf8
} catch {
    if ($_.Exception.Message -match 'already exists') {
        "Add-PrinterPort already exists" | Out-File $Log -Append -Encoding utf8
    } else {
        "Add-PrinterPort ERR: $($_.Exception.Message)" | Out-File $Log -Append -Encoding utf8
    }
}

try {
    Set-Printer -Name $Printer -PortName $Port -ErrorAction Stop
    "Set-Printer ok" | Out-File $Log -Append -Encoding utf8
} catch {
    "Set-Printer ERR: $($_.Exception.Message)" | Out-File $Log -Append -Encoding utf8
}

try {
    $p = Get-PrinterPort | Where-Object { $_.Name -eq $Port }
    "portExists=$($null -ne $p)" | Out-File $Log -Append -Encoding utf8
    "printerPortNow=[$((Get-Printer -Name $Printer).PortName)]" | Out-File $Log -Append -Encoding utf8
} catch {
    "verify ERR: $($_.Exception.Message)" | Out-File $Log -Append -Encoding utf8
}

Get-Content $Log
