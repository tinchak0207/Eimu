param([string]$EnvFile = (Join-Path (Split-Path -Parent $PSScriptRoot) ".env.production"))

$ErrorActionPreference = "Stop"
$envMap = @{}
foreach ($line in Get-Content $EnvFile) {
  if ($line -match "^\s*([^#=\s]+)=(.*)$") {
    $envMap[$matches[1]] = $matches[2].Trim().Trim([char[]]@('"', "'"))
  }
}

function Get-ModelProbe([string]$Name, [string]$BaseKey, [string]$TokenKey) {
  $baseUrl = $envMap[$BaseKey]
  $apiKey = $envMap[$TokenKey]
  $baseKind = if (-not $baseUrl) { "empty" } elseif ($baseUrl -match "^https?://") { "http" } elseif ($baseUrl -eq "undefined") { "undefined" } elseif ($baseUrl -eq "null") { "null" } else { "other" }
  $baseShape = if ($baseUrl) { "length=$($baseUrl.Length);codes=$((@($baseUrl.ToCharArray() | Select-Object -First 8 | ForEach-Object { [int][char]$_ }) -join ','))" } else { "length=0" }
  if (-not $baseUrl -or -not $apiKey) {
    return [pscustomobject]@{ endpoint = $Name; configured = $false; baseKind = $baseKind; baseShape = $baseShape }
  }

  $baseUrl = $baseUrl.TrimEnd("/")
  foreach ($path in @("/models", "/v1/models")) {
    try {
      $response = Invoke-WebRequest -Uri "$baseUrl$path" -Headers @{ Authorization = "Bearer $apiKey" } -UseBasicParsing -TimeoutSec 20
      $body = $response.Content.ToLowerInvariant()
      return [pscustomobject]@{
        endpoint = $Name
        configured = $true
        baseKind = $baseKind
        baseShape = $baseShape
        host = ([uri]$baseUrl).Host
        status = $response.StatusCode
        nanoBanana = $body.Contains("gemini-3.1-flash-image") -or $body.Contains("nano-banana")
        gptImage2 = $body.Contains("gpt-image-2")
      }
    } catch {
      if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -ne 404) {
        return [pscustomobject]@{ endpoint = $Name; configured = $true; baseKind = $baseKind; baseShape = $baseShape; host = ([uri]$baseUrl).Host; status = [int]$_.Exception.Response.StatusCode; nanoBanana = $false; gptImage2 = $false }
      }
    }
  }
  return [pscustomobject]@{ endpoint = $Name; configured = $true; baseKind = $baseKind; baseShape = $baseShape; host = ([uri]$baseUrl).Host; status = $null; nanoBanana = $false; gptImage2 = $false }
}

@(
  Get-ModelProbe "primary" "IMAGE_API_BASE_URL" "IMAGE_API_KEY"
  Get-ModelProbe "fallback" "IMAGE_API_BASE_URL_FALLBACK" "IMAGE_API_KEY_FALLBACK"
  Get-ModelProbe "sub2api" "SUB2API_BASE_URL" "SUB2API_API_KEY"
) | ConvertTo-Json -Compress
