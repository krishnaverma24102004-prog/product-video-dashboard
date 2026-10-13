# Put a (new) Gemini API key and/or Instagram sessionid into backend/.env, then restart the Docker app.
# Values are read hidden (not echoed, not kept in shell history). Press Enter to keep the current value.
# Usage (from the project root):  powershell -ExecutionPolicy Bypass -File scripts\set-keys.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$envFile = 'backend\.env'
if (-not (Test-Path $envFile)) { Copy-Item backend\.env.example $envFile }

function Read-Secret($prompt) {
  $s = Read-Host $prompt -AsSecureString
  return [Net.NetworkCredential]::new('', $s).Password.Trim()
}
function Set-EnvValue($name, $value) {
  $lines = @(Get-Content $envFile)
  if ($lines -match "^$name=") { $lines = $lines -replace "^$name=.*", "$name=$value" }
  else { $lines += "$name=$value" }
  $lines | Set-Content $envFile -Encoding ascii
}

$gemini = Read-Secret 'New GEMINI_API_KEY (Enter = keep current)'
if ($gemini) { Set-EnvValue 'GEMINI_API_KEY' $gemini; Write-Host 'Gemini key saved.' -ForegroundColor Green }

$ig = Read-Secret 'New Instagram sessionid cookie (Enter = keep current)'
if ($ig) { Set-EnvValue 'IG_SESSION_ID' $ig; Write-Host 'Instagram session saved.' -ForegroundColor Green }

# quick check of the Gemini key against the fastest free model (no key is printed)
$key = ((Get-Content $envFile | Where-Object { $_ -match '^GEMINI_API_KEY=' }) -split '=', 2)[1]
if ($key) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -Method Post `
      -Uri 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent' `
      -Headers @{ 'x-goog-api-key' = $key } -ContentType 'application/json' `
      -Body '{"contents":[{"parts":[{"text":"Reply OK"}]}]}'
    Write-Host "Gemini key works (HTTP $($r.StatusCode))." -ForegroundColor Green
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    Write-Host "Gemini check returned HTTP $code (400/403 = bad key; 429/503 = key OK but busy)." -ForegroundColor Yellow
  }
}

# restart the container so it reads the new .env (env_file is read when the container is created)
$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker -and (Test-Path 'C:\Program Files\Docker\Docker\resources\bin\docker.exe')) {
  $env:Path = 'C:\Program Files\Docker\Docker\resources\bin;' + $env:Path; $docker = $true
}
if ($docker) {
  docker compose up -d --force-recreate
  Write-Host 'Restarted. Dashboard: http://localhost:4000' -ForegroundColor Green
} else {
  Write-Host 'Docker not found: restart the backend yourself (npm run dev in backend/).' -ForegroundColor Yellow
}
