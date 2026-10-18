# 复位 MC 存档：删除 dev-env/server/ 下的世界目录与玩家数据，不动 Uina 数据。
# .uina/world-data/minecraft/ 属于 Uina（runtime.db/world-history.db），本脚本绝不触碰。
param(
	[switch]$Confirm
)

$ErrorActionPreference = "Stop"
$serverDir = Join-Path $PSScriptRoot "server"

if (-not (Test-Path $serverDir)) {
	Write-Host "[dev-env] server/ 不存在，无需复位"
	exit 0
}

$targets = @("world", "world_nether", "world_the_end") | ForEach-Object { Join-Path $serverDir $_ }
$existing = $targets | Where-Object { Test-Path $_ }

if ($existing.Count -eq 0) {
	Write-Host "[dev-env] 没有可复位的世界目录"
	exit 0
}

foreach ($dir in $existing) {
	if (-not $Confirm) {
		Write-Host "[dev-env] 将删除 $dir（加 -Confirm 实际执行）"
		continue
	}
	Remove-Item $dir -Recurse -Force
	Write-Host "[dev-env] 已删除 $dir"
}

if ($Confirm) {
	Write-Host "[dev-env] 复位完成；下次启动服务端会生成新世界"
} else {
	Write-Host "[dev-env] 预演结束；实际复位请加 -Confirm"
}
