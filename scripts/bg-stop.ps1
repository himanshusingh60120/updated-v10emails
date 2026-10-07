# Stops the background AuditForge server started by bg-start.ps1.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root ".logs\pids.json"

if (-not (Test-Path $pidFile)) { Write-Host "AuditForge is not running in the background."; exit 0 }

$pids = Get-Content $pidFile -Raw | ConvertFrom-Json
# /T also ends child processes. The keep-awake helper exits by itself once the
# server is gone (releasing its power request); stopping it here is a fallback.
if (Get-Process -Id $pids.server -ErrorAction SilentlyContinue) { taskkill /PID $pids.server /T /F | Out-Null }
Stop-Process -Id $pids.keepAwake -Force -ErrorAction SilentlyContinue
Remove-Item $pidFile
Write-Host "AuditForge background server stopped. The PC can sleep normally again."
