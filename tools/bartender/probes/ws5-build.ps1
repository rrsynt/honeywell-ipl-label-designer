# Compile the BarTender reference builder against the Seagull interop.
$ErrorActionPreference = 'Stop'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
& $csc /nologo /platform:x64 `
    '/r:C:\Program Files\Seagull\BarTender 2022\Interop.BarTender.dll' `
    ('/out:' + (Join-Path $here 'ReferenceBuilder.exe')) `
    (Join-Path $here 'ReferenceBuilder.cs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output "built ok"
