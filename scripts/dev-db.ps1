# Starts the project-local PostgreSQL cluster (.pgdata) on port 5433, creating it on first run.
# Safe to run when it is already up.
$ErrorActionPreference = 'Stop'

$pgBin = 'C:\Program Files\PostgreSQL\18\bin'
$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $root '.pgdata'

& "$pgBin\pg_isready.exe" -q -h 127.0.0.1 -p 5433
if ($LASTEXITCODE -eq 0) {
    Write-Host 'PostgreSQL already running on 127.0.0.1:5433'
    exit 0
}

$created = $false
if (-not (Test-Path (Join-Path $data 'PG_VERSION'))) {
    # Matches the default DATABASE_URL: postgres://slack:change-me@localhost:5433/slack_analyze
    $pw = New-TemporaryFile
    Set-Content -Path $pw -Value 'change-me' -NoNewline -Encoding ascii
    & "$pgBin\initdb.exe" -D $data -U slack --pwfile=$pw -A scram-sha-256 -E UTF8
    $code = $LASTEXITCODE
    Remove-Item $pw
    if ($code -ne 0) { exit $code }
    $created = $true
}

& "$pgBin\pg_ctl.exe" -D $data -l (Join-Path $data 'server.log') -o '-p 5433' -w start
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($created) {
    $env:PGPASSWORD = 'change-me'
    & "$pgBin\createdb.exe" -h 127.0.0.1 -p 5433 -U slack slack_analyze
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Write-Host 'PostgreSQL started on 127.0.0.1:5433'
