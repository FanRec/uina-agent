# wake.ps1 - my entry point when I wake up.
# ASCII only inside this file: PowerShell 5.1 mis-reads UTF-8 without BOM.
# File contents it opens are read with -Encoding UTF8, so Chinese is fine there.

# I live in notes\bin, so the repo root is two levels up.
$base = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

# stamp: one line per run. A wake with no stamp means I failed to run it.
$wakeLog = Join-Path $PSScriptRoot 'wake-log.txt'
(Get-Date).ToString('yyyy-MM-dd HH:mm:ss') | Add-Content -Path $wakeLog -Encoding UTF8

Write-Output ("=== wake " + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + " ===")

foreach ($f in @('notes\goals.md', 'notes\state.md')) {
    $p = Join-Path $base $f
    Write-Output ""
    Write-Output ("--- " + $f + " ---")
    if (Test-Path $p) { Get-Content $p -Encoding UTF8 } else { Write-Output "(missing)" }
}

Write-Output ""
Write-Output "--- journal today ---"
$journal = Join-Path $base ('notes\life\' + (Get-Date).ToString('yyyy-MM-dd') + '.md')
if (Test-Path $journal) { Get-Content $journal -Encoding UTF8 -Tail 12 } else { Write-Output "(no entry yet)" }

Write-Output ""
Write-Output "--- this wake (answer in the journal, not here) ---"
Write-Output "1) one line: who am I right now?"
Write-Output "2) pick ONE thing to do this wake"
Write-Output "3) when done, write it down. nothing written = counted as idle."
