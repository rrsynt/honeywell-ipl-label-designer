# What is BarTender actually showing, and which edition is installed?
$ErrorActionPreference = 'Continue'

Write-Output "--- registry ---"
foreach ($k in @(
    'HKLM:\SOFTWARE\Seagull Scientific\BarTender',
    'HKLM:\SOFTWARE\WOW6432Node\Seagull Scientific\BarTender',
    'HKCU:\SOFTWARE\Seagull Scientific\BarTender')) {
    if (Test-Path $k) {
        Write-Output ("KEY " + $k)
        Get-ItemProperty $k | ForEach-Object { $_.PSObject.Properties } |
            Where-Object { $_.Name -notmatch '^PS' } |
            ForEach-Object { Write-Output ("  " + $_.Name + "=" + $_.Value) }
    }
}

Write-Output "--- visible windows ---"
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinEnum {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
"@
$bt = New-Object -ComObject BarTender.Application
$bt.Visible = $true
Start-Sleep -Seconds 4
$cb = [WinEnum+EP]{ param($h, $l)
    if ([WinEnum]::IsWindowVisible($h)) {
        $sb = New-Object System.Text.StringBuilder 256
        [WinEnum]::GetWindowText($h, $sb, 256) | Out-Null
        if ($sb.Length -gt 0) { Write-Output ("WIN " + $sb.ToString()) }
    }
    return $true
}
[WinEnum]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

Write-Output "--- invoke Edition via reflection ---"
try {
    $r = $bt.GetType().InvokeMember('Edition', [Reflection.BindingFlags]::GetProperty, $null, $bt, $null)
    Write-Output ("Edition(reflection)=" + $r)
} catch { Write-Output ("reflection ERR: " + $_.Exception.ToString().Split("`n")[0]) }

$bt.Quit(0) | Out-Null
Write-Output "DONE"
