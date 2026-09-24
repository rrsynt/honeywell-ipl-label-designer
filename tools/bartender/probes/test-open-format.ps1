$ErrorActionPreference = 'Stop'
$asm = [System.Reflection.Assembly]::LoadFrom('C:\Program Files\Seagull\BarTender 2022\Interop.BarTender.dll')

Write-Output "=== Finding BarTender templates ==="
$searches = @(
    'C:\Users\ratri\Documents',
    'C:\ProgramData\Seagull',
    'C:\Program Files\Seagull\BarTender 2022\Samples',
    $env:LOCALAPPDATA
)
foreach ($s in $searches) {
    if (Test-Path $s) {
        Write-Output "Searching $s..."
        Get-ChildItem $s -Recurse -Filter '*.bar' -ErrorAction SilentlyContinue | 
            Select-Object -First 10 FullName | ForEach-Object { $_.FullName }
    }
}

Write-Output "`n=== Testing Open existing template ==="
$bt = New-Object -ComObject BarTender.Application
$bt.Visible = $false

$f = $bt.Formats
if (-not $f.Count) {
    Write-Output "No templates in current session; trying Open()"
} else {
    Write-Output "Templates exist:"
    for ($i = 0; $i -lt $f.Count; $i++) {
        $tf = $f.Item($i)
        if ($tf) { Write-Output "  [{0}] {1}" -f $i, $tf.FileName }
    }
}

# Try loading our existing .bar file if it exists
$candidateBars = Get-ChildItem "$env:USERPROFILE\Documents" -Recurse -Filter "*.bar" -ErrorAction SilentlyContinue | Select-Object -First 5 -ExpandProperty FullName
if ($candidateBars) {
    Write-Output "`n=== Loading first .bar file ==="
    foreach ($barFile in $candidateBars) {
        Write-Output "Attempting: $barFile"
        try {
            $fmt = $f.Open($barFile, $true, "Intermec PD43 (203 dpi) - IPL")
            if ($fmt) {
                Write-Output ("Opened OK: Name={0} Filename={1}" -f $fmt.Title, $fmt.FileName)
                Write-Output "Objects count: $($fmt.Objects.Count)"
                $fmt.PrintSetup.PrintToFile = $true
                Write-Output "Set PrintToFile=true OK"
                break
            } else {
                Write-Output "Open returned null"
            }
        } catch {
            Write-Output "ERROR: $($_.Exception.Message)"
        }
    }
} else {
    Write-Output "No .bar files found to test with"
}

Write-Output "`n=== Clean exit ==="
$bt.Quit(0) | Out-Null
Write-Output "Done"
