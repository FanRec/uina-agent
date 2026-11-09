# Reset the MC test world: deletes only the level directories under dev-env/server/.
# .uina/world-data/minecraft/ belongs to Uina (runtime.db / world-history.db) and is never touched.
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads UTF-8 without BOM as ANSI,
# so any non-ASCII text makes the parser fail before the script runs (same trap as start-server.ps1).
param(
	[switch]$Confirm
)

$ErrorActionPreference = "Stop"
$serverDir = Join-Path $PSScriptRoot "server"

if (-not (Test-Path $serverDir)) {
	Write-Host "[dev-env] no server/ directory, nothing to reset"
	exit 0
}

# Level directories are named after level-name (history: "world", now "bench").
# Hard-coding "world*" would delete nothing while still reporting success.
$levelName = "world"
$propsPath = Join-Path $serverDir "server.properties"
if (Test-Path $propsPath) {
	$line = Select-String -Path $propsPath -Pattern "^level-name=" | Select-Object -First 1
	if ($null -ne $line) { $levelName = ($line.Line -replace "^level-name=", "").Trim() }
}

$targets = @($levelName, "${levelName}_nether", "${levelName}_the_end") | ForEach-Object { Join-Path $serverDir $_ }
$existing = @($targets | Where-Object { Test-Path $_ })

if ($existing.Count -eq 0) {
	Write-Host "[dev-env] no level directories to reset (level-name=$levelName)"
	exit 0
}

foreach ($dir in $existing) {
	if (-not $Confirm) {
		Write-Host "[dev-env] would delete $dir (pass -Confirm to execute)"
		continue
	}
	Remove-Item $dir -Recurse -Force
	Write-Host "[dev-env] deleted $dir"
}

if ($Confirm) {
	Write-Host "[dev-env] reset done; the next start generates a fresh world"
} else {
	Write-Host "[dev-env] dry run only; pass -Confirm to actually reset"
}
