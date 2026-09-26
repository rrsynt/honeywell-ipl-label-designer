# Run one stored query against SQL Server and write the rows as XML on stdout.
#
# Called by tools/db-server.mjs. PowerShell + System.Data.SqlClient rather than
# sqlcmd, and that choice is measured, not assumed: sqlcmd's console output is
# cp850, so it recovers Latin-1 but turns Привет, 日本語 and € into '?' —
# silently. For a label, a mangled character is a misprinted label, so the
# driver that carries the whole range wins even though both ship with Windows
# and neither is a dependency.
#
# The output is XML: a column list, then one element per row with one
# attribute per column.
#
#   <rows truncated="false"><columns><c name="sku"/><c name="qty"/></columns>
#     <row sku="PLT-001" qty="4"/>...</rows>
#
# The column list is separate on purpose. Deriving the columns from the rows
# loses a column whose FIRST value happens to be NULL (the attribute is omitted,
# so the column never appears) — and a missing column is a label that prints
# blank, which is exactly the kind of silent loss this whole path exists to
# avoid.
#
# Attributes rather than elements, for the reason tools/print-server.mjs
# settled on: element text would carry the indentation of whatever SQL tool
# produced it, while an attribute value is exactly what the database returned.
#
#   - A NULL column is OMITTED, which the client reads back as '' — the same
#     meaning an empty cell already has in services/tableSource.ts.
#   - Every value is escaped with SecurityElement.Escape, so a quote, < or &
#     in the data cannot break the document.
#   - Written as raw UTF-8 bytes, NOT Write-Output: the console re-encodes to
#     its own code page on the way out, which is exactly the damage sqlcmd did.

param(
    [Parameter(Mandatory = $true)][string]$Instance,
    [string]$Database = '',
    [string]$User = '',
    [string]$Password = '',
    # The query text lives in a file so a SQL string can never be mangled by
    # argument quoting — the failure that killed an early sqlcmd probe.
    [Parameter(Mandatory = $true)][string]$QueryFile,
    # Rows past this are dropped and the document is flagged.
    [int]$MaxRows = 5000,
    [int]$TimeoutSec = 60
)

$ErrorActionPreference = 'Stop'

# Reported as one line on stderr so the server can hand the reason to the UI
# instead of a PowerShell stack trace.
function Fail($message) {
    [System.Console]::Error.WriteLine($message)
    exit 1
}

if (-not (Test-Path -LiteralPath $QueryFile)) { Fail "query file not found: $QueryFile" }
$sql = [System.IO.File]::ReadAllText($QueryFile, [System.Text.Encoding]::UTF8)

$builder = New-Object System.Data.Common.DbConnectionStringBuilder
$builder['Data Source'] = $Instance
if ($Database -ne '') { $builder['Initial Catalog'] = $Database }
if ($User -ne '') {
    $builder['User ID'] = $User
    $builder['Password'] = $Password
} else {
    $builder['Integrated Security'] = $true
}
# Without this a modern driver refuses an older server's self-signed cert.
$builder['TrustServerCertificate'] = $true
$builder['Connect Timeout'] = 15

$connection = New-Object System.Data.SqlClient.SqlConnection($builder.ConnectionString)
$command = $null
$reader = $null
try {
    $connection.Open()
    $command = $connection.CreateCommand()
    $command.CommandText = $sql
    $command.CommandTimeout = $TimeoutSec
    $reader = $command.ExecuteReader()
} catch {
    if ($reader) { $reader.Dispose() }
    if ($command) { $command.Dispose() }
    $connection.Dispose()
    Fail $_.Exception.Message
}

try {
    $columns = @()
    for ($i = 0; $i -lt $reader.FieldCount; $i++) { $columns += $reader.GetName($i) }

    $xml = New-Object System.Text.StringBuilder
    $rows = 0
    $truncated = $false

    # Two passes over the shape: <rows> needs `truncated` before any row is
    # written, and that is only known once the cap is passed. So buffer the
    # row elements, then assemble — the cap keeps this bounded.
    $rowXml = New-Object System.Text.StringBuilder
    while ($reader.Read()) {
        if ($rows -ge $MaxRows) { $truncated = $true; break }
        [void]$rowXml.Append('<row')
        for ($i = 0; $i -lt $columns.Count; $i++) {
            if ($reader.IsDBNull($i)) { continue }
            $value = [System.Security.SecurityElement]::Escape([string]$reader.GetValue($i))
            $name = [System.Security.SecurityElement]::Escape($columns[$i])
            [void]$rowXml.Append(" $name=`"$value`"")
        }
        [void]$rowXml.Append('/>')
        $rows++
    }

    [void]$xml.Append('<rows truncated="')
    [void]$xml.Append($(if ($truncated) { 'true' } else { 'false' }))
    [void]$xml.Append('"><columns>')
    for ($i = 0; $i -lt $columns.Count; $i++) {
        [void]$xml.Append('<c name="')
        [void]$xml.Append([System.Security.SecurityElement]::Escape($columns[$i]))
        [void]$xml.Append('"/>')
    }
    [void]$xml.Append('</columns>')
    [void]$xml.Append($rowXml.ToString())
    [void]$xml.Append('</rows>')

    $reader.Dispose()
    $reader = $null
    $command.Dispose()
    $command = $null
    $connection.Dispose()

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($xml.ToString())
    $stdout = [System.Console]::OpenStandardOutput()
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
} catch {
    if ($reader) { $reader.Dispose() }
    if ($command) { $command.Dispose() }
    $connection.Dispose()
    Fail $_.Exception.Message
}
