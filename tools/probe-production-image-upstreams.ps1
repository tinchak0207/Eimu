$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $env:TEMP ("image-gen-production-{0}.env" -f [guid]::NewGuid())

try {
  Push-Location $root
  & npx.cmd vercel env pull $envFile --environment production --yes | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Vercel Production environment pull failed." }
  & "$PSScriptRoot\probe-image-upstreams.ps1" -EnvFile $envFile
} finally {
  Pop-Location -ErrorAction SilentlyContinue
  if (Test-Path $envFile) { Remove-Item -LiteralPath $envFile -Force }
}
