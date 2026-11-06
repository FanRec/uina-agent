# 启动本地 Paper 1.21.11 offline 服务端（dev-env/server/）。
# 首次运行生成 eula.txt / server.properties 后自动改写，再提示需要重启。
param(
	[int]$Port = 25565
)

$ErrorActionPreference = "Stop"
$serverDir = Join-Path $PSScriptRoot "server"
$jar = Join-Path $serverDir "paper-1.21.11-132.jar"

if (-not (Test-Path $jar)) {
	throw "缺少服务端 jar：$jar（见 dev-env/README.md 固定组合）"
}

$eula = Join-Path $serverDir "eula.txt"
$props = Join-Path $serverDir "server.properties"
$firstRun = -not (Test-Path $props)

Write-Host "[dev-env] 启动 Paper 1.21.11 (offline, port $Port)，工作目录 $serverDir"
Push-Location $serverDir
try {
	& java -Xmx2G -jar $jar --nogui
} finally {
	Pop-Location
}

if ($firstRun -and (Test-Path $props)) {
	# 首跑已生成文件；写入 offline/eula/端口，下次启动生效
	(Get-Content $eula) -replace "eula=false", "eula=true" | Set-Content $eula
	$lines = Get-Content $props
	$lines = $lines -replace "^online-mode=.*", "online-mode=false"
	$lines = $lines -replace "^server-port=.*", "server-port=$Port"
	$lines = $lines -replace "^level-name=.*", "level-name=world"
	Set-Content $props $lines
	Write-Host "[dev-env] 首跑配置完成：eula=true, online-mode=false, port=$Port。请重新运行本脚本。"
}
