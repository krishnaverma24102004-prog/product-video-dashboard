# Windows: build and start the whole app in Docker, then open the dashboard.
# Usage (from the project root):  powershell -ExecutionPolicy Bypass -File scripts\docker-start.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host 'Docker is not installed. Install Docker Desktop: https://www.docker.com/products/docker-desktop/' -ForegroundColor Red
  exit 1
}
docker info *> $null
if ($LASTEXITCODE -ne 0) { Write-Host 'Docker Desktop is not running. Start it and try again.' -ForegroundColor Red; exit 1 }

if (-not (Test-Path backend\.env)) {
  Copy-Item backend\.env.example backend\.env
  Write-Host 'Created backend\.env from .env.example. Fill in GEMINI_API_KEY and IG_SESSION_ID, then run this again.' -ForegroundColor Yellow
  exit 1
}
New-Item -ItemType Directory -Force backend\.sessions | Out-Null   # mounted into the container

docker compose up --build -d
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host 'Waiting for the backend to report healthy...'
for ($i = 0; $i -lt 60; $i++) {
  try { if ((Invoke-RestMethod http://localhost:4000/api/health -TimeoutSec 3).ok) { break } } catch {}
  Start-Sleep 2
}
Write-Host 'Dashboard: http://localhost:4000   (logs: docker compose logs -f   stop: docker compose down)' -ForegroundColor Green
Start-Process http://localhost:4000
