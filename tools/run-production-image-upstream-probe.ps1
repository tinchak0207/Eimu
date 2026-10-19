$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
$token = [Convert]::ToBase64String($bytes).Replace("+", "-").Replace("/", "_").TrimEnd("=")

Push-Location $root
try {
  $token | & npx.cmd vercel env add IMAGE_UPSTREAM_PROBE_TOKEN production --force --yes --sensitive | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Unable to set the Production probe token." }
  & npx.cmd vercel --prod --yes | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Unable to deploy the Production probe." }
  try {
    $response = Invoke-WebRequest -Uri "https://image.eimu.dev/api/admin/image-upstream-probe" -Method Post -Headers @{ "x-image-upstream-probe" = $token } -UseBasicParsing -TimeoutSec 300
    $probeOutput = $response.Content
  } catch {
    $response = $_.Exception.Response
    $probeOutput = if ($response) { ([System.IO.StreamReader]::new($response.GetResponseStream())).ReadToEnd() } else { $_.Exception.Message }
  }
} finally {
  $ErrorActionPreference = "Continue"
  & npx.cmd vercel env remove IMAGE_UPSTREAM_PROBE_TOKEN production --yes *> $null
  if ($LASTEXITCODE -eq 0) { & npx.cmd vercel --prod --yes | Out-Host }
  Pop-Location
}

if ($probeOutput) { Write-Output $probeOutput }
