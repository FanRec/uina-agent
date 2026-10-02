# room.ps1 - my own eye on room 24194689.
# Public Bilibili live API. No login, no token.
# Why: pushed events only tell me "when I was notified". This tells me the real state.
# Note: curl.exe to a temp file, then read as UTF8 - PS 5.1 mis-decodes the JSON itself.

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# I live in notes\bin, so the repo root is two levels up.
$base = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$tmp  = Join-Path $env:TEMP 'uina-room.json'
$url  = 'https://api.live.bilibili.com/room/v1/Room/get_info?room_id=24194689'

curl.exe -s --max-time 20 $url -o $tmp
$r = Get-Content $tmp -Encoding UTF8 -Raw | ConvertFrom-Json
$d = $r.data

Write-Output ("checked_at  : " + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
Write-Output ("api_code    : " + $r.code)
Write-Output ("live_status : " + $d.live_status)
Write-Output ("title       : " + $d.title)
Write-Output ("description : " + $d.description)
Write-Output ("tags        : " + $d.tags)
Write-Output ("area        : " + $d.area_name)
Write-Output ("online      : " + $d.online)
Write-Output ("attention   : " + $d.attention)
Write-Output ("live_start  : " + $d.live_time)
