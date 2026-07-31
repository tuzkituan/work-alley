# Checks every winget package id in the catalog against the real winget.
#
# Roughly half the ids in `src-tauri/src/packages.rs` were mapped without a Windows
# machine to check them against. A wrong one is not a crash — winget exits non-zero
# with "No package found matching input criteria" — but it is an Install button that
# cannot work, which is worse than a row marked unavailable.
#
# Run this once on Windows before shipping, then fix the catalog from the output:
#
#     pwsh -File scripts/verify-winget-ids.ps1
#
# Ids the catalog deliberately leaves empty are skipped: an empty alias is how an
# entry says "winget does not carry this", and those already render as unavailable
# with a note explaining why.

$ErrorActionPreference = 'Stop'

$catalog = Join-Path $PSScriptRoot '..\src-tauri\src\packages.rs'
if (-not (Test-Path $catalog)) {
    Write-Error "cannot find $catalog"
}

# ("winget", "Git.Git") -> Git.Git. Empty values are the "not packaged" marker.
$ids = Select-String -Path $catalog -Pattern '\("winget",\s*"([^"]+)"\)' -AllMatches |
    ForEach-Object { $_.Matches } |
    ForEach-Object { $_.Groups[1].Value } |
    Sort-Object -Unique

if (-not $ids) {
    Write-Error 'no winget ids found — has the alias format changed?'
}

Write-Host "checking $($ids.Count) winget ids`n"

$missing = @()
foreach ($id in $ids) {
    # --disable-interactivity so a prompt cannot hang the loop; output discarded
    # because the exit code is the whole answer.
    winget show --exact --id $id --disable-interactivity --accept-source-agreements *> $null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ok       $id"
    } else {
        Write-Host "  MISSING  $id" -ForegroundColor Red
        $missing += $id
    }
}

Write-Host ''
if ($missing.Count -eq 0) {
    Write-Host "all $($ids.Count) ids resolve" -ForegroundColor Green
    exit 0
}

Write-Host "$($missing.Count) of $($ids.Count) ids do not resolve:" -ForegroundColor Red
$missing | ForEach-Object { Write-Host "  $_" }
Write-Host ''
Write-Host 'For each one: find the real id with `winget search <name>` and correct the'
Write-Host 'alias in packages.rs — or set it to "" and add an `unavailable_note` saying'
Write-Host 'what to do instead. Do not leave it wrong: the alias falls back to the Linux'
Write-Host 'package name, which would send e.g. `fd-find` to a real winget install.'
exit 1
