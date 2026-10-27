param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$deskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$deskNode = (Get-Command node.exe -ErrorAction Stop).Source
$deskEntry = Join-Path $deskRoot 'scripts\start-local.mjs'
$deskUrl = 'http://127.0.0.1:17880'
if ($CheckOnly) {
    [pscustomobject]@{ Node=$deskNode; Root=$deskRoot; Entry=$deskEntry; Exists=(Test-Path -LiteralPath $deskEntry); Url=$deskUrl } | ConvertTo-Json
    exit 0
}
function Test-Desk {
    try { $r=Invoke-RestMethod "$deskUrl/api/config" -TimeoutSec 2; return ($r.product -eq 'aos-same-table') } catch { return $false }
}
if (-not (Test-Desk)) {
    Start-Process -FilePath $deskNode -ArgumentList ('"' + $deskEntry + '"') -WorkingDirectory $deskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $deskRoot 'workdir\server.stdout.log') -RedirectStandardError (Join-Path $deskRoot 'workdir\server.stderr.log') | Out-Null
    for ($deskAttempt=0; $deskAttempt -lt 24; $deskAttempt++) {
        Start-Sleep -Milliseconds 500
        if (Test-Desk) { break }
    }
}
if (-not (Test-Desk)) { throw "Could not start Same Table. See $deskRoot\workdir\server.stderr.log" }
Start-Process $deskUrl
