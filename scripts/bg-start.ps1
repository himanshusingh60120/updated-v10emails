<#
  Runs AuditForge unattended on this machine. See RUNNING-LOCALLY.md.

  1. Builds and starts the production server (`next start`) as a hidden
     background process, so it survives closing VS Code or the terminal.
  2. Holds a Windows "system required" power request for as long as the server
     lives. The PC cannot idle-sleep, but the display may still turn off and the
     screen saver / lock screen may still start.
  3. Opens a dedicated Chrome (or Edge) window with background throttling
     disabled. The verification queue runs in that tab, and by default Chrome
     treats a tab behind a screen saver or lock screen as hidden and slows its
     timers to about once a minute.

  Usage:  npm run bg:start            (build, start server, open browser)
          npm run bg:start -- -SkipBuild
          npm run bg:stop
#>
param(
  [int]$Port = 3000,
  [switch]$SkipBuild,
  [switch]$NoBrowser
)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root ".logs"
$pidFile = Join-Path $logDir "pids.json"
New-Item -ItemType Directory -Force $logDir | Out-Null
Set-Location $root

if (Test-Path $pidFile) {
  $old = Get-Content $pidFile -Raw | ConvertFrom-Json
  if (Get-Process -Id $old.server -ErrorAction SilentlyContinue) {
    Write-Host "AuditForge is already running (PID $($old.server)) at http://localhost:$Port. Stop it with: npm run bg:stop"
    exit 0
  }
  Remove-Item $pidFile
}

# `next build` and a running `next dev` both write to .next/ and corrupt each other.
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  throw "Port $Port is already in use (probably 'npm run dev'). Stop it first."
}

if (-not $SkipBuild) {
  Write-Host "Building production bundle..."
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "next build failed; see output above." }
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$server = Start-Process -FilePath "node" `
  -ArgumentList "node_modules/next/dist/bin/next", "start", "-p", $Port `
  -WorkingDirectory $root -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $logDir "server-$stamp.log") `
  -RedirectStandardError (Join-Path $logDir "server-$stamp.err.log")

# The power request lives exactly as long as the server: keep-awake.ps1 holds it
# and exits when the server process does.
$keepAwake = Start-Process -FilePath "powershell.exe" `
  -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "keep-awake.ps1"), "-ServerPid", $server.Id `
  -WindowStyle Hidden -PassThru

@{ server = $server.Id; keepAwake = $keepAwake.Id; port = $Port; started = (Get-Date).ToString("o") } |
  ConvertTo-Json | Set-Content $pidFile -Encoding utf8

# Wait for the server to answer before opening the browser.
$url = "http://localhost:$Port"
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  try { Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2 | Out-Null; $ready = $true; break } catch { Start-Sleep -Milliseconds 500 }
  if ($server.HasExited) { throw "Server exited during startup; see .logs/server-$stamp.err.log" }
}
if (-not $ready) { Write-Warning "Server did not answer within 30s; check .logs/server-$stamp.*.log" }
Write-Host "AuditForge server running at $url (PID $($server.Id)); logs in .logs/"

if ($NoBrowser) { exit 0 }

$candidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$browser = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $browser) { Write-Warning "No Chrome/Edge found; open $url manually."; exit 0 }

# A separate profile is required: these flags are ignored if they are passed to
# an already-running browser that uses your normal profile.
$profileDir = Join-Path $env:LOCALAPPDATA "AuditForge\browser-profile"
Start-Process -FilePath $browser -ArgumentList @(
  "--user-data-dir=`"$profileDir`"",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling",
  "--no-first-run",
  "--new-window",
  $url
)
Write-Host "Opened $url in an unthrottled browser window. Run audits from that window."
