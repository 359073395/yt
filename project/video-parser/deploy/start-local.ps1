$ErrorActionPreference = "Stop"
Set-Location -LiteralPath (Join-Path $PSScriptRoot "..")
if (!(Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
}
docker compose up --build
