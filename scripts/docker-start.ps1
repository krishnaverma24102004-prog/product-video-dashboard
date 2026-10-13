# Windows: start the whole app in Docker. Asks for the Gemini key / Instagram session ONLY if they are not
# saved yet; after the first run they stay in backend/.env (gitignored, never in the image) and are reused.
# Usage (from the project root):  powershell -ExecutionPolicy Bypass -File scripts\docker-start.ps1
# To replace a saved key later:   powershell -ExecutionPolicy Bypass -File scripts\set-keys.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  if (Test-Path 'C:\Program Files\Docker\Docker\resources\bin\docker.exe') {
    $env:Path = 'C:\Program Files\Docker\Docker\resources\bin;' + $env:Path
  } else {
    Write-Host 'Docker is not installed. Install Docker Desktop: https://www.docker.com/products/docker-desktop/' -ForegroundColor Red
    exit 1
  }
}
docker info *> $null
if ($LASTEXITCODE -ne 0) { Write-Host 'Docker Desktop is not running. Start it and try again.' -ForegroundColor Red; exit 1 }

# ---- keys: ask once, then reuse --------------------------------------------------------------
$envFile = 'backend\.env'
if (-not (Test-Path $envFile)) { Copy-Item backend\.env.example $envFile }
function Get-EnvValue($name) {
  $line = Get-Content $envFile | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
  if ($line) { return ($line -split '=', 2)[1].Trim() } else { return '' }
}
function Set-EnvValue($name, $value) {
  $lines = @(Get-Content $envFile)
  if ($lines -match "^$name=") { $lines = $lines -replace "^$name=.*", "$name=$value" } else { $lines += "$name=$value" }
  $lines | Set-Content $envFile -Encoding ascii
}
function Read-Secret($prompt) { [Net.NetworkCredential]::new('', (Read-Host $prompt -AsSecureString)).Password.Trim() }

if (-not (Get-EnvValue 'GEMINI_API_KEY')) {
  Write-Host 'First run: a free Gemini key is needed (https://aistudio.google.com/apikey).' -ForegroundColor Cyan
  $g = Read-Secret 'GEMINI_API_KEY (input hidden; Enter = skip, app runs CLIP-only)'
  if ($g) { Set-EnvValue 'GEMINI_API_KEY' $g; Write-Host 'Saved. It will be reused on every start.' -ForegroundColor Green }
} else { Write-Host 'Gemini key: saved (reusing).' -ForegroundColor Green }

if (-not (Get-EnvValue 'IG_SESSION_ID') -and -not (Test-Path 'backend\.sessions\ig.json')) {
  Write-Host 'First run: Instagram needs your logged-in sessionid cookie (browser DevTools > Application > Cookies > instagram.com > sessionid).' -ForegroundColor Cyan
  $s = Read-Secret 'IG_SESSION_ID (input hidden; Enter = skip, Instagram stays off)'
  if ($s) { Set-EnvValue 'IG_SESSION_ID' $s; Write-Host 'Saved. It will be reused on every start.' -ForegroundColor Green }
} else { Write-Host 'Instagram session: saved (reusing).' -ForegroundColor Green }

New-Item -ItemType Directory -Force backend\.sessions | Out-Null   # mounted into the container

# ---- build + start ----------------------------------------------------------------------------
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host 'Waiting for the backend to report healthy...'
$h = $null
for ($i = 0; $i -lt 60; $i++) {
  try { $h = Invoke-RestMethod http://localhost:4000/api/health -TimeoutSec 3; if ($h.ok) { break } } catch {}
  Start-Sleep 2
}
if ($h) {
  Write-Host ("Gemini: {0} | Instagram: {1}" -f ($(if ($h.vision.gemini) { 'on' } else { 'off (CLIP-only)' })), $h.instagram.method) -ForegroundColor Green
}
Write-Host 'Dashboard: http://localhost:4000   (logs: docker compose logs -f   stop: docker compose down)' -ForegroundColor Green
Start-Process http://localhost:4000
