$ErrorActionPreference = "Stop"
Set-Location -LiteralPath (Join-Path $PSScriptRoot "..")
if (!(Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
}
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build
